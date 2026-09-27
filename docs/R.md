# Research release R: the executing Lean checker

`lean/` holds a Lean 4.34.1 project (no Mathlib) for the obligation-preserving part of activation. `lean/WorkshopChecker/Check.lean` defines `check : Input → Result`. `Main.lean` compiles exactly that function into `lean/.lake/build/bin/workshop-checker`, which the host runs in R mode.

## Contract (fixed)

`lean/WorkshopChecker/Contract.lean` states the properties over input data only. Its sha256 is pinned in `lean/contract.sha256`, and `npm run r:build` refuses to build if it has changed.

| Statement | Meaning |
|---|---|
| `Preservation` | If accepted, every live obligation of the world has a continuation route, and its artifacts and subject records are present. The route is either the candidate's declared adapter to an action that can carry evidence under the grant, or a retained, available, interpreter-supported, schema-compatible, non-retired package whose action can carry it |
| `NoRetiredContinuation` | If accepted, no obligation in the ledger (any branch, any status) has its continuation package retired |
| `RebindsSound` | The plan contains only rebinds of live obligations of this world to candidate adapter actions that can carry them |
| `KeepsIdentityAndRule` | Applying rebinds keeps id, subjects, policy (verdicts, discharger, independence), status, gate and successor |
| `OwnerApproval` | Acceptance requires the host-issued owner receipt of this instance for this candidate and preview; candidate data has no field that can stand in for it |
| `StaleRejected` | A differing revision (live vs receipt vs preview) or state digest is rejected |
| `DispositionsCommitted` | Referenced dispositions are committed, of this world, not from the future, and match their obligation |

`Theorems.lean` proves each one (`preservation`, `no_retired_continuation`, and so on). `Axioms.lean` audits their axioms and ascribes each theorem its exact contract type.

## Trusted assumptions

- The host serializes `Input` faithfully. Every agreement fixture is round-tripped through the binary.
- The host's attestations are true: package availability, interpreter support, schema compatibility (from `schemaProblems`), evidence routes and capability needs of actions, presence of subject records and artifacts.
- The host applies exactly the returned rebinds inside the single SQLite activation transaction after rechecking the revision.
- Trusted components: the Lean toolchain and compiler, the C toolchain it bundles, SQLite, Node, and the OS.
- **Out of R's scope:** record migration (additive schema checks and backfill) stays checked only by TypeScript.

## Gates

| Gate | How | Evidence |
|---|---|---|
| R01 proof replay | `npm run r:build` fails on `sorry`, `admit`, `axiom` declarations, axioms outside {propext, Classical.choice, Quot.sound}, a changed contract, or a theorem restated with another type. It writes `lean/checker-lock.json` (binary sha, source hash, contract hash, toolchain) | `evidence/r-proofs.json`; guard tests in `test/r-checker.test.ts` |
| R02 fail closed | With `WORKSHOP_ASSURANCE=R` (or `new Host(dir, { assurance: 'R' })`), activation requires the locked binary. A missing or altered binary, or changed checker source, rejects activation and names the problem. The checker identity is bound into every candidate hash and recorded in the activation event | `test/r-checker.test.ts` |
| Agreement | 15 activation scenarios (P05/P14/P19/P20/P27/P35/P37, adapters, restore branches) run through both checkers, which must agree on accept/reject and on the exact rebinds; R-mode activation applies only when they agree | `test/r-checker.test.ts` |
| R03 maintenance | The checker changed from a Boolean witness check plus a separate rebind pass to a typed per-obligation `Witness` reconciled in one fold, with specific rejection reasons. The contract is byte-identical, all theorems were re-proved, and the fixtures still agree | `evidence/r03/` |

## Limits

- No checker binary is committed. Build it with `npm run r:build`, which needs elan with `leanprover/lean4:v4.34.1` (from `~/.elan/toolchains/…`, or set `LEAN_TOOLCHAIN_BIN`). This rewrites `lean/checker-lock.json` and `evidence/r-proofs.json`. Until then, R mode fails closed and the 4 R tests skip. The committed lock records the maintainer's macOS arm64 build.

- The binary is built for **macOS arm64** (the development machine). The declared release platform is Linux x86-64, and no Linux x86-64 checker has been built. Exports do not include the checker, so exported copies run in P mode.
- The proofs cover the checker function. Host glue (input construction, applying the plan) is covered by tests, not proofs.
- R has not been run against a live Codex-authored successor.
