---
name: codemap-setup
description: >-
  Set up the codemap in the current project: a `wiki` lookup door (ranked FTS
  over the docs as heading-level sections) plus an agent-written page index of
  the code (units → entries, a table-of-contents tree per lane), kept current by
  edit hooks and on-demand parallel indexer agents. Surveys the codebase,
  designs the lanes, unit rules and YAML schema for THIS stack (monorepo or
  not, any language), installs the deterministic tooling, then proposes an
  indexing strategy. It never indexes on its own. Load on /codemap-setup,
  "set up the codemap", "install the wiki/page index", or to redesign an
  existing codemap.
license: MIT
metadata:
  author: Rateb Seirawan
  version: 1.0.0
---

# codemap-setup

> Created by **Rateb Seirawan**. The design comes from the codemap he runs on his own ERP:
> one lookup door, an agent-written index of the code, hooks that flag drift
> for free, and indexing that runs only when asked.

## What gets built

| Piece | Where | What it is |
|---|---|---|
| `wiki.ts` | `.codemap/tool/` | The ONE lookup door. Docs are FTS5-indexed per heading section (lazy, self-refreshing, no LLM); the code index is searched in the same call. Every hit ends in `→ Read path:lines`. Exit 0 / 1 / 2 (results / usage / no results). |
| code lanes | `.codemap/<lane>/` | One YAML per **unit** (a module, service, package or route group), each listing its **entries** (operations, endpoints, pages, commands…), plus `_tree.yaml`, the lane's table of contents. |
| `reindex.ts` | `.codemap/tool/` | Deterministic upkeep: dirty tracking, coverage gap, packets, finalize, verify, cost estimates. No LLM. |
| hooks | `.claude/settings.json` | Edits flag their unit in `.dirty` (comment-only edits never do; a shell sweep is bucketed, not queued); a corrupt index write bounces back to the agent that wrote it. |
| `<lane>-indexer` agents | `.claude/agents/` | One per lane, hard-scoped to one packet, one unit, one YAML. |
| `codemap-reindex` skill | `.claude/skills/` | The orchestrator: prepare → parallel fan-out → close → tree adoption → verify. |
| CLAUDE.md block | `CLAUDE.md` | Tells every session that the wiki is the lookup door. |

Requirements: **git** and **Bun ≥ 1.2.21** (built-in SQLite FTS5 and YAML; zero npm
dependencies, nothing installed into the project's own package manager). The
project can be in any language; Bun only runs the tooling.

`KIT` below means this skill's own directory (where this SKILL.md and `install.ts` live).

## The run

### 0. Preconditions

- Work from the project's git root. Not a git repo → stop; change tracking is git evidence.
- `bun --version`. Missing or older than 1.2.21 → stop and ask the user to install or
  upgrade it themselves (suggest they type `! curl -fsSL https://bun.sh/install | bash`
  or `! bun upgrade`). Never install a runtime for them.
- `.codemap/config.json` already exists → this is a redesign: read the current config,
  schemas and a few existing YAMLs first, and keep what works. Existing index files must
  still validate under any schema change, or be migrated in the same run.

### 1. Survey (read-only, cheap)

```bash
bun KIT/install.ts survey --project .
```

It prints languages, manifests and frameworks, workspace layout, directory weight,
prose locations, and the project's existing Claude Code skills and hooks. Then read
**2–4 representative source files** from the heaviest code areas (a service or
controller, a route or page, a model) to learn the real conventions: how a module
exports its surface, where routes are declared, where errors live. Do not read
broadly; the survey already sized the tree.

### 2. Design the lanes

Read `KIT/reference/yaml-shapes.md` now. It has the decision rules and worked
shapes per stack.

- **Code lanes** (1–3): areas whose units a developer navigates by name, such as the
  backend modules, the frontend routes or the packages of a library monorepo. Tests,
  generated code, migrations, vendored code and assets are never lanes.
- **Unit rule per lane:** `anchor` (the nearest directory holding a marker file such as
  `*.service.ts`, `views.py`, `mod.rs` or `page.tsx`) when the stack has a marker, else
  `depth` (directory N levels under the root).
- **`context` globs:** files ABOVE a unit that define its surface (a domain routes file,
  `urls.py`, an errors file). Without them an indexer guesses routes.
- **Entries and schema:** the entries key and fields this stack's code actually has. Keep
  it small; every key costs every unit forever. Add a `string_lists` entry for every list
  of strings.
- **Prose lanes:** where the docs live, weighted (instructions and specs ≥ 1.3, history
  and plans ≤ 0.7). `unindexed_docs` excuses markdown that is not knowledge
  (changelogs, vendored READMEs).
- **Aliases:** only abbreviations this codebase really uses (grep a few to confirm).
- **Policy:** `unindexed_dirty: "skip"` until the strategy step decides.

Write the draft to `.codemap/config.json`. The full config reference is in
`KIT/reference/yaml-shapes.md` § Config.

### 3. Preview until the units are right

```bash
bun KIT/install.ts preview --project . --config .codemap/config.json
```

Good units are cohesive and usually 2–25 files under ~4k lines. Hundreds of one-file
units → anchor higher or lower the depth. A handful of 10k-line units → go deeper,
or anchor on a marker. A big "helpers outside every unit" list → add a `fallback_depth`
or accept it (it is reported, never silently dropped). Iterate until the partition
reads like the codebase's own mental map.

### 4. Write each lane's SCHEMA.md

`.codemap/<lane>/SCHEMA.md` is the contract every packet embeds and every indexer
follows: the exact keys, one filled example built from a REAL unit you read in step 1,
and what fills each key in this stack. The installer refuses to run while one is
missing. Put stack-specific extraction rules ("entries = the methods the factory
returns", "route comes from the context routes file") in the lane's
`indexer_notes`; they render into its agent.

### 5. Confirm once, then install

Show the user, in one compact message: the lanes (root, unit rule, unit count), the
schema keys, the prose lanes, and what the installer touches (`.codemap/`,
`.claude/settings.json` hooks, `.claude/agents/<lane>-indexer.md`,
`.claude/skills/codemap-reindex/`, a `.gitignore` block, a `CLAUDE.md` block). Ask
once through the question tool (install / adjust / hooks into `settings.local.json`
instead). Then:

```bash
bun KIT/install.ts install --project . --config .codemap/config.json   # add --local for settings.local.json
```

It copies the tooling, renders the agents and the skill, wires the hooks, smoke-tests
the wiring (wiki answers, verify passes, a corrupt index write bounces), and prints the
cost estimate. **It indexes nothing.** Re-running it is safe and is how a config or
`indexer_notes` change lands.

Prove the docs half works right away; it is free:

```bash
bun .codemap/tool/wiki.ts status
bun .codemap/tool/wiki.ts search <two words from this project's domain>
```

### 6. Propose an indexing strategy (never start one unasked)

Indexing an existing codebase from zero is the expensive part, so it is the user's
call. Gather the numbers:

```bash
bun .codemap/tool/reindex.ts estimate
bun .codemap/tool/reindex.ts hot --days 90 --limit 25
```

Read `KIT/reference/strategy.md`, pick the option these numbers favour, and present
it with its figures: units, rough tokens, the share of recent work it covers, and what
stays unindexed. Then ask through the question tool. Every option opens with a
**pilot**: 1–2 representative units indexed and read together with the user, so the
schema is fixed after 2 units rather than 40. Record the choice by setting
`policy.unindexed_dirty` and re-running the installer.

If the user says go, the pilot runs in this session through the freshly installed
`codemap-reindex` skill (its "Seeding" section). The `<lane>-indexer` agent types
load at the next session start; until then use its documented fallback (a
general-purpose agent with the agent file's body pasted above the packet prompt).

### 7. Hand-off

Report: lanes and unit counts; files written; the smoke-test result; the
strategy chosen (or offered) with its numbers; and three things to remember:
1. `bun .codemap/tool/wiki.ts search <words>` is the lookup door, for agents and humans alike.
2. Edits flag their units automatically. "Reindex" whenever convenient, never mid-flow.
3. Commit `.codemap/` (config, schemas, YAMLs, trees, tool). The indexes are shared
   knowledge; the `.gitignore` block already excludes the per-machine state.

## Rules

- **Never index during setup** unless the user picks a strategy and says go.
- **Never install a runtime or touch the project's package manager.**
- **Design from what the code is**, never from a template's habits. A key the stack
  does not have stays out of the schema.
- **Ask once** (step 5), and once more for the strategy (step 6). Everything else
  has a sensible default; take it and say so.
- **Uninstall:** `bun KIT/install.ts uninstall --project .` removes the hooks, blocks,
  agents, skill and tool and keeps the indexes; `--purge` removes `.codemap/` too.
