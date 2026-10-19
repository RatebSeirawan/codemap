#!/usr/bin/env bun
/**
 * wiki — the ONE lookup door for agents.
 *
 * Part of the codemap kit by Rateb Seirawan (codemap-setup skill), ported from
 * the wiki of his production ERP. Federates every knowledge substrate behind one ranked
 * search surface:
 *   - prose lanes (docs, specs, plans, skills, CLAUDE.mds, READMEs) through a
 *     SQLite FTS5 index chunked at HEADING level, so a hit is a section, not a file
 *   - codemap lanes (.codemap/<lane>/**.yaml), the agent-written page index of
 *     the code: units → entries, navigated as a tree, searched by rarity-weighted
 *     field match
 *
 * Doctrine: this answers "WHERE do I read", never "what is true". Every hit
 * ends in a Read pointer; the source stays canonical.
 *
 * The prose index is LAZY and self-refreshing: every command stats the corpus
 * and re-chunks only changed files. No hooks, no LLM. The codemap lanes are the
 * opposite: written by indexer agents, kept current by reindex.ts.
 *
 * Exit codes: 0 = results delivered · 1 = usage/internal error · 2 = valid query, no results.
 * Lanes, weights, aliases: .codemap/config.json.
 */

import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import {
	CODEMAP,
	type CodemapLane,
	type Config,
	laneById,
	laneYamlUnits,
	loadConfig,
	ROOT,
	ROOT_UNIT,
	sh,
	staleUnits,
	unitSourcePath,
	yamlRel,
} from "./lib/core"
import { entryLine } from "./lib/validate"

const DB_PATH = join(CODEMAP, "wiki.sqlite")
/** Bump when the table shape or chunking rules change; forces a clean rebuild. */
const SCHEMA_VERSION = 1

const cfg: Config = loadConfig()
const LANES = cfg.prose.map((l) => ({ lane: l.lane, weight: l.weight ?? 1, globs: l.globs }))
const LANE_ORDER = LANES.map((l) => l.lane)
const EXCLUDE = new RegExp(cfg.prose_exclude || "node_modules|/dist/|/build/|/vendor/|/\\.next/|/target/|^\\.codemap/")
const UNINDEXED = cfg.unindexed_docs ? new RegExp(cfg.unindexed_docs) : null
const CODE_LANES = cfg.codemap.map((l) => l.id)

// ───────────────────────────────────────────────────────────────────────────
// Corpus
// ───────────────────────────────────────────────────────────────────────────

function scanCorpus(): Map<string, { lane: string; mtime: number; size: number }> {
	const seen = new Map<string, { lane: string; mtime: number; size: number }>()
	for (const { lane, globs } of LANES) {
		for (const pattern of globs) {
			const glob = new Bun.Glob(pattern)
			for (const rel of glob.scanSync({ cwd: ROOT, dot: pattern.startsWith(".") })) {
				if (EXCLUDE.test(rel) || seen.has(rel)) continue
				try {
					const st = statSync(join(ROOT, rel))
					if (st.isFile()) seen.set(rel, { lane, mtime: Math.floor(st.mtimeMs), size: st.size })
				} catch {
					/* raced deletion */
				}
			}
		}
	}
	return seen
}

/** Tracked .md files that no lane claims and `unindexed_docs` does not excuse. */
function unclaimedDocs(indexed: Set<string>): string[] {
	return sh(["git", "ls-files", "*.md"], { allowFail: true })
		.split("\n")
		.filter((p) => p && !indexed.has(p) && !EXCLUDE.test(p) && !(UNINDEXED && UNINDEXED.test(p)))
}

// ───────────────────────────────────────────────────────────────────────────
// Chunking — heading-level sections, fence-aware
// ───────────────────────────────────────────────────────────────────────────

interface Chunk {
	heading: string
	lineStart: number
	lineEnd: number
	body: string
}

/**
 * Splits at every #, ##, ### heading (#### stays inside its parent). Headings
 * inside code fences are not boundaries (fence char + length tracked). A
 * heading with an empty body is still a chunk, so a parent heading stays
 * findable. YAML frontmatter contributes `description` + `keywords`.
 */
function parseDoc(relPath: string, raw: string) {
	const lines = raw.split("\n")
	const lastLine = raw.endsWith("\n") ? lines.length - 1 : lines.length
	const base = relPath.replace(/\.md$/, "").split("/").pop() ?? relPath
	let title = base
	let description = ""
	let keywords = ""
	let start = 0

	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
		if (close > 0) {
			try {
				const fm = Bun.YAML.parse(lines.slice(1, close).join("\n")) as Record<string, unknown>
				if (typeof fm?.description === "string") description = fm.description
				if (Array.isArray(fm?.keywords)) keywords = fm.keywords.join(" ")
				else if (typeof fm?.keywords === "string") keywords = fm.keywords
				if (typeof fm?.title === "string") title = fm.title
				else if (typeof fm?.name === "string") title = fm.name
			} catch {
				/* malformed frontmatter: index the body anyway */
			}
			start = close + 1
		}
	}

	const chunks: Chunk[] = []
	let current: Chunk = { heading: "(intro)", lineStart: start + 1, lineEnd: start + 1, body: "" }
	let fence: string | null = null
	for (let i = start; i < lines.length; i++) {
		const line = lines[i]
		const f = /^\s*(`{3,}|~{3,})/.exec(line)
		if (f) {
			if (!fence) fence = f[1]
			else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
		}
		const h = !fence && /^(#{1,3})\s+(.+)/.exec(line)
		if (h) {
			if (current.body.trim() || current.heading !== "(intro)") {
				current.lineEnd = i
				chunks.push(current)
			}
			if (h[1] === "#" && title === base) title = h[2].trim()
			current = { heading: h[2].trim(), lineStart: i + 1, lineEnd: i + 1, body: "" }
		} else current.body += line + "\n"
	}
	if (current.body.trim() || current.heading !== "(intro)" || chunks.length === 0) {
		current.lineEnd = lastLine
		chunks.push(current)
	}
	if (!description) {
		const firstBody = chunks.find((c) => c.body.trim())
		description = (firstBody?.body.trim().split("\n\n")[0]?.replace(/\s+/g, " ") ?? "").slice(0, 160)
	}
	return { title, description, keywords, chunks }
}

// ───────────────────────────────────────────────────────────────────────────
// Index — lazy, incremental, transactional
// ───────────────────────────────────────────────────────────────────────────

const isCorruptError = (e: unknown) => /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(String(e))

function openDb(): Database {
	mkdirSync(CODEMAP, { recursive: true })
	try {
		return openDbInner()
	} catch (e) {
		if (!isCorruptError(e)) throw e
		console.error("wiki: index was corrupt; discarding and rebuilding")
		for (const s of ["", "-wal", "-shm"]) rmSync(DB_PATH + s, { force: true })
		return openDbInner()
	}
}

function openDbInner(): Database {
	const db = new Database(DB_PATH)
	// FIRST: without a busy timeout a parallel session's query crashes with
	// SQLITE_BUSY instead of waiting while another refreshes.
	db.run("PRAGMA busy_timeout = 5000")
	db.run("PRAGMA journal_mode = WAL")
	const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
	if (v !== SCHEMA_VERSION) {
		db.run("DROP TABLE IF EXISTS files")
		db.run("DROP TABLE IF EXISTS chunks")
		db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
	}
	db.run(`CREATE TABLE IF NOT EXISTS files (
		path TEXT PRIMARY KEY, lane TEXT, mtime INTEGER, size INTEGER, title TEXT, description TEXT
	)`)
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
		path UNINDEXED, lane UNINDEXED, title, heading, keywords, description, body,
		line_start UNINDEXED, line_end UNINDEXED,
		tokenize = 'porter unicode61'
	)`)
	return db
}

function ensureIndex(db: Database, opts: { full?: boolean } = {}) {
	const corpus = scanCorpus()
	const known = new Map<string, { mtime: number; size: number; lane: string }>()
	if (!opts.full)
		for (const row of db.query("SELECT path, mtime, size, lane FROM files").all() as { path: string; mtime: number; size: number; lane: string }[])
			known.set(row.path, row)
	const stale: string[] = []
	for (const [path, meta] of corpus) {
		const k = known.get(path)
		if (!k || k.mtime !== meta.mtime || k.size !== meta.size || k.lane !== meta.lane) stale.push(path)
	}
	const removed = [...known.keys()].filter((p) => !corpus.has(p))
	if (stale.length === 0 && removed.length === 0 && !opts.full) return { indexed: 0, removed: 0 }

	const delChunks = db.prepare("DELETE FROM chunks WHERE path = ?")
	const delFile = db.prepare("DELETE FROM files WHERE path = ?")
	const insFile = db.prepare("INSERT OR REPLACE INTO files (path, lane, mtime, size, title, description) VALUES (?, ?, ?, ?, ?, ?)")
	const insChunk = db.prepare(
		"INSERT INTO chunks (path, lane, title, heading, keywords, description, body, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
	db.run("BEGIN")
	try {
		// Full-rebuild deletes live INSIDE the transaction: WAL readers keep the
		// old index until COMMIT, and a crashed rebuild rolls back.
		if (opts.full) {
			db.run("DELETE FROM files")
			db.run("DELETE FROM chunks")
		}
		for (const path of removed) {
			delChunks.run(path)
			delFile.run(path)
		}
		for (const path of stale) {
			const meta = corpus.get(path)!
			let raw: string
			try {
				raw = readFileSync(join(ROOT, path), "utf8")
			} catch {
				continue
			}
			const doc = parseDoc(path, raw)
			delChunks.run(path)
			insFile.run(path, meta.lane, meta.mtime, meta.size, doc.title, doc.description)
			doc.chunks.forEach((c, i) =>
				insChunk.run(path, meta.lane, doc.title, c.heading, doc.keywords, i === 0 ? doc.description : "", c.body.slice(0, 8000), c.lineStart, c.lineEnd),
			)
		}
		db.run("COMMIT")
	} catch (e) {
		try {
			db.run("ROLLBACK")
		} catch {
			/* BEGIN itself may have lost the race */
		}
		throw e
	}
	return { indexed: stale.length, removed: removed.length }
}

/** Best-effort refresh: losing the write lock to a parallel session is not an error. */
function refreshIndex(db: Database, opts: { full?: boolean } = {}) {
	try {
		return ensureIndex(db, opts)
	} catch (e) {
		if (/SQLITE_BUSY|database is locked/i.test(String(e))) {
			console.error("wiki: another process is refreshing the index; serving the current one")
			return { indexed: 0, removed: 0 }
		}
		throw e
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Query building — tokenize, alias-expand, de-stopword
// ───────────────────────────────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = Object.fromEntries(
	Object.entries(cfg.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v.map((x) => x.toLowerCase())]),
)
/** Reverse direction: a two-word expansion also matches its abbreviation. */
const BIGRAM_ALIASES: Record<string, string> = {}
for (const [abbr, exps] of Object.entries(ALIASES)) for (const e of exps) if (e.split(" ").length === 2) BIGRAM_ALIASES[e] = abbr

// Function words only. NO spatial particles (off, over, up, down…): they form
// compounds ("write off", "down payment") and are matched exact instead.
const STOPWORDS = new Set(
	`a an the is are was were be been being do does did done how what when
	 where which who whom why i we you it its if but not no this that these
	 those with for from by at as on in of to and or can could should would
	 will shall may might must have has had having get gets got need needs
	 there their then than them they our your my me us about into
	 again also just only very too all any each more most
	 some such own same other another between during because while`.split(/\s+/),
)
const NO_PREFIX = new Set(["off", "over", "under", "above", "below", "before", "after", "down", "up", "out"])

/** Unicode-aware: non-Latin scripts survive; `-`/`_` stay inside a token. */
function tokenize(terms: string[]): string[] {
	return [...terms.join(" ").toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)].map((m) => m[0]).filter((t) => /[\p{L}\p{N}]/u.test(t))
}

function buildQuery(terms: string[]): { groups: string[]; contentTokens: string[] } {
	const tokens = tokenize(terms)
	const groups: string[] = []
	const contentTokens: string[] = []
	const star = (t: string) => (t.length >= 3 && !NO_PREFIX.has(t) ? `"${t}"*` : `"${t}"`)
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		const bigram = i + 1 < tokens.length ? `${t} ${tokens[i + 1]}` : ""
		if (bigram && BIGRAM_ALIASES[bigram]) {
			groups.push(`("${bigram}" OR "${BIGRAM_ALIASES[bigram]}")`)
			contentTokens.push(t, tokens[i + 1])
			i++
			continue
		}
		if (ALIASES[t]) {
			// Alias keys match EXACT, never prefixed: a short key starred matches half the corpus.
			groups.push(`("${t}" OR ${ALIASES[t].map((a) => `"${a}"`).join(" OR ")})`)
			contentTokens.push(t)
			continue
		}
		if (STOPWORDS.has(t)) continue
		groups.push(star(t))
		contentTokens.push(t)
	}
	if (groups.length === 0 && tokens.length > 0) {
		for (const t of tokens) groups.push(`"${t}"`)
		contentTokens.push(...tokens)
	}
	return { groups, contentTokens }
}

// ───────────────────────────────────────────────────────────────────────────
// Prose search
// ───────────────────────────────────────────────────────────────────────────

interface Hit {
	path: string
	lane: string
	title: string
	heading: string
	line_start: number
	line_end: number
	excerpt: string
	score: number
	mtime: number
}

function searchProse(db: Database, groups: string[], lanes: string[] | null, limit: number): Hit[] {
	const laneWeight = Object.fromEntries(LANES.map((l) => [l.lane, l.weight]))
	const run = (match: string): Hit[] => {
		if (!match) return []
		const laneFilter = lanes ? `AND chunks.lane IN (${lanes.map(() => "?").join(",")})` : ""
		try {
			return db
				.query(
					`SELECT chunks.path, chunks.lane, chunks.title, chunks.heading,
					        chunks.line_start, chunks.line_end, files.mtime,
					        bm25(chunks, 0, 0, 5.0, 4.0, 8.0, 6.0, 1.0, 0, 0) AS score,
					        snippet(chunks, 6, '', '', ' … ', 24) AS excerpt
					 FROM chunks JOIN files ON files.path = chunks.path
					 WHERE chunks MATCH ? ${laneFilter}
					 ORDER BY score LIMIT ?`,
				)
				.all(match, ...(lanes ?? []), limit * 3) as unknown as Hit[]
		} catch (e) {
			// Only an FTS parse problem is "no match"; a locked database must never masquerade as one.
			if (/syntax error|unterminated string|malformed MATCH|fts5/i.test(String(e))) return []
			throw e
		}
	}
	const weigh = (rs: Hit[]) => {
		for (const r of rs) r.score = r.score * (laneWeight[r.lane] ?? 1)
		return rs.sort((a, b) => a.score - b.score) // bm25: more negative = better
	}
	const andRows = weigh(run(groups.join(" AND ")))
	// The OR fallback fires on THIN results too, but AND hits stay pinned above it.
	let orRows: Hit[] = []
	if (andRows.length < Math.min(3, limit) && groups.length > 1) {
		const seen = new Set(andRows.map((r) => `${r.path}:${r.line_start}`))
		orRows = weigh(run(groups.join(" OR ")).filter((r) => !seen.has(`${r.path}:${r.line_start}`)))
	}
	return collapseByFile([...andRows, ...orRows], limit)
}

/** At most 3 sections of one file per page; the rest backfill only when fewer files match. */
function collapseByFile(ranked: Hit[], limit: number): Hit[] {
	const kept: Hit[] = []
	const spill: Hit[] = []
	const perFile = new Map<string, number>()
	for (const h of ranked) {
		const n = perFile.get(h.path) ?? 0
		;(n < 3 ? kept : spill).push(h)
		perFile.set(h.path, n + 1)
	}
	return [...kept, ...spill].slice(0, limit)
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function printHits(hits: Hit[]): void {
	for (const h of hits) {
		const anchor = h.heading === "(intro)" ? "" : ` § ${h.heading}`
		console.log(`[${h.lane}] ${h.path}${anchor}  (L${h.line_start}–${h.line_end}, ${fmtDate(h.mtime)})`)
		const ex = h.excerpt.replace(/\s+/g, " ").trim()
		if (ex) console.log(`    ${ex.slice(0, 220)}`)
		console.log(`    → Read ${h.path}:${h.line_start}-${h.line_end}`)
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Codemap lanes — load, search, navigate
// ───────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
interface LoadedUnit {
	lane: CodemapLane
	unit: string
	yaml: string
	raw: string
	doc: Obj
}

function loadLane(lane: CodemapLane): { units: LoadedUnit[]; broken: string[] } {
	const units: LoadedUnit[] = []
	const broken: string[] = []
	for (const unit of laneYamlUnits(lane)) {
		const yaml = yamlRel(lane, unit)
		try {
			const raw = readFileSync(join(ROOT, yaml), "utf8")
			const doc = Bun.YAML.parse(raw)
			if (doc && typeof doc === "object" && !Array.isArray(doc)) units.push({ lane, unit, yaml, raw, doc: doc as Obj })
			else broken.push(yaml)
		} catch {
			broken.push(yaml)
		}
	}
	return { units, broken }
}

/** camelCase, snake_case, kebab-case, paths and punctuation all split into lowercase words. */
function words(s: string): string[] {
	return s
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
}

function wordMatches(tok: string, w: string): boolean {
	if (w.startsWith(tok)) return true
	// plural / light inflection: "invoices" finds "invoice"
	return tok.length >= 4 && tok.startsWith(w) && w.length >= tok.length - 2
}

interface Field {
	text: string
	weight: number
}
interface Candidate {
	u: LoadedUnit
	entry: Obj | null
	fields: Field[]
}

function scalarFields(o: Obj, skip: Set<string>, depth = 0): Field[] {
	const out: Field[] = []
	for (const [k, v] of Object.entries(o)) {
		if (skip.has(k)) continue
		if (typeof v === "string" || typeof v === "number") {
			const s = String(v)
			out.push({ text: s, weight: s.length <= 120 ? 2 : 1 })
		} else if (Array.isArray(v)) {
			for (const item of v)
				if (typeof item === "string") out.push({ text: item, weight: item.length <= 120 ? 1.5 : 1 })
				else if (item && typeof item === "object" && depth < 2) out.push(...scalarFields(item as Obj, new Set(), depth + 1))
		} else if (v && typeof v === "object" && depth < 2) out.push(...scalarFields(v as Obj, new Set(), depth + 1))
	}
	return out
}

function candidates(units: LoadedUnit[]): Candidate[] {
	const out: Candidate[] = []
	for (const u of units) {
		const key = u.lane.entries_key
		const head: Field[] = [
			{ text: u.unit, weight: 3 },
			{ text: String(u.doc.name ?? ""), weight: 3 },
			{ text: String(u.doc.description ?? ""), weight: 1 },
		]
		out.push({ u, entry: null, fields: [...head, ...scalarFields(u.doc, new Set([key, "unit", "name", "description", "path"]))] })
		const entries = Array.isArray(u.doc[key]) ? (u.doc[key] as unknown[]) : []
		for (const e of entries) {
			if (!e || typeof e !== "object") continue
			const eo = e as Obj
			out.push({
				u,
				entry: eo,
				fields: [
					{ text: u.unit, weight: 1.5 },
					{ text: String(eo.name ?? ""), weight: 4 },
					{ text: String(eo.description ?? ""), weight: 1 },
					...scalarFields(eo, new Set(["name", "description"])),
				],
			})
		}
	}
	return out
}

/** Rarity-weighted field match: a rare term in an entry name outranks a common one in prose. */
function rank(cands: Candidate[], tokens: string[]): { c: Candidate; score: number; matched: number }[] {
	const wordSets = cands.map((c) => c.fields.map((f) => ({ ws: words(f.text), weight: f.weight })))
	const df = tokens.map((t) => wordSets.filter((fs) => fs.some((f) => f.ws.some((w) => wordMatches(t, w)))).length)
	const N = cands.length || 1
	const idf = df.map((d) => Math.log(1 + N / (1 + d)))
	const out: { c: Candidate; score: number; matched: number }[] = []
	cands.forEach((c, i) => {
		let score = 0
		let matched = 0
		tokens.forEach((t, ti) => {
			let best = 0
			for (const f of wordSets[i]) if (f.weight > best && f.ws.some((w) => wordMatches(t, w))) best = f.weight
			if (best > 0) {
				matched++
				score += best * idf[ti]
			}
		})
		if (matched > 0) out.push({ c, score, matched })
	})
	return out
}

function searchCodemap(lanes: CodemapLane[], tokens: string[], limit: number) {
	const loaded = lanes.map(loadLane)
	const units = loaded.flatMap((l) => l.units)
	const broken = loaded.flatMap((l) => l.broken)
	const ranked = rank(candidates(units), tokens)
	const all = ranked.filter((r) => r.matched === tokens.length).sort((a, b) => b.score - a.score)
	let hits = all
	// Thin AND result: partial matches backfill BELOW the full ones.
	if (all.length < Math.min(3, limit) && tokens.length > 1) {
		const need = Math.ceil(tokens.length / 2)
		hits = [...all, ...ranked.filter((r) => r.matched < tokens.length && r.matched >= need).sort((a, b) => b.matched - a.matched || b.score - a.score)]
	}
	return { hits: hits.slice(0, limit), total: hits.length, broken }
}

function shortFields(o: Obj, skip: string[]): string {
	const parts: string[] = []
	for (const [k, v] of Object.entries(o)) {
		if (skip.includes(k)) continue
		if ((typeof v === "string" && v.length <= 80 && !v.includes("\n")) || typeof v === "number" || typeof v === "boolean")
			parts.push(`${k}: ${v}`)
		if (parts.length >= 3) break
	}
	return parts.join(" · ")
}

function printCodeHit(c: Candidate, stale: Map<string, Map<string, number>>): void {
	const { u, entry } = c
	const id = entry ? `${u.lane.id}:${u.unit}  ›  ${String(entry.name)}` : `${u.lane.id}:${u.unit}  [unit]`
	const s = stale.get(u.lane.id)?.get(u.unit)
	console.log(id + (s ? `   ⚠ stale: ${s} file(s) changed since indexed` : ""))
	const o = entry ?? u.doc
	const sf = shortFields(o, ["name", "description", "unit", "path", u.lane.entries_key])
	if (sf) console.log(`    ${sf}`)
	const desc = String(o.description ?? "").replace(/\s+/g, " ").trim()
	if (desc) console.log(`    ${desc.length > 200 ? desc.slice(0, 200) + " …" : desc}`)
	console.log(`    → Read ${u.yaml}:${entryLine(u.raw, entry ? String(entry.name) : null)}   (source: ${unitSourcePath(u.lane, u.unit)}/)`)
}

function staleMap(lanes: CodemapLane[]): Map<string, Map<string, number>> {
	return new Map(lanes.map((l) => [l.id, staleUnits(l)]))
}

// ───────────────────────────────────────────────────────────────────────────
// Commands
// ───────────────────────────────────────────────────────────────────────────

interface Flags {
	lane?: string
	limit?: number
	limitRaw?: string
	json?: boolean
	full?: boolean
}

async function cmdSearch(terms: string[], flags: Flags): Promise<void> {
	const { groups, contentTokens } = buildQuery(terms)
	if (groups.length === 0) {
		console.log("No searchable terms in that query: give me words, not punctuation.")
		process.exitCode = 1
		return
	}
	const wanted = flags.lane ? flags.lane.split(",").filter(Boolean) : null
	const proseLanes = wanted ? wanted.filter((l) => LANE_ORDER.includes(l)) : null
	const codeLanes = cfg.codemap.filter((l) => !wanted || wanted.includes(l.id))
	const wantProse = !wanted || (proseLanes !== null && proseLanes.length > 0)
	const limit = flags.limit ?? 8

	let hits: Hit[] = []
	if (wantProse && LANES.length) {
		const db = openDb()
		refreshIndex(db)
		hits = searchProse(db, groups, proseLanes, limit)
	}
	// Codemap gets the SANITIZED content tokens, alias expansions folded in.
	const codeTokens = contentTokens.filter((t) => !STOPWORDS.has(t))
	const code = codeLanes.length && codeTokens.length ? searchCodemap(codeLanes, codeTokens, 5) : { hits: [], total: 0, broken: [] as string[] }
	for (const b of code.broken) console.error(`wiki: ${b} does not parse; skipped (run: bun .codemap/tool/reindex.ts verify)`)
	const empty = hits.length === 0 && code.hits.length === 0

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					docs: hits,
					code: code.hits.map(({ c, score }) => ({
						lane: c.u.lane.id,
						unit: c.u.unit,
						entry: c.entry ? c.entry.name : null,
						score: Number(score.toFixed(2)),
						read: `${c.u.yaml}:${entryLine(c.u.raw, c.entry ? String(c.entry.name) : null)}`,
						source: unitSourcePath(c.u.lane, c.u.unit),
					})),
				},
				null,
				1,
			),
		)
		if (empty) process.exitCode = 2
		return
	}
	if (hits.length) {
		console.log("── docs ──")
		printHits(hits)
	}
	if (code.hits.length) {
		console.log(`\n── code (.codemap: ${codeLanes.map((l) => l.id).join(", ")}) ──`)
		const stale = staleMap(codeLanes)
		for (const { c } of code.hits) printCodeHit(c, stale)
		if (code.total > code.hits.length)
			console.log(`  … ${code.total - code.hits.length} more (wiki <lane> search ${codeTokens.join(" ")})`)
	}
	if (empty) {
		console.log(`No matches for: ${contentTokens.join(" ")}`)
		console.log("Try fewer or broader terms, a lane (wiki list <lane>), or the code tree (wiki <lane> tree).")
		process.exitCode = 2
	}
}

type FileRow = { path: string; lane: string; title: string; mtime: number; description: string }

function resolveDoc(db: Database, arg: string): FileRow | null {
	const exact = db.query("SELECT * FROM files WHERE path = ?").get(arg) as FileRow | null
	if (exact) return exact
	const slug = arg.replace(/\.md$/, "").toLowerCase()
	if (!slug.replace(/[%_\s]/g, "")) return null
	const like = `%${slug.replace(/[\\%_]/g, (c) => "\\" + c)}%`
	const rows = db.query("SELECT * FROM files WHERE lower(path) LIKE ? ESCAPE '\\'").all(like) as FileRow[]
	if (rows.length === 0) return null
	const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const boundary = new RegExp(`(^|[/_.-])${esc}s?([/_.-]|$)`)
	const variants = slug.endsWith("s") ? [slug, slug.slice(0, -1)] : [slug, `${slug}s`]
	const r = (row: FileRow): number => {
		const p = row.path.toLowerCase()
		for (const v of variants) {
			if (p.endsWith(`/${v}.md`) || p === `${v}.md`) return 0
			if (p.endsWith(`/${v}/skill.md`)) return 0 // every skill is SKILL.md: match its directory
		}
		return boundary.test(p) ? 2 : 3
	}
	rows.sort((a, b) => r(a) - r(b) || LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) || a.path.length - b.path.length)
	return rows[0]
}

function cmdDoc(db: Database, arg: string): void {
	const file = resolveDoc(db, arg)
	if (!file) {
		console.log(`No indexed doc matches "${arg}". Try: wiki search ${arg}`)
		process.exitCode = 1
		return
	}
	console.log(`${file.path}  [${file.lane}]  modified ${fmtDate(file.mtime)}`)
	console.log(`# ${file.title}`)
	if (file.description) console.log(file.description)
	console.log("")
	const chunks = db.query("SELECT heading, line_start, line_end FROM chunks WHERE path = ? ORDER BY line_start").all(file.path) as {
		heading: string
		line_start: number
		line_end: number
	}[]
	for (const c of chunks) console.log(`  L${String(c.line_start).padStart(4)}  ${c.heading}  (${c.line_end - c.line_start + 1} lines)`)
	console.log(`\n→ Read a section: wiki section ${file.path} <heading words>`)
}

function cmdSection(db: Database, pathArg: string, headingWords: string[]): void {
	const file = resolveDoc(db, pathArg)
	if (!file) {
		console.log(`No indexed doc matches "${pathArg}".`)
		process.exitCode = 1
		return
	}
	const chunks = db.query("SELECT heading, line_start, line_end FROM chunks WHERE path = ? ORDER BY line_start").all(file.path) as {
		heading: string
		line_start: number
		line_end: number
	}[]
	const needle = headingWords.join(" ").toLowerCase().trim()
	const chunk = needle
		? (chunks.find((c) => c.heading.toLowerCase() === needle) ?? chunks.find((c) => c.heading.toLowerCase().includes(needle)))
		: undefined
	if (!chunk) {
		console.log(needle ? `No section matching "${needle}" in ${file.path}. Sections:` : `Which section of ${file.path}? Pick one:`)
		for (const c of chunks) console.log(`  ${c.heading}`)
		process.exitCode = 1
		return
	}
	const lines = readFileSync(join(ROOT, file.path), "utf8").split("\n")
	// A section is the heading's SUBTREE, up to the next heading at its level or above.
	const level = (c: { line_start: number }) => /^(#{1,3})\s/.exec(lines[c.line_start - 1] ?? "")?.[1].length ?? 1
	const own = level(chunk)
	const next = chunks.find((c) => c.line_start > chunk.line_start && level(c) <= own)
	const lineEnd = next ? next.line_start - 1 : (chunks.at(-1)?.line_end ?? chunk.line_end)
	const body = lines.slice(chunk.line_start - 1, lineEnd)
	const CAP = 150
	console.log(`${file.path} § ${chunk.heading}  (L${chunk.line_start}–${lineEnd})`)
	console.log(body.slice(0, CAP).join("\n"))
	if (body.length > CAP) console.log(`… truncated (${body.length - CAP} more lines) → Read ${file.path}:${chunk.line_start}-${lineEnd}`)
}

function cmdList(db: Database, laneArg: string | undefined, flags: Flags): void {
	let lane: string | undefined
	if (laneArg !== undefined) {
		lane = LANE_ORDER.includes(laneArg) ? laneArg : laneArg.replace(/s$/, "")
		if (CODE_LANES.includes(laneArg)) {
			cmdTree(laneById(cfg, laneArg)!)
			return
		}
		if (!LANE_ORDER.includes(lane)) {
			console.log(`Unknown lane "${laneArg}". Prose lanes: ${LANE_ORDER.join(", ")} · code lanes: ${CODE_LANES.join(", ")}`)
			process.exitCode = 1
			return
		}
	}
	const rows = (
		lane
			? db.query("SELECT path, lane, title, description, mtime FROM files WHERE lane = ? ORDER BY path").all(lane)
			: db.query("SELECT path, lane, title, description, mtime FROM files ORDER BY lane, path").all()
	) as FileRow[]
	if (flags.json) {
		console.log(JSON.stringify(rows, null, 1))
		return
	}
	for (const r of rows) console.log(`${r.path}  (${fmtDate(r.mtime)})${r.description ? ` — ${r.description.slice(0, 110)}` : ""}`)
	console.log(`\n${rows.length} docs${lane ? ` in lane ${lane}` : ""}`)
}

function cmdStatus(db: Database, delta: { indexed: number; removed: number }): void {
	const rows = db.query("SELECT lane, COUNT(*) n FROM files GROUP BY lane ORDER BY lane").all() as { lane: string; n: number }[]
	const chunkCount = (db.query("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n
	console.log(`wiki index: .codemap/wiki.sqlite (schema v${SCHEMA_VERSION})`)
	for (const r of rows) console.log(`  ${r.lane.padEnd(10)} ${r.n} docs`)
	console.log(`  chunks     ${chunkCount}`)
	console.log(delta.indexed || delta.removed ? `refreshed just now: ${delta.indexed} reindexed, ${delta.removed} removed` : "prose index fresh")
	for (const l of cfg.codemap) {
		const n = laneYamlUnits(l).length
		const stale = staleUnits(l).size
		console.log(`code lane ${l.id}: ${n} unit(s) indexed${stale ? `, ${stale} stale (reindex.ts status)` : ""}`)
	}
	const indexed = new Set((db.query("SELECT path FROM files").all() as { path: string }[]).map((r) => r.path))
	const unclaimed = unclaimedDocs(indexed)
	console.log(
		unclaimed.length
			? `UNCLAIMED: ${unclaimed.length} tracked .md in no prose lane; add a glob to a lane or match it in unindexed_docs (.codemap/config.json):\n${unclaimed
					.slice(0, 40)
					.map((p) => `  ${p}`)
					.join("\n")}${unclaimed.length > 40 ? `\n  … ${unclaimed.length - 40} more` : ""}`
			: "coverage: every tracked .md is in a lane or deliberately unindexed",
	)
}

// ── code lane verbs ───────────────────────────────────────────────────────

interface TreeUnit {
	id: string
	name?: string
	index?: string
}
interface TreeGroup {
	id: string
	name?: string
	description?: string
	units?: TreeUnit[]
}

function readTree(lane: CodemapLane): { name?: string; description?: string; groups: TreeGroup[] } | null {
	try {
		const t = Bun.YAML.parse(readFileSync(join(CODEMAP, lane.id, "_tree.yaml"), "utf8")) as Obj
		return { name: t.name as string, description: t.description as string, groups: (t.groups as TreeGroup[]) ?? [] }
	} catch {
		return null
	}
}

function cmdTree(lane: CodemapLane): void {
	const tree = readTree(lane)
	const onDisk = new Set(laneYamlUnits(lane))
	const stale = staleUnits(lane)
	console.log(`${lane.id} — ${tree?.name ?? lane.name}  (source: ${lane.root})`)
	if (tree?.description) console.log(`  ${tree.description.replace(/\s+/g, " ").trim()}`)
	const listed = new Set<string>()
	for (const g of tree?.groups ?? []) {
		console.log(`\n  ${g.id}${g.name ? ` — ${g.name}` : ""}`)
		if (g.description) console.log(`    ${g.description.replace(/\s+/g, " ").trim().slice(0, 240)}`)
		for (const u of g.units ?? []) {
			listed.add(u.id)
			const mark = !onDisk.has(u.id) ? "  ✗ missing file" : stale.get(u.id) ? `  ⚠ stale (${stale.get(u.id)})` : ""
			console.log(`    · ${u.id}${u.name ? `  ${u.name}` : ""}${mark}`)
		}
	}
	const orphans = [...onDisk].filter((u) => !listed.has(u))
	if (orphans.length) console.log(`\n  not in _tree.yaml (adopt them; reindex.ts verify fails on this): ${orphans.join(", ")}`)
	console.log(`\n→ wiki ${lane.id} unit <id>   ·   wiki ${lane.id} search <words>   ·   wiki ${lane.id} where <field> <value>`)
}

function cmdUnit(lane: CodemapLane, id: string | undefined, entryName: string | undefined): void {
	if (!id) {
		console.log(`Usage: wiki ${lane.id} unit <unit-id> [entry-name]`)
		process.exitCode = 1
		return
	}
	const unit = id.replace(/\.yaml$/, "")
	const yaml = yamlRel(lane, unit)
	let raw: string
	try {
		raw = readFileSync(join(ROOT, yaml), "utf8")
	} catch {
		const near = laneYamlUnits(lane).filter((u) => u.includes(unit)).slice(0, 8)
		console.log(`No index for ${lane.id}:${unit}.${near.length ? ` Did you mean: ${near.join(", ")}` : ""}`)
		process.exitCode = 2
		return
	}
	const s = staleUnits(lane).get(unit)
	if (s) console.log(`⚠ stale: ${s} file(s) in ${unitSourcePath(lane, unit)}/ changed since this was indexed; trust the source.\n`)
	if (!entryName) {
		console.log(`# ${yaml}\n`)
		console.log(raw)
		return
	}
	const doc = Bun.YAML.parse(raw) as Obj
	const entries = (Array.isArray(doc[lane.entries_key]) ? doc[lane.entries_key] : []) as Obj[]
	const e = entries.find((x) => String(x.name) === entryName) ?? entries.find((x) => String(x.name).toLowerCase().includes(entryName.toLowerCase()))
	if (!e) {
		console.log(`No entry "${entryName}" in ${yaml}. Entries: ${entries.map((x) => x.name).join(", ")}`)
		process.exitCode = 2
		return
	}
	console.log(`# ${yaml}:${entryLine(raw, String(e.name))}  (source: ${unitSourcePath(lane, unit)}/)\n`)
	console.log(Bun.YAML.stringify(e, null, 2))
}

/** Entries (and units) where a field whose dotted path ENDS with <field> contains <value>. */
function cmdWhere(lane: CodemapLane, field: string | undefined, value: string | undefined): void {
	if (!field || !value) {
		console.log(`Usage: wiki ${lane.id} where <field> <value>    e.g. wiki ${lane.id} where route /users`)
		process.exitCode = 1
		return
	}
	const needle = value.toLowerCase()
	const { units } = loadLane(lane)
	const stale = staleMap([lane])
	let n = 0
	const walk = (node: unknown, path: string): boolean => {
		if (Array.isArray(node)) return node.some((x) => walk(x, path))
		if (node && typeof node === "object") return Object.entries(node as Obj).some(([k, v]) => walk(v, path ? `${path}.${k}` : k))
		return (path === field || path.endsWith(`.${field}`)) && String(node).toLowerCase().includes(needle)
	}
	for (const u of units) {
		const key = lane.entries_key
		const top = Object.fromEntries(Object.entries(u.doc).filter(([k]) => k !== key))
		if (walk(top, "")) {
			printCodeHit({ u, entry: null, fields: [] }, stale)
			n++
		}
		for (const e of (Array.isArray(u.doc[key]) ? u.doc[key] : []) as Obj[])
			if (walk(e, "")) {
				printCodeHit({ u, entry: e, fields: [] }, stale)
				n++
			}
	}
	if (!n) {
		console.log(`No ${lane.id} entry has a "${field}" containing "${value}".`)
		process.exitCode = 2
	}
}

function cmdLane(lane: CodemapLane, args: string[], flags: Flags): void {
	const [verb, ...rest] = args
	switch (verb ?? "tree") {
		case "tree":
			return cmdTree(lane)
		case "unit":
			return cmdUnit(lane, rest[0], rest[1])
		case "where":
			return cmdWhere(lane, rest[0], rest.slice(1).join(" ") || undefined)
		case "search": {
			const tokens = buildQuery(rest).contentTokens
			if (!tokens.length) {
				console.log(`Usage: wiki ${lane.id} search <words>`)
				process.exitCode = 1
				return
			}
			const r = searchCodemap([lane], tokens, flags.limit ?? 10)
			const stale = staleMap([lane])
			for (const { c } of r.hits) printCodeHit(c, stale)
			if (!r.hits.length) {
				console.log(`No ${lane.id} matches for: ${tokens.join(" ")}`)
				process.exitCode = 2
			} else if (r.total > r.hits.length) console.log(`  … ${r.total - r.hits.length} more (--limit)`)
			return
		}
		default:
			console.log(`Unknown ${lane.id} verb "${verb}". Verbs: tree · unit <id> [entry] · search <words> · where <field> <value>`)
			process.exitCode = 1
	}
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
	const flags: Flags = {}
	const args: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--json") flags.json = true
		else if (a === "--full") flags.full = true
		else if (a === "--lane") flags.lane = argv[++i] ?? ""
		else if (a.startsWith("--lane=")) flags.lane = a.slice(7)
		else if (a === "--limit" || a === "-n") {
			flags.limitRaw = argv[++i] ?? ""
			flags.limit = Number(flags.limitRaw)
		} else if (a.startsWith("--limit=")) {
			flags.limitRaw = a.slice(8)
			flags.limit = Number(flags.limitRaw)
		} else args.push(a)
	}
	return { cmd: args[0] ?? "help", args: args.slice(1), flags }
}

function validateFlags(flags: Flags): string | null {
	if (flags.limit !== undefined && (!Number.isInteger(flags.limit) || flags.limit < 1))
		return `--limit must be a positive integer (got "${flags.limitRaw ?? flags.limit}")`
	if (flags.lane !== undefined) {
		const all = [...LANE_ORDER, ...CODE_LANES]
		const lanes = flags.lane.split(",").filter(Boolean)
		if (!lanes.length) return `--lane needs at least one lane: ${all.join(", ")}`
		for (const l of lanes) if (!all.includes(l)) return `Unknown lane "${l}". Lanes: ${all.join(", ")}`
	}
	return null
}

const W = "bun .codemap/tool/wiki.ts"
const HELP = `${cfg.project} wiki — one lookup door (prose FTS + codemap)

USAGE
  ${W} <command> [args] [flags]

COMMANDS
  search <words...>        Search EVERYTHING: docs (${LANE_ORDER.join(", ") || "none"})
                           + the code index (${CODE_LANES.join(", ") || "none"}).
                           Stemmed, prefix-matched, stopwords stripped, aliases
                           expanded. Every hit ends in a Read pointer.
  doc <path|slug>          Outline of one document: sections + line ranges.
  section <path|slug> <heading words>
                           Print ONE section, subsections included (150-line cap).
  list [lane]              All indexed docs, or one lane (a code lane prints its tree).
  status                   Index freshness, per-lane counts, unclaimed docs.
  reindex [--full]         Force a prose refresh. Normally unnecessary.
${CODE_LANES.map((id) => `  ${id} tree|unit|search|where   The ${laneById(cfg, id)!.name} code index`).join("\n")}

CODE LANE VERBS
  <lane> tree              The table of contents: groups → units, stale marks
  <lane> unit <id> [entry] One unit's index (or one entry of it)
  <lane> search <words>    Ranked entries in that lane only
  <lane> where <field> <value>
                           Entries whose <field> (dotted suffix) contains <value>

FLAGS
  --lane <l1,l2>           Restrict search to lanes: ${[...LANE_ORDER, ...CODE_LANES].join(", ")}
  --limit <n> | -n <n>     Hit cap (default 8)
  --json                   Machine output

EXIT CODES
  0 results delivered · 1 usage/internal error · 2 valid query, no results`

async function run(): Promise<void> {
	const { cmd, args, flags } = parseArgs(process.argv.slice(2))
	const flagError = validateFlags(flags)
	if (flagError) {
		console.log(flagError)
		process.exitCode = 1
		return
	}
	const codeLane = laneById(cfg, cmd)
	if (codeLane) return cmdLane(codeLane, args, flags)
	switch (cmd) {
		case "search":
			if (!args.length) {
				console.log(HELP)
				process.exitCode = 1
				return
			}
			return cmdSearch(args, flags)
		case "doc":
		case "section":
		case "list":
		case "status": {
			const db = openDb()
			const delta = refreshIndex(db)
			if (cmd === "doc") cmdDoc(db, args[0] ?? "")
			else if (cmd === "section") cmdSection(db, args[0] ?? "", args.slice(1))
			else if (cmd === "list") cmdList(db, args[0], flags)
			else cmdStatus(db, delta)
			return
		}
		case "reindex": {
			const db = openDb()
			const t0 = performance.now()
			const d = ensureIndex(db, { full: flags.full })
			console.log(`reindexed ${d.indexed} docs, removed ${d.removed} (${Math.round(performance.now() - t0)}ms)${flags.full ? " [full rebuild]" : ""}`)
			return
		}
		case "help":
			console.log(HELP)
			return
		default:
			console.log(`Unknown command "${cmd}".\n`)
			console.log(HELP)
			process.exitCode = 1
	}
}

try {
	await run()
} catch (e) {
	if (isCorruptError(e)) {
		console.error("wiki: index was corrupt; discarding and retrying once")
		for (const s of ["", "-wal", "-shm"]) rmSync(DB_PATH + s, { force: true })
		await run()
	} else {
		console.error(`wiki: ${e instanceof Error ? e.message : String(e)}`)
		process.exitCode = 1
	}
}
