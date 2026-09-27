#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .workshop/docker-build
archive=.workshop/docker-build/codex.tar.gz
if [ ! -f "$archive" ]; then
  curl -fL https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-x86_64-unknown-linux-musl.tar.gz -o "$archive"
fi
test "$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" = a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115
tar -xzf "$archive" -C .workshop/docker-build codex-x86_64-unknown-linux-musl
mv .workshop/docker-build/codex-x86_64-unknown-linux-musl .workshop/docker-build/codex
chmod 755 .workshop/docker-build/codex
cp docker/Dockerfile docker/relay.mjs src/codex-profile.json .workshop/docker-build/
docker build --platform linux/amd64 --network none -t workshop-author:0.155.1 .workshop/docker-build
docker image inspect workshop-author:0.155.1 --format '{{json .}}' > .workshop/docker-build/image.json
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const image = JSON.parse(readFileSync('.workshop/docker-build/image.json'));
if (image.Os !== 'linux' || image.Architecture !== 'amd64') throw new Error('incorrect target');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync('docker/runtime-lock.json', JSON.stringify({imageId:image.Id, os:image.Os, architecture:image.Architecture,
  cliVersion:'0.155.1', cliHash:hash('.workshop/docker-build/codex'), relayHash:hash('docker/relay.mjs'),
  profileHash:hash('src/codex-profile.json'), archiveHash:hash('.workshop/docker-build/codex.tar.gz'),
  nodeBase:'node:25.8.1-bookworm-slim@sha256:44bcbf493408a824104e74976ae5539f596c46cbe75ed0423a137552a555e2de'},null,2)+'\n');
JS
