import {
  applyMappingCreateOntoProject,
  assertLiveSchemaMatchesPlan,
  basisQueryFingerprints,
  buildMappingCreatePlan,
  directQueryConsumers,
  excludedByLastFields,
  makeSchemaEvidence,
  plannedOutputColumns,
  probeLastFieldsRestore,
  validateMappingCreatePlan,
} from "./service";
import type { Project, QueryDef, Workspace } from "../../types/pipeline";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const rawSupplier: QueryDef = {
  id: "raw_supplier",
  name: "raw_supplier",
  steps: [{ type: "LoadCsv", payload: { path: "raw_s.csv" } }],
};

const supplier: QueryDef = {
  id: "supplier_products",
  name: "supplier_products",
  steps: [
    { type: "FromQuery", payload: { query_id: "raw_supplier" } },
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
    {
      type: "SelectColumns",
      payload: { columns: ["name"] },
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

const workspace: Workspace = {
  queries: [rawSupplier, supplier, catalog, consumer],
  focus_query_id: "supplier_products",
  key_maps: [],
};

const project = {
  id: "p1",
  name: "t",
  connections: [],
  sources: [],
  workspace,
  dbt_target: "v1",
} as Project;

const upstream = ["product_name", "category", "supplier_id", "product_code"];
const catalogUpstream = ["product_id", "name"];
const catalogOut = ["name"];

function ev(
  queryId: string,
  outputColumns: string[],
  upstreamColumns: string[] | null,
  ws: Workspace = workspace,
) {
  return makeSchemaEvidence({
    workspace: ws,
    queryId,
    outputColumns,
    upstreamColumns,
  });
}

{
  const excluded = excludedByLastFields(supplier, upstream);
  assert(
    excluded.includes("supplier_id") && excluded.includes("product_code"),
    "excluded by last Fields",
  );
  const blocked = probeLastFieldsRestore({
    query: catalog,
    upstreamColumns: catalogUpstream,
    column: "product_id",
  });
  assert(blocked.ok === true, "catalog can restore product_id");
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
  const basis = basisQueryFingerprints(workspace, "supplier_products");
  assert(basis.ok === true, "basis ok");
  if (basis.ok) {
    assert(
      basis.defs.raw_supplier != null && basis.defs.supplier_products != null,
      "basis includes upstream",
    );
  }
}

{
  // Happy path without Fields mutation — keys already on output.
  const simpleCatalog: QueryDef = {
    id: "catalog_products",
    name: "catalog_products",
    steps: [{ type: "LoadCsv", payload: { path: "c.csv" } }],
  };
  const simpleWs: Workspace = {
    queries: [simpleCatalog],
    focus_query_id: "catalog_products",
    key_maps: [],
  };
  const simpleProject = {
    ...project,
    workspace: simpleWs,
  } as Project;
  const draft = {
    name: "Supplier products → catalog",
    sourceQueryId: "catalog_products",
    sourceColumns: ["product_id"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {},
  };
  const plan = buildMappingCreatePlan({
    project: simpleProject,
    draft,
    schemas: [
      ev("catalog_products", ["product_id", "name"], null, simpleWs),
    ],
  });
  assert(plan.ok === true, "same-query plan builds");
  if (plan.ok) {
    assert(plan.plan.patches.length === 0, "no patches");
    assert(
      plan.plan.map.authoring_context?.source_columns[0] === "product_id",
      "authoring context",
    );
    const applied = applyMappingCreateOntoProject(simpleProject, {
      opId: "op1",
      plan: plan.plan,
    });
    assert(applied.result.status === "applied", "applied");
  }
}

{
  // Composite From + Fields restore — evidence stays pre-patch (observed).
  const draft = {
    name: "Supplier→Catalog",
    sourceQueryId: "supplier_products",
    sourceColumns: ["supplier_id", "product_code"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {
      supplier_products: ["supplier_id", "product_code"],
      catalog_products: ["product_id"],
    },
  };
  const schemas = [
    ev("supplier_products", ["product_name", "category"], upstream),
    ev("catalog_products", catalogOut, catalogUpstream),
  ];
  assert(
    !schemas[0]!.outputColumns.includes("supplier_id"),
    "observed source lacks restore cols",
  );
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas,
  });
  assert(
    plan.ok === true,
    `fields plan: ${plan.ok === false ? plan.error : "ok"}`,
  );
  if (plan.ok) {
    assert(plan.plan.patches.length === 2, "source + target fields patches");
    assert(
      plan.plan.map.from_columns?.join(",") === "supplier_id,product_code",
      "composite order",
    );
    const plannedSrc = plannedOutputColumns(schemas[0]!, plan.plan.patches);
    assert(
      plannedSrc.includes("supplier_id") && plannedSrc.includes("product_code"),
      "planned source has restores",
    );
    assert(
      plan.plan.expectedQueryDefs.raw_supplier != null,
      "expected defs include upstream raw",
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
      const cat = applied.project.workspace.queries.find(
        (x) => x.id === "catalog_products",
      );
      const catLast = cat?.steps.at(-1);
      assert(
        catLast?.type === "SelectColumns" &&
          catLast.payload.columns.includes("product_id"),
        "target fields restored",
      );
    }
  }
}

{
  // Upstream changed, selected query steps unchanged → stale.
  const draft = {
    name: "Upstream stale",
    sourceQueryId: "supplier_products",
    sourceColumns: ["supplier_id"],
    targetQueryId: "catalog_products",
    targetColumn: "product_id",
    restoreColumnsByQuery: {
      supplier_products: ["supplier_id"],
      catalog_products: ["product_id"],
    },
  };
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [
      ev("supplier_products", ["product_name", "category"], upstream),
      ev("catalog_products", catalogOut, catalogUpstream),
    ],
  });
  assert(plan.ok === true, "upstream stale setup");
  if (plan.ok) {
    const moved: Project = {
      ...project,
      workspace: {
        ...project.workspace,
        queries: project.workspace.queries.map((q) =>
          q.id === "raw_supplier"
            ? {
                ...q,
                steps: [
                  ...q.steps,
                  { type: "Limit", payload: { n: 5 } },
                ],
              }
            : q,
        ),
      },
    };
    // supplier_products steps fingerprint unchanged:
    assert(
      JSON.stringify(
        moved.workspace.queries.find((q) => q.id === "supplier_products")!
          .steps,
      ) === JSON.stringify(supplier.steps),
      "selected query steps same",
    );
    const v = validateMappingCreatePlan(moved, plan.plan);
    assert(v.ok === false, "upstream basis stale");
    const fold = applyMappingCreateOntoProject(moved, {
      opId: "op-up",
      plan: plan.plan,
    });
    assert(
      fold.result.status === "stale" && fold.project === moved,
      "upstream stale leaves project untouched",
    );
  }
}

{
  // Live schema digest mismatch.
  const draft = {
    name: "Digest",
    sourceQueryId: "catalog_products",
    sourceColumns: ["name"],
    targetQueryId: "catalog_products",
    targetColumn: "name",
    restoreColumnsByQuery: {},
  };
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [ev("catalog_products", catalogOut, catalogUpstream)],
  });
  assert(plan.ok === true, "digest setup");
  if (plan.ok) {
    const live = [
      ev("catalog_products", ["name", "extra"], catalogUpstream),
    ];
    const match = assertLiveSchemaMatchesPlan(plan.plan, live);
    assert(match.ok === false, "digest mismatch refuses");
  }
}

{
  // Stale: query steps changed after plan.
  const draft = {
    name: "X",
    sourceQueryId: "catalog_products",
    sourceColumns: ["name"],
    targetQueryId: "catalog_products",
    targetColumn: "name",
    restoreColumnsByQuery: {},
  };
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [ev("catalog_products", catalogOut, catalogUpstream)],
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
                steps: [...q.steps, { type: "Limit", payload: { n: 10 } }],
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
  const before = JSON.stringify(project);
  buildMappingCreatePlan({
    project,
    draft: {
      name: "Y",
      sourceQueryId: "catalog_products",
      sourceColumns: ["name"],
      targetQueryId: "catalog_products",
      targetColumn: "name",
      restoreColumnsByQuery: {},
    },
    schemas: [ev("catalog_products", catalogOut, catalogUpstream)],
  });
  assert(JSON.stringify(project) === before, "plan is pure");
}

{
  const bad = buildMappingCreatePlan({
    project,
    draft: {
      name: "Z",
      sourceQueryId: "xref:r1:query:q",
      sourceColumns: ["a"],
      targetQueryId: "catalog_products",
      targetColumn: "name",
      restoreColumnsByQuery: {},
    },
    schemas: [
      {
        queryId: "xref:r1:query:q",
        outputColumns: ["a"],
        upstreamColumns: null,
        digest: "a",
        basisQueryDefs: { "xref:r1:query:q": "[]" },
      },
      ev("catalog_products", catalogOut, catalogUpstream),
    ],
  });
  assert(bad.ok === false, "external source refused");
}

{
  const draft = {
    name: "Once",
    sourceQueryId: "catalog_products",
    sourceColumns: ["name"],
    targetQueryId: "catalog_products",
    targetColumn: "name",
    restoreColumnsByQuery: {},
  };
  const plan = buildMappingCreatePlan({
    project,
    draft,
    schemas: [ev("catalog_products", catalogOut, catalogUpstream)],
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
  const legacy: import("../../types/pipeline").KeyMapDef = {
    id: "map_old",
    name: "old",
    entries: [{ from: "a", to: "b" }],
    storage: { kind: "seed" },
  };
  assert(legacy.authoring_context === undefined, "legacy absence");
}

console.log("mappingCreate/service.test.ts: ok");
