# Matching — real-user E2E acceptance (baseline 7c31f6e)

This is a **test plan**, not a record of tests already passed. Run with a real Electron build and a project-local test directory. For source-backed publication use a disposable PostgreSQL table. Never use a production mapping for these tests.

## A. Help Lab: reconciliation (offline)
1. Open Help Lab → **Shipments ↔ sales**. Open dirty_recon → Join Lens → Find Matches.
2. Verify the Help Lab guidance explains that commercial_sku has no LEFT product name and that code similarity is not semantic identity.
3. Save the lab project to a new project path **before a long review** using `Save project…`; make sure Save Progress is enabled afterward.
4. Check LEFT `commercial_sku`, RIGHT `product_id` and outputs. Evaluate full scope. Expected: 4 unique LEFT keys / 7 source rows, 3 RIGHT rows, 12 candidates evaluated (current fixtures).
5. Review one RIGHT candidate; confirm manually. Save Progress. Verify current Review count persisted in the task list.
6. Change a matching rule and Evaluate again. Expected: previous reviewed run is checkpointed **before** the new evaluation; previous Review is available through Resume. Do not accept any silent loss.
7. Resume a saved Review; verify decisions, counts and candidate evidence. Test `Needs review` filter and next-page behavior.
8. Create/select a seed Mapping and Save only confirmed pairs. Confirm that the Mapping editor shows persisted rows. Save project file separately, reopen project, inspect the seed.
9. Apply the Mapping explicitly to the pipeline, rerun the reconciliation, inspect JOIN coverage and downstream quantities. Matching Save alone must **not** claim Apply.

## B. Help Lab: name-based evidence (offline)
1. Open Help Lab → **Two lists · match by name → id seed**; launch Matching for dirty_by_id → erp_products.
2. Compare `name ↔ name` while keeping CRM IDs and ERP IDs as Mapping keys/outputs. Evaluate; inspect why the quality of matches differs from `crm_id ↔ erp_id`.
3. Check A/B labels: changed target, score, classification, candidate count and source-row count are separate, **indicative** metrics. Review decisions are not compared and snapshots are not verified.
4. Confirm an alternative, Save Progress, Resume, then publish only confirmed mappings. Verify nonconfirmed keys remain untouched.

## C. Help Lab: composite name + region (offline)
1. Open `name_region_match` and launch Matching for dirty_exact_pair.
2. Confirm that vendor_label + region remains the complete LEFT key. Matching a same-name vendor from DE to US must not be silently accepted.
3. Open `Needs review`; inspect ambiguous candidates, confirm/defer a subset and Save Progress. Verify no candidate-page limit affects Evaluate coverage.

## D. Source-backed publish (test PostgreSQL only)
1. Attach a writable `storage.kind=source` KeyMap to a disposable table with a composite key and a populated row.
2. Manually confirm a small subset of a larger run. Publish Confirmed. Assert **only** those keys changed in PostgreSQL; unreviewed keys and existing differing output values remain untouched.
3. Stop after a committed batch; restart application; Resume checkpoint; retry. Assert no duplicate keys or silently overwritten values.
4. Trigger a competing edit to the same table row between preflight and publish. Expect a conflict/refusal, not a Saved success.
5. Observe the publication ledger and receipt. A partially completed multi-batch publish is not one atomic transaction.

## E. Failure and lifecycle checks
- Try Estimate at LEFT 5%, RIGHT 100% and LEFT 5%, RIGHT 10%; ensure full Evaluate counts **do not** change.
- Without a project save path, confirm a candidate and attempt Re-evaluate: expect a blocking explanation, not loss of Review.
- After project path changes, Save Progress must still archive a stale Evaluation. Publishing from stale inputs must remain blocked.
- Check the same source key with conflicting descriptive attributes; it must be marked `source_conflict` and never bulk-confirmed.
- Attempt Save without target Mapping, source write under read-only import, and large seed (>supported limit). Each must fail clearly without claiming saved rows.
- Check tab close, project replacement and app quit with uncheckpointed Review. **KNOWN GAP:** universal Matching Review is held in the child component; project lifecycle draft protection may not yet see its dirty state. Treat this as a release blocker until exercised and fixed.

## Pass/fail reporting
Record **commit SHA**, Electron/Host build version, project file path, lab id, exact input fields, runId, scores, candidate counts, Review decisions, saved task revision, destination Mapping ID/storage, actual DB rows changed, screenshots, and failures. Do not infer product readiness from a passing frontend syntax check or patch applicability.
