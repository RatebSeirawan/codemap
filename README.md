# codemap-setup

**A page index of your codebase for Claude Code, built for your stack by Claude itself.**

Created by **Rateb Seirawan**.

Agents waste most of their context finding things: grepping, opening whole
files, re-reading the same docs. This kit gives a project one lookup door and
a map of its code:

- **`wiki`**: one ranked search over your docs (split into heading-level
  sections, so a hit is 40 lines, not a 1 MB file) and your code index, in one
  call. Every hit ends in `→ Read path:lines`. Docs are indexed mechanically
  (SQLite FTS5, lazy, no LLM): free, the moment it is installed.
- **The codemap**: an agent-written index of the code. Each unit (a module,
  service, package or route group) gets one YAML of its entries (operations,
  endpoints, pages, commands…), and each lane gets a `_tree.yaml` table of
  contents an agent navigates like a book's.
- **It stays true by itself, cheaply.** Edit hooks flag the unit a change
  touched (milliseconds, no LLM; comment-only edits never flag; a shell sweep
  is bucketed, not queued). When you say "reindex", deterministic packets give
  one small, hard-scoped agent per dirty unit, all in parallel, and a verifier
  closes the loop.
- **It never indexes on its own.** Indexing an existing codebase from zero is
  the expensive part, so after setup Claude measures your repo (unit counts,
  token estimates, where recent commits concentrate) and proposes a strategy,
  opening with a 1–2 unit pilot. You decide.

## Install

Requirements: git, and [Bun](https://bun.sh) ≥ 1.2.21 to run the tooling (your
project can be in any language; nothing is added to its package manager).

```bash
git clone https://github.com/RatebSeirawan/codemap ~/.claude/skills/codemap-setup
# or, from a zip: unzip codemap-setup.zip -d ~/.claude/skills/
```

Either way you end up with `~/.claude/skills/codemap-setup/SKILL.md`.

Then, in Claude Code at the root of your project:

```
/codemap-setup
```

Claude surveys the codebase; designs the lanes, unit rules and YAML schema
for your stack (monorepo or single app; TypeScript, Python, Go, Rust, Java…);
previews the unit partition; asks you once; installs; proves the wiring; and
proposes how to index. Restart Claude Code afterwards so the new agents and
hooks load.

## What it adds to your project

| Path | What |
|---|---|
| `.codemap/tool/` | `wiki.ts`, `reindex.ts`, `hook.sh` (zero dependencies) |
| `.codemap/config.json` | Lanes, unit rules, schema keys, prose lanes, aliases, policy |
| `.codemap/<lane>/SCHEMA.md` | The YAML contract each indexer follows |
| `.codemap/<lane>/**.yaml` | The index itself (commit it: it is shared knowledge) |
| `.claude/agents/<lane>-indexer.md` | One hard-scoped indexer per lane |
| `.claude/skills/codemap-reindex/` | The reindex orchestrator, the counterpart of setup |
| `.claude/settings.json` | Two PostToolUse hooks (or `settings.local.json`) |
| `CLAUDE.md`, `.gitignore` | One marked block each |

Remove it all with `bun ~/.claude/skills/codemap-setup/install.ts uninstall --project .`
(`--purge` also deletes `.codemap/`).

## Daily use

```bash
bun .codemap/tool/wiki.ts search refund approval     # docs + code, ranked
bun .codemap/tool/wiki.ts api tree                   # the table of contents of a lane
bun .codemap/tool/wiki.ts api where route /invoices  # entries by field
bun .codemap/tool/reindex.ts status                  # what drifted
```

and tell Claude "reindex" at the end of a batch of work.

## Credit

The codemap, the wiki and this kit were designed and built by **Rateb Seirawan**,
first for his own production ERP.

## License

[MIT](LICENSE) © 2026 Rateb Seirawan. Use it, adapt it, ship it; the licence's one
condition is that the copyright notice travels with every copy.
