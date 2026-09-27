# Design summary

Workshop was built against a private design specification. This page summarizes the parts the code and docs refer to: the guarantees (C1–C5), the two releases (P and R), the demonstration story, and the acceptance scenario IDs (P01–P38).

## Goal

A single-user, local project workspace whose records, views and workflows the owner can change from inside the app, by hand or with an AI author. The changes run as real programs in a small checked language. The host that enforces admission, persistence, recovery and authority can never be changed by them. In short: *the project can become the tool you need, while your unfinished responsibilities and your ability to recover survive.*

## Guarantees

| ID | Guarantee | What it means here |
|---|---|---|
| C1 | Recovery stays available | No app package can change or hide the recovery page, the version list, export, or the ability to stop jobs |
| C2 | A runnable copy belongs to the owner | Export produces a self-contained bundle that opens offline on the declared platform |
| C3 | Unfinished commitments survive | Every open review keeps its identity, its rule for completion, and a working way to complete it, unless the owner explicitly cancels or replaces it |
| C4 | Changes are rehearsed and applied exactly | Previews run the real package on a copy of the data; applying installs exactly what was approved, against the state that was previewed |
| C5 | Generated code cannot grant itself authority | Packages act only through typed host operations, cannot approve themselves, and cannot reach other projects, files or the network |

## Releases

- **Release P** (product): a usable app whose guarantees are enforced by the TypeScript host and checked by tests.
- **Release R** (research): the part of activation that preserves commitments is checked by an executable, proved Lean checker, and that proof is maintained through a later change. See [R.md](R.md).

Neither release is claimed yet ([ASSURANCE.md](ASSURANCE.md)).

## Demonstration story

1. **P0, a notebook.** Two options, notes, an open review, and a bounded review job that survives a restart.
2. **P1, a comparison app.** Authored through "Change this": criteria, scores, evidence, a comparison view, and a review action. It is previewed and applied, and the P0 review keeps working. A faulty version that would strand the review is rejected.
3. **P2, evidence and uncertainty.** Authored from within P1: a third option, measured results kept apart from assumptions, and two independent reviews in parallel that must both finish before the decision can be finalized. Live edits made during the preview force a refresh.
4. **Finally:** finish the decision, break the app, recover independently, export, and open the export offline.

Also planned: a trial on three real projects to see whether owners keep using their evolved apps (not started).

## Acceptance scenarios

| ID | Scenario |
|---|---|
| P01 | Start with no network and no AI author; local use, recovery and export still work |
| P02 | A broken or crashing app view leaves the shell and recovery working |
| P03 | Evaluation that exhausts its budget commits nothing |
| P04 | Packages with raw code, SQL or dependency hooks are rejected before running |
| P05 | A candidate cannot change the host checker or forge an approval |
| P06 | A candidate cannot reach another project, host secrets or the network |
| P07 | The AI author cannot use shell, hooks, plugins or secrets |
| P08 | Duplicate commands and callbacks commit once; a reused ID with a different payload is refused |
| P09 | A replaced or stale review attempt cannot commit its result |
| P10 | After cancellation, no new dispatch or late result is accepted |
| P11 | A crash after a completed step keeps its evidence and does not redo it |
| P12 | A crash during an AI call is reported as uncertain, never as free or exactly-once |
| P13 | A migration cannot delete an open review |
| P14 | A migration cannot keep a review's row but remove its handler or files |
| P15 | A migration cannot weaken or retarget a review's rule |
| P16 | Cancelling one review is an explicit, audited owner action for that review only |
| P17 | A decision with an open review cannot be finalized through any route |
| P18 | A decision whose reviews are complete can be finalized |
| P19 | Changing a candidate after preview invalidates its approval |
| P20 | Live changes after a preview make applying fail until the preview is refreshed |
| P21 | Practice edits stay in the practice copy |
| P22 | A crash just before or after applying leaves exactly the old or the new version |
| P23 | Migrating one selected paused job leaves the others and past evidence intact |
| P24 | Restoring a snapshot keeps the newer branch and discloses what is excluded |
| P25 | An export can be moved, disconnected and started fresh |
| P26 | An export missing a needed file or version fails with the exact missing items |
| P27 | An imported copy cannot reuse the original's leases, approvals or sessions |
| P28 | Model output with traversal, symlinks or oversized files is rejected |
| P29 | The notebook authors the comparison app, which authors the evidence app |
| P30 | A new option or relation type needs no host change |
| P31 | Hostile artifact content or cross-site requests cannot run script or change state |
| P32 | Removing a package's own tests cannot admit a defect |
| P33 | A review newer than a restored snapshot stays pending and completable, once |
| P34 | Applying a change while a review job runs keeps exactly one valid result route |
| P35 | Keeping old code while removing its permissions or interpreter is rejected |
| P36 | A shared finite allowance stops recursive job creation |
| P37 | Cancelling after approval, or reusing an approval, requires a fresh preview |
| P38 | Completing a review, then changing its subject, requires a new review before finalizing |
