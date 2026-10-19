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

### Why not vector search?

Frankly, I think vector RAG over a codebase is bullshit, and I say that as
someone who tried to make it work.

Embeddings are good at telling you what *looks like* something. But when an
agent is working in your code, that's not what it's asking. It's asking where
something *is*: which function, which file, which route. Those are different
questions, and most RAG-on-code setups quietly pretend they're the same one.

Code isn't prose. It has names, and names are exact. `issueInvoice` isn't
"similar" to `voidInvoice`; it's a different function with a different
contract, and the one that happens to sit closest in a vector space is often
exactly the one you didn't want. On top of that, chunking a file into
fixed-size slices cuts functions in half and separates a route from the
handler that serves it, and then the agent gets handed the few slices that
*felt* closest and is told that's its context.

What bothers me most is that it never fails honestly. A vector store always
returns something. Ask it for a thing that doesn't exist and you'll get the
nearest thing that does, with the same confidence as a real hit. The agent
can't tell "found it" from "found something like it", so it builds on the
near miss, and you find out three files later in a diff that compiles and is
wrong. And when the code changes, the embeddings don't, and nothing tells you.

So this kit goes the other way, on purpose. Names are matched as names, and
docs are searched as plain text, section by section, ranked by how rare a
term is. The code index is a tree (lane, group, unit, entry), written by an
agent that actually read the whole unit, so you navigate it like a table of
contents instead of fishing in a pile of chunks. Every hit is a pointer to
where you should read, never the answer itself, so the source stays the truth
and you can always check it. When there's nothing, it says nothing (exit code
2) instead of offering a lookalike. And when code changes, its unit is flagged
straight away and every lookup tells you that entry is stale until it's
reindexed.

### Why I don't care about speed

Everyone seems to optimise retrieval for speed, and honestly I think it's the
wrong thing to measure. An agent that gets a wrong answer quickly hasn't saved
you anything. It'll spend the next hour writing perfectly confident code on
top of that answer, and you'll spend the hour after that working out why it's
wrong. A wrong pointer costs far more than any wait ever will.

That's why indexing here is slow and deliberate. One agent per unit reads the
whole unit, works inside a strict scope and schema, and a validator checks its
output before it counts. It only runs when you ask for it, never in the middle
of your work. The bits that run on every edit are cheap precisely because
they're dumb: plain shell and git, no model, so there's nothing in them to get
wrong. Routes are taken from the actual route files, never guessed, because a
guessed route looks completely right right up until it 404s. And an indexer
is allowed to come back and say "nothing changed"; it's never pushed into
inventing an edit to justify having run.

I'd much rather an agent take a moment and land on the right file than answer
instantly and land next to it. Fast and wrong is still wrong, it just gets
there sooner.

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
