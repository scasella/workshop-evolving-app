# Codex authoring transport (milestone 1, experimental)

**Current state.** This document describes `src/authoring.ts`: the first transport to the Codex CLI and its source validator (`validateEdits`), and the author journal. Only fixtures and the Docker path ([DOCKER_AUTHORING.md](DOCKER_AUTHORING.md)) use it. The app's live authoring uses the local CLI profile in `src/host/local-codex.ts` instead; see [LIVE.md](LIVE.md). `validateEdits` and the journal are shared by both.

## History

The notes below were written while the boundary was being built, and they are kept as a record.

Update: the [Docker author boundary](DOCKER_AUTHORING.md) now passes Linux x86-64 positive/hostile fixtures after approved QEMU registration. Its host relay removes Linux CLI tool declarations and rejects returned calls before dispatch. The original local adapter described below remains fixture-only. One live Docker invocation failed the SSE-format check; provider outcome/usage are unknown, no source was accepted, and no retry occurred.

Correction to the initial tool-inventory claim: the original local probe checked the root `tools` array, not embedded `additional_tools` declarations. An empty root array alone does not establish zero advertised tools. The newer Docker relay explicitly inspects/removes both forms, and the Linux receipts preserve the discovered embedded namespace declarations.

### Implemented and executed

The authoring transport uses installed `codex exec`, structured `--output-schema`, JSON events and stdin. `codex --exec --help` returned an unexpected-argument error. No compatibility wrapper or SDK fallback was substituted.

`src/codex-profile.json` pins the inspected executable SHA-256 and CLI version. Each invocation uses a disposable Codex configuration home, empty working directory, minimal child environment, ignored user configuration/rules, disabled features, disabled web search, read-only filesystem sandbox, and `approval_policy="never"`. These child environment overrides do not edit the user's configuration or credentials. The fixture home contains no copied authentication material.

`src/authoring.ts` reserves an invocation unit in SQLite before spawning, enforces the shared root allowance and two-attempt concurrency bound, feeds an assembled prompt via stdin, and bounds execution to 60 seconds and combined output to 1 MiB. Timeout/cancellation/output overflow terminate the owned process group. Unexpected binaries fail closed. Reused operation IDs return stored state; changed input under the same ID is rejected. No retries are automatic.

Successful exit alone is insufficient. The adapter requires a completed CLI turn and one structured final message, rejects execution-event types, validates file count/size/depth/path/manifest restrictions, and stores proposed source as a single content-addressed database object. Source validation is not package admission or owner approval.

### Boundary evidence

The real CLI issued requests to a local fixture endpoint with **an empty `tools` array**. The endpoint then injected calls, irrespective of that advertised list:

| Injected call | Observed result |
|---|---|
| `exec_command` | Unsupported call |
| `shell` | Unsupported call |
| `apply_patch` (native custom-tool format) | Patch handler reached; write rejected by read-only sandbox and approval policy |
| `mcp__host__read_secret` | Unsupported call |
| `spawn_agent` | Unsupported call |

The canary file was not created. An initial malformed function-format patch was rejected for incompatible payload; the recorded final probe uses the correct custom-tool format. The reachable patch handler demonstrates why zero advertised tools is insufficient to establish the specification's stronger absence of executable routes. This is a bounded local observation, not a finding that every possible tool is disabled or that credential access is impossible.

The end-to-end fixture used one CLI invocation, exposed zero tools, sent no Authorization header to the fixture, supplied the output schema, persisted a proposed action, and interpreted that action successfully. A repeated operation did not issue another request. The response was handwritten test data, not authored by a model. No P0→P1→P2 success is claimed.

### Original remaining gate and proposed host work (see Docker update above)

Live mode intentionally fails before launching. Required work:

1. Provision and pin the Linux x86-64 author runtime, then repeat the CLI probes on that exact binary. The existing macOS/ARM64 tests are development evidence only.
2. Implement an OS-contained author process with restricted filesystem and process visibility, minimal assembled context, and model-service-only egress. Keep credentials exclusively in the trusted invocation path, never in package evaluation or source import.
3. Inspect and deny hidden execution routes as well as advertised tools. A reviewed transport boundary that rejects tool-call responses before CLI dispatch is one possible addition; it is not implemented or assumed here.
4. Probe host/sibling filesystem reads, credentials, subprocesses, hooks/plugins/MCP inheritance and unrelated destinations. Retain negative results. Merely asking the model not to use tools is insufficient.
5. Only then enable a bounded live author run with the owner's model and shared call allowance, preserving failure, usage and uncertain-outcome receipts.

The adapter is not a complete durable job supervisor: there are no lease generations/controller epochs, full disk quotas, authentication readiness checks for live mode, continuation migration, or production isolation runner yet. Controller reconciliation must occur only after the prior process is confirmed stopped. The fixture journal is not wired into the application's world revision/obligation reducer. Passing these tests does not satisfy P07, P09–P12, P28 or P36 as complete release scenarios.

For configuration terminology only, the upstream [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json) was inspected. It is not evidence for the installed binary's behavior; local receipts supply that evidence.
