# Indexing strategy for an existing codebase

> Part of the codemap-setup skill by Rateb Seirawan.

Indexing from zero means one agent run per unit, each reading the unit's whole
source. On a large codebase that is millions of tokens, so the installer
indexes nothing and the user chooses. Base the proposal on the numbers
`reindex.ts estimate` and `reindex.ts hot` print, never on a guess.

The docs half (`wiki search` over markdown) works the moment install finishes,
costs nothing, and needs no strategy. Say so first: the user already has a
lookup door before a single unit is indexed.

## Step one of every strategy: the pilot

Index 1–2 representative units (one typical, one large or awkward):

```bash
bun .codemap/tool/reindex.ts prepare --units <lane>:<unit>,<lane>:<unit>
```

Run them through the codemap-reindex skill, then read the YAML **with the user**.
Is the description what a newcomer needs? Are routes real, not guessed? Is a key
always empty (drop it) or always missing something (add it)? Fix `SCHEMA.md`,
`context` or `indexer_notes`, re-run the installer, and re-index the pilot. A
schema fixed after 2 units costs 2 rewrites; after 40 it costs 40. The pilot also
measures the real per-unit cost, which replaces the estimate's rough figure.

## The options

### A. On-touch (lazy)

`policy.unindexed_dirty: "create"`. Nothing upfront; a unit is indexed the first
time someone edits it and then reindexes.
- **Cost:** spread across normal work, paid only where work happens.
- **Coverage:** grows with the work; untouched areas stay dark.
- **Fits:** any size, especially when the budget is tight or the codebase is
  mostly stable. Downside: the first reindex after touching a big unit is a big
  CREATE, which `status` announces before it runs.

### B. Hot seed + on-touch (the usual recommendation)

Seed the units carrying most recent work, then switch to on-touch:

```bash
bun .codemap/tool/reindex.ts prepare --unindexed 20 --lane api   # the 20 hottest unindexed
```

- **Cost:** `estimate` prints it at 50% and 80% of recent commits.
- **Coverage:** where people actually look, immediately.
- **Fits:** medium and large codebases; most teams. Pick the share whose cost the
  user accepts (50% is often a fraction of the units: churn is concentrated).

### C. Full backfill in batches

Every unit, in batches of `max_parallel`, across as many sessions as needed;
`status` and `units --unindexed` show progress.
- **Cost:** the full figure `estimate` prints.
- **Coverage:** complete; `wiki <lane> tree` becomes the whole map.
- **Fits:** small codebases (roughly ≤ 40 units) where the full cost is modest, or
  when the user explicitly wants the whole map.

### D. Area by area

Seed one group or area at a time (`prepare --units` with the group's unit ids),
when a team is about to work in a known part of the code.

## Choosing

| Signal from the numbers | Recommend |
|---|---|
| ≤ 40 units, or the full backfill fits the user's comfort | C, after the pilot |
| Churn concentrated (50% of commits in ≤ 25% of units) | B at 50%, then A |
| Churn spread thin, large codebase | A, plus D for the area being worked next |
| Little or no recent history (fresh import) | A, or D on the core module |

Present ONE recommendation with its numbers (units, rough tokens, share of
recent work covered, what stays dark), and the alternatives in a line each. The
token figures are rough (3× the source tokens, since every agent turn re-sends its context, plus a fixed overhead; calibrated on a measured run); the
pilot's real cost replaces them.

## Afterwards

Whatever is chosen, the hooks keep every **indexed** unit's drift flagged for
free. "Reindex" whenever convenient (end of day, after a batch) runs only the
dirty units, usually a handful of small UPDATE packets that often end in
`NO DRIFT`.
