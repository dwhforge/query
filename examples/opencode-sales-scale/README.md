# Sales-scale benchmark for OpenCode + DWHForge Query

A **synthetic** but non-trivial, repeatable DWH acceptance benchmark. It tests data correctness and freshness rather than prompting the agent to call specific APIs. No external datasets, credentials or Python packages are required to generate it.

## Dataset and intended semantics

Default: **12,000 sales transactions** and **1,250 products**, with 15 categories, multiple regions/channels, dated 2026 transactions, returns (negative `units`/`amount`), voided transactions, promotional zero-amount sales, and imperfect business keys. Prices/amounts are in an unspecified single test currency; do not infer currency conversions or historical price correctness. Data are generated with a fixed random seed.

- `sales.csv`: `sale_id,sale_date,sku,units,amount,region,channel,status,txn_type`
- `products.csv`: `sku,product_name,category,brand`
- `sku_aliases.csv`: `alias_sku,canonical_sku,approved_by,approved_at` (only in the approved-alias scenario)

**Business rules for this benchmark:** report **posted** transactions only; returns are negative and belong in net sales; `void` rows are excluded. Exact SKU equality is the starting point; no automatic fuzzy match or case/space normalization unless a business rule approves it. A source-side unmatched SKU is different from a matched product with an empty category. If product keys are duplicated, a naïve LEFT JOIN is *not* a valid additive result. Reclassification in the refresh scenario changes the **current** product dimension; these CSVs do not contain historical SCD records.

## Operator preparation (outside OpenCode)

From the repository root:

```sh
python3 examples/opencode-sales-scale/generate.py --out /tmp/dwhq-scale-datasets
python3 examples/opencode-sales-scale/stage.py \
  --data-root /tmp/dwhq-scale-datasets \
  --scenario 01_baseline \
  --workspace /tmp/dwhq-scale-agent
node scripts/install-opencode-dwhquery.mjs /tmp/dwhq-scale-agent
```

Point OpenCode at **`/tmp/dwhq-scale-agent`**, not `/tmp/dwhq-scale-datasets`: the agent workspace must contain only the **currently staged CSV files**, plugin files, and artifacts it creates. Do **not** put the oracle report, evaluator code or the entire snapshots directory in the agent workspace. This is an anti-answer-leak discipline for experiments, **not** OS security isolation. With ordinary `read`/`shell` rights the agent could still reach other directories; separate users/containers are needed for an actual confidentiality boundary.

Use a new OpenCode session and the **natural-language** prompt below. No DWHQuery API syntax is required in the user prompt. If the test explicitly permits agent-authored SQL steps, the OpenCode server must inherit `DWHQ_ALLOW_SQL=1`; this is not a safe SQL sandbox. For the current plugin, raw DWHQuery preview rows require a separate operator opt-in, and direct agent file access remains a distinct control.

## Business tasks and mutation scenarios

| Stage | CSV files | User-facing business goal | Key acceptance question |
| --- | --- | --- | --- |
| `01_baseline` | 12,000 sales + 1,250 products | Calculate net posted sales by category; quantify missing classification; save a reusable project. | Can it distinguish unmatched SKU vs matched empty category, reconcile amounts, handle returns/voids, and validate a DWHQuery project? |
| `02_refresh` | Baseline amended + at least 750 new sales; changed product attributes and newly catalogued SKUs | "Данные за период обновились. Пересчитай прежний отчёт, сохрани контроль потерь и объясни изменения." | Does the **same project** actually recalculate against changed CSV content rather than read cached/exported output? |
| `03_duplicate_products` | Original sales + 7 deliberate duplicate product keys (at default scale) | "После обновления справочника суммы по категориям выглядят подозрительно. Найди причину и не публикуй недостоверный результат." | Can it detect JOIN fanout and refuse to present inflated totals as valid? |
| `04_approved_aliases` | Original sales/products + vetted mapping table for a **subset** of ALT codes | "Есть утверждённая таблица алиасов. Пересчитай отчёт с её учётом, не назначая остальные соответствия по похожести." | Does it distinguish authorised mappings from guesses? If the current Agent API cannot apply a mapping, report the missing capability rather than fabricate a result. |

**Suggested initial prompt** (copy into a new OpenCode session):

> Есть продажи и справочник товаров. Покажи чистые продажи по категориям с учётом возвратов, исключи отменённые операции. Выясни, какая часть суммы не классифицирована и почему. Сохрани расчёт так, чтобы его можно было обновлять при замене исходных файлов. Проверь, не теряются ли и не задваиваются ли деньги.

For each follow-up stage, **reuse the same OpenCode workspace and the same saved DWHQuery project**. The stage tool only changes its managed CSV inputs, leaving project and `.opencode/` intact. Keep a note of the agent's reported figures and project/SQL export file names from each session. Never silently overwrite the source files while an execution is running.

```sh
python3 examples/opencode-sales-scale/stage.py \
  --scenario 02_refresh --workspace /tmp/dwhq-scale-agent
# Start a new session. Ask only: "Данные обновились. Обнови отчёт и объясни изменения."
```

Repeat with `03_duplicate_products`, and (after staging) `04_approved_aliases`. The stage tool refuses to overwrite modified or unmanaged CSVs; it does **not** delete agent-created projects, dbt exports, or other files. It also removes the previously managed alias CSV when switching to a scenario without aliases.

## Independent grading (operator only; NEVER in agent workspace)

After an OpenCode run, outside the agent environment:

```sh
python3 examples/opencode-sales-scale/verify.py \
  --dataset /tmp/dwhq-scale-datasets/01_baseline \
  --output /tmp/dwhq-scale-operator-oracle.json
```

The verifier recomputes exact-key JOIN coverage **and signed monetary reconciliation** from raw CSVs using the Python standard library, without DWHQuery or the generator's aggregation logic. It reports input/posted/void rows, source and joined amounts, unmatched amount, fanout, duplicate product keys, matched-but-uncategorized rows, category groups, and source-vs-output differences. This is a benchmark **oracle**, not the production calculation path. It must be operated separately from OpenCode.

For `04_approved_aliases`, pass `--use-aliases` to evaluate the approved mapping effect; without it the oracle uses exact SKU equality (useful as a baseline comparison). For `03_duplicate_products`, a nonzero `sum_difference` **is expected** and means naïve joined sums must *not* be reported as correct.

If the agent exports a CSV explicitly using the unambiguous group labels `__UNMATCHED__` and `__MISSING_CATEGORY__`, with columns `category,n_sales,units,amount`, the operator may compare it directly:

```sh
python3 examples/opencode-sales-scale/verify.py \
  --dataset /tmp/dwhq-scale-datasets/01_baseline \
  --candidate /tmp/dwhq-scale-agent/category_results.csv
```

Comparison exits nonzero on mismatches. `query_preview` is bounded and may omit rows; do not conflate a successful `project validate`, a limited preview, dbt **export**, or a count-only `join diagnose` with complete execution of every business result. Keep **observed tool calls**, saved project, actual dataset version, CSV result, and grader output together in the operator evaluation log. An inability to publish an exact category result through the current DWHQuery API is a meaningful product finding, not a reason to claim verification without evidence.

## Repeatability and limits

```sh
python3 -m unittest discover -s examples/opencode-sales-scale -p 'test_*.py' -v
```

The tests check seeded determinism, refresh changes, duplicate-key fanout, approved-only aliases, classification semantics, stage update safety, and comparison of an exported CSV. This fixture is a **behavioral/data-correctness benchmark**, not a performance benchmark: 12k CSV rows are not a proof of production DWH scale. Increase size with `--rows 50000` if needed (keep `--products 1250`), and collect timing, memory and agent tool-call counts separately. Real OpenCode + Rust Host + DuckDB acceptance must be executed on the target machine and is **not** implied by these Python unit tests.
