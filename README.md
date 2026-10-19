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

## Philosophy

### Vector RAG over a codebase is bullshit

Embeddings answer one question: *what looks like this?* An agent working in
your code is asking a different one: *where is it?* Those are not the same
question, and every RAG-on-code setup I have seen pretends they are.

Code is not prose. It has names, and names are exact. `issueInvoice` is not
"semantically close" to `voidInvoice`. It is a different function with a
different contract, and the one that sits nearest in a vector space is the
one you did not ask for. Chunk a file into 512-token slices and you cut
functions in half, separate a route from its handler, and lose the file it
came from. Then you hand the agent the five slices that *felt* closest and
call it context.

The worst part is that it never fails out loud. A vector store always
returns something. Ask it for a thing that does not exist and you get the
nearest thing that does, ranked with the same confidence as a true hit. The
agent cannot tell "found" from "found something similar", so it builds on
the near miss. You find out three files later, in a diff that compiles and is
wrong. And when the code changes, the embeddings do not. Nothing tells you
they went stale.

This kit takes the other road, on purpose:

- **Exact over similar.** Names are matched as names. Docs are searched as
  text, section by section, ranked by how rare the term is, not by vibes.
- **A map, not a pile of chunks.** The code index is a tree: lane → group →
  unit → entry, written by an agent that read the whole unit. You navigate it
  the way you navigate a book's table of contents.
- **Every hit is a pointer, never the answer.** It tells you *where to read*,
  and the source stays the truth. You can always check it.
- **"Nothing" means nothing.** No result exits 2. A miss is reported as a
  miss, never dressed up as the closest neighbour.
- **Staleness is visible.** An edit flags its unit the moment it lands, and a
  stale entry says so on every lookup until it is reindexed.

### Speed is not the metric. Certainty is.

Everyone optimises retrieval for latency. Milliseconds. It is the wrong
number. An agent that gets the wrong answer in 50ms does not save you
anything; it spends the next hour writing confident code on top of it, and you
spend the hour after that finding out why.

A wrong pointer costs more than any wait. So:

- Indexing is **slow and deliberate**. One agent per unit, reading the whole
  unit, with a hard scope and a schema, checked by a validator before it
  counts. It runs when you ask, never in the middle of your flow.
- The parts that run on every edit are **cheap because they are dumb**. Shell
  and git, no model, nothing to get wrong.
- Routes are **pre-extracted from the real files**, never inferred. A guessed
  route looks right and 404s. That is the exact failure this exists to kill.
- "**No drift**" is a valid answer. An indexer is never pushed to invent a
  change to justify its run.

I would rather an agent wait a second and land on the right file than answer
instantly and land next to it. Fast and wrong is just wrong, sooner.

— Rateb

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
