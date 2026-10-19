---
name: codemap-reindex
description: >-
  Keep the codemap (.codemap/<lane>/*.yaml, the page index of this codebase that
  `wiki` searches) true to the code: reconcile dirty units, or seed unindexed
  ones, through deterministic packets and parallel scoped indexer agents. Load on
  "reindex", "update the codemap", "seed/index <area>", end of day, or after a
  work batch. Never mid-flow.
metadata:
  author: Rateb Seirawan
  kit: codemap-setup
---

# Codemap reindex

> Part of the codemap kit by Rateb Seirawan.

The codemap is an agent-written index of the code: units (directories) → entries
(operations, endpoints, pages, commands…), with a `_tree.yaml` table of contents
per lane. `bun .codemap/tool/wiki.ts` searches it alongside the docs. It goes
stale as code changes. Hooks flag what changed for free (`.codemap/<lane>/.dirty`);
this skill is the on-demand other half.

The split that keeps it cheap:
- **Deterministic prep** (`reindex.ts prepare`, no LLM) writes one packet per unit:
  the exact files, the diff, the existing YAML, the lane schema, a hard scope.
- **One indexer agent per packet**, in parallel, each in a tiny context.
- **Deterministic close** (`finalize`, `mark-verified`, `verify`).

## Lanes

| Lane | Source | Unit rule | Agent |
|------|--------|-----------|-------|
{{LANE_TABLE}}

Schemas: `.codemap/<lane>/SCHEMA.md`. Config and policy: `.codemap/config.json`
(policy `unindexed_dirty: {{POLICY}}`).

## Upkeep run ("reindex")

1. **Status.** `bun .codemap/tool/reindex.ts status`
   - `Nothing dirty` in every lane and no warnings → stop and say so.
   - **Coverage gap** named files (edits made outside a session: an editor, a
     merge, a rebase) → `reindex.ts scan --evidenced-only` before preparing.
     Never dismiss it as noise; it is the narrow, git-evidenced set.
   - **BULK** notice → settle it: `promote-bulk` if the sweep changed behaviour,
     `clear-bulk` (`--dry-run` first) if it was mechanical.
2. **Prepare.** `bun .codemap/tool/reindex.ts prepare` prints each packet and its agent.
3. **Fan out.** One agent per packet, all in ONE message (parallel), at most
   {{MAX_PARALLEL}} at a time; more than that → sequential batches. The prompt:
   ```
   Packet: <packet path>

   Follow its hard scope exactly: read ONLY the files it lists, write ONLY its
   target YAML. Preserve accurate prose. Concluding NO DRIFT and writing nothing
   is a valid, expected outcome; say so plainly. Report in under 150 words.
   ```
   Use the lane's agent (`<lane>-indexer`). If the agent type is not available
   in this session (agents load at session start), use a general-purpose agent
   and paste the agent file `.claude/agents/<lane>-indexer.md` body above the prompt.
4. **Close.** For every agent that reported NO DRIFT:
   `reindex.ts mark-verified <lane>/<unit> …`. Then `reindex.ts finalize`.
   Never mark a unit whose agent crashed or never ran: that marks unread code current.
5. **Adopt new units into `_tree.yaml` yourself, without asking.** `wiki <lane> tree`
   walks the tree, not the directory, so an index file missing from it is
   unreachable. You are the only writer of `_tree.yaml` (agents are forbidden from
   it). Add the unit under its group (the first path segment; create the group if
   new) in the same shape as its siblings:
   ```yaml
   groups:
     - id: billing
       name: Billing
       description: >
         What this area of the code does, in two or three sentences.
       units:
         - id: billing/invoices
           name: Invoice issuing, voiding and PDFs
           index: billing/invoices.yaml
   ```
   `name:` is curated prose: compress the unit's own `description`, never title-case
   the id. When a new unit widens what its group does, extend the group `description`.
6. **Verify.** `reindex.ts status` then `reindex.ts verify` (exit 0 required). `verify`
   checks shape, required keys, collapsed scalars, tree reachability both ways and
   orphans (an index whose source is gone: rename it to the unit it now describes,
   or delete it and its tree entry).
7. **Clean up.** `reindex.ts clear-packets` (keeps `.dirty`; never delete `.dirty` by hand).
8. **Report:** what each agent changed, units adopted into the tree, anything left dirty.

## Seeding unindexed units (deliberate, budgeted)

The codemap never indexes on its own. Coverage grows only on a human's word:
- `reindex.ts estimate` → totals, full-backfill cost, hot-seed cost.
- `reindex.ts hot --days 90` → units ranked by commit churn with cumulative coverage.
- `reindex.ts units --unindexed` → everything not yet indexed, with rough token cost.

Then `prepare --units <id>,<id>` (named units) or `prepare --unindexed N` (the N
hottest unindexed), and run steps 3–7. Packets in CREATE mode read the whole unit.

**Pilot before any batch:** index 1–2 representative units first, read the YAML
with the user, fix `SCHEMA.md` or the lane's `indexer_notes` if the shape is wrong,
then batch. A schema fixed after 40 units costs 40 rewrites.

## Rules

1. **Never bypass packets.** No packet, no indexer run.
2. **Never read source yourself to "help" an indexer.** The packet is the whole input.
3. **`_tree.yaml` is yours, never an agent's.** Adopt units without asking (step 5).
4. **Never during flow.** If the user is mid-task, offer to queue it.
5. **"No drift" is a result, not a failure.** Record it with `mark-verified`.
6. **"Current" is a claim you make.** Never clear a flag you did not reindex to get
   a clean status.
7. **Never run a full backfill unasked.** Seeding is the user's budget call.

## Commands

`bun .codemap/tool/reindex.ts help` prints them all. Lookups: `bun .codemap/tool/wiki.ts help`.
