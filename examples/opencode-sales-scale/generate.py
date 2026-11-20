#!/usr/bin/env python3
"""Deterministic, synthetic DWHQuery/OpenCode scale benchmark. Python stdlib only.

Does not create an answer key or expose a result summary inside agent workspaces.
"""
from __future__ import annotations

import argparse
import csv
import random
from datetime import date, timedelta
from pathlib import Path

CATEGORIES = (
    "Beverages", "Groceries", "Dairy", "Fresh Produce", "Bakery",
    "Household", "Personal Care", "Frozen Food", "Snacks", "Pet Supplies",
    "Electronics", "Home", "Office", "Health", "Sports",
)
REGIONS = ("North", "South", "East", "West", "Central", "Coastal", "Ural", "Siberia")
CHANNELS = ("store", "online", "partner", "wholesale")
PRODUCT_FIELDS = ("sku", "product_name", "category", "brand")
SALES_FIELDS = ("sale_id", "sale_date", "sku", "units", "amount", "region", "channel", "status", "txn_type")
ALIAS_FIELDS = ("alias_sku", "canonical_sku", "approved_by", "approved_at")
SCENARIOS = ("01_baseline", "02_refresh", "03_duplicate_products", "04_approved_aliases")


def write_csv(path: Path, fields: tuple[str, ...], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def products_for(n: int) -> list[dict[str, str]]:
    return [
        {
            "sku": f"SKU-{i:06d}",
            "product_name": f"Synthetic product {i:06d}",
            "category": "" if i % 47 == 0 else CATEGORIES[(i * 11 + i // 17) % len(CATEGORIES)],
            "brand": f"Brand {(i % 31) + 1:02d}",
        }
        for i in range(1, n + 1)
    ]


def choose_sku(rng: random.Random, product_count: int) -> str:
    # These defects are intentional; a 1:1 exact join should NOT map them implicitly.
    p = rng.random()
    if p < .76:  # known exact SKU, has category
        while True:
            i = rng.randint(1, product_count)
            if i % 47:
                return f"SKU-{i:06d}"
    if p < .815:  # case drift
        return f"sku-{rng.randint(1, product_count):06d}"
    if p < .86:  # leading/trailing whitespace
        return f" SKU-{rng.randint(1, product_count):06d} "
    if p < .91:  # potential alias; not proven until approved alias source is supplied
        return f"ALT-{rng.randint(1, product_count):06d}"
    if p < .945:  # actually unknown code
        return f"EXT-{rng.randint(100001, 130000):06d}"
    if p < .965:  # leading-zero mismatch, not logically justified for auto-fixing
        return f"SKU-{rng.randint(1, product_count):03d}"
    if p < .98:  # empty SKU
        return ""
    i = 47 * rng.randint(1, product_count // 47)
    return f"SKU-{i:06d}"  # matched reference row with empty category


def make_sales(rng: random.Random, n: int, product_count: int, start: int = 1) -> list[dict[str, str]]:
    sales: list[dict[str, str]] = []
    for i in range(start, start + n):
        sku = choose_sku(rng, product_count)
        qty = rng.randint(1, 9)
        unit_price_cents = rng.randint(175, 27500)
        txn_type = "return" if rng.random() < .042 else "sale"
        status = "void" if rng.random() < .013 else "posted"
        # Negative quantities/amounts are deliberate and must be netted, not discarded.
        sign = -1 if txn_type == "return" else 1
        cents = unit_price_cents * qty * sign
        if rng.random() < .008:
            cents = 0  # free sample/promotion; units still nonzero
        sale_date = date(2026, 1, 1) + timedelta(days=rng.randrange(300))
        sales.append({
            "sale_id": f"S{i:07d}",
            "sale_date": sale_date.isoformat(),
            "sku": sku,
            "units": str(qty * sign),
            "amount": f"{'-' if cents < 0 else ''}{abs(cents) // 100}.{abs(cents) % 100:02d}",
            "region": rng.choice(REGIONS),
            "channel": rng.choice(CHANNELS),
            "status": status,
            "txn_type": txn_type,
        })
    return sales


def generate(output: Path, count: int, product_count: int, seed: int) -> None:
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output is not empty (refusing to overwrite): {output}")
    rng = random.Random(seed)
    products = products_for(product_count)
    sales = make_sales(rng, count, product_count)

    baseline = output / SCENARIOS[0]
    write_csv(baseline / "sales.csv", SALES_FIELDS, sales)
    write_csv(baseline / "products.csv", PRODUCT_FIELDS, products)

    refresh = output / SCENARIOS[1]
    # Reuse original sale IDs, update selected existing sales, append new activity.
    refreshed_sales = [row.copy() for row in sales]
    for index in range(0, count, 167):
        row = refreshed_sales[index]
        old = int(row["amount"].replace(".", ""))
        new = old + (113 if old >= 0 else -113)
        row["amount"] = f"{'-' if new < 0 else ''}{abs(new)//100}.{abs(new)%100:02d}"
    extra = max(500, count // 16)
    refreshed_sales.extend(make_sales(rng, extra, product_count, start=count + 1))
    refreshed_products = [row.copy() for row in products]
    # A static dimension category correction: history is NOT maintained in this CSV.
    for index in range(18, product_count, 109):
        if refreshed_products[index]["category"]:
            refreshed_products[index]["category"] = "Reclassified"
    # Some formerly unknown EXT codes become explicitly known in the new reference snapshot.
    ext_codes = sorted({s["sku"] for s in sales if s["sku"].startswith("EXT-")})
    for i, sku in enumerate(ext_codes[:25]):
        refreshed_products.append({
            "sku": sku,
            "product_name": f"Newly catalogued item {i+1:02d}",
            "category": "Newly Catalogued",
            "brand": "Brand New",
        })
    write_csv(refresh / "sales.csv", SALES_FIELDS, refreshed_sales)
    write_csv(refresh / "products.csv", PRODUCT_FIELDS, refreshed_products)

    duplicates = output / SCENARIOS[2]
    write_csv(duplicates / "sales.csv", SALES_FIELDS, sales)
    bad_products = [row.copy() for row in products]
    # One conflicting category, other duplicates identical: both cause fanout.
    for idx in [4, 26, 124, 342, 606, 914, 1110]:
        if idx >= product_count:
            continue
        copied = products[idx].copy()
        if idx == 4:
            copied["category"] = "Conflicting Category"
        bad_products.append(copied)
    write_csv(duplicates / "products.csv", PRODUCT_FIELDS, bad_products)

    aliases = output / SCENARIOS[3]
    write_csv(aliases / "sales.csv", SALES_FIELDS, sales)
    write_csv(aliases / "products.csv", PRODUCT_FIELDS, products)
    alt_codes = sorted({s["sku"] for s in sales if s["sku"].startswith("ALT-")})
    # Only a subset is vetted. Similar-looking but unapproved codes must stay unmatched.
    approved = [
        {
            "alias_sku": alt,
            "canonical_sku": alt.replace("ALT-", "SKU-", 1),
            "approved_by": "data_steward_fixture",
            "approved_at": "2026-11-16",
        }
        for alt in alt_codes if int(alt[-6:]) % 3 == 0
    ]
    write_csv(aliases / "sku_aliases.csv", ALIAS_FIELDS, approved)
    print(f"Generated synthetic CSV scenarios at: {output}")
    for scenario in SCENARIOS:
        print(f"  {scenario}/")
    print("No oracle/report is written here; use verify.py outside the agent workspace.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("/tmp/dwhq-scale-datasets"))
    parser.add_argument("--rows", type=int, default=12_000)
    parser.add_argument("--products", type=int, default=1_250)
    parser.add_argument("--seed", type=int, default=20261118)
    args = parser.parse_args()
    if not 1_000 <= args.rows <= 100_000:
        parser.error("--rows must be between 1,000 and 100,000")
    if not 150 <= args.products <= 20_000:
        parser.error("--products must be between 150 and 20,000")
    try:
        generate(args.out.expanduser().resolve(), args.rows, args.products, args.seed)
    except ValueError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
