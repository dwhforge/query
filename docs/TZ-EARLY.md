# ТЕХНИЧЕСКОЕ ЗАДАНИЕ И ИНСТРУКЦИЯ ДЛЯ ИИ-АГЕНТОВ: РЕАЛИЗАЦИЯ DWH-RS-QUERY

> Архив раннего дизайн-документа. Naming нормализован: продукт — **DWH-RS-QUERY**.
> Каноническая инженерия: [DESIGN.md](DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md), [SPEC.md](SPEC.md).

## 1. СИСТЕМНЫЙ КОНТЕКСТ И АРХИТЕКТУРНЫЕ ИНВАРИАНТЫ

DWH-RS-QUERY — локальное desktop-приложение на базе Tauri (Frontend: React/TS/Tailwind, Backend: Rust + встроенный DuckDB).
Главный принцип: **бэкенд на Rust не хранит данные строк в памяти**. Он управляет только AST-деревом шагов (`Vec<TransformationStep>`), транслирует его в SQL для DuckDB и стримит первые 50 строк (Preview) на фронтенд.

Все тяжелые операции (Out-of-Core процессинг, сброс промежуточных хэш-таблиц на диск при `GROUP BY`) берет на себя DuckDB. Безопасность данных абсолютна: весь процессинг происходит локально на Linux/macOS/Windows машине пользователя без отправки сырых данных в облако.

---

## 2. СПЕЦИФИКАЦИЯ БЭКЕНДА (RUST & TAURI CORE)

### 2.1. Контракт Шагов Трансформации (`src-tauri/src/pipeline/model.rs`)

Агенты должны строго следовать следующему перечислению шагов. Любые расширения должны быть строго типизированы.

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    // Входные интерфейсы
    LoadCsv { path: String },
    LoadParquet { path: String },
    LoadPostgres { connection_string: String, table_name: String },

    // Направленные трансформации (Стриминговые операции)
    Filter { condition: String }, // Валидный SQL предикат для WHERE
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    DeriveColumn { name: String, expression: String }, // Вычисляемый столбец (например, "price * qty")

    // Блокирующие трансформации (Агрегация и Сортировка)
    GroupBy {
        dimensions: Vec<String>,
        aggregates: Vec<String> // Формат: ["SUM(amount) AS total_amount", "AVG(qty) AS avg_qty"]
    },
    SortBy { column: String, descending: bool },

    // Эскейп-хэтч для сложной логики
    CustomSql { raw_sql: String }, // Внутри запроса используется плейсхолдер {{prev_step}}
}
```

### 2.2. Архитектура Компилятора Пайплайна (`src-tauri/src/pipeline/compiler.rs`)

Компилятор собирает массив `TransformationStep` в единое декларативное SQL-выражение на базе CTE (`WITH`).

```rust
pub struct PipelineCompiler<'a> {
    steps: &'a [TransformationStep],
}

impl<'a> PipelineCompiler<'a> {
    pub fn new(steps: &'a [TransformationStep]) -> Self {
        Self { steps }
    }

    pub fn to_sql(&self, is_preview: bool) -> Result<String, String> {
        if self.steps.is_empty() {
            return Err("Цепочка шагов пуста".to_string());
        }

        let mut sql = String::new();
        sql.push_str("WITH \n");

        for (idx, step) in self.steps.iter().enumerate() {
            let step_name = format!("step_{}", idx);
            let prev_step = if idx > 0 { format!("step_{}", idx - 1) } else { String::new() };

            let query = match step {
                TransformationStep::LoadCsv { path } => {
                    format!("SELECT * FROM read_csv_auto('{}')", path)
                }
                TransformationStep::LoadParquet { path } => {
                    format!("SELECT * FROM read_parquet('{}')", path)
                }
                TransformationStep::LoadPostgres { connection_string, table_name } => {
                    format!("SELECT * FROM postgres_scan('{}', 'public', '{}')", connection_string, table_name)
                }
                TransformationStep::Filter { condition } => {
                    format!("SELECT * FROM {} WHERE {}", prev_step, condition)
                }
                TransformationStep::SelectColumns { columns } => {
                    format!("SELECT {} FROM {}", columns.join(", "), prev_step)
                }
                TransformationStep::RenameColumn { from, to } => {
                    format!("SELECT * EXCLUDE ({}) , {} AS {} FROM {}", from, from, to, prev_step)
                }
                TransformationStep::DeriveColumn { name, expression } => {
                    format!("SELECT *, ({}) AS {} FROM {}", expression, name, prev_step)
                }
                TransformationStep::GroupBy { dimensions, aggregates } => {
                    format!("SELECT {}, {} FROM {} GROUP BY {}",
                            dimensions.join(", "), aggregates.join(", "), prev_step, dimensions.join(", "))
                }
                TransformationStep::SortBy { column, descending } => {
                    let order = if *descending { "DESC" } else { "ASC" };
                    format!("SELECT * FROM {} ORDER BY {} {}", prev_step, column, order)
                }
                TransformationStep::CustomSql { raw_sql } => {
                    raw_sql.replace("{{prev_step}}", &prev_step)
                }
            };

            sql.push_str(&format!("  {} AS ({})", step_name, query));
            if idx < self.steps.len() - 1 {
                sql.push_str(",\n");
            }
        }

        let last_step = format!("step_{}", self.steps.len() - 1);
        if is_preview {
            sql.push_str(&format!("\nSELECT * FROM {} LIMIT 50;", last_step));
        } else {
            sql.push_str(&format!("\nSELECT * FROM {};", last_step));
        }

        Ok(sql)
    }
}
```

---

## 3. СПЕЦИФИКАЦИЯ ВЫХОДНЫХ МОДУЛЕЙ (OUTPUT PRODUCERS)

### 3.1. Трейт `OutputProducer` (`src-tauri/src/producers/mod.rs`)

```rust
pub trait OutputProducer {
    fn produce(&self, pipeline_name: &str, steps: &[TransformationStep], output_dir: &str) -> Result<(), String>;
}
```

### 3.2. Имплементация dbt Producer (`src-tauri/src/producers/dbt.rs`)

Агент должен сгенерировать логику разделения пайплайна на стейджинг (`stg_`) и финальные марты (`mart_`), используя механизм макросов `{{ ref() }}`.

### 3.3. Имплементация Pure Python (Polars/Pandas) Producer

Продюсер преобразует декларативные шаги в императивный скрипт на Python с использованием цепочки методов (Method Chaining).

```python
import polars as pl

def run_pipeline():
    df = pl.read_csv("data.csv") # Шаг 0
    df = df.filter(pl.col("amount") > 1000) # Шаг 1
    df = df.select(["date", "amount"]) # Шаг 2
    df.write_parquet("output.parquet")
```

---

## 4. СПЕЦИФИКАЦИЯ ФРОНТЕНДА (AI-DRIVEN INTERFACE)

### 4.1. TypeScript Интерфейсы (`src/types/pipeline.ts`)

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

### 4.2. Виртуализация превью

Фронтенд должен использовать TanStack Table совместно с виртуализатором строк (`@tanstack/react-virtual`).
Запрещено рендерить массив превью стандартными `<tr>/<td>` без виртуализации.
Обновление превью — Debounce 150мс при изменении Filter / CustomSql.

---

## 5. AI CONTEXT ENGINE (SYSTEM PROMPT)

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
1. Выведи ТОЛЬКО валидный JSON, соответствующий типу TransformationStep.
2. Не пиши никакого текста до или после JSON. Не используй markdown-обертки типа ```json.
3. Используй только те имена колонок, которые присутствуют в <current_schema>.
4. Для генерации вычисляемых полей используй валидный SQL-синтаксис функций DuckDB.
```

---

## 6. КРИТЕРИИ УСПЕШНОСТИ MVP (DONE DEFINITION)

1. При запуске под Linux приложение успешно инициализирует сессию DuckDB в памяти, подгружает расширения postgres и spatial без вылетов ядра.
2. Фронтенд-компонент «История изменений» поддерживает перетаскивание шагов (Drag-and-Drop) с автоматической валидацией схемы (DESCRIBE) «снизу вверх». Если перетаскивание ломает нижестоящий шаг, UI блокирует операцию с выводом ошибки компилятора DuckDB.
3. Команда «Экспорт в dbt» создает ванильную структуру dbt-проекта, готовую к запуску через CLI командой `dbt run` без ручной модификации сгенерированных `.sql` файлов.
