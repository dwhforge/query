#!/usr/bin/env python3
"""Generate readable KeyMap lab fixtures under fixtures/examples/.

Domains (business entities, not synthetic ids):
  crosswalk — grocery POS sku ↔ WMS item (B2)
  dual      — restaurant groups vs suppliers → dim_party (B3)
  codes     — sales channels / region spellings (B4)
  hop       — café stores → city region → country (B5)

Also writes parquet copies for R2/R3 demos.

  python scripts/examples/generate_all.py
  python scripts/examples/generate_all.py --out fixtures/examples
"""
from __future__ import annotations

import argparse
import csv
from datetime import date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Shared calendar (~120 fact rows when × entities)
# ---------------------------------------------------------------------------

N_DAYS = 30
START = date(2024, 6, 1)


def days() -> list[date]:
    return [START + timedelta(days=i) for i in range(N_DAYS)]


def write_csv(path: Path, headers: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in headers})


def try_write_parquet(csv_path: Path) -> None:
    """Best-effort parquet beside CSV (duckdb CLI / python / pyarrow)."""
    import shutil
    import subprocess

    pq = csv_path.with_suffix(".parquet")
    csv_s = csv_path.as_posix().replace("'", "''")
    pq_s = pq.as_posix().replace("'", "''")
    sql = (
        f"COPY (SELECT * FROM read_csv_auto('{csv_s}')) "
        f"TO '{pq_s}' (FORMAT PARQUET);"
    )
    duckdb_bin = shutil.which("duckdb")
    if duckdb_bin:
        try:
            subprocess.run(
                [duckdb_bin, "-c", sql],
                check=True,
                capture_output=True,
                text=True,
            )
            return
        except Exception as e:
            print(f"  (duckdb CLI parquet failed for {csv_path.name}: {e})")
    try:
        import duckdb

        duckdb.execute(sql)
        return
    except Exception:
        pass
    try:
        import pyarrow.csv as pcsv
        import pyarrow.parquet as pqmod

        table = pcsv.read_csv(csv_path)
        pqmod.write_table(table, pq)
    except Exception as e:
        print(f"  (skip parquet for {csv_path.name}: {e})")


# ===========================================================================
# B2 — Crosswalk: POS grocery ↔ WMS warehouse
# ===========================================================================

# 40 products with readable names; POS uses shelf labels, WMS uses WH codes.
PRODUCTS = [
    ("Coca-Cola Classic 0.5L", "CC-CLASSIC-05", "WH-BEV-1001"),
    ("Coca-Cola Zero 0.5L", "CC-ZERO-05", "WH-BEV-1002"),
    ("Pepsi Max 0.5L", "PEPSI-MAX-05", "WH-BEV-1101"),
    ("Fanta Orange 0.5L", "FANTA-OR-05", "WH-BEV-1201"),
    ("Red Bull Energy 250ml", "RB-250", "WH-BEV-2001"),
    ("Starbucks Frappuccino 250ml", "SBUX-FRAP-250", "WH-BEV-2101"),
    ("Evian Still 1L", "EVIAN-1L", "WH-BEV-3001"),
    ("San Pellegrino Sparkling 1L", "SANPEL-1L", "WH-BEV-3002"),
    ("Heinz Tomato Ketchup 460g", "HEINZ-KETCH-460", "WH-COND-4001"),
    ("Hellmann's Mayo 400ml", "HELL-MAYO-400", "WH-COND-4002"),
    ("Barilla Spaghetti 500g", "BARILLA-SPAG-500", "WH-DRY-5001"),
    ("Barilla Penne 500g", "BARILLA-PENNE-500", "WH-DRY-5002"),
    ("Uncle Ben's Rice 1kg", "UBEN-RICE-1K", "WH-DRY-5101"),
    ("Quaker Oats 500g", "QUAKER-OATS-500", "WH-DRY-5201"),
    ("Nutella 400g", "NUTELLA-400", "WH-SPR-6001"),
    ("Lotus Biscoff Spread 400g", "LOTUS-BISCOFF-400", "WH-SPR-6002"),
    ("Lindt Excellence 70% 100g", "LINDT-70-100", "WH-CONF-7001"),
    ("Haribo Goldbears 200g", "HARIBO-GOLD-200", "WH-CONF-7002"),
    ("Lay's Classic Chips 150g", "LAYS-CLASSIC-150", "WH-SNK-8001"),
    ("Doritos Nacho 150g", "DORITOS-NACHO-150", "WH-SNK-8002"),
    ("Pringles Original 165g", "PRINGLES-ORIG-165", "WH-SNK-8101"),
    ("Oreo Original 154g", "OREO-154", "WH-SNK-8201"),
    ("Philadelphia Cream Cheese 150g", "PHILA-150", "WH-DAIRY-9001"),
    ("Activia Strawberry 4-pack", "ACTIVIA-STRAW-4", "WH-DAIRY-9002"),
    ("President Butter 250g", "PRES-BUTTER-250", "WH-DAIRY-9101"),
    ("Cathedral City Cheddar 350g", "CATH-CHED-350", "WH-DAIRY-9102"),
    ("Innocent Orange Juice 750ml", "INNOCENT-OJ-750", "WH-BEV-1301"),
    ("Tropicana Pure Premium 1L", "TROP-PURE-1L", "WH-BEV-1302"),
    ("Nespresso Arpeggio 10 caps", "NESP-ARP-10", "WH-COFF-1001"),
    ("Lavazza Qualità Rossa 250g", "LAV-ROSSA-250", "WH-COFF-1002"),
    ("Twinings English Breakfast 50s", "TWIN-EB-50", "WH-TEA-1101"),
    ("Yorkshire Tea 80s", "YORK-TEA-80", "WH-TEA-1102"),
    ("Fairy Dishwashing Liquid 500ml", "FAIRY-500", "WH-HOME-2001"),
    ("Domestos Bleach 750ml", "DOMESTOS-750", "WH-HOME-2002"),
    ("Persil Non-Bio 1.4L", "PERSIL-NB-14", "WH-HOME-2101"),
    ("Lenor Spring Fresh 1L", "LENOR-SPRING-1L", "WH-HOME-2102"),
    ("Colgate Total 75ml", "COLGATE-TOTAL-75", "WH-PC-3001"),
    ("Sensodyne Repair 75ml", "SENSO-REPAIR-75", "WH-PC-3002"),
    ("Nivea Soft Cream 200ml", "NIVEA-SOFT-200", "WH-PC-3101"),
    ("Dove Original Soap 4-pack", "DOVE-SOAP-4", "WH-PC-3102"),
]


def gen_crosswalk(out: Path) -> None:
    d = out / "crosswalk"
    # Map: POS sku_code → WMS item_code (leave 4 unmatched for Lens)
    map_rows = []
    unmatched_pos = {"RB-250", "NUTELLA-400", "FAIRY-500", "DOVE-SOAP-4"}
    for name, pos, wms in PRODUCTS:
        if pos in unmatched_pos:
            continue
        map_rows.append(
            {
                "pos_sku": pos,
                "wms_item": wms,
                "product_name": name,
                "confidence": "high",
            }
        )

    pos_sales = []
    wms_moves = []
    for i, day in enumerate(days()):
        for j, (name, pos, wms) in enumerate(PRODUCTS):
            # ~40 products × 30 days = 1200; subsample to ~120+ by taking every product every day
            # User asked ≥100 — full 1200 is fine for "bigger than 10"
            units = 5 + ((i * 3 + j * 7) % 40)
            pos_sales.append(
                {
                    "day": day.isoformat(),
                    "store": ["Borough Market", "Canary Wharf", "Camden"][j % 3],
                    "sku_code": pos,
                    "shelf_label": name,
                    "units": units,
                    "revenue": units * (1.2 + (j % 9) * 0.35),
                }
            )
            qty = 10 + ((i + j * 2) % 50)
            wms_moves.append(
                {
                    "day": day.isoformat(),
                    "warehouse": ["Tilbury DC", "Northampton DC"][j % 2],
                    "item_code": wms,
                    "item_name": name,
                    "qty_out": qty,
                    "cost": round(qty * (0.4 + (j % 11) * 0.15), 2),
                }
            )

    write_csv(
        d / "map_pos_to_wms.csv",
        ["pos_sku", "wms_item", "product_name", "confidence"],
        map_rows,
    )
    # seed-style from,to for seed demos
    write_csv(
        d / "map_pos_to_wms_seed.csv",
        ["from", "to"],
        [{"from": r["pos_sku"], "to": r["wms_item"]} for r in map_rows],
    )
    write_csv(
        d / "pos_sales.csv",
        ["day", "store", "sku_code", "shelf_label", "units", "revenue"],
        pos_sales,
    )
    write_csv(
        d / "wms_moves.csv",
        ["day", "warehouse", "item_code", "item_name", "qty_out", "cost"],
        wms_moves,
    )
    for name in ("pos_sales", "wms_moves", "map_pos_to_wms"):
        try_write_parquet(d / f"{name}.csv")
    print(f"crosswalk: {len(pos_sales)} pos rows, {len(map_rows)} map pairs → {d}")


# ===========================================================================
# B3 — Dual maps + master parties (restaurant groups / suppliers)
# ===========================================================================

PARTIES = [
    ("P-STBUX", "Starbucks Corporation", "USA", "qsr_coffee"),
    ("P-MCD", "McDonald's Corporation", "USA", "qsr"),
    ("P-YUM", "Yum! Brands", "USA", "qsr"),
    ("P-NANDO", "Nando's Group", "UK", "qsr"),
    ("P-PRET", "Pret A Manger", "UK", "qsr_coffee"),
    ("P-COSTA", "Costa Limited", "UK", "qsr_coffee"),
    ("P-WAGAMAMA", "Wagamama Ltd", "UK", "qsr"),
    ("P-DISHOOM", "Dishoom Limited", "UK", "qsr"),
    ("P-GREGGS", "Greggs plc", "UK", "qsr"),
    ("P-CHIPOTLE", "Chipotle Mexican Grill", "USA", "qsr"),
    ("P-SYSCO", "Sysco Corporation", "USA", "supplier"),
    ("P-BIDFOOD", "Bidfood UK", "UK", "supplier"),
    ("P-BRAKES", "Brakes Group", "UK", "supplier"),
    ("P-NESTLE", "Nestlé Professional", "CH", "supplier"),
    ("P-UNILEVER", "Unilever Food Solutions", "NL", "supplier"),
    ("P-COCA", "Coca-Cola Europacific Partners", "UK", "supplier"),
    ("P-HEINEKEN", "Heineken UK", "UK", "supplier"),
    ("P-ABEV", "AB InBev UK", "UK", "supplier"),
    ("P-ARLA", "Arla Foods", "DK", "supplier"),
    ("P-KERRY", "Kerry Group", "IE", "supplier"),
]

# Sales-side spellings (POS / loyalty) — separate From space from AP
SALES_ALIASES = [
    ("SBUX", "P-STBUX"),
    ("Starbucks UK", "P-STBUX"),
    ("McDonalds", "P-MCD"),
    ("McDonald's Restaurants", "P-MCD"),
    ("Yum Brands", "P-YUM"),
    ("Nandos", "P-NANDO"),
    ("Pret", "P-PRET"),
    ("Pret A Manger Ltd", "P-PRET"),
    ("Costa Coffee", "P-COSTA"),
    ("Wagamama", "P-WAGAMAMA"),
    ("Dishoom", "P-DISHOOM"),
    ("Greggs", "P-GREGGS"),
    ("Chipotle", "P-CHIPOTLE"),
    # intentional blanks for Lens / dual lab
    # ("Five Guys", ...) — not in map
]

# AP / invoice legal names — overlapping short codes would collide in ONE map
# e.g. both sides could invent "SYS" — dual maps avoid that
SPEND_ALIASES = [
    ("SYSCO CORP", "P-SYSCO"),
    ("Sysco Foods", "P-SYSCO"),
    ("BIDFOOD", "P-BIDFOOD"),
    ("Brakes Bros", "P-BRAKES"),
    ("NESTLE PROFESSIONAL", "P-NESTLE"),
    ("Unilever Food Solutions", "P-UNILEVER"),
    ("CCEP", "P-COCA"),
    ("Coca-Cola Europacific", "P-COCA"),
    ("Heineken UK Ltd", "P-HEINEKEN"),
    ("AB INBEV UK", "P-ABEV"),
    ("Arla Foods Amba", "P-ARLA"),
    ("Kerry Ingredients", "P-KERRY"),
]


def gen_dual(out: Path) -> None:
    d = out / "dual"
    dim = [
        {
            "party_id": p,
            "party_name": n,
            "country": c,
            "kind": k,
        }
        for p, n, c, k in PARTIES
    ]
    # Note in README: add P-FIVEGUYS to dim then map — master edit story
    sales_names = [a[0] for a in SALES_ALIASES] + ["Five Guys", "Leon Restaurants"]
    spend_names = [a[0] for a in SPEND_ALIASES] + ["Booker Wholesale"]

    sales_rows = []
    spend_rows = []
    for i, day in enumerate(days()):
        for j, name in enumerate(sales_names):
            units = 20 + ((i * 5 + j * 11) % 80)
            sales_rows.append(
                {
                    "day": day.isoformat(),
                    "brand": name,
                    "city": ["London", "Manchester", "Birmingham", "Edinburgh"][j % 4],
                    "covers": units,
                    "revenue": round(units * (8.5 + (j % 6)), 2),
                }
            )
        for j, name in enumerate(spend_names):
            amt = round(500 + ((i * 17 + j * 43) % 4000) + j * 10.5, 2)
            spend_rows.append(
                {
                    "day": day.isoformat(),
                    "vendor_name": name,
                    "invoice_no": f"INV-{day.strftime('%m%d')}-{j:02d}",
                    "category": ["produce", "beverage", "dry_goods", "dairy"][j % 4],
                    "amount": amt,
                }
            )

    write_csv(
        d / "dim_party.csv",
        ["party_id", "party_name", "country", "kind"],
        dim,
    )
    write_csv(
        d / "map_sales_alias.csv",
        ["from", "to"],
        [{"from": a, "to": b} for a, b in SALES_ALIASES],
    )
    write_csv(
        d / "map_spend_alias.csv",
        ["from", "to"],
        [{"from": a, "to": b} for a, b in SPEND_ALIASES],
    )
    # PG-style column names for source storage demos
    write_csv(
        d / "map_sales_alias_pg.csv",
        ["alias_name", "party_id", "note"],
        [
            {"alias_name": a, "party_id": b, "note": "pos"}
            for a, b in SALES_ALIASES
        ],
    )
    write_csv(
        d / "map_spend_alias_pg.csv",
        ["legal_name", "party_id", "note"],
        [
            {"legal_name": a, "party_id": b, "note": "ap"}
            for a, b in SPEND_ALIASES
        ],
    )
    write_csv(
        d / "pos_covers.csv",
        ["day", "brand", "city", "covers", "revenue"],
        sales_rows,
    )
    write_csv(
        d / "ap_invoices.csv",
        ["day", "vendor_name", "invoice_no", "category", "amount"],
        spend_rows,
    )
    for name in (
        "dim_party",
        "pos_covers",
        "ap_invoices",
        "map_sales_alias_pg",
        "map_spend_alias_pg",
    ):
        try_write_parquet(d / f"{name}.csv")
    print(
        f"dual: {len(sales_rows)} covers, {len(spend_rows)} invoices, "
        f"{len(dim)} parties → {d}"
    )


# ===========================================================================
# B4 — Channel / region code synonyms
# ===========================================================================

CHANNEL_MAP = [
    ("WWW", "web"),
    ("web", "web"),
    ("ONLINE", "web"),
    ("Online Store", "web"),
    ("eCom", "web"),
    ("APP", "app"),
    ("Mobile App", "app"),
    ("iOS", "app"),
    ("Android", "app"),
    ("STORE", "store"),
    ("Retail", "store"),
    ("High Street", "store"),
    ("POS", "store"),
    ("MARKETPLACE", "marketplace"),
    ("Amazon", "marketplace"),
    ("eBay", "marketplace"),
    # unmatched leftovers
    # ("TikTok Shop", ?)
]

REGION_MAP = [
    ("UK", "GB"),
    ("United Kingdom", "GB"),
    ("Great Britain", "GB"),
    ("GBR", "GB"),
    ("England", "GB"),
    ("DE", "DE"),
    ("Germany", "DE"),
    ("Deutschland", "DE"),
    ("FR", "FR"),
    ("France", "FR"),
    ("NL", "NL"),
    ("Netherlands", "NL"),
    ("Holland", "NL"),
]


def gen_codes(out: Path) -> None:
    d = out / "codes"
    channels = [c[0] for c in CHANNEL_MAP] + ["TikTok Shop", "WhatsApp"]
    regions = [r[0] for r in REGION_MAP] + ["Scandinavia"]
    rows = []
    for i, day in enumerate(days()):
        for j, ch in enumerate(channels):
            for k, reg in enumerate(regions[:6]):  # keep ~30*18*6 too big — take slice
                if (j + k + i) % 3 != 0:
                    continue
                units = 3 + ((i + j * 5 + k) % 25)
                rows.append(
                    {
                        "day": day.isoformat(),
                        "channel_code": ch,
                        "region_code": reg,
                        "sku": ["Classic Roast", "Cold Brew", "Mug Set"][(j + k) % 3],
                        "units": units,
                        "revenue": round(units * (4.5 + j * 0.2), 2),
                    }
                )
    write_csv(
        d / "map_channel.csv",
        ["from", "to"],
        [{"from": a, "to": b} for a, b in CHANNEL_MAP],
    )
    write_csv(
        d / "map_region.csv",
        ["from", "to"],
        [{"from": a, "to": b} for a, b in REGION_MAP],
    )
    write_csv(
        d / "map_channel_pg.csv",
        ["raw_channel", "canon_channel", "owner_team"],
        [
            {"raw_channel": a, "canon_channel": b, "owner_team": "digital"}
            for a, b in CHANNEL_MAP
        ],
    )
    write_csv(
        d / "ecommerce_sales.csv",
        ["day", "channel_code", "region_code", "sku", "units", "revenue"],
        rows,
    )
    try_write_parquet(d / "ecommerce_sales.csv")
    try_write_parquet(d / "map_channel_pg.csv")
    print(f"codes: {len(rows)} sales rows → {d}")


# ===========================================================================
# B5 — Multi-hop: store → city region → country
# ===========================================================================

STORES = [
    ("SBUX-SOHO", "Starbucks Reserve Soho", "REG-LON"),
    ("SBUX-SHORE", "Starbucks Liverpool Street", "REG-LON"),
    ("SBUX-KING", "Starbucks King's Cross", "REG-LON"),
    ("COSTA-OXF", "Costa Oxford Street", "REG-LON"),
    ("COSTA-BRI", "Costa Brighton Lanes", "REG-SE"),
    ("PRET-CAN", "Pret Canary Wharf", "REG-LON"),
    ("PRET-MAN", "Pret Manchester Piccadilly", "REG-NW"),
    ("NANDO-BRI", "Nando's Brighton", "REG-SE"),
    ("NANDO-EDI", "Nando's Edinburgh Old Town", "REG-SCOT"),
    ("MCD-BHX", "McDonald's Birmingham Bullring", "REG-MID"),
    ("MCD-GLA", "McDonald's Glasgow Central", "REG-SCOT"),
    ("GREGGS-NCL", "Greggs Newcastle", "REG-NE"),
    ("WAGA-CAM", "Wagamama Cambridge", "REG-EA"),
    ("DISH-KG", "Dishoom King's Cross", "REG-LON"),
    ("CHIP-LIV", "Chipotle Liverpool ONE", "REG-NW"),
]

REGIONS = [
    ("REG-LON", "London & South East Core", "GB"),
    ("REG-SE", "South Coast", "GB"),
    ("REG-NW", "North West England", "GB"),
    ("REG-NE", "North East England", "GB"),
    ("REG-MID", "Midlands", "GB"),
    ("REG-EA", "East Anglia", "GB"),
    ("REG-SCOT", "Scotland", "GB"),
]


def gen_hop(out: Path) -> None:
    d = out / "hop"
    sales = []
    for i, day in enumerate(days()):
        for j, (sid, sname, rid) in enumerate(STORES):
            covers = 40 + ((i * 7 + j * 13) % 120)
            sales.append(
                {
                    "day": day.isoformat(),
                    "store_code": sid,
                    "store_name": sname,
                    "covers": covers,
                    "revenue": round(covers * (6.2 + (j % 5) * 0.4), 2),
                }
            )
    write_csv(
        d / "map_store_to_region.csv",
        ["from", "to"],
        [{"from": s[0], "to": s[2]} for s in STORES],
    )
    write_csv(
        d / "map_region_to_country.csv",
        ["from", "to"],
        [{"from": r[0], "to": r[2]} for r in REGIONS],
    )
    write_csv(
        d / "dim_region.csv",
        ["region_id", "region_name", "country_code"],
        [
            {"region_id": a, "region_name": b, "country_code": c}
            for a, b, c in REGIONS
        ],
    )
    write_csv(
        d / "store_sales.csv",
        ["day", "store_code", "store_name", "covers", "revenue"],
        sales,
    )
    try_write_parquet(d / "store_sales.csv")
    print(f"hop: {len(sales)} store-day rows → {d}")


# ===========================================================================
# Composite From — recycled external offer id + day → offer_sk (ADR-0024)
# ===========================================================================

# Same external id reappears on different days with different meanings.
OFFERS = [
    # (ext_id, day_offset, offer_sk, name, dirty_left_alias)
    ("OF-100", 0, "SK-SUMMER-A", "Summer splash A", "OF-100"),
    ("OF-100", 7, "SK-SUMMER-B", "Summer splash B", "OF100"),  # recycled id
    ("OF-100", 14, "SK-SUMMER-C", "Summer splash C", "of-100"),
    ("OF-200", 0, "SK-LOYAL-1", "Loyalty tier 1", "OF-200"),
    ("OF-200", 10, "SK-LOYAL-2", "Loyalty tier 2", "OF_200"),
    ("OF-300", 1, "SK-FLASH-1", "Flash sale Mon", "OF-300"),
    ("OF-300", 8, "SK-FLASH-2", "Flash sale Tue", "OF-30O"),  # typo O/0
    ("OF-400", 2, "SK-BUNDLE-X", "Bundle X", "OF-400"),
    ("OF-400", 9, "SK-BUNDLE-Y", "Bundle Y", "OF400"),
    ("OF-500", 3, "SK-WELCOME", "Welcome pack", "OF-500"),
    ("OF-500", 15, "SK-WINBACK", "Winback", "OF-50O"),
    ("OF-600", 4, "SK-VIP-A", "VIP weekend A", "OF-600"),
    ("OF-600", 11, "SK-VIP-B", "VIP weekend B", "OF-600"),
    ("OF-700", 5, "SK-APP-ONLY", "App-only deal", "OF-700"),
    ("OF-700", 12, "SK-APP-PLUS", "App+ deal", "of700"),
    ("OF-800", 6, "SK-PARTNER", "Partner promo", "OF-800"),
]


def gen_offer(out: Path) -> None:
    d = out / "offer"
    events = []
    dim = []
    map_rows = []
    for ext, day_off, sk, name, dirty in OFFERS:
        day = (START + timedelta(days=day_off)).isoformat()
        # Canon dim uses clean offer_code
        dim.append(
            {
                "as_of_day": day,
                "offer_code": ext,
                "offer_sk": sk,
                "offer_name": name,
            }
        )
        # Left events use dirty / recycled aliases
        events.append(
            {
                "day": day,
                "ext_offer_id": dirty,
                "campaign": name,
                "clicks": 20 + (day_off * 3 + len(ext)) % 80,
            }
        )
        # Seed map: dirty alias + day → offer_sk (leave a few unmatched for Lens)
        if dirty not in {"OF-50O", "of700"}:
            map_rows.append(
                {
                    "ext_offer_id": dirty,
                    "as_of_day": day,
                    "offer_sk": sk,
                }
            )

    # Extra fact rows across calendar so ≥100 rows
    for i, day in enumerate(days()):
        for j, (ext, _off, sk, name, dirty) in enumerate(OFFERS):
            if (i + j) % 2 != 0:
                continue
            events.append(
                {
                    "day": day.isoformat(),
                    "ext_offer_id": dirty if i % 5 else ext,
                    "campaign": name,
                    "clicks": 5 + ((i * 5 + j) % 40),
                }
            )

    write_csv(
        d / "offer_events.csv",
        ["day", "ext_offer_id", "campaign", "clicks"],
        events,
    )
    write_csv(
        d / "offer_dim.csv",
        ["as_of_day", "offer_code", "offer_sk", "offer_name"],
        dim,
    )
    write_csv(
        d / "map_offer_day.csv",
        ["ext_offer_id", "as_of_day", "offer_sk"],
        map_rows,
    )
    # seed-style for sync tests
    write_csv(
        d / "map_offer_day_seed.csv",
        ["ext_offer_id", "as_of_day", "offer_sk"],
        map_rows,
    )
    try_write_parquet(d / "offer_events.csv")
    try_write_parquet(d / "offer_dim.csv")
    print(f"offer: {len(events)} events, {len(map_rows)} map rows → {d}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "fixtures" / "examples",
    )
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    gen_crosswalk(out)
    gen_dual(out)
    gen_codes(out)
    gen_hop(out)
    gen_offer(out)
    (out / "README.md").write_text(
        "# Generated KeyMap example fixtures\n\n"
        "Regenerate: `python scripts/examples/generate_all.py`\n\n"
        "Load into Postgres: `python scripts/examples/load_postgres.py` "
        "(DSN via `DWH_PG_DSN` or default local lab).\n\n"
        "Composite From lab: `offer/` (ADR-0024 recycled ext_offer_id + day).\n",
        encoding="utf-8",
    )
    print(f"done → {out}")


if __name__ == "__main__":
    main()
