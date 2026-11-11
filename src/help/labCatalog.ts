/** Help Lab catalog wire types ([ADR-0039](../../docs/adr/0039-help-lab-catalog.md)). */

export const HELP_LAB_TAB = "help-lab";

export type HelpLabTrack = "start" | "mapping" | "quality" | "advanced";

export type HelpLabRequires = "offline" | "postgres" | "local_cache";

export interface HelpLabCard {
  id: string;
  track: HelpLabTrack | string;
  title: string;
  tagline: string;
  teaches: string[];
  youKeep: string[];
  requires: HelpLabRequires | string;
  featured: boolean;
}

export const TRACK_ORDER: HelpLabTrack[] = [
  "start",
  "quality",
  "mapping",
  "advanced",
];

export const TRACK_LABELS: Record<HelpLabTrack, string> = {
  start: "Start here",
  quality: "Mapping quality",
  mapping: "Mapping patterns",
  advanced: "Advanced",
};

export const REQUIRES_LABELS: Record<string, string> = {
  offline: "Offline",
  postgres: "Needs Postgres",
  local_cache: "Local cache",
};

/** Fallback if host catalog cannot be loaded (keep in sync with fixtures/labs/catalog.json). */
export const FALLBACK_LAB_CATALOG: HelpLabCard[] = [
  {
    id: "recon_ship_sales",
    track: "start",
    title: "Shipments ↔ sales",
    tagline:
      "Plant SKUs vs commercial codes — map, then explain qty and revenue gaps by month.",
    teaches: [
      "Why a plain Join fails when two systems name the same product differently",
      "Partial Mapping + Join Lens on unmatched commercial SKUs",
      "Monthly reconciliation after Apply Mapping",
    ],
    youKeep: [
      "Mapping seed map_sku (exportable dbt seed)",
      "dirty_recon, sales_mapped, recon_by_month queries",
      "A checked calculation you can re-export as SQL/dbt",
    ],
    requires: "offline",
    featured: true,
  },
  {
    id: "keymap",
    track: "start",
    title: "F&B company aliases",
    tagline:
      "POS and cost feeds spell brands differently — one map to company_id, daily then monthly PnL.",
    teaches: [
      "Unmatched names → Add to map from Join Lens",
      "Reuse one Mapping on two feeds",
      "Derive net and roll up by month",
    ],
    youKeep: [
      "seeds/map_company_alias.csv after export",
      "sales_canon / spend_canon / daily_pnl / monthly_pnl",
    ],
    requires: "offline",
    featured: false,
  },
  {
    id: "name_region_match",
    track: "start",
    title: "Vendors · name + region both soft",
    tagline:
      "ComputerParts LLC US≠DE (exact same name). Nestlé / Danone need LLM synonyms on name and region. Mart: vendor_name, region, SUM(qty).",
    teaches: [
      "Exact same vendor_name in different regions are different companies (ComputerParts LLC US ≠ DE)",
      "Brand synonyms (NW bottled water, Danone Eau, EU/RF/Russia) need Matching/LLM on both fields",
      "Name-only Join fans shared names across regions; mapped mart keeps region in the grain",
    ],
    youKeep: [
      "KeyMap seed map_pos_to_vendor (vendor_label,region,vendor_id)",
      "invoices_mapped + by_vendor_region (vendor_name, region, SUM(qty))",
      "Two Matching practice sets: exact same-name cross-region + LLM synonyms",
    ],
    requires: "offline",
    featured: true,
  },
  {
    id: "mapping_quality",
    track: "quality",
    title: "Mapping quality · 100K",
    tagline:
      "Whole-map overview: family/grade drift, concentration, inspect into Join Lens.",
    teaches: [
      "Coverage is not correctness",
      "Aggregate observations with bounded samples",
    ],
    youKeep: [
      "Local demo cache under ~/.dwhforge-query/demos/",
      "Overview tab + lab MappingCheck",
    ],
    requires: "local_cache",
    featured: true,
  },
];
