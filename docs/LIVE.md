# Live run (P29), 2026-09-27

The owner authorized live model calls through the local `codex exec` (codex-cli 0.155.1, sha256 pinned in `src/codex-profile.json`, model `gpt-6-astra`, reasoning effort medium).

**Call profile** (`src/host/local-codex.ts`): the CLI uses its own sign-in (`CODEX_HOME=~/.codex`). The host reads `~/.codex/auth.json` only to check that an access token is present before enabling Ask Codex; it never copies, logs, stores or transmits it. User config and rules are ignored; the session is ephemeral; the sandbox is read-only; every optional feature in the profile is disabled; approval is `never`; web search is disabled; the working directory is empty and temporary. Any tool item in the event stream rejects the output. **This is the local profile, not the Docker isolation boundary.** The Docker path passed its fixture gate but has never completed a live call. No tool activity appeared in any live call.

## What happened

| Step | Result |
|---|---|
| Aborted run 1 | 2 calls. The host's output parser built an error message eagerly and threw on *valid* output, so the run was stopped by hand. The in-flight author call was killed and recorded as uncertain. Fixed, and the parser is now tested on the real CLI event stream (`evidence/live/aborted-run-1/`) |
| P0 review job | A live Codex review requested changes (it wanted requirements tied to the options) |
| P1 authored by Codex | Attempt 1: malformed JSON in one file, rejected before admission. Attempt 2: 9 file edits, **admitted**, practiced, approved, applied. `r17` stayed on its pinned P0 route. The authored actions and planner drove the P1 work |
| Faulty P1 | A demo-injected `retire` was rejected, naming both stranded reviews |
| P2 authored by Codex | Attempt 1 was rejected by admission (a malformed `obligations` status filter). Attempt 2: 14 edits, **admitted**. A live review change made the preview stale; it was refreshed, re-approved and applied. The migration backfilled `basis` correctly |
| Parallel reviews | Two live Codex reviews ran concurrently. Both requested changes, because the evidence records were **not in their input** (host bug, below) |
| Re-review 1 | After the bundle fix and owner updates (demo data): the reviewers caught that the owner's throughput *scores contradicted the measurements*. All three requested changes |
| Re-review 2 | After the scores were reconciled and recovery drills added: the early reviewer **approved SQLite** with citations. The methodology and risk reviewers still request changes, and a re-review of the owner's comparison review (opened when evidence changed) is also still open. **The decision remains blocked; nothing was overridden** |
| Break / recover / export | The corrupted package was listed by Recovery, repaired from hash-verified bytes, exported and verified |

Calls: 2 (aborted) + 13 (a capped allowance, raised once by the owner from 10 to 13 for a final review round) = **15 live calls**. Receipts with timing and token usage are in `evidence/live-demo.json` and `evidence/live-demo-continue-{1,2}.json`. The authored packages are in `evidence/live/p1-authored/` and `evidence/live/p2-authored/`.

**The project data is demo data.** The alternatives, benchmark numbers, recovery drills and requirements were entered by the scripts acting as the owner. The reviewers evaluated made-up measurements, so the SQLite approval is a demonstration of the workflow, not an engineering recommendation.

## Found by the live run and fixed

1. **Parser** (above).
2. **Review context**: bundles held only the obligation's subjects, so reviewers could not see the evidence, criteria or assumptions linked to them. They now include the one-hop related records and the decision being gated.
3. **Stranded job reviews**: after `changes_requested`, a job-discharged review had no job left, so it could only be disposed of, which is a C3 reachability gap. The owner can now **Request another review**, and the project page has **Run them with Codex**.

## Reproducing it

The live project directory from this run was local to the machine that ran it and is not in the repository. To run the story yourself (paid, up to 10 calls by default):

```sh
WORKSHOP_ALLOW_PAID_CALLS=1 WORKSHOP_LIVE_DIR=.workshop/my-live npm run live:paid-demo
node src/host/cli.ts serve .workshop/my-live
```

In the app, set a model and an allowance under **Change this → Authoring settings**. Address the reviewers' notes, then use **Request another review** and **Run them with Codex**. Both **Ask Codex** and review runs use the local profile above. `scripts/live-continue.ts` is the owner-side continuation used in this run, kept for the record.
