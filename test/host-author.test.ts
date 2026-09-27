import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEdits } from '../src/authoring.ts';
import { applyEdits, authorPrompt, diffEdits } from '../src/host/evolve.ts';
import { readPackageDir } from '../src/host/package-dir.ts';
import { Fixture, P1_DIR, P2_DIR } from './helpers.ts';

test('author input bundle: request, language brief, commitments and current source; bounded', () => {
  const f = new Fixture().baseline();
  const { prompt, parent } = authorPrompt(f.host, 'project', 'Turn this project into a comparison workspace');
  assert.equal(parent, f.p0);
  assert.match(prompt, /Owner request: Turn this project into a comparison workspace/);
  assert.match(prompt, /ob-r17 "Review: Which storage engine\?": continues through action record_review/);
  assert.match(prompt, /=== actions\/record_review.json ===/);
  assert.ok(Buffer.byteLength(prompt) < 65536, `prompt is ${Buffer.byteLength(prompt)} bytes`);
  assert.doesNotMatch(prompt, /access_token|auth\.json|\/Users\//, 'no credentials or host paths in the bundle');
});

test('recorded successor edits pass the author validator and admit through the ordinary path; the host sets the parent', () => {
  const f = new Fixture().baseline();
  const p0 = f.host.pkg(f.p0)!.files;
  const recorded = diffEdits(p0, readPackageDir(P1_DIR));
  const validated = validateEdits(JSON.stringify({ files: recorded }));
  // An author trying to choose a different parent is overridden.
  const forged = validated.map(e => e.path === 'package.json' ? { ...e, content: JSON.stringify({ ...JSON.parse(e.content), parent: 'f'.repeat(64) }) } : e);
  const files = applyEdits(p0, forged, f.p0);
  assert.equal(JSON.parse(files['package.json']).parent, f.p0);
  const { result } = f.propose(files);
  assert.equal(result.status, 'previewable', JSON.stringify((result as any).reasons));
  // P1 → P2 drops a migration file by omitting it from the manifest.
  const p2 = diffEdits(readPackageDir(P1_DIR), readPackageDir(P2_DIR));
  assert.ok(p2.length <= 32, `${p2.length} edits`);
  assert.ok(!('migrations/001-comparison.json' in applyEdits(readPackageDir(P1_DIR), validateEdits(JSON.stringify({ files: p2 })), f.p0)));
  // Host control files and traversal never pass the validator.
  for (const path of ['../src/host/checker.ts', 'approved.json', 'actions/../../x.json', '.git/config'])
    assert.throws(() => validateEdits(JSON.stringify({ files: [{ path, content: '{}' }] })), /forbidden file path/);
});
