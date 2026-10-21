# Installation Engineering Costing Workbench (Conversation-Driven Costing)

A costing workbench for installation engineering (fire protection / plumbing & drainage /
electrical / HVAC / low-voltage systems): upload real BOQ / price-inquiry / quota tables,
issue tasks in natural language (import, match, price composition, bid clarification,
summarize, export), and the Agent calls tools to modify data — critical write operations
go through a confirmation gate. All amounts and quantities are computed by a deterministic
engine: reproducible and traceable.

## Running

```bash
npm install
npx prisma db push        # Initialize SQLite (prisma/dev.db)
npm run dev               # http://127.0.0.1:3210
npm run build && npm start # Production build
```

The dev server outputs to `.next-dev/`; the production build outputs to `.next/` — the two
never overwrite each other. Both servers default to the same port, so stop whichever is
occupying the port before starting the other.

Data and storage locations (`.env`):

```dotenv
DATABASE_URL="file:./dev.db"
STORAGE_DIR="./storage"
```

### Model Configuration (optional)

Conversation runs on the built-in rule engine by default with all features available;
configuring a model enables LLM planning (costing business rules live in domain services
and the deterministic engine — never in the prompt). Either configuration works:

```dotenv
MODEL_PROVIDER=openai-compatible   # or anthropic; =rule forces the rule engine
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=sk-...
MODEL_NAME=deepseek-chat
# DEEPSEEK_API_KEY alone also works: falls back to DeepSeek's official endpoint + deepseek-chat
```

When the model is unreachable the system automatically falls back to the rule engine and
shows "fixed-task mode" in the conversation.

## Pages

| Path | Description |
|---|---|
| `/` | Project list (create / switch projects) |
| `/new` | Create a new project |
| `/p/[id]` | Project workbench: native conversation track on the left ｜ workspace (BOQ / files / deliverables) on the right |
| `/admin` | Data admin panel: global datasets (material price library, quota library, measure-fee coefficients) with row-level maintenance |

## Typical Workflow

1. **Import files**: drag in Excel/PDF (BOQs, price-inquiry sheets, quota tables, review
   forms, progress measurement tables…). The system recognizes table structure and column
   roles → stores `ProjectFile.meta.mapping` → pushes a "column mapping" view; if confidence
   is insufficient or the user edited the mapping, the confirmation gate suspends and only
   commits after approval (re-importing the same file is idempotent).
2. **Review mapping before confirming**: the column-mapping view shows each table's type,
   "N rows will be imported", and per-column evidence; 0 rows is flagged red (data exists
   but name/quantity columns weren't recognized), so you don't discover a whole table
   missing only after confirming.
3. **Fill prices / compose pricing**: missing main-material price → `material.matchLibrary`
   (preview) → `material.fillFromLibrary` (confirmation gate) writes the **provisional
   main-material price** → `quota.match`/`quota.calculate` computes → `quota.applyCalc`
   (confirmation gate) writes the **comprehensive unit price**.
4. **Fees & deliverables**: `cost.feeSummary` (itemized → measures → other → statutory fees
   → pre-tax → tax → tax-inclusive), `cost.composition` (labor/material/machinery +
   management/profit cost breakdown, cost-inversion warnings), bid-clarification anomaly
   checks, report and Excel export.
5. **Undo anytime**: every modification produces an ActionReceipt (with before/after
   snapshots), supporting row-level undo with conflict rejection.

One-click quoting (autopilot): say "one-click quote / auto quote" or pass `autopilot=true`
to run the deterministic pipeline
`matchLibrary→fillFromLibrary→quota.match→calculate→applyCalc→measureFees→feeSummary`;
write operations still go through the confirmation gate. If the management rate / profit
rate is missing, write-back is skipped with a prompt to complete settings, then reply
"write back pricing" to continue.

## Directory Layout

```
agent/        In-house Agent engine: runtime (conversation loop)/runs (lifecycle & concurrency
              guard)/planner (intent routing)/confirmation/pending (confirmation gate)
              /executor (tool audit & result output)/llm (model egress)/events (SSE events)
              /autopilot + tools/ (domain tools with schema guards)
cost-engine/  Pure-function deterministic costing engine (decimal.js): money/semantic/match/
              quota/aggregate/adjust/fees/costComposition/calcExpr/fileCompare — all amounts
              may only be computed here
file/         Parsing & ingestion: ingest (project file intake & import-confirmation rules),
              excel (header locating/column roles/type inference/write-back), pdf,
              inspection (recognition + template cache), classify (file type/stage),
              factsExtract (ledger facts), compareReport, storage
boq/          BOQ domain services: service (import/query/reprice), mapRow (row→persistence),
              ingestRules (row-level rules)
material/     Material price matching consumer
project/      Project & pricing-settings domain service (payload/facts)
dataset/      Global datasets: service, priceParse, priceMatch, quotaParse (quota-table parsing)
quota/        Quota services: service/library (library loading), matching (match & unmatched
              handling), pricing (material pricing/computation/write-back/manual composition),
              spec (spec retrieval & chapter evidence)
shared/       Cross-boundary types & pure functions: types/mapping (role alignment)/json/settings
src/app/      Next.js routes (pages + /api)
src/ui/       Workbench UI (conversation track, BOQ tables, result views, admin panel,
              shadcn components)
prisma/       Schema & migrations (SQLite; kept Postgres-portable: Json/enums→String)
tests/        vitest (engine/tools/parsing/frontend views)
scripts/      Data import & regression scripts (test-real/check-cost-flow/make-fixtures/
              import-sc2020-*)
```

Current module responsibilities, dependency direction, and verification are documented in
the [architecture notes](docs/restructure-design.md).

## Key Conventions (Red Lines)

- **Comprehensive unit price vs. main-material price**: `unitPrice` is the comprehensive
  unit price (the result of composing labor/material/machinery + management/profit);
  `mainMaterialPrice` is the provisional main-material price (inquiry/information price).
  Material/inquiry prices must **never** be written to `unitPrice`.
- **Tax-inclusive prices**: when a source table's unit-price column is tax-inclusive it is
  flagged `taxIncluded` (itemized items and priced measures alike); such rows are excluded
  from the pre-tax base at aggregation and never taxed twice.
- **Statutory-fee base**: per Sichuan installation conventions the base is the **quota labor
  cost** (written to the ledger after computation); when no base exists it degrades to the
  itemized cost and is annotated.
- **Measure fees**: imported measure BOQs take precedence as ground truth; official
  coefficients may be layered on top (scaffolding / excess height / high-rise / system
  adjustments).
- **Ledger facts**: rate/amount text must go through `parseRateValue`/`parseAmountValue`
  ("9%" ≠ 9); `Number(fact.value)` is forbidden.
- **Traceability**: source-table raw text is fully preserved in `BoqItem.rawCells`
  (including `__nonNumeric/__derived/__decomp` markers); cells changed on Excel write-back
  get annotations.

## Verification

```bash
npm test                     # Unit tests (engine/parsing/tools/frontend views)
npm run typecheck            # tsc --noEmit
npx tsx scripts/test-real.ts # Regression on real costing files (reads desktop samples)
npm run build                # Production build
npx tsx scripts/check-cost-flow.ts   # E2E: isolated DB + real APIs on `next start` (build first)
npm run fixtures             # Generate test Excel files into fixtures/out/
```

## Conventions

- Model keys, `storage/`, `prisma/dev.db`, `.verify/`, and other local state are not
  committed (see `.gitignore`).
- Never commit data files or model keys; rotate any keys used for local debugging before
  production use.
