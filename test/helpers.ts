import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Host, type Outcome } from '../src/host/store.ts';
import { readPackageDir, withManifest } from '../src/host/package-dir.ts';
import type { Json } from '../src/host/canonical.ts';

export const P0_DIR = new URL('../packages/p0-notebook', import.meta.url).pathname;
export const P1_DIR = new URL('../packages/p1-comparison', import.meta.url).pathname;
export const P2_DIR = new URL('../packages/p2-evidence', import.meta.url).pathname;
export const tempDir = () => mkdtempSync(join(tmpdir(), 'workshop-test-'));

let counter = 0;
export class Fixture {
  host: Host; p0: string; world = 'project';
  constructor(dir = tempDir(), opts: ConstructorParameters<typeof Host>[1] = {}) {
    this.host = new Host(dir, opts);
    this.p0 = this.host.createProject(this.world, readPackageDir(P0_DIR));
  }
  get revision() { return this.host.world(this.world).revision; }
  // The owner's current root capability belongs to the active live branch.
  get activeLive() { return (this.host.worlds() as any[]).find(w => w.kind === 'live' && w.status === 'active').id as string; }
  act(actionId: string, input: Record<string, Json>, opts: { packageHash?: string; world?: string; op?: string } = {}): Outcome {
    const world = opts.world ?? this.world;
    const w = this.host.world(world);
    return this.host.run({ operationId: opts.op ?? `op-${++counter}`, worldId: world, expectedRevision: w.revision,
      packageHash: opts.packageHash ?? w.packageHash, capabilityRef: `cap-owner-${this.activeLive}`, actionId, input });
  }
  ok(actionId: string, input: Record<string, Json>, opts: { packageHash?: string; world?: string } = {}) {
    const o = this.act(actionId, input, opts);
    if (o.status !== 'committed') throw new Error(`${actionId} rejected: ${o.reasons.join('; ')}`);
    return o;
  }
  // Two alternatives, a draft decision, and one open owner review (the "R17" of the design docs).
  baseline() {
    this.ok('add_note', { id: 'n1', title: 'Pick a storage engine', body: 'Independent review still needed.' });
    this.ok('add_alternative', { id: 'sqlite', title: 'SQLite' });
    this.ok('add_alternative', { id: 'postgres', title: 'Postgres' });
    this.ok('start_decision', { id: 'd1', question: 'Which storage engine?' });
    this.ok('request_review', { key: 'r17', decision: 'd1' });
    return this;
  }
  p1Files(edit?: (files: Record<string, string>) => void, manifest: Record<string, unknown> = {}) {
    const files = withManifest(readPackageDir(P1_DIR), { parent: this.host.world(this.world).packageHash, ...manifest });
    edit?.(files);
    return files;
  }
  propose(files: Record<string, string>, id = `prop-${++counter}`) { return { id, result: this.host.propose(id, this.world, 'test change', files) }; }
  // Propose, approve exactly what was previewed, activate.
  evolve(files: Record<string, string>) {
    const { id, result } = this.propose(files);
    if (result.status !== 'previewable') throw new Error(`proposal rejected: ${result.reasons.join('; ')}`);
    this.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
    const outcome = this.host.activate(id);
    if (outcome.status !== 'committed') throw new Error(`activation rejected: ${outcome.reasons.join('; ')}`);
    return id;
  }
}
export function editJson(files: Record<string, string>, path: string, fn: (value: any) => any) {
  files[path] = JSON.stringify(fn(JSON.parse(files[path])), null, 2);
}
export function addFile(files: Record<string, string>, path: string, content: string) {
  files[path] = content;
  editJson(files, 'package.json', m => ({ ...m, files: [...m.files, path].sort() }));
}
export function removeFile(files: Record<string, string>, path: string) {
  delete files[path];
  editJson(files, 'package.json', m => ({ ...m, files: m.files.filter((f: string) => f !== path) }));
}
