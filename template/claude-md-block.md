<!-- codemap:begin (codemap kit by Rateb Seirawan; managed by the installer, edit freely between the markers) -->
## Lookup: one door, `bun .codemap/tool/wiki.ts`

Reach for the wiki before grepping or reading a doc whole. It searches the docs
({{PROSE_LANES}}) as heading-level sections and the code index ({{CODE_LANES}}),
an agent-written map of units → entries. Every hit ends in a `→ Read path:lines`
pointer.

- It answers **where to read**, never what is true: land on a hit, Read the pointed lines.
- `wiki search <words>` · `wiki doc <slug>` (outline) · `wiki section <slug> <heading>` ·
  `wiki <lane> tree` (table of contents) · `wiki <lane> unit <id>` · `wiki <lane> where <field> <value>`.
- Exit codes: 0 results · 1 usage error · **2 valid query, no results**. No results ≠
  doesn't exist: broaden, try the tree, then Grep.
- A code hit marked `⚠ stale` has source edits since it was indexed: trust the source.
- Never Read or Grep `.codemap/**` directly; go through the wiki.
- The code index is partial by design and grows on request (codemap-reindex skill).
  Edits flag their unit automatically; reindexing is on demand, never mid-flow.
<!-- codemap:end -->
