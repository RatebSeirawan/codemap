/**
 * codemap core — config, globs, unit resolution, git evidence, dirty ledger.
 *
 * Part of the codemap kit by Rateb Seirawan (codemap-setup skill).
 * Shared by wiki.ts (lookup) and reindex.ts (maintenance). Bun only, zero
 * npm dependencies: YAML via Bun.YAML, FTS via bun:sqlite.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * The project root: this file lives at <root>/.codemap/tool/lib/core.ts.
 * CODEMAP_ROOT / CODEMAP_CONFIG let the installer's `preview` run the real
 * resolver against a draft config before anything is installed.
 */
export const ROOT = process.env.CODEMAP_ROOT ? resolve(process.env.CODEMAP_ROOT) : resolve(import.meta.dir, "../../..")
export const CODEMAP = join(ROOT, ".codemap")
export const CONFIG_PATH = process.env.CODEMAP_CONFIG ? resolve(process.env.CODEMAP_CONFIG) : join(CODEMAP, "config.json")

// ───────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────

export interface ProseLane {
	lane: string
	/** Multiplies the bm25 score: >1 boosts, <1 damps (historical logs, plans). */
	weight?: number
	/** Repo-relative globs. First lane to claim a path wins. */
	globs: string[]
}

export type UnitRule =
	| { strategy: "depth"; depth: number }
	| { strategy: "anchor"; anchors: string[]; fallback_depth?: number }

export interface CodemapLane {
	id: string
	name: string
	/** Repo-relative source root ("." for the repo root). */
	root: string
	/** Globs relative to `root`. A glob with no "/" matches the basename anywhere. */
	include: string[]
	exclude?: string[]
	unit: UnitRule
	/** The YAML key holding the unit's list of entries (operations, endpoints, pages, commands…). */
	entries_key: string
	/** Top-level keys every unit YAML must carry. `unit`, `path`, `description` are always required. */
	required?: string[]
	/** Keys every entry must carry. `name` is always required. */
	entry_required?: string[]
	/** Dotted paths whose list items MUST be strings: "tables.writes", "operations[].errors". */
	string_lists?: string[]
	/**
	 * Basename globs for read-only CONTEXT files: any file matching one in an
	 * ANCESTOR directory of a unit (up to the lane root) rides along in that
	 * unit's packet. The generic form of "the domain's routes / errors /
	 * wiring file lives above the unit": e.g. ["*.routes.ts", "urls.py", "mod.rs"].
	 */
	context?: string[]
	/** Stack-specific extraction notes, rendered into this lane's indexer agent. */
	indexer_notes?: string
}

export interface Policy {
	/** A dirty file in a unit with no YAML yet: "create" indexes the unit on first touch, "skip" leaves it for a planned seed. */
	unindexed_dirty: "create" | "skip"
	/** One Bash command touching more files than this in one lane is a sweep: bucketed, never queued. */
	bulk_threshold: number
	/** Indexer agents per fan-out batch. */
	max_parallel: number
}

export interface Config {
	version: 1
	project: string
	prose: ProseLane[]
	/** Regex source; matching paths are never prose-indexed. */
	prose_exclude?: string
	/** Regex source; tracked .md deliberately left out of every prose lane (silences `wiki status`). */
	unindexed_docs?: string
	/** Abbreviation → expansions, measured on this codebase's vocabulary. */
	aliases?: Record<string, string[]>
	codemap: CodemapLane[]
	policy?: Partial<Policy>
}

const RESERVED = new Set(["search", "doc", "section", "list", "status", "reindex", "help", "tree", "unit", "where"])

export function validateConfig(c: unknown): string[] {
	const errs: string[] = []
	const cfg = c as Config
	if (!cfg || typeof cfg !== "object") return ["config is not an object"]
	if (cfg.version !== 1) errs.push(`version must be 1`)
	if (typeof cfg.project !== "string" || !cfg.project) errs.push("project: a short name is required")
	if (!Array.isArray(cfg.prose)) errs.push("prose: must be an array (may be empty)")
	if (!Array.isArray(cfg.codemap)) errs.push("codemap: must be an array (may be empty)")
	const ids = new Set<string>()
	for (const p of cfg.prose ?? []) {
		if (!/^[a-z][a-z0-9-]*$/.test(p.lane ?? "")) errs.push(`prose lane "${p.lane}": id must be kebab-case`)
		if (!Array.isArray(p.globs) || p.globs.length === 0) errs.push(`prose lane "${p.lane}": globs required`)
		if (ids.has(p.lane)) errs.push(`lane id "${p.lane}" used twice`)
		ids.add(p.lane)
	}
	for (const l of cfg.codemap ?? []) {
		const at = `codemap lane "${l.id}"`
		if (!/^[a-z][a-z0-9-]*$/.test(l.id ?? "")) errs.push(`${at}: id must be kebab-case`)
		if (RESERVED.has(l.id)) errs.push(`${at}: "${l.id}" is a wiki verb, pick another id`)
		if (ids.has(l.id)) errs.push(`lane id "${l.id}" used twice`)
		ids.add(l.id)
		if (typeof l.root !== "string") errs.push(`${at}: root required`)
		else if (!existsSync(join(ROOT, l.root))) errs.push(`${at}: root "${l.root}" does not exist`)
		if (!Array.isArray(l.include) || l.include.length === 0) errs.push(`${at}: include globs required`)
		if (!l.entries_key) errs.push(`${at}: entries_key required`)
		const u = l.unit as UnitRule
		if (!u) errs.push(`${at}: unit rule required`)
		else if (u.strategy === "depth") {
			if (!Number.isInteger(u.depth) || u.depth < 1) errs.push(`${at}: unit.depth must be an integer ≥ 1`)
		} else if (u.strategy === "anchor") {
			if (!Array.isArray(u.anchors) || u.anchors.length === 0) errs.push(`${at}: unit.anchors required`)
		} else errs.push(`${at}: unit.strategy must be "depth" or "anchor"`)
	}
	const pol = cfg.policy ?? {}
	if (pol.unindexed_dirty && !["create", "skip"].includes(pol.unindexed_dirty))
		errs.push(`policy.unindexed_dirty must be "create" or "skip"`)
	return errs
}

let cached: Config | null = null
export function loadConfig(): Config {
	if (cached) return cached
	if (!existsSync(CONFIG_PATH)) throw new Error(`No ${CONFIG_PATH}. Run the codemap-setup skill first.`)
	const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config
	const errs = validateConfig(cfg)
	if (errs.length) throw new Error(`Invalid .codemap/config.json:\n  ${errs.join("\n  ")}`)
	cached = cfg
	return cfg
}

export function policy(cfg: Config): Policy {
	return {
		unindexed_dirty: cfg.policy?.unindexed_dirty ?? "skip",
		bulk_threshold: cfg.policy?.bulk_threshold ?? 12,
		max_parallel: cfg.policy?.max_parallel ?? 8,
	}
}

export function laneById(cfg: Config, id: string): CodemapLane | undefined {
	return cfg.codemap.find((l) => l.id === id)
}

// ───────────────────────────────────────────────────────────────────────────
// Globs — **, *, ?, {a,b}
// ───────────────────────────────────────────────────────────────────────────

const globCache = new Map<string, RegExp>()
export function globToRegExp(glob: string): RegExp {
	const hit = globCache.get(glob)
	if (hit) return hit
	let re = ""
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// "**/" matches zero or more directories; a bare "**" matches anything
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?"
					i += 2
				} else {
					re += ".*"
					i += 1
				}
			} else re += "[^/]*"
		} else if (c === "?") re += "[^/]"
		else if (c === "{") {
			const close = glob.indexOf("}", i)
			if (close < 0) re += "\\{"
			else {
				re += `(?:${glob
					.slice(i + 1, close)
					.split(",")
					.map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
					.join("|")})`
				i = close
			}
		} else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&")
	}
	const out = new RegExp(`^${re}$`)
	globCache.set(glob, out)
	return out
}

export function globMatch(glob: string, rel: string): boolean {
	const target = glob.includes("/") ? rel : (rel.split("/").pop() ?? rel)
	return globToRegExp(glob).test(target)
}

// ───────────────────────────────────────────────────────────────────────────
// Lanes and units
// ───────────────────────────────────────────────────────────────────────────

export const ROOT_UNIT = "_root"

/** Path relative to the lane root, or null when the file is outside the lane. */
export function laneRel(lane: CodemapLane, rel: string): string | null {
	const root = lane.root.replace(/^\.\/?/, "").replace(/\/$/, "")
	let inLane: string
	if (!root) inLane = rel
	else if (rel.startsWith(root + "/")) inLane = rel.slice(root.length + 1)
	else return null
	if (!lane.include.some((g) => globMatch(g, inLane))) return null
	if ((lane.exclude ?? []).some((g) => globMatch(g, inLane))) return null
	return inLane
}

export function laneOf(cfg: Config, rel: string): CodemapLane | null {
	for (const l of cfg.codemap) if (laneRel(l, rel) !== null) return l
	return null
}

function laneAbs(lane: CodemapLane, ...segs: string[]): string {
	return join(ROOT, lane.root, ...segs)
}

const anchorCache = new Map<string, boolean>()
function dirHasAnchor(lane: CodemapLane, segs: string[], anchors: string[]): boolean {
	const key = `${lane.id}:${segs.join("/")}`
	const hit = anchorCache.get(key)
	if (hit !== undefined) return hit
	let found = false
	try {
		for (const name of readdirSync(laneAbs(lane, ...segs))) {
			if (anchors.some((a) => globToRegExp(a).test(name))) {
				found = true
				break
			}
		}
	} catch {
		/* directory gone */
	}
	anchorCache.set(key, found)
	return found
}

/**
 * The unit a lane file belongs to: a directory id relative to the lane root,
 * "_root" for the root itself, or null for a helper no unit owns (anchor
 * strategy without a fallback). Works for deleted files too.
 */
export function resolveUnit(lane: CodemapLane, rel: string): string | null {
	const inLane = laneRel(lane, rel)
	if (inLane === null) return null
	const dirs = inLane.split("/").slice(0, -1)
	const byDepth = (d: number) => {
		const n = Math.min(d, dirs.length)
		return n === 0 ? ROOT_UNIT : dirs.slice(0, n).join("/")
	}
	const u = lane.unit
	if (u.strategy === "depth") return byDepth(u.depth)
	for (let n = dirs.length; n >= 0; n--) {
		if (dirHasAnchor(lane, dirs.slice(0, n), u.anchors)) return n === 0 ? ROOT_UNIT : dirs.slice(0, n).join("/")
	}
	return u.fallback_depth ? byDepth(u.fallback_depth) : null
}

/** Context files for a unit: matches of `lane.context` in each ancestor directory, nearest first. */
export function contextFiles(lane: CodemapLane, unit: string): string[] {
	if (!lane.context?.length) return []
	const segs = unit === ROOT_UNIT ? [] : unit.split("/")
	const out: string[] = []
	for (let n = segs.length - 1; n >= 0; n--) {
		const dir = segs.slice(0, n)
		let names: string[] = []
		try {
			names = readdirSync(laneAbs(lane, ...dir)).sort()
		} catch {
			continue
		}
		for (const name of names)
			if (lane.context.some((g) => globToRegExp(g).test(name))) {
				const rel = [lane.root.replace(/^\.\/?/, "").replace(/\/$/, ""), ...dir, name].filter(Boolean).join("/")
				out.push(rel)
			}
	}
	return out
}

/** Every file in the lane's root tree whose basename matches a `context` glob. */
const laneContextCache = new Map<string, string[]>()
function laneContextFiles(lane: CodemapLane): string[] {
	const hit = laneContextCache.get(lane.id)
	if (hit) return hit
	const root = lane.root.replace(/^\.\/?/, "").replace(/\/$/, "")
	const out = repoFiles().filter(
		(f) => (!root || f.startsWith(root + "/")) && (lane.context ?? []).some((g) => globToRegExp(g).test(f.split("/").pop()!)),
	)
	laneContextCache.set(lane.id, out)
	return out
}

/** Router / prefix declarations across stacks (Elysia, Express, Hono, FastAPI, Flask, Spring, NestJS, Rails, Laravel, Go routers). */
const MOUNT =
	/prefix\s*[:=]\s*["'`]|\.group\(\s*["'`]|\.route\(\s*["'`]\/|\.(use|mount)\(\s*["'`]\/|APIRouter\(|Blueprint\(|@RequestMapping|@Controller\(\s*["'`]|\bscope\s+["'`]?\/|\bnamespace\s+:|Route::prefix|\.(Group|PathPrefix)\(\s*["'`]/

/** Names a unit declares: functions, classes, consts, methods. Length ≥ 6 keeps `list`/`get` out. */
export function declaredNames(files: string[]): string[] {
	const names = new Set<string>()
	const decl = /(?:function|class|const|let|var|def|func|fn|interface|type|struct|enum)\s+\*?\s*([A-Za-z_][A-Za-z0-9_]{5,})/g
	const method = /^\s*(?:async\s+|pub\s+|public\s+|static\s+)*([a-z_][A-Za-z0-9_]{5,})\s*[:=]?\s*(?:async\s*)?\(/gm
	for (const f of files) {
		let src = ""
		try {
			src = readFileSync(join(ROOT, f), "utf8")
		} catch {
			continue
		}
		// Imports name OTHER units' symbols; they would point at the wrong code.
		src = src.replace(/^\s*import\s[\s\S]*?from\s+["'][^"']+["'];?/gm, "").replace(/^\s*(from\s+\S+\s+)?import\s.*$/gm, "")
		for (const m of src.matchAll(decl)) names.add(m[1])
		for (const m of src.matchAll(method)) names.add(m[1])
	}
	// Distinctive only: compound identifiers (camelCase, PascalCase with 2+ humps,
	// snake_case). A single plain word ("option", "Static") matches prose and comments.
	return [...names].filter((n) => /[a-z0-9][A-Z]|[A-Za-z]_[A-Za-z]/.test(n))
}

/**
 * Where a unit's declared names appear in the lane's context files (routes,
 * errors, wiring), pre-extracted with line numbers. The deterministic answer
 * to "which route serves this method", even when it is declared in ANOTHER
 * group's routes file. Names found in more than 4 context files are too
 * generic to point anywhere and are dropped.
 */
export function contextExcerpts(lane: CodemapLane, unit: string, files: string[], cap = 160): string {
	const ctx = laneContextFiles(lane)
	if (!ctx.length || !files.length) return ""
	const names = declaredNames(files)
	const unitSeg = unit === ROOT_UNIT ? null : unit.split("/").pop()!
	const texts = new Map<string, string[]>()
	for (const f of ctx) {
		try {
			texts.set(f, readFileSync(join(ROOT, f), "utf8").split("\n"))
		} catch {
			/* gone */
		}
	}
	const wordRe = (n: string) => new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`)
	const useful = names.filter((n) => {
		const re = wordRe(n)
		let k = 0
		for (const lines of texts.values()) if (lines.some((l) => re.test(l)) && ++k > 4) return false
		return k > 0
	})
	const needles = useful.map(wordRe)
	if (unitSeg && unitSeg.length >= 4) needles.push(new RegExp(`["'\`/]${unitSeg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`/]`))
	if (!needles.length) return ""
	const isComment = (l: string) => /^\s*(\/\/|#|\*|\/\*|--)/.test(l)
	const perFile: { f: string; lines: string[]; hits: number[] }[] = []
	for (const [f, lines] of texts) {
		const hits: number[] = []
		lines.forEach((l, i) => {
			if (!isComment(l) && needles.some((re) => re.test(l))) hits.push(i)
		})
		if (hits.length) perFile.push({ f, lines, hits })
	}
	perFile.sort((a, b) => b.hits.length - a.hits.length)
	const out: string[] = []
	let used = 0
	for (const { f, lines, hits } of perFile) {
		const keep = new Set<number>()
		for (const h of hits) for (let d = -1; d <= 1; d++) if (h + d >= 0 && h + d < lines.length) keep.add(h + d)
		// The nearest mount declaration above each hit: a route's full path is
		// its router's prefix + its own path, and routers are often declared
		// mid-file, one per sub-resource.
		const mounts: number[] = []
		lines.forEach((l, i) => {
			if (!isComment(l) && MOUNT.test(l)) mounts.push(i)
		})
		for (const h of hits) {
			const m = mounts.filter((i) => i <= h).at(-1)
			if (m !== undefined) keep.add(m)
		}
		const sorted = [...keep].sort((a, b) => a - b)
		out.push(`\n\`${f}\` (${hits.length} hit${hits.length === 1 ? "" : "s"}):`, "```")
		let prev = -2
		for (const i of sorted) {
			if (used >= cap) break
			if (i !== prev + 1) out.push("…")
			out.push(`${String(i + 1).padStart(5)}  ${lines[i].slice(0, 220)}`)
			prev = i
			used++
		}
		out.push("```")
		if (used >= cap) {
			out.push(`(excerpt capped at ${cap} lines)`)
			break
		}
	}
	return out.length ? `Matched names: ${useful.slice(0, 30).join(", ")}${useful.length > 30 ? " …" : ""}\n${out.join("\n")}` : ""
}

export function yamlRel(lane: CodemapLane, unit: string): string {
	return `.codemap/${lane.id}/${unit}.yaml`
}

export function unitSourcePath(lane: CodemapLane, unit: string): string {
	const root = lane.root.replace(/^\.\/?/, "").replace(/\/$/, "")
	if (unit === ROOT_UNIT) return root || "."
	return root ? `${root}/${unit}` : unit
}

export function unitFromYamlRel(lane: CodemapLane, yrel: string): string | null {
	const prefix = `.codemap/${lane.id}/`
	if (!yrel.startsWith(prefix) || !yrel.endsWith(".yaml")) return null
	const u = yrel.slice(prefix.length, -".yaml".length)
	if (u === "_tree" || u.split("/").some((s) => s.startsWith("."))) return null
	return u
}

/** Every tracked + untracked-not-ignored file in the repo, repo-relative. */
let allFilesCache: string[] | null = null
export function repoFiles(): string[] {
	if (allFilesCache) return allFilesCache
	const out = sh(["git", "ls-files", "-co", "--exclude-standard"])
	allFilesCache = out.split("\n").filter((p) => p && existsSync(join(ROOT, p)))
	return allFilesCache
}

export interface UnitInfo {
	lane: CodemapLane
	unit: string
	files: string[]
	bytes: number
	lines: number
	yaml: string
	indexed: boolean
}

/** All units of a lane, built from the file list. Helpers no unit owns are returned apart. */
export function laneUnits(lane: CodemapLane): { units: Map<string, UnitInfo>; helpers: string[] } {
	const units = new Map<string, UnitInfo>()
	const helpers: string[] = []
	for (const rel of repoFiles()) {
		if (laneRel(lane, rel) === null) continue
		const unit = resolveUnit(lane, rel)
		if (unit === null) {
			helpers.push(rel)
			continue
		}
		let u = units.get(unit)
		if (!u) {
			const yaml = yamlRel(lane, unit)
			u = { lane, unit, files: [], bytes: 0, lines: 0, yaml, indexed: existsSync(join(ROOT, yaml)) }
			units.set(unit, u)
		}
		u.files.push(rel)
		try {
			const buf = readFileSync(join(ROOT, rel))
			u.bytes += buf.length
			let n = 0
			for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
			u.lines += n
		} catch {
			/* raced deletion */
		}
	}
	return { units, helpers }
}

/** Index files on disk for a lane (excluding _tree.yaml), as unit ids. */
export function laneYamlUnits(lane: CodemapLane): string[] {
	const dir = join(CODEMAP, lane.id)
	if (!existsSync(dir)) return []
	const glob = new Bun.Glob("**/*.yaml")
	const out: string[] = []
	for (const rel of glob.scanSync({ cwd: dir })) {
		const u = unitFromYamlRel(lane, `.codemap/${lane.id}/${rel}`)
		if (u) out.push(u)
	}
	return out.sort()
}

// ───────────────────────────────────────────────────────────────────────────
// Git
// ───────────────────────────────────────────────────────────────────────────

export function sh(cmd: string[], opts: { allowFail?: boolean } = {}): string {
	const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
	if (r.exitCode !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().trim()}`)
	return r.stdout.toString()
}

/** Files with uncommitted changes (incl. untracked, not ignored). Deleted files included. */
export function porcelainFiles(): string[] {
	const out = sh(["git", "status", "--porcelain=v1", "-uall", "-z"], { allowFail: true })
	const parts = out.split("\0").filter(Boolean)
	const files: string[] = []
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]
		const code = p.slice(0, 2)
		files.push(p.slice(3))
		if (code[0] === "R" || code[0] === "C") i++ // rename: the next field is the old path
	}
	return files
}

/** Files touched by the last `n` commits. */
export function recentCommitFiles(n = 20): Map<string, string> {
	const out = sh(["git", "log", `-${n}`, "--name-only", "--pretty=format:@@%h"], { allowFail: true })
	const files = new Map<string, string>()
	let commit = ""
	for (const line of out.split("\n")) {
		if (line.startsWith("@@")) commit = line.slice(2)
		else if (line && !files.has(line)) files.set(line, commit)
	}
	return files
}

export function isTracked(rel: string): boolean {
	return Bun.spawnSync(["git", "ls-files", "--error-unmatch", rel], { cwd: ROOT, stdout: "ignore", stderr: "ignore" }).exitCode === 0
}

const COMMENT_PREFIXES: Record<string, string[]> = {
	c: ["//", "/*", "*", "*/"],
	hash: ["#"],
	dash: ["--"],
}
const EXT_STYLE: Record<string, keyof typeof COMMENT_PREFIXES> = {}
for (const e of "ts tsx js jsx mjs cjs go rs java kt kts swift c h cc cpp hpp cs php scala dart groovy zig".split(" ")) EXT_STYLE[e] = "c"
for (const e of "py rb sh bash zsh ex exs pl r yaml yml toml tf nim cr".split(" ")) EXT_STYLE[e] = "hash"
for (const e of "sql lua hs elm".split(" ")) EXT_STYLE[e] = "dash"

/**
 * True when every changed line versus HEAD is blank or a comment. A reworded
 * comment changes nothing the index records, so it never flags. Measured
 * against HEAD on purpose: a file already carrying an unindexed code change
 * stays flagged when a comment is then added. Unknown languages, untracked
 * files and any doubt answer false (flag it).
 */
export function isCommentOnlyChange(rel: string): boolean {
	const ext = rel.split(".").pop()?.toLowerCase() ?? ""
	const style = EXT_STYLE[ext]
	if (!style || !existsSync(join(ROOT, rel)) || !isTracked(rel)) return false
	const diff = sh(["git", "diff", "HEAD", "-U0", "--no-color", "--", rel], { allowFail: true })
	if (!diff.trim()) return true
	const prefixes = COMMENT_PREFIXES[style]
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) continue
		if (!(line.startsWith("+") || line.startsWith("-"))) continue
		const body = line.slice(1).trim()
		if (!body) continue
		if (!prefixes.some((p) => body.startsWith(p))) return false
	}
	return true
}

// ───────────────────────────────────────────────────────────────────────────
// Dirty ledger — .codemap/<lane>/.dirty holds repo-relative file paths
// ───────────────────────────────────────────────────────────────────────────

export function dirtyPath(lane: CodemapLane, bulk = false): string {
	return join(CODEMAP, lane.id, bulk ? ".dirty.bulk" : ".dirty")
}

export function readDirty(lane: CodemapLane, bulk = false): string[] {
	const p = dirtyPath(lane, bulk)
	if (!existsSync(p)) return []
	return [...new Set(readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))]
}

export function writeDirty(lane: CodemapLane, lines: string[], bulk = false): void {
	const p = dirtyPath(lane, bulk)
	const uniq = [...new Set(lines)].sort()
	if (uniq.length === 0) {
		rmSync(p, { force: true })
		return
	}
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, uniq.join("\n") + "\n")
}

export function addDirty(lane: CodemapLane, paths: string[], bulk = false): number {
	const cur = readDirty(lane, bulk)
	const set = new Set(cur)
	let added = 0
	for (const p of paths)
		if (!set.has(p)) {
			set.add(p)
			added++
		}
	if (added) writeDirty(lane, [...set], bulk)
	return added
}

export function mtimeMs(rel: string): number | null {
	try {
		return statSync(join(ROOT, rel)).mtimeMs
	} catch {
		return null
	}
}

/** Units with dirty files, for the stale marker on lookups. */
export function staleUnits(lane: CodemapLane): Map<string, number> {
	const out = new Map<string, number>()
	for (const f of readDirty(lane)) {
		const u = resolveUnit(lane, f)
		if (u) out.set(u, (out.get(u) ?? 0) + 1)
	}
	return out
}
