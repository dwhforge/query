# DWH-RS-QUERY — Product Design

## 1. Product

**DWH-RS-QUERY** — локальное desktop-приложение для построения и превью data-пайплайнов (CSV / Parquet / Postgres → трансформации → экспорт в dbt или Polars).

- Стек UI: Tauri + React + TypeScript + Tailwind
- Исполнение: встроенный DuckDB (Rust core)
- Данные не уходят в облако: процессинг только на машине пользователя (Linux / macOS / Windows)

Repo / packages: `dwh-rs-query`. Tauri app id: `com.dwhrsquery.app`.

## 2. Problem & persona

**Проблема:** собрать воспроизводимый transform-пайплайн без ручного SQL-спагетти и без выгрузки сырых таблиц во внешние сервисы.

**Персона:** аналитик / data engineer, работает с локальными файлами и/или Postgres, хочет быстрый preview и экспорт в dbt/Polars.

## 3. Core loop

1. Загрузить источник (Load*)
2. Добавить шаги (вручную или через AI Chat)
3. Смотреть Preview (≤50 строк) после каждого изменения
4. Переупорядочить историю (DnD) — только если схема валидна
5. Экспортировать пайплайн (dbt / Python Polars)

## 4. MVP surfaces

Один экран — одно composition (не dashboard из виджетов):

| Surface | Роль |
|---------|------|
| **История изменений** | Вертикальный список шагов, DnD reorder |
| **Preview** | Виртуализированная таблица результата (≤50 строк) |
| **AI Chat** | NL → JSON `TransformationStep[]` |
| **Export** | dbt project / Polars script в выбранную папку |

Hero/brand в UI: имя продукта **DWH-RS-QUERY** как главный сигнал заголовка окна / стартового состояния (пустой пайплайн).

## 5. UX rules

- Preview refresh: **debounce 150ms** на правки Filter / CustomSql / Derive expression
- DnD: до применения порядка — validate schema снизу вверх; при ошибке DuckDB — блок операции + текст ошибки
- AI context: только `current_schema` + `applied_steps` + текст пользователя; **сырые строки таблицы не отправляются**
- Широкие таблицы (>50 колонок): виртуализация строк обязательна; колонки — виртуализировать при необходимости, чтобы DOM не рос линейно

## 6. Out of scope (MVP)

- Spatial UI / geo-визуализация (расширение `spatial` только грузится при старте сессии)
- Multi-pipeline workspace, облачный sync, auth
- Полноценный streaming preview построчно по IPC (MVP = batch `LIMIT 50`)
- Pandas producer (канон MVP — Polars)

## 7. Success (user-facing)

Пользователь на Linux открывает приложение, грузит CSV, через чат или UI добавляет Filter + GroupBy, видит preview, перетаскивает шаги без поломки схемы, экспортирует dbt-проект и запускает `dbt run` без ручных правок SQL.

См. инженерный DoD: [SPEC.md § MVP Done Definition](SPEC.md).
