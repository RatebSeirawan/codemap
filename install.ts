#!/usr/bin/env bun
/**
 * codemap-setup installer — the deterministic half of the codemap-setup skill.
 * Created by Rateb Seirawan.
 *
 *   bun install.ts survey    --project <dir>                    read the stack (no writes)
 *   bun install.ts preview   --project <dir> --config <draft>   the unit partition a draft config yields (no writes)
 *   bun install.ts install   --project <dir> --config <draft> [--local]
 *   bun install.ts uninstall --project <dir> [--purge]
 *
 * `install` copies the tooling into <project>/.codemap/tool, writes the config,
 * renders one indexer agent per code lane and the codemap-reindex skill, wires
 * the PostToolUse hooks, the .gitignore and the CLAUDE.md lookup block, then
 * smoke-tests the wiring. It NEVER indexes: coverage is the user's budget call.
 * Re-running it is safe (every write is idempotent) and is how a config change lands.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const KIT = import.meta.dir
const TEMPLATE = join(KIT, "template")
const KIT_VERSION = "1.0.0"
const MIN_BUN = [1, 2, 21]

const [cmd, ...args] = process.argv.slice(2)
const opt = (n: string) => {
	const i = args.indexOf(`--${n}`)
	return i >= 0 ? args[i + 1] : undefined
}
const has = (n: string) => args.includes(`--${n}`)

function die(msg: string): never {
	console.error(`✗ ${msg}`)
	process.exit(1)
}

function bunOk(): boolean {
	const v = Bun.version.split(".").map(Number)
	for (let i = 0; i < 3; i++) {
		if (v[i] > MIN_BUN[i]) return true
		if (v[i] < MIN_BUN[i]) return false
	}
	return true
}

function projectRoot(): string {
	const p = resolve(opt("project") ?? process.cwd())
	const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: p, stdout: "pipe", stderr: "pipe" })
	if (r.exitCode !== 0) die(`${p} is not inside a git repository. The codemap's change tracking is git evidence; init a repo first.`)
	return r.stdout.toString().trim()
}

function git(root: string, ...a: string[]): string {
	return Bun.spawnSync(["git", ...a], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString()
}

// ───────────────────────────────────────────────────────────────────────────
// survey
// ───────────────────────────────────────────────────────────────────────────

const MANIFESTS = [
	"package.json", "pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json", "deno.json", "bunfig.toml",
	"go.mod", "go.work", "Cargo.toml", "pyproject.toml", "setup.py", "requirements.txt", "Pipfile",
	"pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "Gemfile", "composer.json", "mix.exs",
	"pubspec.yaml", "Package.swift", "CMakeLists.txt", "Makefile", "docker-compose.yml", "manage.py",
]
const FRAMEWORKS = [
	"next", "react", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro", "@remix-run/react", "@angular/core", "solid-js",
	"express", "fastify", "@nestjs/core", "hono", "elysia", "koa", "@trpc/server", "graphql", "@apollo/server",
	"prisma", "@prisma/client", "drizzle-orm", "typeorm", "sequelize", "mongoose", "zod", "react-native", "expo", "electron", "vite",
]
const PY_FRAMEWORKS = ["django", "fastapi", "flask", "sqlalchemy", "pydantic", "celery", "starlette", "litestar"]

function survey(): void {
	const root = projectRoot()
	const files = git(root, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean)
	console.log(`# Survey of ${root}`)
	console.log(`bun ${Bun.version}${bunOk() ? "" : `  ✗ need ≥ ${MIN_BUN.join(".")}`} · ${files.length} files (tracked + untracked, not ignored)`)
	console.log(`commits: ${git(root, "rev-list", "--count", "HEAD").trim() || "0"} · last 90 days: ${git(root, "rev-list", "--count", "--since=90.days", "HEAD").trim() || "0"}`)

	const ext = new Map<string, number>()
	for (const f of files) {
		const base = f.split("/").pop()!
		const e = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "(none)"
		ext.set(e, (ext.get(e) ?? 0) + 1)
	}
	console.log(`\n## Extensions\n${[...ext].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([e, n]) => `${e}:${n}`).join("  ")}`)

	console.log("\n## Manifests (depth ≤ 3)")
	const manifests = files.filter((f) => MANIFESTS.includes(f.split("/").pop()!) && f.split("/").length <= 4 && !f.includes("node_modules"))
	for (const m of manifests.slice(0, 40)) {
		let note = ""
		const abs = join(root, m)
		if (m.endsWith("package.json")) {
			try {
				const pj = JSON.parse(readFileSync(abs, "utf8"))
				const deps = { ...pj.dependencies, ...pj.devDependencies }
				const fw = FRAMEWORKS.filter((f) => f in deps)
				note = [pj.workspaces ? `workspaces=${JSON.stringify(pj.workspaces.packages ?? pj.workspaces)}` : "", fw.length ? `uses ${fw.join(", ")}` : ""].filter(Boolean).join(" · ")
			} catch {
				/* unreadable */
			}
		} else if (/pyproject\.toml|requirements\.txt|Pipfile/.test(m)) {
			const txt = readFileSync(abs, "utf8").toLowerCase()
			const fw = PY_FRAMEWORKS.filter((f) => txt.includes(f))
			if (fw.length) note = `uses ${fw.join(", ")}`
		} else if (m.endsWith("Cargo.toml") && readFileSync(abs, "utf8").includes("[workspace]")) note = "workspace"
		console.log(`  ${m}${note ? `  — ${note}` : ""}`)
	}

	console.log("\n## Directory weight (code files = not .md/.json/.lock/.svg/.png…)")
	const NON_CODE = /\.(md|mdx|json|lock|svg|png|jpe?g|gif|webp|ico|txt|csv|ya?ml|toml|snap|map|woff2?|ttf|pdf)$/i
	const tally = (depth: number) => {
		const m = new Map<string, { all: number; code: number }>()
		for (const f of files) {
			const segs = f.split("/")
			if (segs.length <= depth) continue
			const k = segs.slice(0, depth).join("/")
			const t = m.get(k) ?? { all: 0, code: 0 }
			t.all++
			if (!NON_CODE.test(f)) t.code++
			m.set(k, t)
		}
		return [...m].sort((a, b) => b[1].code - a[1].code)
	}
	for (const [d, t] of tally(1).slice(0, 14)) {
		console.log(`  ${d}/  ${t.code} code / ${t.all} files`)
		for (const [d2, t2] of tally(2).filter(([k]) => k.startsWith(d + "/")).slice(0, 6)) console.log(`      ${d2}/  ${t2.code} code`)
	}

	console.log("\n## Prose")
	const md = files.filter((f) => /\.mdx?$/i.test(f))
	const mdDirs = new Map<string, number>()
	for (const f of md) {
		const k = f.includes("/") ? f.split("/")[0] + "/" : "(root)"
		mdDirs.set(k, (mdDirs.get(k) ?? 0) + 1)
	}
	console.log(`  ${md.length} markdown file(s): ${[...mdDirs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}${n}`).join("  ")}`)
	const claudeMds = md.filter((f) => /(^|\/)CLAUDE\.md$/.test(f))
	console.log(`  CLAUDE.md: ${claudeMds.length ? claudeMds.join(", ") : "none"}`)

	console.log("\n## Claude Code in this project")
	const skills = existsSync(join(root, ".claude/skills")) ? readdirSync(join(root, ".claude/skills")) : []
	const agents = existsSync(join(root, ".claude/agents")) ? readdirSync(join(root, ".claude/agents")) : []
	console.log(`  skills: ${skills.join(", ") || "none"} · agents: ${agents.join(", ") || "none"}`)
	for (const s of [".claude/settings.json", ".claude/settings.local.json"])
		if (existsSync(join(root, s))) {
			try {
				const j = JSON.parse(readFileSync(join(root, s), "utf8"))
				console.log(`  ${s}: hooks on ${Object.keys(j.hooks ?? {}).join(", ") || "nothing"}`)
			} catch {
				console.log(`  ${s}: does not parse as JSON`)
			}
		}
	console.log(`  existing .codemap/: ${existsSync(join(root, ".codemap/config.json")) ? "YES (installed: this is an upgrade/re-design)" : "no"}`)
}

// ───────────────────────────────────────────────────────────────────────────
// preview
// ───────────────────────────────────────────────────────────────────────────

function readDraft(): { path: string; json: Record<string, unknown> } {
	const p = opt("config")
	if (!p) die("--config <draft.json> is required")
	const path = resolve(p)
	if (!existsSync(path)) die(`${path} does not exist`)
	try {
		return { path, json: JSON.parse(readFileSync(path, "utf8")) }
	} catch (e) {
		die(`${path} is not valid JSON: ${String(e)}`)
	}
}

async function validateDraft(root: string, path: string): Promise<void> {
	const r = Bun.spawnSync(
		["bun", "-e", `import { validateConfig } from ${JSON.stringify(join(TEMPLATE, "tool/lib/core.ts"))}; const e = validateConfig(JSON.parse(await Bun.file(${JSON.stringify(path)}).text())); if (e.length) { console.log(e.join("\\n")); process.exit(1) }`],
		{ cwd: root, env: { ...process.env, CODEMAP_ROOT: root, CODEMAP_CONFIG: path }, stdout: "pipe", stderr: "pipe" },
	)
	if (r.exitCode !== 0) die(`config is invalid:\n  ${(r.stdout.toString() + r.stderr.toString()).trim().split("\n").join("\n  ")}`)
}

async function preview(): Promise<void> {
	const root = projectRoot()
	const { path } = readDraft()
	await validateDraft(root, path)
	console.log(`# Unit partition for ${opt("config")}\n`)
	const r = Bun.spawnSync(["bun", join(TEMPLATE, "tool/reindex.ts"), "units"], {
		cwd: root,
		env: { ...process.env, CODEMAP_ROOT: root, CODEMAP_CONFIG: path },
		stdout: "inherit",
		stderr: "inherit",
	})
	if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
	console.log("\nGood units are cohesive (one module, service, package, route group): typically 2–25 files and under ~4k lines.")
	console.log("Hundreds of 1-file units → raise the depth or use anchors. A few giant units → deepen, or anchor on a marker file.")
}

// ───────────────────────────────────────────────────────────────────────────
// install
// ───────────────────────────────────────────────────────────────────────────

interface Lane {
	id: string
	name: string
	root: string
	description?: string
	unit: { strategy: string; depth?: number; anchors?: string[]; fallback_depth?: number }
	entries_key: string
	indexer_notes?: string
}

function block(text: string, begin: string, end: string, body: string): string {
	const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`)
	if (re.test(text)) return text.replace(re, body.endsWith("\n") ? body : body + "\n")
	return (text && !text.endsWith("\n") ? text + "\n" : text) + (text ? "\n" : "") + (body.endsWith("\n") ? body : body + "\n")
}

function writeIfChanged(path: string, content: string): boolean {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return false
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
	return true
}

function unitRuleText(l: Lane): string {
	return l.unit.strategy === "depth"
		? `directory at depth ${l.unit.depth}`
		: `nearest dir holding ${(l.unit.anchors ?? []).map((a) => `\`${a}\``).join(" / ")}${l.unit.fallback_depth ? `, else depth ${l.unit.fallback_depth}` : ""}`
}

const HOOK_MARK = ".codemap/tool/hook.sh"

function wireHooks(settingsPath: string): void {
	let s: Record<string, any> = {}
	if (existsSync(settingsPath)) {
		try {
			s = JSON.parse(readFileSync(settingsPath, "utf8"))
		} catch {
			die(`${settingsPath} does not parse as JSON; fix it, then rerun`)
		}
	}
	s.hooks ??= {}
	const post: any[] = (s.hooks.PostToolUse ??= [])
	// Idempotent: drop every earlier codemap hook, then add ours once.
	for (const entry of post) entry.hooks = (entry.hooks ?? []).filter((h: any) => !String(h.command ?? "").includes(HOOK_MARK))
	s.hooks.PostToolUse = post.filter((e) => (e.hooks ?? []).length > 0)
	s.hooks.PostToolUse.push(
		{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: `"$CLAUDE_PROJECT_DIR"/${HOOK_MARK} edit` }] },
		{ matcher: "Bash", hooks: [{ type: "command", command: `"$CLAUDE_PROJECT_DIR"/${HOOK_MARK} bash` }] },
	)
	writeIfChanged(settingsPath, JSON.stringify(s, null, 2) + "\n")
}

function smokeTest(root: string, lanes: Lane[]): string[] {
	const fails: string[] = []
	const run = (cmd: string[], input?: string) =>
		Bun.spawnSync(cmd, { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdin: input ? Buffer.from(input) : undefined, stdout: "pipe", stderr: "pipe" })
	const wiki = run(["bun", ".codemap/tool/wiki.ts", "status"])
	if (wiki.exitCode !== 0) fails.push(`wiki status failed: ${wiki.stderr.toString().trim() || wiki.stdout.toString().trim()}`)
	const verify = run(["bun", ".codemap/tool/reindex.ts", "verify"])
	if (verify.exitCode !== 0) fails.push(`reindex verify failed:\n${verify.stdout.toString().trim()}`)
	if (lanes.length) {
		// The validate hook must bounce a broken index write with exit 2.
		const probe = join(root, ".codemap", lanes[0].id, "zz-codemap-probe.yaml")
		writeFileSync(probe, "unit: zz-codemap-probe\nitems:\n  - fine\n  - broken: entry\n")
		const r = run([join(root, HOOK_MARK), "edit"], JSON.stringify({ tool_input: { file_path: probe } }))
		rmSync(probe, { force: true })
		if (r.exitCode !== 2) fails.push(`the edit hook did not reject a corrupt index write (exit ${r.exitCode}): ${r.stderr.toString().trim()}`)
	}
	return fails
}

async function install(): Promise<void> {
	if (!bunOk()) die(`bun ${Bun.version} is too old; need ≥ ${MIN_BUN.join(".")} (built-in YAML). Run: bun upgrade`)
	const root = projectRoot()
	const { path, json } = readDraft()
	await validateDraft(root, path)
	const lanes = (json.codemap as Lane[]) ?? []
	const prose = (json.prose as { lane: string }[]) ?? []

	for (const l of lanes)
		if (!existsSync(join(root, ".codemap", l.id, "SCHEMA.md")))
			die(`.codemap/${l.id}/SCHEMA.md is missing. Write the lane's YAML schema first (reference/yaml-shapes.md), then rerun.`)

	const changed: string[] = []
	const note = (p: string, did: boolean) => did && changed.push(relative(root, p))

	// 1. tooling
	const toolDst = join(root, ".codemap/tool")
	cpSync(join(TEMPLATE, "tool"), toolDst, { recursive: true, force: true })
	// The hook's shell fast path reads these; config stays out of code.
	const roots = lanes.map((l) => l.root.replace(/^\.\//, "").replace(/\/$/, "") || ".")
	writeFileSync(join(toolDst, "lane-roots"), roots.join("\n") + "\n")
	chmodSync(join(toolDst, "hook.sh"), 0o755)
	writeFileSync(
		join(toolDst, "README.md"),
		`# codemap tool (kit ${KIT_VERSION})\n\nInstalled by the codemap-setup skill, created by Rateb Seirawan.\n\n- \`bun .codemap/tool/wiki.ts help\`: the lookup door\n- \`bun .codemap/tool/reindex.ts help\`: keeping the code index current\n- Config: \`.codemap/config.json\` · lane schemas: \`.codemap/<lane>/SCHEMA.md\`\n\nRerun the installer after changing the config. Do not edit these files in place; they are overwritten.\n`,
	)
	changed.push(".codemap/tool/")

	// 2. config
	const cfgPath = join(root, ".codemap/config.json")
	if (resolve(path) !== cfgPath) note(cfgPath, writeIfChanged(cfgPath, JSON.stringify(json, null, 2) + "\n"))

	// 3. per-lane trees + agents
	for (const l of lanes) {
		const tree = join(root, ".codemap", l.id, "_tree.yaml")
		if (!existsSync(tree)) {
			const desc = (l.description ?? `${l.name}: the code under ${l.root}.`).replace(/\s+/g, " ").trim()
			note(
				tree,
				writeIfChanged(
					tree,
					`# ${l.id}: table of contents of the ${l.name} code index.\n# Written by the reindex ORCHESTRATOR only, never by an indexer agent\n# (parallel agents on one shared file lose writes). Every unit YAML on disk\n# must be listed here or \`wiki ${l.id} tree\` cannot reach it.\n\nlane: ${l.id}\nname: ${JSON.stringify(l.name)}\ndescription: >\n  ${desc}\ngroups: []\n`,
				),
			)
		}
		const agent = readFileSync(join(TEMPLATE, "agent.md"), "utf8")
			.replaceAll("{{LANE_ID}}", l.id)
			.replaceAll("{{LANE_NAME}}", l.name)
			.replace("{{INDEXER_NOTES}}", (l.indexer_notes ?? "Follow the lane schema; it names every key and what fills it.").trim())
		const ap = join(root, ".claude/agents", `${l.id}-indexer.md`)
		note(ap, writeIfChanged(ap, agent))
	}

	// 4. the reindex skill
	const pol = (json.policy as Record<string, unknown>) ?? {}
	const table = lanes.map((l) => `| \`${l.id}\` | \`${l.root}\` | ${unitRuleText(l)} | \`${l.id}-indexer\` |`).join("\n")
	const skill = readFileSync(join(TEMPLATE, "reindex-skill.md"), "utf8")
		.replace("{{LANE_TABLE}}", table || "| (no code lanes yet) | | | |")
		.replace("{{POLICY}}", String(pol.unindexed_dirty ?? "skip"))
		.replace("{{MAX_PARALLEL}}", String(pol.max_parallel ?? 8))
	const sp = join(root, ".claude/skills/codemap-reindex/SKILL.md")
	note(sp, writeIfChanged(sp, skill))

	// 5. hooks
	const settings = join(root, ".claude", has("local") ? "settings.local.json" : "settings.json")
	const before = existsSync(settings) ? readFileSync(settings, "utf8") : ""
	wireHooks(settings)
	if (readFileSync(settings, "utf8") !== before) changed.push(relative(root, settings))

	// 6. .gitignore
	const gi = join(root, ".gitignore")
	const giBody = `# codemap:begin (codemap kit by Rateb Seirawan)\n.codemap/wiki.sqlite*\n.codemap/.seen.json\n.codemap/*/.dirty\n.codemap/*/.dirty.bulk\n.codemap/*/.packets/\n# codemap:end\n`
	note(gi, writeIfChanged(gi, block(existsSync(gi) ? readFileSync(gi, "utf8") : "", "# codemap:begin", "# codemap:end", giBody)))

	// 7. CLAUDE.md lookup block
	const cm = join(root, "CLAUDE.md")
	const cmBody = readFileSync(join(TEMPLATE, "claude-md-block.md"), "utf8")
		.replace("{{PROSE_LANES}}", prose.map((p) => p.lane).join(", ") || "none yet")
		.replace("{{CODE_LANES}}", lanes.map((l) => l.id).join(", ") || "none yet")
	note(cm, writeIfChanged(cm, block(existsSync(cm) ? readFileSync(cm, "utf8") : "", "<!-- codemap:begin", "<!-- codemap:end -->", cmBody)))

	// 8. baseline the Bash-lane snapshot: edits made before install are not this session's to flag
	Bun.spawnSync([join(root, HOOK_MARK), "bash"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdin: Buffer.from('{"tool_input":{"command":"x > y"}}') })

	console.log(`✓ codemap kit ${KIT_VERSION} installed in ${root}`)
	for (const c of changed) console.log(`  wrote ${c}`)
	const fails = smokeTest(root, lanes)
	if (fails.length) {
		for (const f of fails) console.log(`✗ smoke test: ${f}`)
		process.exit(1)
	}
	console.log("✓ smoke test: wiki answers, verify passes, the edit hook rejects a corrupt index write")
	console.log("\nNothing was indexed. Agents and the hooks load at the next Claude Code session start.\n")
	Bun.spawnSync(["bun", ".codemap/tool/reindex.ts", "estimate"], { cwd: root, stdout: "inherit", stderr: "inherit" })
}

// ───────────────────────────────────────────────────────────────────────────
// uninstall
// ───────────────────────────────────────────────────────────────────────────

function uninstall(): void {
	const root = projectRoot()
	for (const s of ["settings.json", "settings.local.json"]) {
		const p = join(root, ".claude", s)
		if (!existsSync(p)) continue
		const j = JSON.parse(readFileSync(p, "utf8"))
		for (const e of j.hooks?.PostToolUse ?? []) e.hooks = (e.hooks ?? []).filter((h: any) => !String(h.command ?? "").includes(HOOK_MARK))
		if (j.hooks?.PostToolUse) j.hooks.PostToolUse = j.hooks.PostToolUse.filter((e: any) => (e.hooks ?? []).length > 0)
		if (j.hooks?.PostToolUse?.length === 0) delete j.hooks.PostToolUse
		if (j.hooks && Object.keys(j.hooks).length === 0) delete j.hooks
		writeFileSync(p, JSON.stringify(j, null, 2) + "\n")
	}
	for (const [file, begin, end] of [
		[".gitignore", "# codemap:begin", "# codemap:end"],
		["CLAUDE.md", "<!-- codemap:begin", "<!-- codemap:end -->"],
	]) {
		const p = join(root, file)
		if (!existsSync(p)) continue
		const left = block(readFileSync(p, "utf8"), begin, end, "").replace(/\n{3,}$/, "\n")
		if (left.trim()) writeFileSync(p, left)
		else rmSync(p) // only the codemap block was ever in it
	}
	const agentsDir = join(root, ".claude/agents")
	if (existsSync(agentsDir))
		for (const f of readdirSync(agentsDir))
			if (f.endsWith("-indexer.md") && readFileSync(join(agentsDir, f), "utf8").includes("kit: codemap-setup")) rmSync(join(agentsDir, f))
	rmSync(join(root, ".claude/skills/codemap-reindex"), { recursive: true, force: true })
	if (has("purge")) rmSync(join(root, ".codemap"), { recursive: true, force: true })
	else for (const p of ["tool", "wiki.sqlite", "wiki.sqlite-wal", "wiki.sqlite-shm", ".seen.json"]) rmSync(join(root, ".codemap", p), { recursive: true, force: true })
	console.log(`✓ codemap removed from ${root}${has("purge") ? " (indexes purged)" : " (config, schemas and YAML indexes kept in .codemap/; --purge removes them)"}`)
}

// ───────────────────────────────────────────────────────────────────────────

switch (cmd) {
	case "survey":
		survey()
		break
	case "preview":
		await preview()
		break
	case "install":
		await install()
		break
	case "uninstall":
		uninstall()
		break
	default:
		console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""))
		process.exitCode = cmd ? 1 : 0
}

