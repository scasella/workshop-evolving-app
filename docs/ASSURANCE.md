# Assurance map

What is enforced, which test or receipt shows it, and where the claim stops. Rows describe the source that actually executes. Tests call the same `Host` and `checker.ts` functions the app uses. "Tested" means a named automated test exercises the behavior against real SQLite; it is not a claim of release readiness. No row alone establishes a complete guarantee (C1–C5 in [DESIGN.md](DESIGN.md)). The only formal claim is the Lean checker's, which is scoped in [R.md](R.md).

`npm test` runs 86 tests; the 4 in `test/r-checker.test.ts` skip unless `npm run r:build` has built the Lean checker. `npm run check` (strict TypeScript) is clean.

## Host (`src/host/`)

| Area | Source | Evidence | Limit |
|---|---|---|---|
| Canonical identities | `canonical.ts` | Floats, `undefined` and duplicate JSON keys are rejected (`host-admission`) | Integer-only numbers by design |
| Package language `workshop-lang/1` | `lang.ts` | Hostile packages (raw code, SQL, hooks, HTML views, traversal) are rejected at admission (P04/P05/P28). Depth, steps, overflow, division by zero and type mismatches are typed errors. Scans are charged per element read, constructed values are size-capped, and views and the planner have a 1.5 s deadline (`host-regressions`) | Value types are checked during evaluation, not by a full static type system |
| Completeness | `packages/p1-comparison` | A new relation, a compound review action, an evidence-sensitive planner and a matrix view, with no host change (`host-evolution`) | Hand-written fixture |
| Authorization | `checker.ts` `authorizeAction` | Every primitive is checked for capability, principal, continuation route, subject binding and schema. Forged capability refs and package hashes are refused. Records are capped at 64 KiB | Single owner principal |
| Commitment ledger | `obligations`; practice copies in `shadow_obligations` and `shadow_tasks` | P13–P16, P38. Practice reviews and practice review jobs never touch live rows, even through restore plus transfer (P21, `host-regressions`) | `blocked` status exists but is never assigned |
| Subject-bound reviews | `subjectDigest`, `renewals` | Editing a reviewed record, rescoring it, or changing a gated decision's question or options opens a linked re-review in the same transaction. Additive migration does not (P38, `host-regressions`) | Relations are never deleted in v1 |
| Finalization | `finalizeDecision`, `/protected/finalize` | Owner only, explicit confirmation. Blocked by open reviews in *any* branch sharing the decision, by stale-subject reviews, and by replaced reviews whose replacement is not done (P17/P18, shell tests) | |
| Cancel / replace a review | `disposeObligation` | One review at a time, with a reason. Its waiting jobs are cancelled (P16/P37) | |
| Continuation witnesses | `continuationWitnesses` | Retired package, missing adapter target, removed capability, unsupported interpreter, missing artifact and incompatible schema all reject and name the review (P14/P35). Retiring a package any review needs is refused, even with an adapter, matching the Lean rule | Adapter routes are checked for an evidence route, not for what the target action requires of the reviewer |
| Additive migration | `schemaProblems`, `migrate` | Removing or reinterpreting a field, reusing a semantic ID, turning an optional field required without a default, and backfilling existing fields are all rejected (P13/P15, `host-regressions`) | Default-fill and backfill into new fields only |
| Propose → preview → apply | `Host.propose/approve/activate/refresh` | Exact candidate/preview binding (P19); stale rejection and refresh (P20); practice isolation (P21); disposition ordering and receipt reuse (P37). Re-proposing the active version is refused plainly | |
| Atomic activation | `Host.activate` (one SQLite transaction) | A real child process exits immediately before and after COMMIT, leaving the old or new version, never a mix (P22) | Two injection points; no storage-fault injection |
| Package rehearsals | `lang.ts` tests, `Host.rehearse` | Package-supplied episodes run on disposable copies after host checks. Failures, and errors while rehearsing, reject the candidate. Deleting them cannot admit a defect (P32) | Recorded inputs only |
| Idempotent commands | `commands` journal | The same ID returns the recorded outcome; a different payload is refused (P08). The shell gives each rendered form its own ID, so a double submit is saved once | Stale-revision and budget refusals are not journaled |
| Review jobs | `startAttempt`, `completeReview`, `failAttempt`, `runQueued` | Replaced generations and old controller epochs are refused (P09); a failing old attempt no longer revokes the current one. Cancellation revokes first (P10). A refused result fails its attempt instead of hanging. Crashes are reconciled as uncertain and never retried automatically (P11/P12). One finite allowance is shared by author and review calls (P36). A running attempt survives activation (P34). Selected paused jobs can migrate (P23) | Review independence is by job identity, not by reviewer model or credential |
| Artifacts | `putArtifact`, `readArtifact` | Staged, hashed, fsynced and renamed; tampered or missing bytes are reported | Text media types only |
| Policy identity | `POLICY_ID` | A hash of the checker, interpreter and store source goes into every candidate hash and the export manifest | Exports therefore ship the source |

## Shell and recovery

| Area | Source | Evidence | Limit |
|---|---|---|---|
| Loopback shell | `server.ts`, `render.ts` | The sign-in link sets an HttpOnly SameSite=Strict cookie. There is a Host allow-list (DNS rebinding), a required same-origin `Origin` (null or foreign refused), a per-session CSRF token, a CSP with no script source, escaped package text, and sandboxed `text/plain` artifacts (P31) | The sign-in link is reusable until the host stops; sessions do not expire while it runs |
| Usability | `server.ts`, `render.ts` | IDs are generated from titles, and references are chosen from lists. Input is kept after a failed submit, with plain-language errors and 404/400/401 pages. The planner goes options → decision → review. Finalize shows what blocks it. Change this leads with what works. The approval page catches a stale preview on load (`host-shell` usability tests) | Keyboard and focus were checked by hand in one browser; no automated accessibility audit |
| Independent recovery | `recovery.ts`, `cli.ts recovery` | Never runs package code. With a corrupted app version, the project page reports it, reviews stay listed and completable through their pinned version, and Recovery lists the broken reference (P02) | Cannot repair a corrupted database |
| Restore and branches | `restorePreview`, `restore`, `switchBranch`, `transfer` | A confirmation page lists what the restore leaves behind. Restoring makes a new branch and keeps the old one, its reviews and the journal (P24). You can switch back. Newer reviews stay bound once and remain completable, movable only when the host's check passes, or cancellable (P33) | Full snapshots only, taken before each app change |
| Repair | `Host.repairPackage` | Reinstalls app-version bytes only if they hash to an identity the host already references | Needs a good copy of the source |

## Export (C2)

| Area | Source | Evidence | Limit |
|---|---|---|---|
| Export and import | `export.ts`, `/protected/export`, `Host.adoptImport` | An incomplete closure is refused, naming every missing object and dependent (P26). The manifest detects modified, missing and unexpected files and a changed checker. An imported copy gets a new identity; old approvals, leases and allowance cannot be replayed (P27). The Recovery page exports to a new folder (shell test) | See [EXPORT.md](EXPORT.md) |
| Offline launch | `npm run export:offline-check` | In a fresh `--network none` linux/amd64 container with the image's Node deleted and the bundle moved, verify, recovery, the shell, an offline edit and a re-export all work (P01, P25; `evidence/export-offline.json`) | Same Debian base as the runtime source, run under QEMU |

## Codex

| Area | Source | Evidence | Limit |
|---|---|---|---|
| Live authoring and reviews | `local-codex.ts`, `/change/author`, `/protected/run-reviews` | These are owner actions. Buttons stay disabled until you set a model and a call allowance and the pinned CLI is signed in. The first live run made 15 real calls with receipts; the output parser is tested on the real CLI event stream ([LIVE.md](LIVE.md)) | Local CLI profile, not the Docker boundary |
| Author attempts across restarts | `reconcileAuthorAttempts` | A call interrupted by a restart is marked uncertain, keeps its charge, and is shown on Change this and Recovery; it is never retried | |
| Docker author boundary (experimental) | `docker-author.ts`, `docker/relay.mjs`, `response-firewall.ts` | Fixture gate: no network, read-only root, no mounts, tool declarations removed, tool-call responses refused (`evidence/docker-gate.json`) | No successful live call; the gate receipt checks drift, not tampering |

## Research release R

See [R.md](R.md). Seven theorems of a hash-pinned contract are replayed with standard axioms. The build refuses weakened statements. A missing or altered binary fails closed. TypeScript and Lean agree on 15 fixtures. R03 re-proved the contract after an algorithm change. Limits: macOS arm64 only; record migration and job rebinding are outside its scope.

## Scenario status ([P01–P38](DESIGN.md#acceptance-scenarios))

| Status | Scenarios |
|---|---|
| Tested by `npm test` | P02, P03, P04, P05, P08, P09, P10, P11, P13–P24, P26, P27, P28, P30–P38 |
| Verified by script (`export:offline-check`, Docker) | P01, P25 |
| Partial | P06 (the package language has no route to other worlds, files, environment or network, and probes confirm denial; the Codex author runs as a local CLI profile, not an OS sandbox), P07 (Docker fixture gate only; live calls used the local profile, and no tool activity appeared in 15 calls), P12 (the reviewer in the crash test is simulated) |
| Ran live, not complete | P29: Codex authored P1 and P2 live and both were applied; the decision is still blocked by two independent reviewers ([LIVE.md](LIVE.md)) |

## Known gaps and non-claims

- **Release status:** neither release P nor release R is claimed. The adoption trial ([DESIGN.md](DESIGN.md)) has not started.
- **Workflows:** stage definitions (`workflows/*.json`) are validated but not executed.
- **Allowance roots:** review jobs do not record which change request's allowance they belong to; the owner chooses it when running them.
- **Migration races:** if a job selected for migration starts running between approval and activation, activation fails closed as `rejected` rather than `stale`.
- **R-mode messages:** running `r:build` between approval and activation changes the candidate identity, so activation reports "the candidate changed". The Lean binary runs inside the activation transaction with a 10 s timeout. `KeepsIdentityAndRule` is proved about a model of the host's update; the real update is covered by the agreement fixtures.
- **Self-influence:** a package's own review prompts are shown to the reviewer, so a package can influence (though never bypass) its own reviews.
- **Reviews across branches:** a review completed on another branch can be stale for a restored branch's copy of a decision, and there is no re-review control for that case. The ways out are switching back, cancelling it, or recording a new review there. Moving a review only works from a branch you restored from, so reviews left on a restored branch can be cancelled but not moved back.
- **Completion window:** a crash between committing a review result and marking its job succeeded leaves the job for reconciliation; the result itself is committed.

## Pre-release review fixes

An adversarial review before publication reproduced and fixed:

- practice review jobs leaking into the live queue;
- a failing old attempt revoking the current one;
- evaluation cost not proportional to work;
- re-review after a transfer running in the wrong branch;
- optional-to-required schema changes;
- decision redrafts not reopening reviews;
- the retire rule diverging from Lean.

Each has a regression test in `test/host-regressions.test.ts`.

## History: milestone-1 feasibility spike

`src/spike.ts` and `src/demo.ts` (`npm run spike:demo`) are the first prototype: one interpreted action, copied worlds, revision checks. It is superseded by `src/host` and kept for reference. `src/authoring.ts` is the first Codex transport (see [AUTHORING.md](AUTHORING.md)).
