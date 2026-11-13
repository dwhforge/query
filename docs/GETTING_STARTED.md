# Getting started — offline lab first, dbt when needed

Start with a **DWHForge Query** desktop build and the committed offline flagship.
You do not need PostgreSQL, an LLM, an account or dbt build to inspect it. Source
setup is in §6; optional dbt/export setup follows the first-launch steps.
The [development notes](RELEASE_NOTES.md) distinguish this checkout's UX from older packages.

Related deep-dives: [Export & run](export-and-run.md) · [ADR-0014](adr/0014-query-execution-affinity.md) · [ADR-0017](adr/0017-export-offline-dbt-parse.md)

---

## 1. What you installed

| Piece | Role |
|-------|------|
| **Electron app** (`DWHForge-Query` / `npm run electron:dev`) | UI + launches `dwh-host` |
| **`dwh-host`** | Rust sidecar: DuckDB preview, project I/O, export, `dbt` CLI |
| **`extensions/`** | Offline DuckDB extensions (`postgres`, `httpfs`, …) |
| **`dbt-venv/`** (optional but recommended) | Local dbt Core 1.x + adapters for Parse / Build |

The app does **not** install dbt into the system Python. You create a project-local venv once (see §3).

---

## 2. First launch — offline lab

1. Open the desktop app. If dbt setup is offered, choose **Not now** for this lab.
2. Open **Help → Help Lab…**, find **Shipments ↔ sales**, then **Open lab**. If current work is unsaved, use **Save / Discard / Cancel**; cancel or a failed save keeps it open. The lab gets a new unsaved identity, not the working project's save path.
3. Read the task card and press **Show me where to start**. It selects the original Join in **dirty_recon** and Data/Join Lens. Hints are optional, one at a time; **Got it**, **Dismiss** or Escape stops them. **Lab task** restores a dismissed card. On an older package without the card, select the Join manually.
4. Select **No match** to inspect commercial SKU values without a plant product partner. Read the **Sample / Full preview** label; sample rows are not full-input proof. The hint disappears when No match is reached, not when the data is fixed.
5. **Inspect mapped example** opens the prepared **sales_mapped** pipeline. **Inspect monthly reconciliation** opens **recon_by_month**. These queries already exist in the lab and the map is incomplete.
6. For a concrete correction, open **Mappings → Commercial SKU → plant product**, choose **Add row**, fill **From = COM-AMM**, **To = AMM-A**, then **Save map**. Return to the mapped example and press **Recompute**. The product reference contains AMM-A; do not invent a match for NEW-BLEND.
7. Inspect the changed mapped rows and monthly gap calculation. No success percentage or full-data reconciliation is implied. **File → Save as…** saves your edited project; reopen it to continue ordinary work. Tutorial hints are session-only, not saved project content.

![Actual offline flagship Join Lens](stabilization/flagship-join-lens.png)

### Optional later: destination and export

1. **Project** menu:
   - **Execution engine** = SQL dialect for emit/preview honesty (`duckdb` or `postgres`).
   - **Destination** = where **published** models materialize (`duckdb` file or **PostgreSQL**).
2. For Files/CSV → Postgres use **engine = DuckDB**, **destination = PostgreSQL**, and pick a Postgres **connection**.
3. In the query inspector, enable **Publish to destination** on every query that should become a `mart_*` (empty publish list ⇒ only the ★ focus query).

Secrets (Postgres DSN, S3 keys) live in `~/.dwhforge-query/secrets.json`, not inside the `.dwhproj.json` file.

---

## 3. Install dbt (required for Parse / Build)

From the **repository root** (or the unpacked portable tree that contains `scripts/`):

```bash
./scripts/fetch-dbt-venv.sh
```

Or from the app (**ADR-0023**): first launch offers **Install for me** / **Copy install script** into `~/.dwhforge-query/dbt-venv`; repeat via **File → Options…**.

Dev script creates **`./dbt-venv/`** (or `DWH_DBT_VENV=…`) with:

- `dbt-core` 1.x  
- `dbt-duckdb`  
- `dbt-postgres`

**You do not put dbt inside Electron `node_modules`.**

The host looks for dbt in this order ([ADR-0021](adr/0021-app-options-recent-projects.md)):

1. **File → Options… → dbt virtualenv** (absolute path to a venv root that contains `bin/dbt`), when set  
2. `./dbt-venv/bin/dbt` next to the app / cwd / `~/.dwhforge-query/dbt-venv`  
3. `dbt` on your `PATH`

Use Options when the venv lives somewhere other than the portable tree. Defaults for **new** projects (execution engine + destination) are also under Options; they do not change an already-open project.

**File → Open Recent** keeps the last 10 project paths in `~/.dwhforge-query/settings.json`.

Verify:

```bash
./dbt-venv/bin/dbt --version
```

---

## 4. After install — typical workflow

```text
Edit graph → Publish marts → Export dbt → (optional) Parse → Build
```

| Step | Menu | What happens |
|------|------|----------------|
| **Export dbt…** | File | Writes `dbt_project.yml`, models, seeds, profiles; then offline **dbt parse** (author gate). Progress bar shows write → parse. |
| **Parse export…** | File | Re-run parse only on the last export folder. |
| **Build export…** | File | Runs **`dbt build`** (seed + models). Injects `DWH_PG_DSN` from the destination Postgres connection when needed. |

Green **parse** ≠ correct data. **Build** is what creates tables/views.

### DuckDB-only destination

- Working file: `local.duckdb` next to the export.  
- No `DWH_PG_DSN` required.

### DuckDB engine → PostgreSQL destination

1. Add a **Postgres connection** (DSN) in the project.  
2. Project → Destination → **PostgreSQL** + that connection.  
3. Publish the marts you want in PG.  
4. Export, then **Build**.

**Where data lands**

| Layer | Where |
|-------|--------|
| `stg_*` / `int_*` / seeds (`map_*`) | DuckDB `main` (working file) |
| `mart_*` (published) | Postgres schema (default `public`) via ATTACH alias `pg` |

CLI equivalent (same folder the UI exported):

```bash
export DWH_PG_DSN='postgresql://user:pass@host:5432/dbname'
cd /path/to/export/<pipeline_name>
/path/to/dwh-rs-query/dbt-venv/bin/dbt build --profiles-dir .
```

The UI Build path injects the DSN from the connection automatically — no need to export env in the shell when using the menu.

---

## 5. Portable / release layout

Unpacked Linux/Windows packages typically look like:

```text
DWHForge-Query*          # launcher
dwh-host                 # sidecar
extensions/              # DuckDB extensions
fixtures/                # includes committed offline Help Lab assets
# After you run fetch-dbt-venv.sh in this folder (or ship it):
dbt-venv/
```

If Parse/Build say **dbt not found**, run `./scripts/fetch-dbt-venv.sh` in that folder (dev) or place a `dbt-venv` next to the binary with `bin/dbt` executable.

---

## 6. Dev machine (from source)

```bash
./scripts/fetch-duckdb-extensions.sh   # once, needs network
npm ci
cargo build -p dwh-host --release
./scripts/sync-duckdb-lib.sh
npm run electron:dev
```

Run those commands from a checked-out repository with Node 20+, stable Rust,
native linker and Bash. The remote default is main; the exact new task/hint UI
requires the reviewed development checkout containing the UX commits. Release
tags and packages may be older. Windows packages are produced by CI; these
Linux source commands are not a clean-machine Windows validation claim.

The extension fetch and dependency/build steps need network on first setup.
Installing dbt is optional for the offline lab; do it later using §3.
After dependencies and extensions are present, no cloud/provider is needed for
the flagship. In a development session, run **npm run build** plus Electron E2E
for UI/desktop checks; a UI bundle alone does not validate the desktop path.

Prefer a normal terminal for `electron:dev` (avoid IDE “Debug” attach storms that exit the window).

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Data says preview cancelled | Use **Recompute**; cancellation does not roll back committed mapping writes |
| Data says preview failed | Read the error above/Details, correct the source or query, then **Recompute** |
| Data returns zero rows | This is an empty result, not waiting; inspect filters, keys and preview scope |
| Save before switching stops on Mapping/Matching drafts | Save those in their editor first; project-file Save is not warehouse/Matching Save-all |
| White Electron window / GPU errors | Restart; Linux builds pass `--disable-gpu`. |
| `dbt parse` / Build: dbt not found | `./scripts/fetch-dbt-venv.sh` |
| Build: missing `DWH_PG_DSN` | Destination Postgres connection with DSN; or export env for CLI |
| Schema `main_public` | Re-export with current host (includes `generate_schema_name` → real `public`) |
| Only one table in PG | Enable **Publish to destination** on each mart (e.g. daily + monthly) |
| `map_*` missing at run | Use **Build** (`dbt build`), not `dbt run` alone |
| `local.duckdb` … not a valid DuckDB database | Delete the bad file next to the export (`rm local.duckdb*`) and Build again. The app also auto-removes tiny/corrupt stubs before build. |
| Collation version WARNING on PG | Postgres/OS mismatch; optional `ALTER DATABASE … REFRESH COLLATION VERSION` |

---

## 8. What not to commit

- `dbt-venv/` (regenerate with the script)  
- `~/.dwhforge-query/secrets.json`  
- Hand-edited generator-owned export files without sync (safe re-export will refuse)  
