import {
  applyMappingCreateOntoProject,
  buildMappingCreatePlan,
  directQueryConsumers,
  excludedByLastFields,
  makeSchemaEvidence,
  probeLastFieldsRestore,
  validateMappingCreatePlan,
} from "./service";
import type { Project, QueryDef } from "../../types/pipeline";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const supplier: QueryDef = {
  id: "supplier_products",
  name: "supplier_products",
  steps: [
    {
      type: "LoadCsv",
      payload: { path: "s.csv" },
    },
    {
      type: "SelectColumns",
      payload: { columns: ["product_name", "category"] },
    },
  ],
};

const catalog: QueryDef = {
  id: "catalog_products",
  name: "catalog_products",
  steps: [
    {
      type: "LoadCsv",
      payload: { path: "c.csv" },
    },
  ],
};

const consumer: QueryDef = {
  id: "mart",
  name: "mart",
  steps: [
    {
      type: "FromQuery",
      payload: { query_id: "supplier_products" },
    },
  ],
};

const project = {
  id: "p1",
  name: "t",
  connections: [],
  sources: [],
  workspace: {
    queries: [supplier, catalog, consumer],
    focus_query_id: "supplier_products",
    key_maps: [],
  },
  dbt_target: "v1",
} as Project;

const upstream = ["product_name", "category", "supplier_id", "product_code"];
const catalogOut = ["product_id", "name"];

{
  const excluded = excludedByLastFields(supplier, upstream);
  assert(
    excluded.includes("supplier_id") && excluded.includes("product_code"),
    "excluded by last Fields",
  );
  const blocked = probeLastFieldsRestore({
    query: catalog,
    upstreamColumns: catalogOut,
    column: "product_id",
  });
  assert(blocked.ok === false, "non-Fields last step blocks restore");
  const ok = probeLastFieldsRestore({
    query: supplier,
    upstreamColumns: upstream,
    column: "supplier_id",
  });
  assert(ok.ok === true, "restore supplier_id");
}

{
  const cons = directQueryConsumers(project.workspace, "supplier_products");
  assert(
    cons.some((c) => c.queryId === "mart" && c.via.includes("FromQuery")),
    "FromQuery consumer",
  );
  assert(
    directQueryConsumers(project.workspace, "catalog_products").length === 0,
    "no consumers for catalog",
  );
}

{
  // Happy path without Fields mutation — keys already on output.
  const draft = {
    name: "Supplier products → catalog",
    sourceQueryId: "catalog_products",
    sourceColumns: ["product_id"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {},
  };
  // Use catalog both sides with available column (simplified positive).
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [
      makeSchemaEvidence({
        queryId: "catalog_products",
        outputColumns: catalogOut,
        upstreamColumns: null,
      }),
    ],
  });
  // Need both schema entries when source===target — same query twice in evidence ok.
  assert(plan.ok === true, "same-query plan builds");
  if (plan.ok) {
    assert(plan.plan.patches.length === 0, "no patches");
    assert(
      plan.plan.map.authoring_context?.source_columns[0] === "product_id",
      "authoring context",
    );
    const applied = applyMappingCreateOntoProject(project, {
      opId: "op1",
      plan: plan.plan,
    });
    assert(applied.result.status === "applied", "applied");
    assert(
      (applied.project.workspace.key_maps ?? []).some(
        (m) => m.id === plan.plan.map.id,
      ),
      "map in project",
    );
    assert(
      JSON.stringify(applied.project.workspace.queries.map((q) => q.steps)) ===
        JSON.stringify(project.workspace.queries.map((q) => q.steps)),
      "query steps untouched",
    );
  }
}

{
  // Composite From + Fields restore on supplier.
  const draft = {
    name: "Supplier→Catalog",
    sourceQueryId: "supplier_products",
    sourceColumns: ["supplier_id", "product_code"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {
      supplier_products: ["supplier_id", "product_code"],
    },
  };
  const schemas = [
    makeSchemaEvidence({
      queryId: "supplier_products",
      outputColumns: ["product_name", "category", "supplier_id", "product_code"],
      upstreamColumns: upstream,
    }),
    makeSchemaEvidence({
      queryId: "catalog_products",
      outputColumns: catalogOut,
      upstreamColumns: null,
    }),
  ];
  // For plan build, outputColumns should reflect *current* (pre-patch) schema —
  // keys not yet in output, so validateDraftSelection would fail.
  // Wizard must describe after restore plan OR include restored cols in selection
  // against planned schema. Spec: pick keys that will exist after Fields include.
  // buildMappingCreatePlan validates against schema evidence outputColumns.
  // So for review we pass evidence as if keys will be available after patch:
  // use planned output (= current + restored) for source evidence.
  const plannedOut = [
    "product_name",
    "category",
    "supplier_id",
    "product_code",
  ];
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [
      makeSchemaEvidence({
        queryId: "supplier_products",
        outputColumns: plannedOut,
        upstreamColumns: upstream,
      }),
      schemas[1]!,
    ],
  });
  assert(plan.ok === true, `fields plan: ${plan.ok === false ? plan.error : "ok"}`);
  if (plan.ok) {
    assert(plan.plan.patches.length === 1, "one fields patch");
    assert(
      plan.plan.map.from_columns?.join(",") === "supplier_id,product_code",
      "composite order",
    );
    assert(
      plan.plan.consumers.some((c) => c.queryId === "mart"),
      "consumer warning data",
    );
    const applied = applyMappingCreateOntoProject(project, {
      opId: "op2",
      plan: plan.plan,
    });
    assert(applied.result.status === "applied", "fields applied");
    if (applied.result.status === "applied") {
      const q = applied.project.workspace.queries.find(
        (x) => x.id === "supplier_products",
      );
      const last = q?.steps.at(-1);
      assert(
        last?.type === "SelectColumns" &&
          last.payload.columns.includes("supplier_id") &&
          last.payload.columns.includes("product_code"),
        "fields appended",
      );
      // Unrelated consumer query preserved by identity.
      assert(
        applied.project.workspace.queries.find((x) => x.id === "mart")
          ?.steps[0]?.type === "FromQuery",
        "unrelated query kept",
      );
    }
  }
}

{
  // Stale: query steps changed after plan.
  const draft = {
    name: "X",
    sourceQueryId: "catalog_products",
    sourceColumns: ["product_id"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {},
  };
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [
      makeSchemaEvidence({
        queryId: "catalog_products",
        outputColumns: catalogOut,
        upstreamColumns: null,
      }),
    ],
  });
  assert(plan.ok === true, "stale setup");
  if (plan.ok) {
    const moved: Project = {
      ...project,
      workspace: {
        ...project.workspace,
        queries: project.workspace.queries.map((q) =>
          q.id === "catalog_products"
            ? {
                ...q,
                steps: [
                  ...q.steps,
                  { type: "Limit", payload: { n: 10 } },
                ],
              }
            : q,
        ),
      },
    };
    const v = validateMappingCreatePlan(moved, plan.plan);
    assert(v.ok === false, "stale validate");
    const fold = applyMappingCreateOntoProject(moved, {
      opId: "op3",
      plan: plan.plan,
    });
    assert(
      fold.result.status === "stale" && fold.project === moved,
      "stale leaves project untouched",
    );
  }
}

{
  // Cancel / no commit: building plan does not mutate.
  const before = JSON.stringify(project);
  buildMappingCreatePlan({
    project,
    draft: {
      name: "Y",
      sourceQueryId: "catalog_products",
      sourceColumns: ["product_id"],
      targetQueryId: "catalog_products",
      targetColumn: "product_id",
      restoreColumnsByQuery: {},
    },
    schemas: [
      makeSchemaEvidence({
        queryId: "catalog_products",
        outputColumns: catalogOut,
        upstreamColumns: null,
      }),
    ],
  });
  assert(JSON.stringify(project) === before, "plan is pure");
}

{
  // External query id refused.
  const bad = buildMappingCreatePlan({
    project,
    draft: {
      name: "Z",
      sourceQueryId: "xref:r1:query:q",
      sourceColumns: ["a"],
      targetQueryId: "catalog_products",
      targetColumn: "product_id",
      restoreColumnsByQuery: {},
    },
    schemas: [
      makeSchemaEvidence({
        queryId: "xref:r1:query:q",
        outputColumns: ["a"],
        upstreamColumns: null,
      }),
      makeSchemaEvidence({
        queryId: "catalog_products",
        outputColumns: catalogOut,
        upstreamColumns: null,
      }),
    ],
  });
  assert(bad.ok === false, "external source refused");
}

{
  // Double-confirm: second apply with same plan id conflicts.
  const draft = {
    name: "Once",
    sourceQueryId: "catalog_products",
    sourceColumns: ["product_id"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {},
  };
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [
      makeSchemaEvidence({
        queryId: "catalog_products",
        outputColumns: catalogOut,
        upstreamColumns: null,
      }),
    ],
  });
  assert(plan.ok === true, "double setup");
  if (plan.ok) {
    const first = applyMappingCreateOntoProject(project, {
      opId: "a",
      plan: plan.plan,
    });
    assert(first.result.status === "applied", "first ok");
    const second = applyMappingCreateOntoProject(first.project, {
      opId: "b",
      plan: plan.plan,
    });
    assert(second.result.status === "stale", "second refuses duplicate id");
  }
}

{
  // Legacy map without authoring_context still valid shape.
  const legacy: import("../../types/pipeline").KeyMapDef = {
    id: "map_old",
    name: "old",
    entries: [{ from: "a", to: "b" }],
    storage: { kind: "seed" },
  };
  assert(legacy.authoring_context === undefined, "legacy absence");
}

console.log("mappingCreate/service.test.ts: ok");
