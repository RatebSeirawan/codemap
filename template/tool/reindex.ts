#!/usr/bin/env bun
/**
 * reindex — keeps the codemap (.codemap/<lane>/**.yaml) true to the code.
 *
 * Part of the codemap kit by Rateb Seirawan (codemap-setup skill), modelled on
 * the reindex of his production ERP. The split:
 *   - hooks flag what changed (zero LLM, milliseconds): .codemap/<lane>/.dirty
 *   - `prepare` builds one scaffold packet per unit: the exact files, the diff,
 *     the existing YAML, the lane schema, a hard scope
 *   - one indexer agent per packet, in parallel, each in a tiny context
 *   - `finalize` / `mark-verified` / `verify` close the loop deterministically
 *
 * Nothing here ever indexes on its own. The LLM work runs only when you ask
 * (the codemap-reindex skill), never mid-flow.
 *
 * Run with no args (or `help`) for the command list.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
	addDirty,
	CODEMAP,
	contextExcerpts,
	contextFiles,
	type CodemapLane,
	type Config,
	isCommentOnlyChange,
	laneById,
	laneOf,
	laneUnits,
	laneYamlUnits,
	loadConfig,
	mtimeMs,
	policy,
	porcelainFiles,
	readDirty,
	recentCommitFiles,
	resolveUnit,
	ROOT,
	sh,
	type UnitInfo,
	unitSourcePath,
	writeDirty,
	yamlRel,
} from "./lib/core"
import { stripArtifacts, validateUnitYaml } from "./lib/validate"

const cfg: Config = loadConfig()
const POL = policy(cfg)
const R = "bun .codemap/tool/reindex.ts"

/**
 * Rough agent cost of indexing a unit: source tokens (~3.5 bytes each) times
 * the turn multiplier (every agent turn re-sends its context), plus a fixed
 * overhead for the packet and the agent's own instructions. Calibrated on a
 * measured CREATE run: a 1.2k-line unit cost ~71k tokens. The pilot replaces
 * this with the project's own figure.
 */
const BYTES_PER_TOKEN = 3.5
const TURN_MULTIPLIER = 3
const AGENT_OVERHEAD = 15000
const LARGE_UNIT_LINES = 4000
const DIFF_CAP_LINES = 400

// ───────────────────────────────────────────────────────────────────────────
// Args
// ───────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0] ?? "help"
const rest = argv.slice(1)
const flag = (name: string) => rest.includes(`--${name}`)
function opt(name: string): string | undefined {
	const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
	if (i < 0) return undefined
	return rest[i].includes("=") ? rest[i].split("=").slice(1).join("=") : rest[i + 1]
}
const positionals = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && /^--(lane|units|days|limit|top)$/.test(rest[i - 1])))

function lanesArg(): CodemapLane[] {
	const l = opt("lane")
	if (!l) return cfg.codemap
	const lane = laneById(cfg, l)
	if (!lane) die(`Unknown lane "${l}". Lanes: ${cfg.codemap.map((x) => x.id).join(", ")}`)
	return [lane!]
}

function die(msg: string, code = 1): never {
	console.error(msg)
	process.exit(code)
}

const KNOWN_FLAGS: Record<string, string[]> = {
	status: ["lane"],
	units: ["lane", "unindexed", "json"],
	estimate: ["lane"],
	hot: ["lane", "days", "limit"],
	scan: ["lane", "dry-run", "evidenced-only"],
	prepare: ["lane", "units", "unindexed", "top", "force"],
	verify: ["lane"],
	"promote-bulk": ["lane"],
	"clear-bulk": ["lane", "dry-run"],
	recover: ["lane", "dry-run"],
	"clear-packets": [],
	finalize: [],
	"mark-verified": [],
	validate: [],
	flag: [],
	hook: [],
}
function rejectUnknownFlags(): void {
	const allowed = KNOWN_FLAGS[cmd]
	if (!allowed) return
	for (const a of rest)
		if (a.startsWith("--")) {
			const name = a.slice(2).split("=")[0]
			// Unknown flags are refused: a silently ignored --dry-run would write for real.
			if (!allowed.includes(name)) die(`Unknown flag ${a} for "${cmd}". Allowed: ${allowed.map((f) => `--${f}`).join(" ") || "(none)"}`)
		}
}

// ───────────────────────────────────────────────────────────────────────────
// Shared views
// ───────────────────────────────────────────────────────────────────────────

const unitsCache = new Map<string, ReturnType<typeof laneUnits>>()
function unitsOf(lane: CodemapLane) {
	let u = unitsCache.get(lane.id)
	if (!u) {
		u = laneUnits(lane)
		unitsCache.set(lane.id, u)
	}
	return u
}

function yamlMtime(lane: CodemapLane, unit: string): number | null {
	return mtimeMs(yamlRel(lane, unit))
}

/** Dirty files grouped by unit, with helpers no unit owns set apart. */
function dirtyByUnit(lane: CodemapLane): { byUnit: Map<string, string[]>; unowned: string[] } {
	const byUnit = new Map<string, string[]>()
	const unowned: string[] = []
	for (const f of readDirty(lane)) {
		const u = resolveUnit(lane, f)
		if (u === null) {
			unowned.push(f)
			continue
		}
		byUnit.set(u, [...(byUnit.get(u) ?? []), f])
	}
	return { byUnit, unowned }
}

/**
 * The coverage gap: files with GIT EVIDENCE of change (uncommitted, or in the
 * last 20 commits) whose unit HAS an index older than the file, and which are
 * not in .dirty. Edits made outside a session (an editor, a merge, a rebase)
 * never reach the hooks; this is how they surface. Unindexed units are not
 * drift: they are coverage, reported apart.
 */
function coverageGap(lane: CodemapLane): { file: string; unit: string; evidence: string }[] {
	const dirty = new Set(readDirty(lane))
	const recent = recentCommitFiles(20)
	const evidence = new Map<string, string>()
	for (const f of porcelainFiles()) evidence.set(f, "uncommitted")
	for (const [f, c] of recent) if (!evidence.has(f)) evidence.set(f, `commit ${c}`)
	const out: { file: string; unit: string; evidence: string }[] = []
	for (const [f, ev] of evidence) {
		if (dirty.has(f)) continue
		const u = resolveUnit(lane, f)
		if (u === null) continue
		const y = yamlMtime(lane, u)
		if (y === null) continue
		const m = mtimeMs(f)
		if (m === null ? ev === "uncommitted" : m > y) out.push({ file: f, unit: u, evidence: ev })
	}
	return out
}

interface TreeFile {
	groups?: { id: string; units?: { id: string; index?: string }[] }[]
}
function treeUnits(lane: CodemapLane): Set<string> | null {
	const p = join(CODEMAP, lane.id, "_tree.yaml")
	if (!existsSync(p)) return null
	try {
		const t = Bun.YAML.parse(readFileSync(p, "utf8")) as TreeFile
		return new Set((t?.groups ?? []).flatMap((g) => (g.units ?? []).map((u) => u.id)))
	} catch {
		return null
	}
}

/** Index files whose unit no longer resolves to any source file: renamed, moved or deleted. */
function orphanYamls(lane: CodemapLane): string[] {
	const { units } = unitsOf(lane)
	return laneYamlUnits(lane).filter((u) => !units.has(u))
}

function fmtK(n: number): string {
	return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
}
function unitCost(u: UnitInfo): number {
	return Math.round((u.bytes / BYTES_PER_TOKEN) * TURN_MULTIPLIER) + AGENT_OVERHEAD
}

// ───────────────────────────────────────────────────────────────────────────
// status
// ───────────────────────────────────────────────────────────────────────────

function cmdStatus(): void {
	for (const lane of lanesArg()) {
		const { units, helpers } = unitsOf(lane)
		const indexed = [...units.values()].filter((u) => u.indexed).length
		console.log(`── ${lane.id} (${lane.name}) — ${indexed}/${units.size} units indexed ──`)
		const bulk = readDirty(lane, true)
		if (bulk.length) {
			console.log(`BULK: ${bulk.length} file(s) from a sweep sit in .dirty.bulk, never fanned out.`)
			console.log(`  Settle it: \`${R} promote-bulk --lane ${lane.id}\` if the sweep changed behaviour, \`clear-bulk\` if it was mechanical.`)
		}
		const gap = coverageGap(lane)
		if (gap.length) {
			console.log(`⚠️  Coverage gap: ${gap.length} file(s) changed in indexed units but are NOT in .dirty:`)
			for (const g of gap.slice(0, 15)) console.log(`    · ${g.file}  (${g.unit}; ${g.evidence})`)
			if (gap.length > 15) console.log(`    … ${gap.length - 15} more`)
			console.log(`  Merge them: \`${R} scan --evidenced-only\``)
		}
		const { byUnit, unowned } = dirtyByUnit(lane)
		const update = [...byUnit].filter(([u]) => units.get(u)?.indexed || existsSync(join(ROOT, yamlRel(lane, u))))
		const create = [...byUnit].filter(([u]) => !update.some(([x]) => x === u))
		if (update.length) {
			console.log(`Dirty: ${update.length} indexed unit(s) to reconcile:`)
			for (const [u, fs] of update) console.log(`    · ${u}  (${fs.length} file(s))`)
		}
		if (create.length) {
			const verb = POL.unindexed_dirty === "create" ? "will be CREATED on prepare (policy: create)" : "are SKIPPED by prepare (policy: skip; seed them deliberately)"
			console.log(`Touched but never indexed: ${create.length} unit(s) ${verb}:`)
			for (const [u, fs] of create.slice(0, 15)) console.log(`    · ${u}  (${fs.length} file(s))`)
			if (create.length > 15) console.log(`    … ${create.length - 15} more`)
		}
		if (unowned.length) console.log(`Helpers no unit owns (reported, not indexed): ${unowned.slice(0, 8).join(", ")}${unowned.length > 8 ? " …" : ""}`)
		if (helpers.length && lane.unit.strategy === "anchor")
			console.log(`(${helpers.length} lane file(s) sit outside every anchored unit; \`units --lane ${lane.id}\` lists them)`)
		const orphans = orphanYamls(lane)
		if (orphans.length) {
			console.log(`ORPHAN index files (their source is gone; rename to the unit they now describe, or delete with their _tree.yaml entry): ${orphans.join(", ")}`)
		}
		const tree = treeUnits(lane)
		const notInTree = tree ? laneYamlUnits(lane).filter((u) => !tree.has(u)) : []
		if (notInTree.length) {
			console.log(`Not in _tree.yaml (invisible to \`wiki ${lane.id} tree\`; adopt them): ${notInTree.join(", ")}`)
		}
		if (!update.length && !create.length && !gap.length) console.log("Nothing dirty. Index is current for what is indexed.")
		console.log("")
	}
}

// ───────────────────────────────────────────────────────────────────────────
// units / estimate / hot — the inputs to a bootstrap strategy
// ───────────────────────────────────────────────────────────────────────────

function cmdUnits(): void {
	const rows: object[] = []
	for (const lane of lanesArg()) {
		const { units, helpers } = unitsOf(lane)
		const list = [...units.values()].filter((u) => !flag("unindexed") || !u.indexed).sort((a, b) => a.unit.localeCompare(b.unit))
		if (flag("json")) {
			for (const u of list) rows.push({ lane: lane.id, unit: u.unit, files: u.files.length, lines: u.lines, indexed: u.indexed, est_tokens: unitCost(u) })
			continue
		}
		console.log(`── ${lane.id}: ${list.length} unit(s) ──`)
		for (const u of list)
			console.log(`  ${u.indexed ? "✓" : "·"} ${u.unit.padEnd(48)} ${String(u.files.length).padStart(4)} files ${String(u.lines).padStart(7)} lines  ~${fmtK(unitCost(u))} tok`)
		if (helpers.length) {
			console.log(`  helpers outside every unit (${helpers.length}):`)
			for (const h of helpers.slice(0, 20)) console.log(`    ${h}`)
			if (helpers.length > 20) console.log(`    … ${helpers.length - 20} more`)
		}
	}
	if (flag("json")) console.log(JSON.stringify(rows, null, 1))
}

/** Commits touching each unit within the window: where the work actually happens. */
function churn(lane: CodemapLane, days: number): Map<string, number> {
	// Root commits (an initial import, a shallow clone's boundary) touch every
	// file and say nothing about where work happens: they do not count.
	const out = sh(["git", "log", `--since=${days}.days`, "--no-merges", "--name-only", "--pretty=format:@@%P"], { allowFail: true })
	const counts = new Map<string, number>()
	let seen = new Set<string>()
	let root = false
	for (const line of out.split("\n")) {
		if (line.startsWith("@@")) {
			seen = new Set()
			root = line.length === 2
			continue
		}
		if (!line || root) continue
		const u = resolveUnit(lane, line)
		if (u === null || seen.has(u)) continue
		seen.add(u)
		counts.set(u, (counts.get(u) ?? 0) + 1)
	}
	return counts
}

function cmdHot(): void {
	const days = Number(opt("days") ?? 90)
	const limit = Number(opt("limit") ?? 20)
	for (const lane of lanesArg()) {
		const { units } = unitsOf(lane)
		const c = churn(lane, days)
		const total = [...c.values()].reduce((a, b) => a + b, 0)
		const ranked = [...c].filter(([u]) => units.has(u)).sort((a, b) => b[1] - a[1])
		console.log(`── ${lane.id}: unit churn, last ${days} days (${total} unit-commits across ${ranked.length} unit(s)) ──`)
		if (!ranked.length) {
			console.log("  no commits in the window")
			continue
		}
		let cum = 0
		let tok = 0
		for (const [u, n] of ranked.slice(0, limit)) {
			cum += n
			const info = units.get(u)!
			tok += unitCost(info)
			console.log(
				`  ${info.indexed ? "✓" : "·"} ${u.padEnd(44)} ${String(n).padStart(4)} commits  cum ${String(Math.round((cum / total) * 100)).padStart(3)}%  ~${fmtK(unitCost(info))} tok (Σ ${fmtK(tok)})`,
			)
		}
	}
}

function cmdEstimate(): void {
	for (const lane of lanesArg()) {
		const { units, helpers } = unitsOf(lane)
		const all = [...units.values()]
		const un = all.filter((u) => !u.indexed)
		const files = all.reduce((a, u) => a + u.files.length, 0)
		const lines = all.reduce((a, u) => a + u.lines, 0)
		const tok = un.reduce((a, u) => a + unitCost(u), 0)
		const big = un.filter((u) => u.lines > LARGE_UNIT_LINES)
		const sizes = all.map((u) => u.files.length).sort((a, b) => a - b)
		const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0
		console.log(`── ${lane.id} (${lane.name}) ──`)
		console.log(`  ${all.length} units · ${files} files · ${lines} lines · median ${median} files/unit · ${helpers.length} helper file(s) outside units`)
		console.log(`  indexed ${all.length - un.length} · unindexed ${un.length}`)
		console.log(`  full backfill of the unindexed: ~${fmtK(tok)} input tokens across ${un.length} agent run(s) (rough: ${TURN_MULTIPLIER}× source tokens + ${fmtK(AGENT_OVERHEAD)}/agent; the pilot measures the real figure)`)
		if (big.length) console.log(`  ${big.length} unit(s) over ${LARGE_UNIT_LINES} lines (split the unit rule, or index them alone): ${big.slice(0, 6).map((u) => u.unit).join(", ")}${big.length > 6 ? " …" : ""}`)
		const c = churn(lane, 90)
		const total = [...c.values()].reduce((a, b) => a + b, 0)
		if (total) {
			const ranked = [...c].filter(([u]) => units.has(u)).sort((a, b) => b[1] - a[1])
			const covering = (pct: number) => {
				let cum = 0
				let tk = 0
				let n = 0
				for (const [u, k] of ranked) {
					cum += k
					tk += units.get(u)!.indexed ? 0 : unitCost(units.get(u)!)
					n++
					if (cum / total >= pct) break
				}
				return `${n} unit(s), ~${fmtK(tk)} tok`
			}
			console.log(`  churn (90d): ${ranked.length} active unit(s). Hot seed covering 50% of recent work: ${covering(0.5)} · 80%: ${covering(0.8)}`)
		} else console.log("  churn (90d): no commits in the window")
		console.log("")
	}
}

// ───────────────────────────────────────────────────────────────────────────
// scan / recover / bulk
// ───────────────────────────────────────────────────────────────────────────

function cmdScan(): void {
	const dry = flag("dry-run")
	for (const lane of lanesArg()) {
		let found: string[]
		if (flag("evidenced-only")) found = coverageGap(lane).map((g) => g.file)
		else {
			// mtime superset: every lane file newer than its unit's index. A checkout
			// or rebase rewrites mtimes without changing a byte, so preview first.
			const { units } = unitsOf(lane)
			found = []
			for (const u of units.values()) {
				if (!u.indexed) continue
				const y = yamlMtime(lane, u.unit)!
				for (const f of u.files) if ((mtimeMs(f) ?? 0) > y) found.push(f)
			}
		}
		const fresh = found.filter((f) => !readDirty(lane).includes(f))
		console.log(`${lane.id}: ${fresh.length} file(s) ${dry ? "would be" : ""} added to .dirty${fresh.length ? ":" : ""}`)
		for (const f of fresh.slice(0, 30)) console.log(`  ${f}`)
		if (fresh.length > 30) console.log(`  … ${fresh.length - 30} more`)
		if (!dry && fresh.length) addDirty(lane, fresh)
	}
	if (dry) console.log("(dry run: nothing written)")
}

function cmdRecover(): void {
	for (const lane of lanesArg()) {
		const files = porcelainFiles().filter((f) => resolveUnit(lane, f) !== null && !isCommentOnlyChange(f))
		console.log(`${lane.id}: ${files.length} uncommitted lane file(s)${flag("dry-run") ? " would be" : ""} re-flagged`)
		if (!flag("dry-run")) addDirty(lane, files)
	}
}

function cmdPromoteBulk(): void {
	for (const lane of lanesArg()) {
		const bulk = readDirty(lane, true)
		if (!bulk.length) continue
		addDirty(lane, bulk)
		writeDirty(lane, [], true)
		console.log(`${lane.id}: promoted ${bulk.length} bulk file(s) into .dirty`)
	}
}

function cmdClearBulk(): void {
	for (const lane of lanesArg()) {
		const bulk = readDirty(lane, true)
		if (!bulk.length) continue
		if (flag("dry-run")) {
			console.log(`${lane.id}: would discard ${bulk.length} bulk file(s) and stamp their indexed units current`)
			continue
		}
		// A mechanical sweep changes nothing the index records: stamp the swept
		// units so the coverage gap reads them current, unless a real flag holds them.
		const held = new Set(dirtyByUnit(lane).byUnit.keys())
		const stamped = new Set<string>()
		for (const f of bulk) {
			const u = resolveUnit(lane, f)
			if (!u || held.has(u) || stamped.has(u)) continue
			const y = join(ROOT, yamlRel(lane, u))
			if (existsSync(y)) {
				const now = new Date()
				utimesSync(y, now, now)
				stamped.add(u)
			}
		}
		writeDirty(lane, [], true)
		console.log(`${lane.id}: discarded ${bulk.length} bulk file(s); stamped ${stamped.size} unit(s) current`)
	}
}

// ───────────────────────────────────────────────────────────────────────────
// prepare — scaffold packets
// ───────────────────────────────────────────────────────────────────────────

function packetDir(lane: CodemapLane): string {
	return join(CODEMAP, lane.id, ".packets")
}
function packetName(unit: string): string {
	return `${unit.replace(/\//g, "__")}.md`
}

function readSchema(lane: CodemapLane): string {
	const p = join(CODEMAP, lane.id, "SCHEMA.md")
	return existsSync(p) ? readFileSync(p, "utf8").trim() : `(no .codemap/${lane.id}/SCHEMA.md; follow the shape of the existing YAML)`
}

function diffFor(files: string[]): { text: string; large: boolean; untracked: string[]; deleted: string[] } {
	const tracked: string[] = []
	const untracked: string[] = []
	const deleted: string[] = []
	for (const f of files) {
		if (!existsSync(join(ROOT, f))) deleted.push(f)
		else if (Bun.spawnSync(["git", "ls-files", "--error-unmatch", f], { cwd: ROOT, stdout: "ignore", stderr: "ignore" }).exitCode === 0) tracked.push(f)
		else untracked.push(f)
	}
	let text = tracked.length ? sh(["git", "diff", "HEAD", "--no-color", "--", ...tracked], { allowFail: true }) : ""
	const lines = text.split("\n")
	const hunks = lines.filter((l) => l.startsWith("@@")).length
	const large = lines.length > DIFF_CAP_LINES || hunks > 10
	if (lines.length > DIFF_CAP_LINES) text = lines.slice(0, DIFF_CAP_LINES).join("\n") + `\n… (${lines.length - DIFF_CAP_LINES} more diff lines cut)`
	return { text, large, untracked, deleted }
}

function buildPacket(lane: CodemapLane, info: UnitInfo | undefined, unit: string, dirtyFiles: string[], mode: "CREATE" | "UPDATE"): string {
	const target = yamlRel(lane, unit)
	const files = info?.files ?? []
	const agent = `${lane.id}-indexer`
	const out: string[] = []
	out.push(`# Codemap packet — ${lane.id}/${unit}  [${mode}]`)
	out.push("")
	out.push(`- Agent: \`${agent}\``)
	out.push(`- Target YAML: \`${target}\` (the ONLY file you write)`)
	out.push(`- Source dir: \`${unitSourcePath(lane, unit)}/\``)
	out.push(`- Entries key: \`${lane.entries_key}\``)
	out.push(`- Dirty files this packet answers: ${dirtyFiles.length ? dirtyFiles.map((f) => `\`${f}\``).join(", ") : "(none: a deliberate seed or a refresh)"}`)
	out.push("")
	out.push("## Hard scope")
	out.push("")
	out.push("- Read ONLY the source files and context files listed below, and the target YAML. No Glob, no exploring, no sibling units.")
	out.push("- Write ONLY the target YAML. Never touch `.dirty`, `_tree.yaml`, another unit's YAML, or any source file.")
	out.push("- If you genuinely need a file not listed, STOP and report the gap; do not read it.")
	out.push(
		mode === "UPDATE"
			? "- UPDATE mode: amend surgically. Preserve accurate prose verbatim. Concluding there is NO drift and writing nothing is a valid, expected result; say so plainly."
			: "- CREATE mode: write the unit's YAML from the source files below.",
	)
	out.push("")
	out.push(`## Source files in this unit (${files.length})`)
	out.push("")
	if (info && info.lines > LARGE_UNIT_LINES)
		out.push(`> LARGE unit (${info.lines} lines). Read signatures and exports first; open bodies only where an entry's behaviour needs it.\n`)
	for (const f of files) {
		let n = 0
		try {
			n = readFileSync(join(ROOT, f), "utf8").split("\n").length
		} catch {
			/* gone */
		}
		out.push(`- \`${f}\` (${n} lines)`)
	}
	if (!files.length) out.push("- (none: every file of this unit is gone; the unit was deleted or moved. Report it; do not invent content.)")
	out.push("")
	const ctx = contextFiles(lane, unit)
	const excerpt = contextExcerpts(lane, unit, files)
	if (ctx.length || excerpt) {
		out.push(`## Context (read-only; shared with other units)`)
		out.push("")
		out.push(
			"Where this unit's declared names and path appear in the lane's context files (routes, errors, wiring), pre-extracted with line numbers. This is how you find the route that serves an entry, even one declared in another group's file. Prefer it to opening a context file; when you must open one, Read only the line range you need (offset/limit), never the whole file.",
		)
		if (excerpt) out.push("", excerpt)
		else out.push("", "(no context file mentions this unit's names: an entry with no route here is not served over this lane's routes; use `~`)")
		if (ctx.length) {
			out.push("", "Context files above this unit (ranged reads allowed):")
			for (const f of ctx) out.push(`- \`${f}\``)
		}
		out.push("")
	}
	if (mode === "UPDATE") {
		const d = diffFor(dirtyFiles)
		out.push("## Source changes (git diff HEAD)")
		out.push("")
		if (!dirtyFiles.length) out.push("(no dirty files: this is a refresh; read the source files to find drift)")
		else if (!d.text.trim() && !d.untracked.length && !d.deleted.length)
			out.push("(empty: the change is already committed; read the dirty files in full to find what drifted)")
		else {
			if (d.large) out.push("> LARGE diff: consider reading the full files instead.\n")
			if (d.text.trim()) out.push("```diff", d.text.trimEnd(), "```")
			if (d.untracked.length) out.push(`\nNew (untracked) files, read them whole: ${d.untracked.map((f) => `\`${f}\``).join(", ")}`)
			if (d.deleted.length) out.push(`\nDeleted files, drop what only they provided: ${d.deleted.map((f) => `\`${f}\``).join(", ")}`)
		}
		out.push("")
		out.push("## Existing YAML")
		out.push("")
		out.push("```yaml", readFileSync(join(ROOT, target), "utf8").trimEnd(), "```")
		out.push("")
	}
	out.push(`## Lane schema (.codemap/${lane.id}/SCHEMA.md)`)
	out.push("")
	out.push(readSchema(lane))
	out.push("")
	out.push("## Your task")
	out.push("")
	out.push(`1. ${mode === "UPDATE" ? "Read the diff; escalate to full-file reads only when the diff is empty, LARGE, adds a new entry, or names untracked files." : "Read the source files."}`)
	out.push(`2. ${mode === "UPDATE" ? "Amend" : "Write"} \`${target}\` to the lane schema. \`unit: ${unit}\` and \`path: ${unitSourcePath(lane, unit)}\` are fixed.`)
	out.push("3. Report in under 150 words: added, changed, removed, or `NO DRIFT`.")
	return out.join("\n") + "\n"
}

function cmdPrepare(): void {
	const lanes = lanesArg()
	const explicit = opt("units")?.split(",").filter(Boolean) ?? []
	const seedN = opt("unindexed") ? Number(opt("unindexed")) : flag("top") ? Number(opt("top")) : 0
	const prepared: { lane: string; unit: string; mode: string; packet: string }[] = []
	const skipped: string[] = []
	const found = new Set<string>()
	for (const lane of lanes) {
		const { units } = unitsOf(lane)
		const jobs = new Map<string, { files: string[]; mode: "CREATE" | "UPDATE" }>()
		const has = (u: string) => existsSync(join(ROOT, yamlRel(lane, u)))
		for (const [u, fs] of dirtyByUnit(lane).byUnit) {
			if (has(u)) jobs.set(u, { files: fs, mode: "UPDATE" })
			else if (POL.unindexed_dirty === "create" || explicit.includes(u)) jobs.set(u, { files: fs, mode: "CREATE" })
			else skipped.push(`${lane.id}/${u}`)
		}
		for (const raw of explicit) {
			const u = raw.includes(":") ? raw.split(":")[1] : raw
			if (raw.includes(":") && raw.split(":")[0] !== lane.id) continue
			if (!units.has(u) && !has(u)) continue
			found.add(raw)
			if (!jobs.has(u)) jobs.set(u, { files: [], mode: has(u) ? "UPDATE" : "CREATE" })
		}
		if (seedN > 0) {
			// Seed the N hottest unindexed units by 90-day churn.
			const c = churn(lane, 90)
			const hot = [...units.values()]
				.filter((u) => !u.indexed && !jobs.has(u.unit))
				.sort((a, b) => (c.get(b.unit) ?? 0) - (c.get(a.unit) ?? 0) || b.lines - a.lines)
				.slice(0, seedN)
			for (const u of hot) jobs.set(u.unit, { files: [], mode: "CREATE" })
		}
		if (!jobs.size) continue
		mkdirSync(packetDir(lane), { recursive: true })
		for (const [u, j] of jobs) {
			const p = join(packetDir(lane), packetName(u))
			writeFileSync(p, buildPacket(lane, units.get(u), u, j.files, j.mode))
			prepared.push({ lane: lane.id, unit: u, mode: j.mode, packet: p.slice(ROOT.length + 1) })
		}
	}
	for (const raw of explicit) if (!found.has(raw)) console.error(`No unit "${raw}" in ${lanes.map((l) => l.id).join(" or ")} (see \`${R} units\`; prefix a lane as lane:unit)`)
	if (skipped.length)
		console.log(`Skipped ${skipped.length} touched-but-unindexed unit(s) (policy: skip): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? " …" : ""}\n  Seed one deliberately with --units <id>.\n`)
	if (!prepared.length) {
		console.log("Nothing to prepare.")
		return
	}
	console.log(`Prepared ${prepared.length} packet(s); spawn one agent per packet, at most ${POL.max_parallel} at a time:`)
	for (const p of prepared) console.log(`  [${p.mode}] ${p.lane}-indexer  ←  ${p.packet}`)
}

function cmdClearPackets(): void {
	for (const lane of cfg.codemap) rmSync(packetDir(lane), { recursive: true, force: true })
	console.log("Packets cleared (.dirty untouched).")
}

// ───────────────────────────────────────────────────────────────────────────
// finalize / mark-verified
// ───────────────────────────────────────────────────────────────────────────

/** Dirty files named in a unit's packet, with the packet's write time. */
function packetFor(lane: CodemapLane, unit: string): { files: string[]; at: number } | null {
	const p = join(packetDir(lane), packetName(unit))
	if (!existsSync(p)) return null
	const m = /^- Dirty files this packet answers: (.*)$/m.exec(readFileSync(p, "utf8"))
	const files = m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : []
	return { files, at: statSync(p).mtimeMs }
}

/**
 * Clears a dirty line once the unit's YAML is newer than the file. A file
 * edited again after its index was written stays dirty. A deleted file clears
 * when its unit's YAML was written after the packet that named it.
 */
function cmdFinalize(): void {
	for (const lane of cfg.codemap) {
		const dirty = readDirty(lane)
		if (!dirty.length) continue
		const keep: string[] = []
		for (const f of dirty) {
			const u = resolveUnit(lane, f)
			const y = u ? yamlMtime(lane, u) : null
			if (u === null || y === null) {
				keep.push(f)
				continue
			}
			const m = mtimeMs(f)
			if (m !== null) {
				if (m >= y) keep.push(f)
				continue
			}
			const pk = packetFor(lane, u)
			if (!(pk && pk.files.includes(f) && y > pk.at)) keep.push(f)
		}
		writeDirty(lane, keep)
		console.log(`${lane.id}: cleared ${dirty.length - keep.length}, ${keep.length} still dirty`)
	}
}

/** An indexer reconciled the unit and found NO drift: stamp its YAML and clear its lines. */
function cmdMarkVerified(): void {
	if (!positionals.length) die(`Usage: ${R} mark-verified <lane>/<unit> ...`)
	for (const arg of positionals) {
		const [laneId, ...u] = arg.split("/")
		const lane = laneById(cfg, laneId)
		const unit = u.join("/")
		if (!lane || !unit) die(`"${arg}": expected <lane>/<unit>`)
		const y = join(ROOT, yamlRel(lane!, unit))
		if (!existsSync(y)) die(`${arg}: no index file; a unit with no YAML cannot be verified, only created`)
		const now = new Date()
		utimesSync(y, now, now)
		const keep = readDirty(lane!).filter((f) => resolveUnit(lane!, f) !== unit)
		writeDirty(lane!, keep)
		console.log(`${arg}: verified current`)
	}
}

// ───────────────────────────────────────────────────────────────────────────
// verify / validate
// ───────────────────────────────────────────────────────────────────────────

function cmdVerify(): void {
	let bad = 0
	for (const lane of lanesArg()) {
		const yamls = laneYamlUnits(lane)
		let shapeBad = 0
		for (const u of yamls) {
			const fs = validateUnitYaml(lane, yamlRel(lane, u))
			for (const f of fs) console.log(`✗ ${f.file}: ${f.message}`)
			if (fs.length) shapeBad++
		}
		const tree = treeUnits(lane)
		const treeFile = join(CODEMAP, lane.id, "_tree.yaml")
		const problems: string[] = []
		if (!tree) problems.push(`${treeFile.slice(ROOT.length + 1)} is missing or does not parse`)
		else {
			for (const u of yamls) if (!tree.has(u)) problems.push(`${lane.id}/${u}: index file not in _tree.yaml (unreachable from the tree; adopt it)`)
			for (const u of tree) if (!yamls.includes(u)) problems.push(`${lane.id}/${u}: _tree.yaml lists it but no index file exists`)
		}
		for (const u of orphanYamls(lane)) problems.push(`${lane.id}/${u}: orphan; no source file resolves to this unit any more`)
		for (const p of problems) console.log(`✗ ${p}`)
		const ok = yamls.length - shapeBad
		console.log(`${lane.id}: ${ok}/${yamls.length} index file(s) valid · ${problems.length ? `${problems.length} reachability problem(s)` : "tree and source reachability clean"}`)
		bad += shapeBad + problems.length
	}
	if (bad) process.exitCode = 1
}

function cmdValidate(): void {
	let bad = 0
	for (const p of positionals) {
		const rel = p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p
		const lane = cfg.codemap.find((l) => rel.startsWith(`.codemap/${l.id}/`))
		if (!lane || rel.endsWith("_tree.yaml")) {
			try {
				Bun.YAML.parse(readFileSync(join(ROOT, rel), "utf8"))
			} catch (e) {
				console.log(`✗ ${rel}: YAML does not parse: ${String(e).split("\n")[0]}`)
				bad++
			}
			continue
		}
		for (const f of validateUnitYaml(lane, rel)) {
			console.log(`✗ ${f.file}: ${f.message}`)
			bad++
		}
	}
	if (bad) process.exitCode = 1
}

// ───────────────────────────────────────────────────────────────────────────
// hooks — advisory, silent, never block (except a bad index write, exit 2)
// ───────────────────────────────────────────────────────────────────────────

function flagFiles(paths: string[]): void {
	for (const rel of paths) {
		const lane = laneOf(cfg, rel)
		if (!lane) continue
		if (isCommentOnlyChange(rel)) continue
		addDirty(lane, [rel])
	}
}

const SEEN = join(CODEMAP, ".seen.json")

/**
 * The Bash lane: shell edits (sed, heredocs, codemods) never reach the
 * Write/Edit hook, so ask GIT what changed since the last look. A command that
 * touches more than bulk_threshold lane files is a sweep: bucketed into
 * .dirty.bulk, reported by status, never fanned out.
 */
function hookBash(): void {
	const cur: Record<string, number> = {}
	for (const f of porcelainFiles()) if (laneOf(cfg, f)) cur[f] = mtimeMs(f) ?? -1
	let prev: Record<string, number> | null = null
	try {
		prev = JSON.parse(readFileSync(SEEN, "utf8"))
	} catch {
		/* first run: baseline only */
	}
	writeFileSync(SEEN, JSON.stringify(cur))
	if (!prev) return
	const perLane = new Map<CodemapLane, string[]>()
	for (const [f, m] of Object.entries(cur)) {
		if (prev[f] === m) continue
		const lane = laneOf(cfg, f)!
		if (readDirty(lane).includes(f)) continue
		// Already reconciled: its unit's index was written after this edit.
		const u = resolveUnit(lane, f)
		const y = u ? yamlMtime(lane, u) : null
		if (y !== null && m <= y) continue
		perLane.set(lane, [...(perLane.get(lane) ?? []), f])
	}
	for (const [lane, files] of perLane) {
		const real = files.filter((f) => !isCommentOnlyChange(f))
		if (real.length > POL.bulk_threshold) addDirty(lane, real, true)
		else addDirty(lane, real)
	}
}

/**
 * A payload path made repo-relative. Both sides are realpath'd: a checkout
 * reached through a symlink (macOS /tmp → /private/tmp, a symlinked home)
 * otherwise reads as outside every lane and silently flags nothing.
 */
function repoRelative(abs: string): string | null {
	const real = (p: string): string => {
		try {
			return realpathSync(p)
		} catch {
			return join(real(dirname(p)), basename(p)) // deleted file: resolve its directory
		}
	}
	const root = real(ROOT)
	const file = real(abs)
	return file.startsWith(root + "/") ? file.slice(root.length + 1) : null
}

async function cmdHook(): Promise<void> {
	const kind = positionals[0]
	let payload: { tool_input?: { file_path?: string; path?: string } } = {}
	try {
		payload = JSON.parse(await Bun.stdin.text())
	} catch {
		return
	}
	if (kind === "bash") return hookBash()
	const abs = payload.tool_input?.file_path ?? payload.tool_input?.path
	if (!abs) return
	const rel = repoRelative(abs)
	if (rel === null) return
	if (rel.startsWith(".codemap/") && rel.endsWith(".yaml")) {
		if (!existsSync(join(ROOT, rel))) return
		stripArtifacts(join(ROOT, rel))
		const lane = cfg.codemap.find((l) => rel.startsWith(`.codemap/${l.id}/`))
		if (!lane || rel.endsWith("_tree.yaml")) return
		const findings = validateUnitYaml(lane, rel)
		if (findings.length) {
			console.error(`Codemap index validation failed for ${rel}:\n`)
			for (const f of findings) console.error(`  - ${f.message}`)
			console.error(`\nFix the file you just wrote, then continue. Most common cause: a ": " inside a plain list item\nsplits it into a map. Quote the whole item, or reword with "=" or " — ".`)
			process.exit(2)
		}
		return
	}
	flagFiles([rel])
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

const HELP = `codemap reindex — keep .codemap/<lane>/ true to the code (by Rateb Seirawan's codemap kit)

USAGE
  ${R} <command> [flags]          lanes: ${cfg.codemap.map((l) => l.id).join(", ") || "(none)"}

LOOK
  status [--lane L]              Dirty units, coverage gap, bulk sweeps, orphans, tree adoption
  units [--lane L] [--unindexed] [--json]
                                 Every unit: files, lines, indexed?, rough token cost
  estimate [--lane L]            Totals + backfill cost + hot-seed cost (50% / 80% of recent work)
  hot [--lane L] [--days 90] [--limit 20]
                                 Units ranked by commit churn, cumulative coverage
  verify [--lane L]              Shape + required keys + tree + source reachability (exit 1 on any)

FLAG
  scan --evidenced-only          Merge the coverage gap (git-evidenced) into .dirty
  scan [--dry-run]               mtime superset; preview first (a checkout moves mtimes)
  recover [--dry-run]            Re-flag every uncommitted lane file (lost .dirty)
  promote-bulk | clear-bulk [--dry-run]
                                 Settle a sweep the Bash hook bucketed

INDEX (the LLM half runs through the codemap-reindex skill)
  prepare [--lane L]             One packet per dirty unit
          [--units a,b]          …plus these units (CREATE if unindexed), e.g. a pilot
          [--unindexed N]        …plus the N hottest unindexed units (a seed batch)
  mark-verified <lane>/<unit>…   An indexer found NO drift: stamp it current
  finalize                       Clear dirty lines whose unit index is now newer
  clear-packets                  Remove packets, keep .dirty

INTERNAL
  validate <file.yaml>…          Validate index files (the edit hook calls this)
  hook edit|bash                 PostToolUse hook entry (stdin = hook payload)

Nothing here runs an LLM, and nothing indexes on its own.`

rejectUnknownFlags()
switch (cmd) {
	case "status":
		cmdStatus()
		break
	case "units":
		cmdUnits()
		break
	case "estimate":
		cmdEstimate()
		break
	case "hot":
		cmdHot()
		break
	case "scan":
		cmdScan()
		break
	case "recover":
		cmdRecover()
		break
	case "promote-bulk":
		cmdPromoteBulk()
		break
	case "clear-bulk":
		cmdClearBulk()
		break
	case "prepare":
		cmdPrepare()
		break
	case "clear-packets":
		cmdClearPackets()
		break
	case "finalize":
		cmdFinalize()
		break
	case "mark-verified":
		cmdMarkVerified()
		break
	case "verify":
		cmdVerify()
		break
	case "validate":
		cmdValidate()
		break
	case "flag":
		flagFiles(positionals)
		break
	case "hook":
		try {
			await cmdHook()
		} catch {
			/* a hook never fails a tool call over bookkeeping */
		}
		break
	case "help":
		console.log(HELP)
		break
	default:
		console.log(`Unknown command "${cmd}".\n\n${HELP}`)
		process.exitCode = 1
}

