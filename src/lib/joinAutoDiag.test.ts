/**
 * Run: npx tsx src/lib/joinAutoDiag.test.ts
 */
import {
  joinLooksFixtureSmall,
  shouldAutoRunJoinDiagnostics,
} from "./joinAutoDiag";
import type { Workspace } from "../types/pipeline";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const fixture: Workspace = {
  focus_query_id: "dirty_join",
  queries: [
    {
      id: "sales_daily",
      name: "sales",
      steps: [{ type: "LoadCsv", payload: { path: "/tmp/sales.csv" } }],
    },
    {
      id: "dim_company",
      name: "dim",
      steps: [{ type: "LoadCsv", payload: { path: "/tmp/dim.csv" } }],
    },
    {
      id: "dirty_join",
      name: "dirty_join",
      steps: [
        { type: "FromQuery", payload: { query_id: "sales_daily" } },
        {
          type: "Join",
          payload: {
            right_query_id: "dim_company",
            join_type: "left",
            left_on: ["company"],
            right_on: ["company_id"],
          },
        },
      ],
    },
  ],
};

assert(
  joinLooksFixtureSmall(fixture, "dirty_join", 1),
  "FromQuery + LoadCsv demo must auto-diag",
);

assert(
  shouldAutoRunJoinDiagnostics(fixture, "dirty_join", 1, null),
  "should auto-run without prepare on CSV fixture",
);

const withPg: Workspace = {
  focus_query_id: "j",
  queries: [
    {
      id: "t",
      name: "t",
      steps: [
        {
          type: "LoadPostgres",
          payload: {
            connection_id: "pg",
            schema: "public",
            table_name: "big",
            connection_string: "",
          },
        },
      ],
    },
    {
      id: "j",
      name: "j",
      steps: [
        { type: "FromQuery", payload: { query_id: "t" } },
        {
          type: "Join",
          payload: {
            right_query_id: "t",
            join_type: "inner",
            left_on: ["id"],
            right_on: ["id"],
          },
        },
      ],
    },
  ],
};

assert(
  !joinLooksFixtureSmall(withPg, "j", 1),
  "Postgres loads must not look fixture-small",
);

assert(
  shouldAutoRunJoinDiagnostics(fixture, "dirty_join", 1, {
    prepared: true,
    left_rows: 900,
    right_rows: 50,
    left_materialized: false,
    right_materialized: false,
  }),
  "known small row counts auto-run even if not TEMP-materialized",
);

assert(
  !shouldAutoRunJoinDiagnostics(fixture, "dirty_join", 1, {
    prepared: true,
    left_rows: 200_000,
    right_rows: 50,
    left_materialized: true,
    right_materialized: true,
  }),
  "large prepared sides must stay manual",
);

console.log("joinAutoDiag.test.ts: ok");
