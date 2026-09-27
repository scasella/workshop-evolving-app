import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/host/canonical.ts';
import { CHECKER_BINARY, checkerSourceHash } from '../src/host/rcheck.ts';

// R01: build the executing checker and replay every proof; audit axioms; pin the result.
const root = new URL('..', import.meta.url).pathname;
// WORKSHOP_LEAN_DIR audits another copy (used by the hostile-mutation tests); only the real one writes the lock.
const lean = process.env.WORKSHOP_LEAN_DIR ?? join(root, 'lean');
const official = lean === join(root, 'lean');
const toolchain = readFileSync(join(lean, 'lean-toolchain'), 'utf8').trim();
const bin = process.env.LEAN_TOOLCHAIN_BIN ?? join(homedir(), '.elan', 'toolchains', toolchain.replace('/', '--').replace(':', '---'), 'bin');
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const sources = readdirSync(join(lean, 'WorkshopChecker')).filter(f => f.endsWith('.lean'));
for (const f of [...sources.map(f => join(lean, 'WorkshopChecker', f)), join(lean, 'Main.lean')])
  if (/\b(sorry|admit)\b|^\s*axiom\s/m.test(readFileSync(f, 'utf8'))) throw new Error(`${f} contains sorry, admit or an axiom declaration`);
// The contract is fixed: a changed statement is a new contract, which needs an explicit owner decision.
const pinned = readFileSync(join(lean, 'contract.sha256'), 'utf8').trim();
const contractHash = sha256(readFileSync(join(lean, 'WorkshopChecker', 'Contract.lean')));
if (contractHash !== pinned) throw new Error(`Contract.lean changed (${contractHash.slice(0, 12)} vs pinned ${pinned.slice(0, 12)}); proofs may not be weakened by editing the contract`);
const version = execFileSync(join(bin, 'lean'), ['--version'], { encoding: 'utf8' }).trim();
execFileSync(join(bin, 'lake'), ['build'], { cwd: lean, env, stdio: 'inherit' });
const audit = execFileSync(join(bin, 'lake'), ['env', 'lean', 'Axioms.lean'], { cwd: lean, env, encoding: 'utf8' }).trim().split('\n');
const allowed = new Set(['propext', 'Classical.choice', 'Quot.sound']);
const theorems: string[] = [];
for (const line of audit) {
  const m = /^'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)/.exec(line);
  if (!m) throw new Error(`unexpected axiom audit line: ${line}`);
  theorems.push(m[1]);
  for (const ax of (m[2] ?? '').split(',').map(s => s.trim()).filter(Boolean)) if (!allowed.has(ax)) throw new Error(`${m[1]} depends on unapproved axiom ${ax}`);
}
const required = ['preservation', 'no_retired_continuation', 'rebinds_sound', 'keeps_identity_and_rule', 'owner_approval', 'stale_rejected', 'dispositions_committed'].map(t => `Workshop.${t}`);
for (const t of required) if (!theorems.includes(t)) throw new Error(`theorem ${t} for the fixed contract was not audited`);
if (!official) { console.log(`Audit of ${lean} passed (${theorems.length} theorems); no lock written.`); process.exit(0); }
const lock = { binarySha256: sha256(readFileSync(CHECKER_BINARY)), sourceHash: checkerSourceHash(), contractHash, toolchain: version, theorems, axioms: audit };
writeFileSync(join(lean, 'checker-lock.json'), JSON.stringify(lock, null, 2) + '\n');
writeFileSync(join(root, 'evidence', 'r-proofs.json'), JSON.stringify({ observedAt: new Date().toISOString(), scope: 'R01: proofs replayed by lake build of the executing checker; axioms audited', platform: `${process.platform}/${process.arch}`, ...lock }, null, 2) + '\n');
console.log(`Checker built and ${theorems.length} theorems replayed with approved axioms only.`);
