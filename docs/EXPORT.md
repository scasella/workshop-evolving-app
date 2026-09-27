# Export (C2)

From the app: **Versions & recovery → Export** writes a bundle to a new folder (no bundled runtime).

From the terminal, `node src/host/cli.ts export <state-dir> <out-dir> [node-binary license source]` can also bundle a Linux x86-64 Node runtime. For example:

```sh
node src/host/cli.ts export .workshop/host /tmp/my-export .workshop/runtime/node-linux-x64 .workshop/runtime/NODE-LICENSE "node:25.8.1-bookworm-slim@sha256:44bc…"
```

## Contents

| Path | What |
|---|---|
| `manifest.json` | Format, source instance, `POLICY_ID`, declared platform, package/artifact closure, SHA-256 of every file, licenses, omissions, prerequisites |
| `state/host.sqlite` | Consistent copy made with `node:sqlite` `backup()`, including the control journal and the global obligation ledger |
| `state/artifacts/` | Only the closure: artifacts referenced by obligations, evidence, succeeded attempts, and artifact-typed record fields |
| `state/IMPORT_PENDING` | On first launch, the copy takes a fresh instance identity (see P27 below) |
| `app/` | Host source (`src/host`), local package sources, production `node_modules` only |
| `runtime/` | Linux x86-64 Node 25.8.1 copied from the digest-pinned `node:25.8.1-bookworm-slim` image, plus Node's LICENSE (fetched from the `v25.8.1` tag; sha256 `d94dd749…`) |
| `launch.sh`, `recovery.sh`, `verify.sh` | Use `./runtime/node` explicitly. Nothing is downloaded at launch |

Export refuses to write a bundle whose closure is incomplete. The refusal names each missing object and everything that depends on it (P26).

The first time any process opens the copy's state directory (the `Host` constructor checks the marker), the copy adopts a fresh instance identity. Approved proposals become stale, and receipts from the source instance are refused by the checker. Queued and running agent work pauses for reconciliation, job capabilities are revoked, and remaining dispatch allowance is zeroed (P27).

## Runtime license

The pinned image does not contain Node's LICENSE. Fetch it once for the matching tag and check its hash:

```sh
mkdir -p .workshop/runtime
curl -fsSL https://raw.githubusercontent.com/nodejs/node/v25.8.1/LICENSE -o .workshop/runtime/NODE-LICENSE
shasum -a 256 .workshop/runtime/NODE-LICENSE   # d94dd7496d4de9cd130f1eb6e661e43422483663fd48cf3a450d244b9cda6fdc
```

## Offline check (P25, P01)

`npm run export:offline-check` needs Docker with linux/amd64 execution. It exports a P0→P1 project with an open review and an artifact-backed agent review. It then starts the pinned image with `--network none`, deletes the image's own Node, copies the bundle to `/opt/moved-export`, and runs `verify.sh`, `recovery.sh`, a re-export of the copy (P01), `launch.sh`, and an HTTP probe using the bundled runtime. The latest receipt is in `evidence/export-offline.json`.

Limits: the fresh environment is the same Debian 12 base image the runtime came from, with Node removed. It is not an independent distribution. It ran under QEMU on an arm64 Docker VM, not on native x86-64 hardware. Redistribution terms of bundled third-party software were not reviewed beyond collecting license identifiers and files.
