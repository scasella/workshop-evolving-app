# Docker author boundary

**Current status:** experimental, and not used by the app. The shell and the live run use the local `codex exec` profile instead ([LIVE.md](LIVE.md)). The linux/amd64 image and the fixture isolation gate pass (`npm run author:docker:probe`, `evidence/docker-gate.json`), and the feasibility tests (authoring, relay, firewall) cover this path. The gate receipt detects accidental drift of the runner, firewall and relay sources; it is not tamper-proof. One live invocation reached the model service but failed the relay's SSE response-format check. No proposal was accepted; provider generation and usage are unknown. The reservation remains consumed and no retry occurred.

## Prepared design

- Exact Linux x86-64 Node and Codex artifacts; archive verified against the official Codex release SHA-256. `docker/runtime-lock.json` pins the built image ID, executable, profile and relay hashes.
- Unprivileged UID 65532, read-only root, all Linux capabilities dropped, no-new-privileges, default Docker seccomp, limited memory/CPU/PIDs, bounded temporary filesystem, no host bind mounts, no Docker socket, and Docker logging disabled for the invocation.
- `--network none`. The CLI can reach only a loopback HTTP relay inside its own container. Its request travels through container stdin/stdout to the trusted host. The container receives neither account credentials nor a host-home mount.
- The Linux CLI can advertise executable namespaces through `input.additional_tools` despite disabled feature flags. The host explicitly removes root and embedded tool declarations, forces `tool_choice="none"`, then validates the outbound request. Original and projected request metadata are recorded separately. No response bytes are delivered to the CLI until the complete bounded response passes an event/item allowlist. Tool calls, including hidden `apply_patch` calls, are rejected before CLI dispatch.
- Returned source still goes through the existing proposal validator and durable journal. Docker is not authorization to activate a package.

## Run

```sh
npm run author:docker:build
npm run author:docker:probe
npm test
```

The build script downloads only the official pinned CLI archive if missing, verifies its hash, and builds the pinned image. The probe uses no model credentials or live model service. Positive and hostile fixture responses exercise the real Linux CLI. A successful probe writes a gate receipt bound to the image, runner and firewall identities. Changes require a fresh probe.

The authenticated host forwarder is implemented in `src/host-model-relay.ts` and tested with fake credentials. It relays the request produced by `codex exec` only to `https://chatgpt.com/backend-api/codex/responses`, rejects redirects, permits one request, bounds streamed bytes, and attaches existing login credentials only in host HTTPS headers. It is not a model SDK fallback. Endpoint/header names were checked against the official `rust-v0.155.1` provider source. Live behavior remains unverified.

The single live call used `gpt-6-astra`, the synthetic prompt in `requests/docker-author-smoke.json`, and no automatic retry. It asked for one constrained observation-record action and included an adversarial note requesting forbidden tools. It did not read project records or mount host files. `evidence/live-request-preview.json` contains the staged outbound request, including CLI-provided context, without credentials. Automatic approval review initially stopped the command before launch. After the exact request was staged and checked for sensitive workspace content, review accepted the same action on reconsideration.

The live result is preserved in `evidence/live-1790459598257.json`; `evidence/docker-current-status.json` records subsequent reconciliation. The original code recorded the transport rejection as `failed`/`firewallRejection`; an audited journal transition now marks the invocation `uncertain` without changing its original receipt or refunding its allowance. The host never accepted or interpreted live-authored source. The first failure did not preserve the unexpected media type, so no specific service-side cause is claimed. Code now distinguishes transport failures from rejected tool calls and records status/media type for future diagnosis. No second live request was made.

## Verified Docker results

`evidence/docker-gate.json` records the passing fixture gate and source identities. The real x86-64 CLI accepted a valid structured proposal through the relay. Injected `exec_command` and native `apply_patch` responses were rejected by the host before reaching Codex. Container checks observed Linux/x64, UID 65532, no host home or Docker socket, no credentials, denied host/external connections, and a read-only root. These are bounded tested guarantees under the declared Docker/OS/host trust boundary, not a sandbox-escape proof or a complete P release.

Initial failed fixture receipts are retained. They exposed two wire-format details: an omitted root tools array and a nonempty embedded namespace declaration. The production host projection addresses those details without allowing executable model responses.

## Platform observation on 2026-09-26

The image built successfully, but this machine's Docker VM initially failed to run its x86-64 Node binary: `Exec format error`, both with and without Docker's init process. The daemon is Linux aarch64. Docker settings already reported Virtualization Framework and Rosetta enabled. Thus the initial failure is an execution/emulation issue, not a missing x86-64 image.

An unrelated existing container was left running. No Docker restart or shared VM emulation change has been performed as part of the initial probe.

After explicit owner approval, this remediation was executed successfully (`installing: amd64 OK`):

```sh
docker run --privileged --rm --network none \
  tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 \
  --install amd64
```

This was a one-time privileged change to executable handlers in the shared Docker Linux VM, not a privilege granted to author containers. No Docker restart occurred. A later VM restart may require re-registration; the build and author scripts do not perform it automatically.

Docker documents QEMU registration for failed multi-platform execution in its [multi-platform guide](https://docs.docker.com/build/building/multi-platform/#install-qemu-manually); the [binfmt project](https://github.com/tonistiigi/binfmt) documents architecture-specific installation and removal. This mechanism does not prove the application isolation gate by itself.
