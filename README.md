# Workshop

**A local project workspace whose app you can reprogram, by hand or with Codex, without losing your open reviews, your history, or your way back.**

You keep notes, options and decisions in a small app that runs on your own machine. When the app doesn't fit the work, you ask for a change: "turn this into a comparison workspace", "add a third option and run two independent reviews". The change arrives as a *package* written in a small checked language. You preview it on a copy of your data, and apply it only if Workshop's own checks pass. Reviews you required keep working across every change. Decisions they gate stay blocked until the reviews are done. Every version can be restored, and the whole project can be exported and opened offline.

This is a research prototype built against a design specification summarized in [docs/DESIGN.md](docs/DESIGN.md). It is single-user, runs on loopback only, and is not production software.

| Area | Status |
|---|---|
| Host, package language, reviews, previews, recovery, export | Implemented; 86 automated tests |
| Live authoring with Codex | Has run end to end once, on demo data ([live run](docs/LIVE.md)) |
| Docker isolation for the author | Fixture gate passes; never used for a live call |
| Lean-checked activation (research release "R") | Proved and integrated on macOS arm64 only ([R](docs/R.md)) |
| Real-user adoption trial | Not started |

## Quickstart

Requires **Node.js 25.8.1** (see `.nvmrc`). Workshop uses Node's built-in `node:sqlite`, native TypeScript type stripping and JSON import attributes, so no build step is needed.

```sh
npm ci
npm start          # serves a new project from .workshop/host and prints a sign-in link
npm test           # 86 tests; without a Lean build, 82 run and 4 R-checker tests skip
```

Open the printed `http://127.0.0.1:4317/login?token=…` link. If port 4317 is taken, use `npm start -- 4391`. The suggested next steps walk you through it:

1. Add the options you're choosing between.
2. Start a decision.
3. Require a review.

To change the app, open **Change this** and propose the bundled `p1-comparison` package. Try it in the practice area, then apply it. Your review still has to be completed before you can finalize.

## How it works

```
 you / Codex ──► package (JSON AST) ──► admission & preview ──► owner approval ──► atomic activation
                     │                        │                                    │
                     ▼                        ▼                                    ▼
               lang.ts interpreter      checker.ts (+ Lean in R mode)          store.ts (SQLite)
                                                                                    │
     Project page · Change this · Versions & recovery · Export ◄── server.ts (loopback shell, no client script)
```

- **Package language** (`src/host/lang.ts`): schemas, typed relations, compound actions, planner rules, views, additive migrations and rehearsal tests, as versioned JSON. It has no eval, SQL, shell or HTML. Evaluation is bounded by steps, value size and time.
- **Authority** (`src/host/checker.ts`): pure functions decide every state change.
  - A global ledger of *commitments* (reviews you required), bound to the subjects they reviewed.
  - Owner-only finalization and cancellation.
  - Continuation checks, so no change can strand an open review.
  - Activation of a new app version.
- **Store** (`src/host/store.ts`): one SQLite writer.
  - Idempotent commands.
  - Practice copies of your data for previews.
  - The propose → preview → approve → apply flow.
  - Snapshots, restore and switching branches.
  - Fenced review jobs with a finite call allowance.
  - Offline export and import.
- **Shell** (`src/host/server.ts`, `render.ts`, `recovery.ts`): Fastify on loopback, React rendered on the server, no client JavaScript. Recovery never runs app code.
- **Codex** (`src/host/local-codex.ts`, optional): live authoring and reviews through your locally installed Codex CLI. They run only when you've set a model and a call allowance and press the button.
- **Lean checker** (`lean/`, optional): a proved checker for the part of activation that preserves reviews.

## Requirements for optional features

| Feature | Needs |
|---|---|
| Ask Codex / Run reviews with Codex / `npm run live:paid-demo` | OpenAI Codex CLI **0.155.1** at `/opt/homebrew/bin/codex` (sha256 pinned in `src/codex-profile.json`), signed in with `codex login`. **Each call is billed to your account.** |
| `npm run r:build`, the 4 R tests, R mode | Lean `v4.34.1` via elan (`~/.elan/toolchains/…`, or set `LEAN_TOOLCHAIN_BIN`) |
| `npm run export:offline-check`, `npm run demo:recorded`, `author:docker:*` | Docker with `linux/amd64` (QEMU on Apple silicon) |

## Scripts

| Script | What it does | Needs | Writes tracked files |
|---|---|---|---|
| `start` | Serve the project in `.workshop/host` | — | no |
| `test` / `check` | Test suite / strict type check | — | no |
| `r:build` | Build the Lean checker, replay proofs, audit axioms | Lean | `lean/checker-lock.json`, `evidence/r-proofs.json` |
| `export:offline-check` | Export a project, then launch it in a fresh `--network none` container | Docker | `evidence/export-offline.json` |
| `demo:recorded` | The full demo story with recorded author responses (no model calls) | Docker | `evidence/demo-recorded.json` |
| `live:paid-demo` | The full demo story with **live, paid** Codex calls (needs `WORKSHOP_ALLOW_PAID_CALLS=1`) | Codex | `evidence/live-demo.json`, `evidence/live/` |
| `author:docker:build` / `author:docker:probe` | Build the pinned author image / re-run the isolation gate | Docker | `docker/runtime-lock.json`, `evidence/docker-*.json` |
| `spike:demo` | The milestone-1 prototype (superseded by `src/host`) | — | no |

## Documentation

- [docs/ASSURANCE.md](docs/ASSURANCE.md): what is tested, with which evidence, and its limits (C1–C5, P01–P38).
- [docs/R.md](docs/R.md): the Lean checker, its fixed contract and assumptions.
- [docs/EXPORT.md](docs/EXPORT.md): offline export and import.
- [docs/LIVE.md](docs/LIVE.md): the live Codex run, what it found, and its costs.
- [docs/DOCKER_AUTHORING.md](docs/DOCKER_AUTHORING.md), [docs/AUTHORING.md](docs/AUTHORING.md): the isolated author boundary (experimental).
- [docs/DESIGN.md](docs/DESIGN.md): the goals, the guarantees **C1–C5**, releases P and R, the demonstration story, and the acceptance scenarios **P01–P38**.

## Limitations

- Single owner, one machine, loopback only. The sign-in link works until the host process stops.
- The live Codex run used made-up project data. Its outcome demonstrates the workflow, not an engineering recommendation.
- Live authoring uses the local Codex CLI profile, not the Docker boundary.
- The R checker covers only obligation-preserving activation, only on macOS arm64. It relies on facts the host supplies ([docs/R.md](docs/R.md)).
- The package language is deliberately small. Workflow stage definitions are validated but not executed.

## Repository layout

```
src/host/     the application: language, checker, store, shell, runner, export, Codex adapters
src/*.ts      milestone-1 author transport, Docker boundary and prototype
packages/     example app packages: p0-notebook (genesis), p1-comparison, p2-evidence
lean/         Lean checker and proofs (research release R)
docker/       pinned author image
scripts/      demos, probes and checks
evidence/     receipts from real runs (local paths redacted)
test/         node:test suites
```

## License

[MIT](LICENSE)
