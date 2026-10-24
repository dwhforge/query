# DWH-RS-QUERY — Engineering Spec

Каноническая инженерная спецификация MVP. Именование: продукт **DWH-RS-QUERY**, packages **dwh-rs-query**, Tauri id `com.dwhrsquery.app`.

## 1. TransformationStep contract

Wire format (Rust serde + TypeScript): tagged enum.

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    LoadCsv { path: String },
    LoadParquet { path: String },
    LoadPostgres { connection_string: String, table_name: String },
    Filter { condition: String },
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    DeriveColumn { name: String, expression: String },
    GroupBy { dimensions: Vec<String>, aggregates: Vec<String> },
    SortBy { column: String, descending: bool },
    CustomSql { raw_sql: String },
}
```

```typescript
export type ColumnType = 'INTEGER' | 'VARCHAR' | 'FLOAT' | 'TIMESTAMP' | 'BOOLEAN';

export interface ColumnMetadata {
  name: string;
  type: ColumnType;
}

export interface TableSchema {
  columns: ColumnMetadata[];
}

export type TransformationStep =
  | { type: 'LoadCsv'; payload: { path: string } }
  | { type: 'LoadParquet'; payload: { path: string } }
  | { type: 'LoadPostgres'; payload: { connection_string: string; table_name: string } }
  | { type: 'Filter'; payload: { condition: string } }
  | { type: 'SelectColumns'; payload: { columns: string[] } }
  | { type: 'RenameColumn'; payload: { from: string; to: string } }
  | { type: 'DeriveColumn'; payload: { name: string; expression: string } }
  | { type: 'GroupBy'; payload: { dimensions: string[]; aggregates: string[] } }
  | { type: 'SortBy'; payload: { column: string; descending: boolean } }
  | { type: 'CustomSql'; payload: { raw_sql: string } };
```

Правила:

- Первый шаг пайплайна — один из `Load*`
- `Filter.condition` — SQL predicate для `WHERE`
- `GroupBy.aggregates` — строки вида `SUM(amount) AS total_amount`
- `CustomSql.raw_sql` содержит плейсхолдер `{{prev_step}}` (заменяется на CTE-имя или `{{ ref('...') }}` в dbt)

## 2. Pipeline compiler

`PipelineCompiler::to_sql(steps, is_preview) -> Result<String, String>`

- Пустой `steps` → error
- CTE: `step_0`, `step_1`, …
- Финал: `SELECT * FROM step_N` + `LIMIT 50` если preview
- Семантика шагов — как в [TZ-EARLY.md §2.2](TZ-EARLY.md); production-код обязан quoting путей/идентификаторов ([ARCHITECTURE.md §6](ARCHITECTURE.md))

## 3. Tauri commands

| Command | In | Out |
|---------|----|-----|
| `preview_pipeline` | `steps: TransformationStep[]` | `{ columns: ColumnMetadata[], rows: JsonValue[][], sql: string }` |
| `describe_pipeline` | `steps`, `upto_index: number` | `TableSchema` |
| `validate_reorder` | `steps`, `from: number`, `to: number` | `{ ok: true }` или `{ ok: false, error: string }` |
| `export_dbt` | `pipeline_name`, `steps`, `output_dir` | `{ path: string }` |
| `export_python` | `pipeline_name`, `steps`, `output_dir` | `{ path: string }` |
| `ai_compile` | `prompt`, `schema`, `steps` | `TransformationStep[]` или error |

`rows` в preview: максимум 50; значения JSON-compatible (числа, строки, bool, null).

## 4. Schema validation (DnD)

Алгоритм для кандидата `steps'` после reorder `from → to`:

1. Если `steps'` пуст или первый шаг не `Load*` → reject
2. Для `i` от `0` до `len-1`: скомпилировать префикс `steps'[0..=i]` с `is_preview=false`, выполнить эквивалент `SELECT * FROM step_i LIMIT 0` (или DESCRIBE результата) в DuckDB
3. Любая ошибка DuckDB → `{ ok: false, error }` — UI **не** применяет reorder
4. Успех всех префиксов → `{ ok: true }` — UI коммитит `steps'`

## 5. Output producers

### 5.1 Trait

```rust
pub trait OutputProducer {
    fn produce(
        &self,
        pipeline_name: &str,
        steps: &[TransformationStep],
        output_dir: &str,
    ) -> Result<(), String>;
}
```

### 5.2 DbtProducer (DoD #3)

Генерировать проект, готовый к `dbt run` без ручных правок `.sql`:

```
{output_dir}/{pipeline_name}/
  dbt_project.yml
  profiles.yml.example
  models/
    sources.yml          # для LoadPostgres
    staging/
      stg_{pipeline_name}__source.sql   # Load* → source model
    marts/
      mart_{pipeline_name}__step_{k}.sql  # transform chain via {{ ref() }}
    schema.yml
```

Правила именования:

- Staging: один (или несколько) `stg_` моделей из Load*
- Каждый последующий transform-шаг — модель в `marts/` с `{{ ref('previous_model') }}`
- `LoadPostgres` → `{{ source('postgres_raw', '<table_name>') }}` + запись в `sources.yml`
- `CustomSql`: заменить `{{prev_step}}` на `{{ ref('...') }}`

Минимальный `dbt_project.yml` с `model-paths: ["models"]` и профилем, указанным в `profiles.yml.example` (duckdb или postgres — зафиксировать duckdb target для локального smoke).

### 5.3 PythonProducer (Polars)

Один файл `{pipeline_name}.py`:

| Step | Polars |
|------|--------|
| LoadCsv | `pl.read_csv(path)` |
| LoadParquet | `pl.read_parquet(path)` |
| LoadPostgres | comment + `NotImplementedError` или `pl.read_database_uri` если connection доступен |
| Filter | `df.filter(...)` — для простых предикатов; иначе `pl.sql` / comment fallback |
| SelectColumns | `df.select([...])` |
| RenameColumn | `df.rename({from: to})` |
| DeriveColumn | `df.with_columns([...])` |
| GroupBy | `df.group_by(dimensions).agg([...])` |
| SortBy | `df.sort(column, descending=...)` |
| CustomSql | comment + `pl.sql` с подстановкой предыдущего relation если возможно |

Целевой вид — method chaining в `run_pipeline()`.

## 6. AI Context Engine

System prompt (обязательные правила ответа — только JSON):

```
Ты — внутреннее ядро компиляции DWH-RS-QUERY AI Engine. Твоя единственная задача — переводить текстовые инструкции пользователя на естественном языке в строго валидные JSON-команды согласно типам данных приложения.
Тебе доступны метаданные текущего состояния таблицы (Текущая схема):
<current_schema>
{JSON_CURRENT_SCHEMA}
</current_schema>
Тебе доступна текущая история примененных шагов:
<applied_steps>
{JSON_APPLIED_STEPS}
</applied_steps>
ПРАВИЛА ОТВЕТА:
1. Выведи ТОЛЬКО валидный JSON (массив TransformationStep).
2. Не пиши текст до или после JSON. Не используй markdown-обертки.
3. Используй только имена колонок из <current_schema>.
4. Для вычисляемых полей — валидный SQL DuckDB.
```

Runtime:

- API key и endpoint — локальные settings приложения
- В запрос **не** включать preview rows / содержимое файлов
- Parse → schema validate колонок → append к steps → `preview_pipeline`

## 7. Frontend constraints

- Preview table: TanStack Table + `@tanstack/react-virtual` (строки обязательны)
- Запрет: полный render всех preview cells через обычные `<tr>/<td>` без virtualizer
- Debounce **150ms** на preview-триггеры для Filter / CustomSql / Derive
- FE не материализует полный результат пайплайна

## 8. MVP Done Definition

1. **Linux startup:** in-memory DuckDB session; extensions `postgres` и `spatial` загружаются без crash процесса.
2. **History DnD:** reorder с валидацией схемы снизу вверх; ломающий reorder блокируется с текстом ошибки DuckDB.
3. **dbt export:** сгенерированный проект выполняется `dbt run` без ручной модификации сгенерированных `.sql`.

## 9. Non-goals (MVP)

- Spatial query steps / map UI
- Row-level streaming preview over IPC
- Cloud sync / multi-user
- Sending raw table data to LLM
