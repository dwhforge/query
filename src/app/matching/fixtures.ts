/**
 * Deterministic Matching fixtures (ADR-0044).
 *
 * Classic acceptance rows kept by id:
 *   a1+Eurpope → propose 1 / alt 2; empty region → no arbitrary pick; z9 incomplete.
 *
 * Rich trial sample (~150 keys, single-output):
 *   ~50% Tier‑1 fuzzy closed (no LLM)
 *   ~40% residue meant for LLM alias-expand / rank
 *   ~10% left unresolved for manual
 */
import type {
  MatchingCandidateView,
  MatchingPlanDraft,
  MatchingProposalView,
} from "./types";

export const FIXTURE_PLAN: MatchingPlanDraft = {
  sourceRef: "Client",
  targetRef: "A",
  mapKeyFields: ["provider", "region"],
  targetIdentityFields: ["id"],
  comparisons: [
    { sourceField: "provider", targetField: "name", role: "soft_signal" },
    {
      sourceField: "region",
      targetField: "region",
      role: "hard_constraint",
    },
  ],
  normalization: ["trim", "casefold"],
  outputs: ["id"],
  ambiguity: "leave_for_manual",
  scope: "cohort",
  semanticRevision: 1,
  uiRevision: 0,
};

/** Target mix sizes for the rich sample (excludes multi-out demo row). */
export const FIXTURE_SAMPLE = {
  fuzzy: 75,
  llm: 60,
  manual: 15,
} as const;

export const FIXTURE_SAMPLE_TOTAL =
  FIXTURE_SAMPLE.fuzzy + FIXTURE_SAMPLE.llm + FIXTURE_SAMPLE.manual;

const REGIONS = [
  "Europe",
  "US",
  "DE",
  "UK",
  "RUS",
  "APAC",
  "LatAm",
  "MEA",
] as const;

const VENDOR_STEMS = [
  "Acme Supplies",
  "Nordic Pack",
  "Cedar Logistics",
  "Atlas Parts",
  "Harbor Foods",
  "Summit Tools",
  "Vertex Media",
  "Cascade Chem",
  "Pioneer Soft",
  "Maple Retail",
  "Orion Metals",
  "Beacon Pharma",
  "Silver Line",
  "Copper River",
  "Granite Works",
] as const;

/** Opaque POS label → canonical vendor (LLM expand targets). */
const LLM_ALIAS_PAIRS: { label: string; canonical: string; region: string }[] =
  [
    { label: "NW bottled water", canonical: "Nestle Waters", region: "Europe" },
    { label: "CCEP", canonical: "Coca-Cola Europacific", region: "Europe" },
    { label: "RF Holdings", canonical: "Russian Federation Trading", region: "RUS" },
    { label: "Son-in-law Office", canonical: "Kushner Advisors", region: "US" },
    { label: "IBM Corp.", canonical: "International Business Machines", region: "US" },
    { label: "BMW AG", canonical: "Bayerische Motoren Werke", region: "DE" },
    { label: "J&J Consumer", canonical: "Johnson and Johnson", region: "US" },
    { label: "L'Oreal SA", canonical: "Loreal Group", region: "Europe" },
    { label: "Danone Waters EU", canonical: "Danone Waters", region: "Europe" },
    { label: "Unilever PLC", canonical: "Unilever", region: "UK" },
  ];

const GEO_ALIAS_PAIRS: { sourceRegion: string; targetRegion: string }[] = [
  { sourceRegion: "USA", targetRegion: "US" },
  { sourceRegion: "U.S.A.", targetRegion: "US" },
  { sourceRegion: "United States", targetRegion: "US" },
  { sourceRegion: "RF", targetRegion: "RUS" },
  { sourceRegion: "Russian Federation", targetRegion: "RUS" },
  { sourceRegion: "Great Britain", targetRegion: "UK" },
  { sourceRegion: "Deutschland", targetRegion: "DE" },
  { sourceRegion: "EU", targetRegion: "Europe" },
];

function cand(
  id: string,
  name: string,
  region: string,
  extra?: Record<string, string>,
): MatchingCandidateView {
  return {
    candidateId: `cand:${id}`,
    targetId: id,
    outputValues: [id],
    fields: { id, name, region, ...extra },
    evidenceRevision: 1,
  };
}

function vendorName(i: number): string {
  const stem = VENDOR_STEMS[i % VENDOR_STEMS.length]!;
  const n = Math.floor(i / VENDOR_STEMS.length) + 1;
  return n === 1 ? stem : `${stem} ${n}`;
}

function regionOf(i: number): string {
  return REGIONS[i % REGIONS.length]!;
}

/** Classic + generated dictionary (≥ enough for expand lookup). */
export const FIXTURE_CANDIDATES: MatchingCandidateView[] = (() => {
  const out: MatchingCandidateView[] = [
    cand("1", "a1", "Europe"),
    cand("2", "a1", "RUS"),
    cand("3", "b2", "EU", { code: "v1" }),
  ];
  for (let i = 0; i < 90; i++) {
    const id = String(100 + i);
    out.push(cand(id, vendorName(i), regionOf(i)));
  }
  for (let i = 0; i < LLM_ALIAS_PAIRS.length; i++) {
    const p = LLM_ALIAS_PAIRS[i]!;
    out.push(cand(`L${i}`, p.canonical, p.region));
  }
  // Geo-canonical rows for soft name + aliased region pairs.
  for (let i = 0; i < GEO_ALIAS_PAIRS.length; i++) {
    const g = GEO_ALIAS_PAIRS[i]!;
    out.push(cand(`G${i}`, `GeoCo ${i + 1}`, g.targetRegion));
  }
  return out;
})();

/** Multi-output candidate pair (same target row). */
export const FIXTURE_MULTI_OUT_CANDIDATES: MatchingCandidateView[] = [
  {
    candidateId: "cand:m1",
    targetId: "10",
    outputValues: ["10", "sku-a"],
    fields: { id: "10", name: "widget", sku: "sku-a" },
    evidenceRevision: 1,
  },
  {
    candidateId: "cand:m2",
    targetId: "11",
    outputValues: ["11", "sku-b"],
    fields: { id: "11", name: "widget", sku: "sku-b" },
    evidenceRevision: 1,
  },
];

function baseProp(
  partial: Omit<MatchingProposalView, "semanticPlanRevision" | "evidenceRevision"> & {
    semanticPlanRevision?: number;
  },
  semanticRev: number,
): MatchingProposalView {
  return {
    evidenceRevision: 1,
    semanticPlanRevision: semanticRev,
    ...partial,
  };
}

function classicProposals(semanticRev: number): MatchingProposalView[] {
  return [
    baseProp(
      {
        proposalId: "prop:a1-eurpope",
        mapKey: ["a1", "Eurpope"],
        sourceValues: { provider: "a1", region: "Eurpope" },
        affectedSourceRows: 24,
        proposedCandidateId: "cand:1",
        alternativeCandidateIds: ["cand:2"],
        state: "proposed",
        provenance: "fixture",
        searchIncomplete: false,
        evidence: [
          { field: "name", note: "matched (typo region)" },
          { field: "region", note: "probable typo Europe↔Eurpope" },
          { field: "bucket", note: "llm residue (alts)" },
        ],
      },
      semanticRev,
    ),
    baseProp(
      {
        proposalId: "prop:a1-empty-region",
        mapKey: ["a1", ""],
        sourceValues: { provider: "a1", region: "" },
        affectedSourceRows: 3,
        proposedCandidateId: null,
        alternativeCandidateIds: ["cand:1", "cand:2"],
        state: "ambiguous",
        provenance: "fixture",
        searchIncomplete: false,
        evidence: [
          { field: "name", note: "matched" },
          { field: "region", note: "empty — no arbitrary pick" },
          { field: "bucket", note: "manual" },
        ],
      },
      semanticRev,
    ),
    baseProp(
      {
        proposalId: "prop:incomplete",
        mapKey: ["z9", "Asia"],
        sourceValues: { provider: "z9", region: "Asia" },
        affectedSourceRows: 1,
        proposedCandidateId: null,
        alternativeCandidateIds: [],
        state: "incomplete_search",
        provenance: "fixture",
        searchIncomplete: true,
        evidence: [
          { field: "search", note: "candidate search truncated" },
          { field: "bucket", note: "llm residue (opaque / truncated)" },
        ],
      },
      semanticRev,
    ),
    baseProp(
      {
        proposalId: "prop:multi-out",
        mapKey: ["widget"],
        sourceValues: { name: "widget" },
        affectedSourceRows: 2,
        proposedCandidateId: "cand:m1",
        alternativeCandidateIds: ["cand:m2"],
        state: "proposed",
        provenance: "fixture",
        searchIncomplete: false,
        evidence: [{ field: "name", note: "matched" }],
      },
      semanticRev,
    ),
  ];
}

/**
 * Build the rich cohort. Classic rows occupy first slots of their buckets so
 * acceptance ids stay stable; remaining slots are generated.
 */
function richProposals(semanticRev: number): MatchingProposalView[] {
  const classic = classicProposals(semanticRev);
  const eurpope = classic[0]!;
  const empty = classic[1]!;
  const incomplete = classic[2]!;

  const fuzzy: MatchingProposalView[] = [];
  // Fill fuzzy to FIXTURE_SAMPLE.fuzzy (all deterministic, no alts).
  for (let i = 0; i < FIXTURE_SAMPLE.fuzzy; i++) {
    const id = String(100 + i);
    const name = vendorName(i);
    const region = regionOf(i);
    // Mild typo on ~1/3 so evidence looks like Tier‑1, still single-candidate.
    const typo =
      i % 3 === 0 && name.length > 4
        ? `${name.slice(0, 2)}${name.slice(3)}`
        : name;
    fuzzy.push(
      baseProp(
        {
          proposalId: `prop:fuzzy-${i}`,
          mapKey: [typo, region],
          sourceValues: { provider: typo, region },
          affectedSourceRows: 1 + (i % 5),
          proposedCandidateId: `cand:${id}`,
          alternativeCandidateIds: [],
          state: "proposed",
          provenance: "fuzzy",
          searchIncomplete: false,
          evidence: [
            {
              field: "name",
              note:
                typo === name
                  ? "exact / normalize"
                  : `Levenshtein typo → ${name}`,
            },
            { field: "bucket", note: "fuzzy" },
          ],
        },
        semanticRev,
      ),
    );
  }

  const llm: MatchingProposalView[] = [eurpope, incomplete];
  let llmIdx = 0;
  while (llm.length < FIXTURE_SAMPLE.llm) {
    const kind = llmIdx % 3;
    if (kind === 0) {
      const pair = LLM_ALIAS_PAIRS[llmIdx % LLM_ALIAS_PAIRS.length]!;
      // Keep the opaque label intact for alias expand; disambiguate via site tag
      // that normalize strips for lookup (` #N`).
      const label =
        llmIdx < LLM_ALIAS_PAIRS.length
          ? pair.label
          : `${pair.label} #${llmIdx}`;
      llm.push(
        baseProp(
          {
            proposalId: `prop:llm-alias-${llmIdx}`,
            mapKey: [label, pair.region],
            sourceValues: { provider: label, region: pair.region },
            affectedSourceRows: 1 + (llmIdx % 4),
            proposedCandidateId: null,
            alternativeCandidateIds: [],
            state: "incomplete_search",
            provenance: "fixture",
            searchIncomplete: true,
            evidence: [
              {
                field: "name",
                note: `opaque alias — expect LLM → ${pair.canonical}`,
              },
              { field: "bucket", note: "llm" },
            ],
          },
          semanticRev,
        ),
      );
    } else if (kind === 1) {
      const g = GEO_ALIAS_PAIRS[llmIdx % GEO_ALIAS_PAIRS.length]!;
      const gi = llmIdx % GEO_ALIAS_PAIRS.length;
      const name = `GeoCo ${gi + 1}`;
      const regionKey =
        llmIdx < GEO_ALIAS_PAIRS.length
          ? g.sourceRegion
          : `${g.sourceRegion}/${llmIdx}`;
      llm.push(
        baseProp(
          {
            proposalId: `prop:llm-geo-${llmIdx}`,
            mapKey: [name, regionKey],
            sourceValues: { provider: name, region: regionKey },
            affectedSourceRows: 2,
            proposedCandidateId: null,
            alternativeCandidateIds: [`cand:G${gi}`],
            state: "ambiguous",
            provenance: "fixture",
            searchIncomplete: false,
            evidence: [
              {
                field: "region",
                note: `geo synonym ${g.sourceRegion}↔${g.targetRegion}`,
              },
              { field: "bucket", note: "llm" },
            ],
          },
          semanticRev,
        ),
      );
    } else {
      // Near-miss: proposed with competing alt — LLM rank / human.
      const i = llmIdx % 90;
      const id = String(100 + i);
      const alt = String(100 + ((i + 7) % 90));
      const name = vendorName(i);
      const region = `${regionOf(i)}~${llmIdx}`;
      llm.push(
        baseProp(
          {
            proposalId: `prop:llm-near-${llmIdx}`,
            mapKey: [name, region],
            sourceValues: { provider: name, region },
            affectedSourceRows: 1,
            proposedCandidateId: `cand:${id}`,
            alternativeCandidateIds: [`cand:${alt}`],
            state: "proposed",
            provenance: "fixture",
            searchIncomplete: false,
            evidence: [
              { field: "name", note: "near-miss — rank among alts" },
              { field: "bucket", note: "llm" },
            ],
          },
          semanticRev,
        ),
      );
    }
    llmIdx += 1;
  }

  const manual: MatchingProposalView[] = [empty];
  let manIdx = 0;
  while (manual.length < FIXTURE_SAMPLE.manual) {
    const kind = manIdx % 3;
    if (kind === 0) {
      const name = vendorName(manIdx + 3);
      manual.push(
        baseProp(
          {
            proposalId: `prop:manual-empty-${manIdx}`,
            mapKey: [name, ""],
            sourceValues: { provider: name, region: "" },
            affectedSourceRows: 1 + (manIdx % 3),
            proposedCandidateId: null,
            alternativeCandidateIds: [
              `cand:${String(100 + (manIdx % 90))}`,
              `cand:${String(100 + ((manIdx + 1) % 90))}`,
            ],
            state: "ambiguous",
            provenance: "fixture",
            searchIncomplete: false,
            evidence: [
              { field: "region", note: "empty — no arbitrary pick" },
              { field: "bucket", note: "manual" },
            ],
          },
          semanticRev,
        ),
      );
    } else if (kind === 1) {
      manual.push(
        baseProp(
          {
            proposalId: `prop:manual-none-${manIdx}`,
            mapKey: [`UNKNOWN-${manIdx}`, "Narnia"],
            sourceValues: {
              provider: `UNKNOWN-${manIdx}`,
              region: "Narnia",
            },
            affectedSourceRows: 1,
            proposedCandidateId: null,
            alternativeCandidateIds: [],
            state: "no_candidates",
            provenance: "fixture",
            searchIncomplete: false,
            evidence: [
              { field: "search", note: "no dictionary hit — manual entry" },
              { field: "bucket", note: "manual" },
            ],
          },
          semanticRev,
        ),
      );
    } else {
      manual.push(
        baseProp(
          {
            proposalId: `prop:manual-conflict-${manIdx}`,
            mapKey: ["a1", `ConflictZone-${manIdx}`],
            sourceValues: {
              provider: "a1",
              region: `ConflictZone-${manIdx}`,
            },
            affectedSourceRows: 2,
            proposedCandidateId: null,
            alternativeCandidateIds: ["cand:1", "cand:2", "cand:3"],
            state: "ambiguous",
            provenance: "fixture",
            searchIncomplete: false,
            evidence: [
              {
                field: "region",
                note: "conflicting regions — leave for manual",
              },
              { field: "bucket", note: "manual" },
            ],
          },
          semanticRev,
        ),
      );
    }
    manIdx += 1;
  }

  // Stable order: fuzzy → llm → manual (classic ids embedded in llm/manual).
  return [...fuzzy, ...llm, ...manual];
}

export function fixtureProposals(semanticRev = 1): MatchingProposalView[] {
  return [...richProposals(semanticRev), classicProposals(semanticRev)[3]!];
}

/** Counts for the single-output trial cohort (multi-out excluded). */
export function fixtureSampleBucketCounts(proposals: MatchingProposalView[]): {
  fuzzy: number;
  llm: number;
  manual: number;
  total: number;
} {
  let fuzzy = 0;
  let llm = 0;
  let manual = 0;
  for (const p of proposals) {
    if (p.proposalId === "prop:multi-out") continue;
    const bucket =
      p.evidence.find((e) => e.field === "bucket")?.note ??
      (p.provenance === "fuzzy" ? "fuzzy" : "");
    if (bucket.startsWith("fuzzy")) fuzzy += 1;
    else if (bucket.startsWith("llm") || bucket.includes("llm residue"))
      llm += 1;
    else if (bucket.startsWith("manual")) manual += 1;
    else if (p.provenance === "fuzzy" && p.alternativeCandidateIds.length === 0)
      fuzzy += 1;
    else manual += 1;
  }
  return { fuzzy, llm, manual, total: fuzzy + llm + manual };
}

export function fixtureCandidatesForPlan(
  plan: MatchingPlanDraft,
): MatchingCandidateView[] {
  if (plan.outputs.length > 1) {
    return [...FIXTURE_CANDIDATES.slice(0, 2), ...FIXTURE_MULTI_OUT_CANDIDATES];
  }
  return FIXTURE_CANDIDATES;
}
