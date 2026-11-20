#!/usr/bin/env python3
"""Copy one generated CSV snapshot into a stable OpenCode workspace without touching projects.

Only files managed by this staging tool are ever replaced. A manifest check protects
against overwriting CSVs the user or agent modified since the previous stage.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

from generate import SCENARIOS

NAMES = ("sales.csv", "products.csv", "sku_aliases.csv")
MARKER = ".dwhq-scale-staging.json"


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def stage(data_root: Path, scenario: str, workspace: Path) -> None:
    source = data_root / scenario
    if not source.is_dir():
        raise ValueError(f"Scenario not found: {source}")
    if source.resolve() == workspace.resolve():
        raise ValueError("Workspace must differ from the dataset snapshot")
    workspace.mkdir(parents=True, exist_ok=True)
    marker_file = workspace / MARKER
    marker = json.loads(marker_file.read_text(encoding="utf-8")) if marker_file.is_file() else None
    if marker is not None and marker.get("format") != 1:
        raise ValueError("Unknown workspace staging marker version")
    for name in NAMES:
        target = workspace / name
        if target.is_symlink():
            raise ValueError(f"Refusing symlinked target: {target}")
        if target.exists():
            if marker is None or marker.get("sha256", {}).get(name) != sha(target):
                raise ValueError(f"Refusing to overwrite unmanaged/modified CSV: {target}")
    for name in ("sales.csv", "products.csv"):
        if not (source / name).is_file():
            raise ValueError(f"Required source missing: {source/name}")
    for name in NAMES:
        original = source / name
        target = workspace / name
        if original.is_file():
            with tempfile.NamedTemporaryFile(dir=workspace, prefix=".stage-", delete=False) as temp:
                staged = Path(temp.name)
            try:
                shutil.copyfile(original, staged)
                os.replace(staged, target)
            finally:
                staged.unlink(missing_ok=True)
        elif target.exists():
            target.unlink()  # only a previously managed alias file; checked above
    marker_file.write_text(json.dumps({
        "format": 1, "scenario": scenario,
        "sha256": {name: sha(workspace / name) for name in NAMES if (workspace / name).exists()},
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Staged {scenario} into {workspace} (project and .opencode/ untouched)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data-root", type=Path, default=Path("/tmp/dwhq-scale-datasets"))
    p.add_argument("--scenario", choices=SCENARIOS, required=True)
    p.add_argument("--workspace", type=Path, required=True)
    a = p.parse_args()
    try:
        stage(a.data_root.resolve(), a.scenario, a.workspace.resolve())
    except ValueError as e:
        p.error(str(e))


if __name__ == "__main__":
    main()
