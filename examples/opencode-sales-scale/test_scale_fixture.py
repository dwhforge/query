"""Regression tests for deterministic CSV fixtures and independent operator oracle."""
from __future__ import annotations

import csv
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from generate import SCENARIOS, generate
from stage import MARKER, stage
from verify import compare_csv, verify


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ScaleFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dwhq-scale-test-")
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.data = self.dir / "snapshots"
        generate(self.data, count=2_200, product_count=180, seed=20261118)

    def test_deterministic_and_no_answers_in_snapshots(self):
        second = self.dir / "second"
        generate(second, count=2_200, product_count=180, seed=20261118)
        for scenario in SCENARIOS:
            a = sorted((self.data / scenario).glob("*.csv"))
            b = sorted((second / scenario).glob("*.csv"))
            self.assertEqual([p.name for p in a], [p.name for p in b])
            self.assertEqual([digest(p) for p in a], [digest(p) for p in b])
            self.assertFalse(list((self.data / scenario).glob("*expected*")))
            self.assertFalse(list((self.data / scenario).glob("*oracle*")))
        with self.assertRaisesRegex(ValueError, "not empty"):
            generate(self.data, count=2_200, product_count=180, seed=20261118)

    def test_baseline_reconciliation_and_missed_categories(self):
        r = verify(self.data / SCENARIOS[0])
        self.assertEqual(r["input_sales_rows"], 2200)
        self.assertGreater(r["excluded_void_rows"], 0)
        self.assertGreater(r["unmatched_rows"], 0)
        self.assertGreater(r["matched_missing_category_rows"], 0)
        self.assertEqual(r["right_duplicate_key_groups"], 0)
        self.assertEqual(r["left_join_output_rows"], r["included_sales_rows"])
        self.assertEqual(r["sum_difference"], "0.00")
        self.assertEqual(r["source_amount"], r["joined_amount"])
        self.assertIn("__UNMATCHED__", r["categories"])
        self.assertIn("__MISSING_CATEGORY__", r["categories"])

    def test_refresh_changes_data_without_breaking_key_contract(self):
        base = verify(self.data / SCENARIOS[0])
        newer = verify(self.data / SCENARIOS[1])
        self.assertGreater(newer["input_sales_rows"], base["input_sales_rows"])
        self.assertNotEqual(newer["source_amount"], base["source_amount"])
        self.assertEqual(newer["sum_difference"], "0.00")
        self.assertEqual(newer["right_duplicate_key_groups"], 0)
        self.assertLess(newer["unmatched_rows"], base["unmatched_rows"] + 500)

    def test_duplicates_create_fanout_even_if_sku_is_equal(self):
        r = verify(self.data / SCENARIOS[2])
        self.assertGreater(r["right_duplicate_key_groups"], 0)
        self.assertGreater(r["fanout_extra_rows"], 0)
        self.assertGreater(r["left_join_output_rows"], r["included_sales_rows"])
        self.assertNotEqual(r["sum_difference"], "0.00")

    def test_only_approved_aliases_are_applied(self):
        dataset = self.data / SCENARIOS[3]
        without = verify(dataset)
        with_approved = verify(dataset, use_aliases=True)
        self.assertGreater(with_approved["approved_aliases_applied_rows"], 0)
        self.assertLess(with_approved["unmatched_rows"], without["unmatched_rows"])
        self.assertEqual(with_approved["source_amount"], without["source_amount"])
        self.assertEqual(with_approved["sum_difference"], "0.00")
        self.assertGreater(with_approved["unmatched_rows"], 0)

    def test_staging_preserves_project_and_guards_modified_input(self):
        workspace = self.dir / "workspace"
        stage(self.data, SCENARIOS[0], workspace)
        self.assertTrue((workspace / MARKER).is_file())
        project = workspace / "business_project.json"
        project.write_text('{"business":"kept"}', encoding="utf-8")
        stage(self.data, SCENARIOS[3], workspace)
        self.assertTrue((workspace / "sku_aliases.csv").is_file())
        stage(self.data, SCENARIOS[1], workspace)
        self.assertFalse((workspace / "sku_aliases.csv").exists())
        self.assertEqual(json.loads(project.read_text()), {"business": "kept"})
        with (workspace / "sales.csv").open("a", encoding="utf-8") as f:
            f.write("# human edit\n")
        with self.assertRaisesRegex(ValueError, "modified CSV"):
            stage(self.data, SCENARIOS[0], workspace)

    def test_operator_can_score_exported_aggregates(self):
        expected = verify(self.data / SCENARIOS[0])["categories"]
        candidate = self.dir / "category_results.csv"
        with candidate.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["category", "n_sales", "units", "amount"])
            for c, metrics in expected.items():
                w.writerow([c, metrics["n_sales"], metrics["units"], metrics["amount"]])
        self.assertTrue(compare_csv(candidate, expected)["passed"])
        lines = candidate.read_text().splitlines()
        lines[-1] = lines[-1].rsplit(",", 1)[0] + ",999999.00"
        candidate.write_text("\n".join(lines) + "\n")
        self.assertFalse(compare_csv(candidate, expected)["passed"])


if __name__ == "__main__":
    unittest.main()
