#!/usr/bin/env python3
"""Operator-side ground truth for the synthetic sales benchmark (stdlib only).

Run outside the OpenCode workspace. Does NOT execute DWHQuery: compare its output
and diagnostic claims with these independently computed facts.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

ZERO = Decimal("0.00")


def rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def money(v: Decimal) -> str:
    return f"{v.quantize(Decimal('0.01')):.2f}"


def verify(dataset: Path, use_aliases: bool = False) -> dict:
    sales = rows(dataset / "sales.csv")
    products = rows(dataset / "products.csv")
    aliases = rows(dataset / "sku_aliases.csv") if use_aliases else []
    if use_aliases and not (dataset / "sku_aliases.csv").is_file():
        raise ValueError("--use-aliases requires sku_aliases.csv")
    product_by_sku: dict[str, list[dict[str, str]]] = defaultdict(list)
    for product in products:
        if product["sku"]:
            product_by_sku[product["sku"]].append(product)
    # Strict approval source, never infer mapping from code similarity.
    alias_map: dict[str, str] = {}
    for row in aliases:
        k, target = row["alias_sku"], row["canonical_sku"]
        if k in alias_map and alias_map[k] != target:
            raise ValueError(f"Ambiguous approved alias: {k}")
        if target not in product_by_sku:
            raise ValueError(f"Alias target not found in products: {target}")
        alias_map[k] = target

    posted = [s for s in sales if s["status"] == "posted"]
    void = len(sales) - len(posted)
    if len({s["sale_id"] for s in sales}) != len(sales):
        raise ValueError("Duplicate sale_id in fixture")
    cat: dict[str, dict] = defaultdict(lambda: {"n_sales": 0, "units": 0, "amount": ZERO})
    unmatched = 0
    missing_category = 0
    extra_join_rows = 0
    unmatched_amount = ZERO
    matched_missing_category_amount = ZERO
    source_amount = ZERO
    source_units = 0
    joined_amount = ZERO
    joined_units = 0
    mapped_by_alias = 0
    for s in posted:
        amount = Decimal(s["amount"])
        units = int(s["units"])
        source_amount += amount
        source_units += units
        sku = s["sku"]
        key = sku
        if sku not in product_by_sku and sku in alias_map:
            key = alias_map[sku]
            mapped_by_alias += 1
        matches = product_by_sku.get(key, [])
        if not matches:
            unmatched += 1
            unmatched_amount += amount
            matches_for_rollup = ["__UNMATCHED__"]
        else:
            extra_join_rows += len(matches) - 1
            matches_for_rollup = []
            if all(not m["category"] for m in matches):
                missing_category += 1
                matched_missing_category_amount += amount
            for product in matches:
                matches_for_rollup.append(product["category"] or "__MISSING_CATEGORY__")
        for c in matches_for_rollup:
            agg = cat[c]
            agg["n_sales"] += 1
            agg["units"] += units
            agg["amount"] += amount
            joined_amount += amount
            joined_units += units

    groups = sum(1 for matches in product_by_sku.values() if len(matches) > 1)
    rollup = {c: {"n_sales": v["n_sales"], "units": v["units"], "amount": money(v["amount"])}
              for c, v in sorted(cat.items())}
    return {
        "input_sales_rows": len(sales),
        "excluded_void_rows": void,
        "included_sales_rows": len(posted),
        "products_rows": len(products),
        "right_duplicate_key_groups": groups,
        "left_join_output_rows": len(posted) + extra_join_rows,
        "fanout_extra_rows": extra_join_rows,
        "matched_rows": len(posted) - unmatched,
        "unmatched_rows": unmatched,
        "unmatched_amount": money(unmatched_amount),
        "matched_missing_category_rows": missing_category,
        "matched_missing_category_amount": money(matched_missing_category_amount),
        "approved_aliases_applied_rows": mapped_by_alias,
        "source_units": source_units,
        "joined_units": joined_units,
        "source_amount": money(source_amount),
        "joined_amount": money(joined_amount),
        "sum_difference": money(joined_amount - source_amount),
        "categories": rollup,
    }


def compare_csv(path: Path, categories: dict) -> dict:
    """Accept a human-exported CSV with category,n_sales,units,amount.

    Null/missing category needs an explicit label: no silent mixing with unmatched.
    """
    result: dict[str, dict] = {}
    for row in rows(path):
        cat = row["category"]
        if cat in result:
            raise ValueError(f"Duplicate category in result: {cat}")
        if not cat:
            raise ValueError("Blank category in result; distinguish unmatched vs missing category")
        result[cat] = {
            "n_sales": int(row["n_sales"]),
            "units": int(row["units"]),
            "amount": money(Decimal(row["amount"])),
        }
    extra = sorted(set(result) - set(categories))
    missing = sorted(set(categories) - set(result))
    unequal = {c: {"expected": categories[c], "actual": result[c]}
               for c in sorted(set(categories) & set(result)) if categories[c] != result[c]}
    return {"passed": not (extra or missing or unequal), "extra_categories": extra,
            "missing_categories": missing, "different_categories": unequal}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dataset", type=Path, required=True, help="Scenario directory, not agent workspace")
    p.add_argument("--use-aliases", action="store_true")
    p.add_argument("--candidate", type=Path, help="Optional agent-exported category,n_sales,units,amount CSV")
    p.add_argument("--output", type=Path, help="Write JSON outside OpenCode workspace")
    args = p.parse_args()
    try:
        report = verify(args.dataset, use_aliases=args.use_aliases)
        if args.candidate:
            comparison = compare_csv(args.candidate, report["categories"])
            report["candidate_check"] = comparison
        serialized = json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(serialized, encoding="utf-8")
            print(f"Oracle written to: {args.output}")
        else:
            print(serialized, end="")
        if args.candidate and not report["candidate_check"]["passed"]:
            raise SystemExit(1)
    except (ValueError, KeyError) as e:
        p.error(str(e))


if __name__ == "__main__":
    main()
