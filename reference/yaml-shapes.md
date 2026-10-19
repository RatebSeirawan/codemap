# Designing lanes, units and the YAML schema

> Part of the codemap-setup skill by Rateb Seirawan.

The codemap is a **page index** of the code: a tree an agent navigates
(lane → group → unit → entry) instead of grepping. Every design choice below
serves one question: *when an agent asks "where is X?", does the answer land on
one unit and one entry with a Read pointer?*

## Vocabulary

- **Lane:** one indexed code area with one schema (`api`, `web`, `pkg`). 1–3 per project.
- **Unit:** one directory of a lane, one YAML file. A unit's id is its path under
  the lane root (`billing/invoices`); the root itself is `_root`.
- **Group:** a unit id's first segment; the tree's chapters.
- **Entry:** one item in the unit's entries list: an operation, endpoint, page,
  command, job, component, exported function.

## Choosing lanes

| Codebase | Lanes |
|---|---|
| Monorepo, backend + frontend apps | `api` (backend modules) + `web` (frontend routes); `pkg` for shared packages only if they hold real logic |
| Single backend service | one lane on its source root |
| Single frontend app | one lane on the routes dir; a second on `components/` only if it is large and shared |
| Library or SDK | one lane on `src/` (or `packages/` in a library monorepo, unit = package) |
| CLI tool | one lane, entries = commands |

Never lanes: tests, migrations, generated code, vendored code, fixtures, assets, build output.
Exclude them with `exclude` globs inside a lane too (`**/*.test.ts`, `**/__generated__/**`).

## Choosing the unit rule

**`anchor`** when the stack marks a module with a file. The unit is the
NEAREST ancestor directory holding an anchor, so nested modules split
naturally and a module's helper subdirectories fold into it.

| Stack | Anchors |
|---|---|
| NestJS | `*.module.ts` |
| Service-factory TS (Elysia, Hono, Express + services) | `*.service.ts`, `*.worker.ts` |
| Next.js / Remix / SvelteKit routes | `page.tsx` / `route.tsx` / `+page.svelte` (or use depth on route groups) |
| Django | `apps.py` (one Django app = one unit) |
| FastAPI / Flask | `router.py`, `routes.py`, `views.py` |
| Rust | `mod.rs`, `lib.rs` (or `Cargo.toml` for a workspace, unit = crate) |
| Go | `depth` usually fits better: a Go package is a directory already |
| Java / Kotlin (Spring) | `*Controller.java` / `*Service.kt`, or `depth` at the feature-package level |
| Rails | `depth` on `app/` sub-dirs is awkward; prefer a lane on `app/controllers` with depth 1 plus `context: ["routes.rb"]` |

`fallback_depth` gives files outside every anchored directory a depth-based
unit instead of reporting them as helpers. Use it when helpers carry real logic.

**`depth`** when directories already are the modules: the unit is the directory
N levels under the root (a shallower file belongs to its own directory). Route
groups like `(auth)` count as a level.

**Sizing:** aim for 2–25 files and under ~4k lines per unit. `install.ts
preview` shows the partition with line counts and rough token costs. A unit over
4k lines costs a lot to create and gets thin descriptions; go deeper.

## `context`: what sits above a unit

Many stacks declare a module's public surface ABOVE it: a domain routes file,
`urls.py`, an errors enum, a DI composition root. A packet is hard-scoped to the
unit's own files, so without `context` the indexer cannot see routes and
**guesses them**. Guessed routes are the single worst failure of a code index:
they look right and 404. List those files' basename globs. Every packet then
carries a pre-extracted excerpt: the lines of ANY context file in the lane that
mention the unit's own declared names (compound identifiers, imports stripped)
or its path segment, with line numbers, busiest file first. It finds a route
even when another group's routes file declares it, and the indexer never pages
through a 4,000-line routes file. Ancestor context files are also listed for
ranged reads.

```json
"context": ["*.routes.ts", "*.errors.ts", "urls.py", "routes.rb"]
```

## The schema

Fixed by the tooling (validated): `unit`, `path`, `description`, and the
entries list under `entries_key`, whose items need a `name`. Everything else is
yours. Keep it to what this stack really has and an agent really asks for.

Good keys answer lookups: *what does it do* (description), *how is it reached*
(route, command, export), *what does it touch* (tables, queues, files),
*what can go wrong* (errors), *what does it call* (cross-unit calls).
Bad keys restate code an agent will read anyway (full parameter types of every
private helper) or record history (dates, "previously").

Declare every list of strings in `string_lists` so `verify` catches a collapsed
`key: value` item; the tooling also detects them heuristically in lists nobody declared.

### Backend service (TypeScript, Python, Go, Java…)

```yaml
unit: billing/invoices
path: src/modules/billing/invoices
name: Invoice issuing and voiding
description: >
  Issues invoices from confirmed orders, numbers them per entity, and voids them
  with a reversing credit. Draft → issued → paid | voided. Calls payments to
  settle and ledger to post.
tables:
  reads: [orders, customers]
  writes: [invoices, invoice_lines]
operations:
  - name: issue
    type: mutation            # query | mutation
    risk: write               # read | write | destructive
    route: "POST /invoices/:id/issue"     # ~ when not served over HTTP
    description: >
      Numbers a draft and freezes its lines; refuses an order with no lines.
    errors: [INVOICE_NOT_DRAFT, ORDER_EMPTY]
    effects:
      - "UPDATE invoices (status → issued, number assigned)"
    calls:
      - "ledger/journal: post — books revenue and receivable"
```
`string_lists`: `["tables.reads", "tables.writes", "operations[].errors", "operations[].effects", "operations[].calls"]`

### Frontend routes (Next.js, Remix, SvelteKit, Nuxt…)

```yaml
unit: (app)/billing/invoices
path: app/(app)/billing/invoices
name: Invoices
description: >
  List and detail of invoices with issue / void actions; the detail page renders
  the PDF preview.
pages:
  - name: list
    route: /billing/invoices
    description: Filterable table of invoices; status tabs in the URL.
    data: [GET /invoices]
    actions: ["new | createInvoice | needs billing.write"]
    components: [InvoiceTable, StatusTabs]
  - name: detail
    route: /billing/invoices/[id]
    description: One invoice with lines, payments and the PDF preview.
    data: [GET /invoices/:id]
    actions: ["issue | issueInvoice | status = draft", "void | voidInvoice | status = issued"]
```
`string_lists`: `["pages[].data", "pages[].actions", "pages[].components"]`.
Notice the `"…| status = draft"` items: `=` instead of `: `, or the item collapses.

### Library / package

```yaml
unit: parser
path: packages/parser
name: Source parser
description: >
  Tokenises and parses source text into the AST used by every other package.
exports:
  - name: parse
    kind: function
    signature: "parse(src: string, opts?: ParseOptions): Ast"
    description: Parses one file; throws ParseError with a span on bad input.
```

### CLI

```yaml
unit: commands/deploy
path: src/commands/deploy
name: deploy command
description: Builds, uploads and activates a release.
commands:
  - name: deploy
    usage: "tool deploy [--env <name>] [--dry-run]"
    description: Builds and uploads; --dry-run prints the plan only.
    exits: ["1 = build failed", "3 = remote refused"]
```

### Workers, jobs, event consumers

Entries = jobs: `name`, `trigger` (cron, queue, event), `description`, `effects`,
`retries`. Anchor on `*.worker.*` / `*.job.*` / `*consumer*`.

## Prose lanes

Order matters: the first lane whose glob claims a path wins. Put narrow
high-value lanes first.

```json
"prose": [
  { "lane": "claude", "weight": 1.3, "globs": ["CLAUDE.md", "**/CLAUDE.md"] },
  { "lane": "spec",   "weight": 1.3, "globs": ["specs/**/*.md", "docs/adr/**/*.md"] },
  { "lane": "skill",  "weight": 1.0, "globs": [".claude/skills/**/*.md", ".claude/agents/*.md"] },
  { "lane": "doc",    "weight": 1.0, "globs": ["docs/**/*.md", "*.md", "src/**/*.md"] },
  { "lane": "plan",   "weight": 0.7, "globs": ["plans/**/*.md", "rfcs/**/*.md"] }
]
```

Weights multiply the bm25 score: boost what is current and authoritative, damp
what is historical (build logs, old RFCs) so it never outranks the doc that
superseded it. `wiki status` names every tracked `.md` no lane claims; claim it
or excuse it in `unindexed_docs` (a regex). Never leave it silently invisible.

## Config reference (`.codemap/config.json`)

```json
{
  "version": 1,
  "project": "acme",
  "prose": [ … ],
  "prose_exclude": "node_modules|/dist/|/build/|/vendor/",
  "unindexed_docs": "^(CHANGELOG\\.md|third_party/)",
  "aliases": { "po": ["purchase order"], "k8s": ["kubernetes"] },
  "codemap": [
    {
      "id": "api",
      "name": "Backend API",
      "description": "One paragraph for the top of the tree.",
      "root": "services/api/src/modules",
      "include": ["**/*.ts"],
      "exclude": ["**/*.test.ts", "**/*.spec.ts"],
      "unit": { "strategy": "anchor", "anchors": ["*.service.ts"], "fallback_depth": 1 },
      "context": ["*.routes.ts", "*.errors.ts"],
      "entries_key": "operations",
      "required": ["name"],
      "entry_required": ["name", "type", "description"],
      "string_lists": ["tables.reads", "tables.writes", "operations[].errors"],
      "indexer_notes": "Entries are the methods the create*Service factory returns. route comes from the packet's Context excerpt (a routes file calling the method); the full path is that file's mount prefix + the route's own path, so when the prefix is not in the excerpt, Read only the top ~40 lines of that routes file. ~ only when no route serves the method."
    }
  ],
  "policy": { "unindexed_dirty": "skip", "bulk_threshold": 12, "max_parallel": 8 }
}
```

- `include` / `exclude` / `anchors` / `context`: a glob with no `/` matches the basename anywhere.
- Lane ids are kebab-case and must not be a wiki verb (`search`, `doc`, `list`, …).
- `aliases`: abbreviation → expansions. Keys match exact; a two-word expansion also finds its abbreviation.
