---
name: DWHQuery Data Workbench
description: Build, validate and export repeatable business data pipelines from CSV, Parquet and PostgreSQL using DWHQuery tools, including JOIN reconciliation and monthly summaries. Use for natural-language data integration and data quality requests without requiring the user to know DWHQuery.
---

# Business-data tasks

Translate the user's business objective into a reproducible data pipeline. DWHQuery is an implementation tool, not a user-facing prerequisite. Ask only about missing business semantics or permissions that affect correctness, such as the definition of a payment date, currency normalization, or whether duplicate documents should be deduplicated.

1. `dwhquery_capabilities` discovers available commands. `dwhquery_project_create` creates a new project. Never modify an existing user's project unless the operator has explicitly allowed it and the user asked.
2. Register CSV/Parquet sources inside the configured business workspace with `dwhquery_query_add`. For PostgreSQL, use `dwhquery_connection_add` with the **name** of an environment variable that the operator set, never the credential itself.
3. After each creation or edit, use `dwhquery_project_inspect` to discover real Query IDs and step indices. Never guess IDs, column names, or join predicates. Run `dwhquery_query_describe` before constructing expressions or JOIN pairs.
4. Use `dwhquery_query_join`, `dwhquery_query_step`, and `dwhquery_query_derive` as needed. SQL expressions require an explicit operator `DWHQ_ALLOW_SQL=1`; do not bypass the refusal with another tool.
5. Check results with `dwhquery_project_validate`, `dwhquery_query_preview`, and for JOINs `dwhquery_join_diagnose`. A schema check and 50-row preview are not full-data correctness proofs. Do not silently accept speculative entity mappings.
6. `dwhquery_project_export` produces dbt files, **not** a successful `dbt build` or warehouse publication. Report remaining unverified assumptions and the project path.

All DWHQuery tool arguments are internal machine interfaces. The user may talk only about companies, invoices, payments, shipments, customers, regions, classifications or other domain concepts. Explain outputs in the same business vocabulary. Do not imply that the OpenCode plugin removes the general shell/file tools or their permissions; use ordinary user approvals for source access and any external writes. Never transmit raw row values or connection strings to an LLM by default.
