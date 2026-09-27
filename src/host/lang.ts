import { canonical, digest, fail, need, parseCanonicalJson, sha256, type Json } from './canonical.ts';

// workshop-lang/1: a versioned JSON AST interpreted by the trusted host.
// Package source never reaches eval, dynamic import, SQL, a shell, or the DOM.
export const INTERPRETER = 'workshop-lang/1';
export const LIMITS = {
  files: 128, fileBytes: 64 * 1024, packageBytes: 1024 * 1024, astDepth: 24, steps: 20_000,
  listItems: 1000, stringBytes: 4096, mutations: 256, effectsPerAction: 64, loopItems: 64, viewRows: 500
};
export const CAPABILITIES = ['records.write', 'relations.write', 'obligations.open', 'evidence.submit',
  'tasks.review', 'decisions.draft'] as const;
export type Capability = typeof CAPABILITIES[number];

// ---------- Package model ----------
export type FieldSpec = { type: 'string'; max?: number } | { type: 'int'; min?: number; max?: number } |
  { type: 'bool' } | { type: 'enum'; values: string[] } | { type: 'ref'; to: string } | { type: 'artifact' } |
  { type: 'list'; of: FieldSpec; max: number };
export type Field = FieldSpec & { optional?: boolean; default?: Json; semantic: string };
export type TypeDef = { id: string; title: string; fields: Record<string, Field> };
export type RelationDef = { id: string; title: string; from: string; to: string; fields: Record<string, Field> };
export type Expr = { [op: string]: any };
export type Effect = { [kind: string]: any };
export type ActionDef = { id: string; title: string; inputs: Record<string, Field>; let?: { name: string; value: Expr }[];
  requires?: { when: Expr; reason: string }[]; effects: Effect[] };
export type ViewDef = { id: string; title: string; kind: 'table' | 'matrix' | 'status' | 'form'; [key: string]: any };
export type Stage = { id: string; after: string[]; task: 'review'; fanout?: number };
export type WorkflowDef = { id: string; title: string; stages: Stage[] };
export type PlannerRule = { id: string; when: Expr; suggest: { action: string; label: string; input: Record<string, Expr> } };
// Candidate-supplied rehearsal episodes: data only, run by the host in disposable worlds.
export type TestStep = { action: string; input: Record<string, Json>; expect: 'committed' | 'rejected'; reason?: string }
  | { finalize: { decision: string; choice: string }; expect: 'committed' | 'rejected'; reason?: string }
  | { view: string; contains: string } | { planner: string; present: boolean };
export type PackageTest = { id: string; title: string; steps: TestStep[] };
export type Manifest = { name: string; version: number; language: string; parent: string | null;
  interpreters: string[]; files: string[]; capabilities: Capability[]; migration: string | null;
  views: string[]; retire?: string[]; continuations?: Record<string, string> };
export type Package = { hash: string; manifest: Manifest; files: Record<string, string>;
  types: Map<string, TypeDef>; relations: Map<string, RelationDef>; actions: Map<string, ActionDef>;
  views: Map<string, ViewDef>; workflows: Map<string, WorkflowDef>; planner: PlannerRule[];
  migration: { steps: { backfill: { type: string; field: string; value: Expr } }[] } | null; tests: PackageTest[] };

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const RECORD_ID = /^[a-z][a-z0-9_-]{0,79}$/;
const FILE = /^(package\.json|planner\.json|(schemas|actions|workflows|views|migrations|tests)\/[a-z0-9][a-z0-9_-]{0,63}\.json|prompts\/[a-z0-9][a-z0-9_-]{0,63}\.md)$/;
export const isRecordId = (value: unknown): value is string => typeof value === 'string' && RECORD_ID.test(value);

function obj(value: unknown, where: string, required: string[], optional: string[] = []): Record<string, any> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'package_shape', `${where}: expected object`);
  for (const key of required) need(key in (value as object), 'package_shape', `${where}: missing ${key}`);
  for (const key of Object.keys(value as object))
    need(required.includes(key) || optional.includes(key), 'package_unknown_key', `${where}: unsupported key "${key}"`);
  return value as Record<string, any>;
}
function name(value: unknown, where: string): string {
  need(typeof value === 'string' && NAME.test(value), 'package_name', `${where}: invalid identifier ${JSON.stringify(value)}`);
  return value;
}
function text(value: unknown, where: string, max = 200): string {
  need(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max, 'package_text', `${where}: invalid text`);
  return value;
}
function list<T = any>(value: unknown, where: string, max: number): T[] {
  need(Array.isArray(value) && value.length <= max, 'package_shape', `${where}: expected list of at most ${max}`);
  return value as T[];
}

function parseFieldSpec(value: unknown, where: string, depth = 0): FieldSpec {
  need(depth < 3, 'package_shape', `${where}: nested lists too deep`);
  const raw = value as any;
  need(raw && typeof raw === 'object', 'package_shape', `${where}: expected field`);
  const meta = ['optional', 'default', 'semantic'];
  switch (raw.type) {
    case 'string': obj(raw, where, ['type'], ['max', ...meta]);
      need(raw.max === undefined || (Number.isSafeInteger(raw.max) && raw.max > 0 && raw.max <= LIMITS.stringBytes), 'package_shape', `${where}: bad max`);
      return raw;
    case 'int': obj(raw, where, ['type'], ['min', 'max', ...meta]);
      need([raw.min, raw.max].every(v => v === undefined || Number.isSafeInteger(v)), 'package_shape', `${where}: bad bounds`);
      return raw;
    case 'bool': case 'artifact': obj(raw, where, ['type'], meta); return raw;
    case 'enum': obj(raw, where, ['type', 'values'], meta);
      list(raw.values, where, 32).forEach((v, i) => name(v, `${where}.values[${i}]`)); return raw;
    case 'ref': obj(raw, where, ['type', 'to'], meta); name(raw.to, `${where}.to`); return raw;
    case 'list': obj(raw, where, ['type', 'of', 'max'], meta);
      need(Number.isSafeInteger(raw.max) && raw.max > 0 && raw.max <= LIMITS.listItems, 'package_shape', `${where}: bad list max`);
      parseFieldSpec(raw.of, `${where}.of`, depth + 1); return raw;
    default: fail('package_shape', `${where}: unsupported field type ${JSON.stringify(raw.type)}`);
  }
}
function parseFields(value: unknown, where: string, semantic: boolean): Record<string, Field> {
  const fields = obj(value, where, [], Object.keys((value as object) ?? {}));
  need(Object.keys(fields).length <= 48, 'package_shape', `${where}: too many fields`);
  for (const [key, spec] of Object.entries(fields)) {
    name(key, `${where}.${key}`);
    parseFieldSpec(spec, `${where}.${key}`);
    if (semantic) need(typeof spec.semantic === 'string' && /^[a-z][a-z0-9_./-]{0,79}$/.test(spec.semantic), 'package_semantic', `${where}.${key}: semantic ID required`);
    if (spec.default !== undefined) checkValue(spec, spec.default, `${where}.${key}.default`);
  }
  return fields as Record<string, Field>;
}

// ---------- Values ----------
export type RecordValue = { id: string; type: string; rev: number; data: Record<string, Json> };
export type RelationValue = { id: string; relation: string; from: string; to: string; data: Record<string, Json> };
export function checkValue(spec: FieldSpec, value: unknown, where: string): Json {
  switch (spec.type) {
    case 'string': need(typeof value === 'string' && Buffer.byteLength(value) <= (spec.max ?? LIMITS.stringBytes), 'type_error', `${where}: expected string within limit`); break;
    case 'int': need(Number.isSafeInteger(value) && (spec.min === undefined || (value as number) >= spec.min) && (spec.max === undefined || (value as number) <= spec.max), 'type_error', `${where}: expected integer in range`); break;
    case 'bool': need(typeof value === 'boolean', 'type_error', `${where}: expected boolean`); break;
    case 'enum': need(typeof value === 'string' && spec.values.includes(value), 'type_error', `${where}: expected one of ${spec.values.join(', ')}`); break;
    case 'ref': need(isRecordId(value), 'type_error', `${where}: expected record ID`); break;
    case 'artifact': need(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'type_error', `${where}: expected artifact hash`); break;
    case 'list': need(Array.isArray(value) && value.length <= spec.max, 'type_error', `${where}: expected bounded list`);
      (value as unknown[]).forEach((item, i) => checkValue(spec.of, item, `${where}[${i}]`)); break;
  }
  return value as Json;
}

// ---------- AST validation ----------
const EXPR_OPS: Record<string, 'lit' | 'name' | 'expr' | 'pair' | 'list' | 'triple' | 'special'> = {
  lit: 'lit', input: 'name', var: 'name', get: 'special', record: 'expr', records: 'name', related: 'special',
  obligations: 'special', decisions: 'special', decision: 'expr', subject_digest: 'expr', exists: 'expr',
  eq: 'pair', ne: 'pair', lt: 'pair', le: 'pair', gt: 'pair', ge: 'pair', add: 'pair', sub: 'pair', mul: 'pair', div: 'pair',
  in: 'pair', union: 'pair', and: 'list', or: 'list', concat: 'list', list: 'list', not: 'expr', len: 'expr', if: 'triple',
  filter: 'special', map: 'special', any: 'special', all: 'special', count: 'special', sum: 'special', unique: 'expr'
};
export function validateExpr(expr: unknown, where: string, scope: Set<string>, pkgRefs: RefCheck, depth = 0): void {
  need(depth <= LIMITS.astDepth, 'ast_depth', `${where}: AST depth exceeds ${LIMITS.astDepth}`);
  need(expr !== null && typeof expr === 'object' && !Array.isArray(expr) && Object.keys(expr).length === 1, 'ast_shape', `${where}: expression must be an object with one operator`);
  const [op, arg] = Object.entries(expr as object)[0];
  const kind = EXPR_OPS[op];
  need(kind, 'ast_operator', `${where}: unsupported operator "${op}"`);
  const sub = (value: unknown, suffix: string, extra?: string) =>
    validateExpr(value, `${where}.${suffix}`, extra ? new Set([...scope, extra]) : scope, pkgRefs, depth + 1);
  switch (kind) {
    case 'lit': canonical(arg); need(Buffer.byteLength(JSON.stringify(arg)) <= LIMITS.stringBytes, 'ast_literal', `${where}: literal too large`); break;
    case 'name':
      name(arg, `${where}.${op}`);
      if (op === 'var') need(scope.has(arg), 'ast_scope', `${where}: unbound variable ${arg}`);
      if (op === 'input') need(pkgRefs.inputs?.has(arg), 'ast_scope', `${where}: undeclared input ${arg}`);
      if (op === 'records') need(pkgRefs.types.has(arg), 'ast_ref', `${where}: unknown type ${arg}`);
      break;
    case 'expr': sub(arg, op); break;
    case 'pair': need(Array.isArray(arg) && arg.length === 2, 'ast_shape', `${where}: ${op} takes two operands`); arg.forEach((a: unknown, i: number) => sub(a, `${op}[${i}]`)); break;
    case 'triple': need(Array.isArray(arg) && arg.length === 3, 'ast_shape', `${where}: if takes three operands`); arg.forEach((a: unknown, i: number) => sub(a, `if[${i}]`)); break;
    case 'list': list(arg, `${where}.${op}`, 32).forEach((a, i) => sub(a, `${op}[${i}]`)); break;
    case 'special':
      if (op === 'get') { need(Array.isArray(arg) && arg.length === 2, 'ast_shape', `${where}: get takes [record, field]`); sub(arg[0], 'get[0]'); need(typeof arg[1] === 'string' && (BUILTIN_FIELDS.has(arg[1]) || pkgRefs.fieldNames.has(arg[1])), 'ast_ref', `${where}: unknown field ${JSON.stringify(arg[1])}`); }
      else if (op === 'related') { const r = obj(arg, `${where}.related`, ['relation'], ['from', 'to']); need(pkgRefs.relations.has(r.relation), 'ast_ref', `${where}: unknown relation ${r.relation}`); if (r.from) sub(r.from, 'from'); if (r.to) sub(r.to, 'to'); }
      else if (op === 'decisions') { const o = obj(arg, `${where}.decisions`, [], ['status']); if (o.status) need(o.status === 'draft' || o.status === 'final', 'ast_ref', `${where}: decisions status is draft or final`); }
      else if (op === 'obligations') { const o = obj(arg, `${where}.obligations`, [], ['gate', 'subject', 'status']); if (o.gate) sub(o.gate, 'gate'); if (o.subject) sub(o.subject, 'subject'); if (o.status) list(o.status, 'status', 5).forEach(s => need(OBLIGATION_STATUSES.includes(s), 'ast_ref', `${where}: bad status`)); }
      else {
        const s = obj(arg, `${where}.${op}`, ['list', 'as'], op === 'map' || op === 'sum' ? ['to'] : ['where']);
        name(s.as, `${where}.as`); sub(s.list, 'list');
        if (op === 'map' || op === 'sum') { need(s.to, 'ast_shape', `${where}: ${op} needs to`); sub(s.to, 'to', s.as); }
        else if (op === 'count') { if (s.where) sub(s.where, 'where', s.as); }
        else { need(s.where, 'ast_shape', `${where}: ${op} needs where`); sub(s.where, 'where', s.as); }
      }
  }
}
const BUILTIN_FIELDS = new Set(['id', 'type', 'from', 'to', 'status', 'gate', 'subjects', 'title', 'key', 'question', 'choice']);
export const OBLIGATION_STATUSES = ['open', 'blocked', 'fulfilled', 'cancelled_by_owner', 'superseded_by_owner'];
type RefCheck = { types: Map<string, TypeDef>; relations: Map<string, RelationDef>; fieldNames: Set<string>; inputs?: Set<string> };

const EFFECT_CAPS: Record<string, Capability> = {
  create: 'records.write', update: 'records.write', relate: 'relations.write', obligation: 'obligations.open',
  evidence: 'evidence.submit', task: 'tasks.review', decision: 'decisions.draft'
};
function validateEffects(effects: unknown, where: string, scope: Set<string>, refs: RefCheck, caps: Set<string>, used: Set<string>, depth = 0) {
  need(depth <= 3, 'ast_depth', `${where}: foreach nesting too deep`);
  list(effects, where, LIMITS.effectsPerAction).forEach((effect, i) => {
    const at = `${where}[${i}]`;
    need(effect && typeof effect === 'object' && Object.keys(effect).length === 1, 'effect_shape', `${at}: effect must have one kind`);
    const [kind, arg] = Object.entries(effect)[0] as [string, any];
    const e = (value: unknown, key: string) => validateExpr(value, `${at}.${key}`, scope, refs);
    if (kind === 'foreach') {
      const f = obj(arg, at, ['list', 'as', 'effects']); name(f.as, `${at}.as`); e(f.list, 'list');
      validateEffects(f.effects, `${at}.effects`, new Set([...scope, f.as]), refs, caps, used, depth + 1); return;
    }
    const cap = EFFECT_CAPS[kind];
    need(cap, 'effect_kind', `${at}: unsupported effect "${kind}"`);
    need(caps.has(cap), 'capability_undeclared', `${at}: effect ${kind} requires undeclared capability ${cap}`);
    used.add(cap);
    if (kind === 'create') {
      const c = obj(arg, at, ['type', 'id', 'fields']); need(refs.types.has(c.type), 'ast_ref', `${at}: unknown type ${c.type}`);
      e(c.id, 'id'); checkFieldExprs(c.fields, refs.types.get(c.type)!.fields, at, e, true);
    } else if (kind === 'update') {
      const u = obj(arg, at, ['type', 'id', 'fields']); need(refs.types.has(u.type), 'ast_ref', `${at}: unknown type ${u.type}`);
      e(u.id, 'id'); checkFieldExprs(u.fields, refs.types.get(u.type)!.fields, at, e, false);
    } else if (kind === 'relate') {
      const r = obj(arg, at, ['relation', 'from', 'to', 'fields']); need(refs.relations.has(r.relation), 'ast_ref', `${at}: unknown relation ${r.relation}`);
      e(r.from, 'from'); e(r.to, 'to'); checkFieldExprs(r.fields, refs.relations.get(r.relation)!.fields, at, e, true);
    } else if (kind === 'obligation') {
      const o = obj(arg, at, ['key', 'title', 'subjects', 'gate', 'verdicts', 'discharge', 'continuation'], ['independent']);
      e(o.key, 'key'); e(o.title, 'title'); e(o.subjects, 'subjects'); e(o.gate, 'gate');
      list(o.verdicts, `${at}.verdicts`, 4).forEach(v => name(v, `${at}.verdicts`));
      need(o.discharge === 'owner' || o.discharge === 'job', 'effect_shape', `${at}: discharge must be owner or job`);
      need(o.independent === undefined || typeof o.independent === 'boolean', 'effect_shape', `${at}: independent must be boolean`);
      name(o.continuation, `${at}.continuation`);
    } else if (kind === 'evidence') {
      const v = obj(arg, at, ['obligation', 'verdict', 'note'], ['artifact']);
      e(v.obligation, 'obligation'); e(v.verdict, 'verdict'); e(v.note, 'note'); if (v.artifact) e(v.artifact, 'artifact');
    } else if (kind === 'task') {
      const t = obj(arg, at, ['kind', 'obligation', 'prompt']); need(t.kind === 'review', 'effect_shape', `${at}: only review tasks exist in v1`);
      e(t.obligation, 'obligation'); name(t.prompt, `${at}.prompt`);
    } else if (kind === 'decision') {
      const d = obj(arg, at, ['id', 'question', 'subjects', 'choice']); e(d.id, 'id'); e(d.question, 'question'); e(d.subjects, 'subjects'); e(d.choice, 'choice');
    }
  });
}
function checkFieldExprs(fields: unknown, specs: Record<string, Field>, at: string, e: (v: unknown, k: string) => void, create: boolean) {
  const f = obj(fields, `${at}.fields`, [], Object.keys(specs));
  for (const [key, value] of Object.entries(f)) e(value, `fields.${key}`);
  if (create) for (const [key, spec] of Object.entries(specs))
    need(key in f || spec.optional || spec.default !== undefined, 'effect_shape', `${at}: required field ${key} not set`);
}

// ---------- Package parsing / static admission ----------
export function packageHash(files: Record<string, string>): string {
  return digest({ language: INTERPRETER, files: Object.keys(files).sort().map(path => [path, sha256(files[path])]) });
}
export function parsePackage(files: Record<string, string>): Package {
  need(files && typeof files === 'object', 'package_shape', 'expected file map');
  const paths = Object.keys(files);
  need(paths.length > 0 && paths.length <= LIMITS.files, 'package_files', 'file count out of bounds');
  let total = 0;
  const lower = new Set<string>();
  for (const path of paths) {
    need(FILE.test(path), 'package_path', `rejected path ${JSON.stringify(path)} (allowed: declared package directories, no traversal or nesting)`);
    need(!lower.has(path.toLowerCase()), 'package_path', `duplicate path ${path}`); lower.add(path.toLowerCase());
    need(typeof files[path] === 'string', 'package_encoding', `${path}: expected UTF-8 text`);
    need(!files[path].includes('\u0000'), 'package_encoding', `${path}: NUL byte`);
    const size = Buffer.byteLength(files[path]); total += size;
    need(size <= LIMITS.fileBytes, 'package_size', `${path}: exceeds ${LIMITS.fileBytes} bytes`);
  }
  need(total <= LIMITS.packageBytes, 'package_size', 'package exceeds size limit');
  need('package.json' in files, 'package_manifest', 'missing package.json');
  const json = (path: string) => parseCanonicalJson(files[path], LIMITS.fileBytes);
  const m = obj(json('package.json'), 'package.json', ['name', 'version', 'language', 'parent', 'interpreters', 'files', 'capabilities', 'migration', 'views'], ['retire', 'continuations']) as Manifest;
  name(m.name, 'package.json.name');
  need(Number.isSafeInteger(m.version) && m.version > 0, 'package_manifest', 'version must be a positive integer');
  need(m.language === INTERPRETER, 'package_language', `unsupported language ${JSON.stringify(m.language)}`);
  need(m.parent === null || (typeof m.parent === 'string' && /^[0-9a-f]{64}$/.test(m.parent)), 'package_manifest', 'parent must be a package hash or null');
  need(list(m.interpreters, 'interpreters', 4).includes(INTERPRETER), 'package_language', 'package is not compatible with this interpreter');
  const declared = list<string>(m.files, 'files', LIMITS.files);
  need([...declared].sort().join('\n') === paths.filter(p => p !== 'package.json').sort().join('\n'),
    'package_manifest', 'manifest file list must exactly match package files (undeclared or missing files)');
  const caps = new Set(list<string>(m.capabilities, 'capabilities', CAPABILITIES.length));
  for (const cap of caps) need((CAPABILITIES as readonly string[]).includes(cap), 'capability_unknown', `unknown capability ${cap}`);
  if (m.retire) list<string>(m.retire, 'retire', 16).forEach(h => need(/^[0-9a-f]{64}$/.test(h), 'package_manifest', 'retire entries must be package hashes'));
  if (m.continuations) for (const [from, to] of Object.entries(obj(m.continuations, 'continuations', [], Object.keys(m.continuations)))) {
    need(/^[0-9a-f]{64}:[a-z][a-z0-9_]{0,47}$/.test(from), 'package_manifest', `continuation adapter key ${from} must be <packageHash>:<action>`);
    name(to, `continuations.${from}`);
  }

  const types = new Map<string, TypeDef>(); const relations = new Map<string, RelationDef>();
  for (const path of paths.filter(p => p.startsWith('schemas/'))) {
    const s = obj(json(path), path, [], ['types', 'relations']);
    for (const [i, t] of list(s.types ?? [], `${path}.types`, 64).entries()) {
      const def = obj(t, `${path}.types[${i}]`, ['id', 'title', 'fields']);
      name(def.id, `${path}.types[${i}].id`); text(def.title, `${path}.types[${i}].title`);
      need(!types.has(def.id), 'package_duplicate', `duplicate type ${def.id}`);
      types.set(def.id, { id: def.id, title: def.title, fields: parseFields(def.fields, `${path}.${def.id}`, true) });
    }
    for (const [i, r] of list(s.relations ?? [], `${path}.relations`, 64).entries()) {
      const def = obj(r, `${path}.relations[${i}]`, ['id', 'title', 'from', 'to', 'fields']);
      name(def.id, `${path}.relations[${i}].id`); text(def.title, `${path}.relations[${i}].title`);
      need(!relations.has(def.id), 'package_duplicate', `duplicate relation ${def.id}`);
      relations.set(def.id, { id: def.id, title: def.title, from: name(def.from, 'from'), to: name(def.to, 'to'), fields: parseFields(def.fields, `${path}.${def.id}`, true) });
    }
  }
  for (const r of relations.values()) need(types.has(r.from) && types.has(r.to), 'ast_ref', `relation ${r.id} references an unknown type`);
  for (const t of types.values()) for (const [f, spec] of Object.entries(t.fields)) {
    let s: FieldSpec = spec; while (s.type === 'list') s = s.of;
    if (s.type === 'ref') need(types.has(s.to), 'ast_ref', `${t.id}.${f} references unknown type ${s.to}`);
  }
  const fieldNames = new Set<string>([...types.values(), ...relations.values()].flatMap(d => Object.keys(d.fields)));
  const base: RefCheck = { types, relations, fieldNames };
  const usedCaps = new Set<string>();

  const actions = new Map<string, ActionDef>();
  for (const path of paths.filter(p => p.startsWith('actions/'))) {
    const a = obj(json(path), path, ['id', 'title', 'inputs', 'effects'], ['let', 'requires']) as ActionDef;
    name(a.id, `${path}.id`); text(a.title, `${path}.title`);
    need(!actions.has(a.id), 'package_duplicate', `duplicate action ${a.id}`);
    const inputs = parseFields(a.inputs, `${path}.inputs`, false);
    const refs = { ...base, inputs: new Set(Object.keys(inputs)) };
    const scope = new Set<string>();
    for (const [i, binding] of list(a.let ?? [], `${path}.let`, 16).entries()) {
      const b = obj(binding, `${path}.let[${i}]`, ['name', 'value']); name(b.name, `${path}.let[${i}].name`);
      validateExpr(b.value, `${path}.let[${i}]`, scope, refs); scope.add(b.name);
    }
    for (const [i, rule] of list(a.requires ?? [], `${path}.requires`, 32).entries()) {
      const r = obj(rule, `${path}.requires[${i}]`, ['when', 'reason']); text(r.reason, `${path}.requires[${i}].reason`, 300);
      validateExpr(r.when, `${path}.requires[${i}]`, scope, refs);
    }
    validateEffects(a.effects, `${path}.effects`, scope, refs, caps, usedCaps);
    actions.set(a.id, a);
  }
  // Continuation actions named by obligation effects must exist in this package.
  for (const a of actions.values()) walkEffects(a.effects, e => {
    if (e.obligation) need(actions.has(e.obligation.continuation) && hasEvidenceRoute(actions.get(e.obligation.continuation)!),
      'continuation_missing', `action ${a.id} opens obligations whose continuation ${e.obligation.continuation} is missing or cannot submit evidence`);
  });
  const workflows = new Map<string, WorkflowDef>();
  for (const path of paths.filter(p => p.startsWith('workflows/'))) {
    const w = obj(json(path), path, ['id', 'title', 'stages']) as WorkflowDef;
    name(w.id, `${path}.id`); text(w.title, `${path}.title`);
    const ids = new Set<string>();
    for (const [i, st] of list(w.stages, `${path}.stages`, 16).entries()) {
      const s = obj(st, `${path}.stages[${i}]`, ['id', 'after', 'task'], ['fanout']);
      name(s.id, 'stage id'); need(!ids.has(s.id), 'package_duplicate', `duplicate stage ${s.id}`);
      for (const dep of list(s.after, 'after', 16)) need(ids.has(dep), 'workflow_cycle', `${path}: stage ${s.id} depends on a later or unknown stage ${dep} (stages must be acyclic and ordered)`);
      need(s.task === 'review', 'effect_shape', `${path}: unsupported task kind ${s.task}`);
      need(s.fanout === undefined || (Number.isSafeInteger(s.fanout) && s.fanout >= 1 && s.fanout <= 4), 'workflow_fanout', `${path}: fan-out must be 1..4`);
      ids.add(s.id);
    }
    workflows.set(w.id, w);
  }
  const planner: PlannerRule[] = [];
  if ('planner.json' in files) {
    const p = obj(json('planner.json'), 'planner.json', ['rules']);
    for (const [i, r] of list(p.rules, 'planner.rules', 32).entries()) {
      const rule = obj(r, `planner.rules[${i}]`, ['id', 'when', 'suggest']) as PlannerRule;
      name(rule.id, 'rule id');
      validateExpr(rule.when, `planner.${rule.id}.when`, new Set(), base);
      const s = obj(rule.suggest, `planner.${rule.id}.suggest`, ['action', 'label', 'input']);
      need(actions.has(s.action), 'ast_ref', `planner.${rule.id}: unknown action ${s.action}`); text(s.label, 'label');
      for (const [k, v] of Object.entries(obj(s.input, 'input', [], Object.keys(s.input)))) {
        need(k in actions.get(s.action)!.inputs, 'ast_ref', `planner.${rule.id}: action ${s.action} has no input ${k}`);
        validateExpr(v, `planner.${rule.id}.input.${k}`, new Set(), base);
      }
      planner.push(rule);
    }
  }
  const views = new Map<string, ViewDef>();
  for (const path of paths.filter(p => p.startsWith('views/'))) {
    const v = parseView(json(path), path, base, actions);
    need(!views.has(v.id), 'package_duplicate', `duplicate view ${v.id}`); views.set(v.id, v);
  }
  for (const v of list<string>(m.views, 'views', 16)) need(views.has(v), 'ast_ref', `manifest names unknown view ${v}`);
  let migration: Package['migration'] = null;
  if (m.migration !== null) {
    need(typeof m.migration === 'string' && m.migration.startsWith('migrations/') && m.migration in files, 'package_manifest', 'migration entry must name a package migration file');
    const mig = obj(json(m.migration), m.migration, ['steps']);
    for (const [i, step] of list(mig.steps, `${m.migration}.steps`, 32).entries()) {
      need(step && typeof step === 'object' && Object.keys(step).length === 1 && 'backfill' in step,
        'migration_kind', `${m.migration}.steps[${i}]: only additive backfill steps are supported (got ${Object.keys(step ?? {}).join(',')})`);
      const b = obj(step.backfill, `${m.migration}.steps[${i}].backfill`, ['type', 'field', 'value']);
      need(types.has(b.type) && b.field in types.get(b.type)!.fields, 'ast_ref', `${m.migration}: unknown backfill target ${b.type}.${b.field}`);
      validateExpr(b.value, `${m.migration}.steps[${i}]`, new Set(['record']), base);
    }
    migration = mig as Package['migration'];
  }
  const tests: PackageTest[] = [];
  for (const path of paths.filter(p => p.startsWith('tests/'))) {
    const t = obj(json(path), path, ['id', 'title', 'steps']);
    name(t.id, `${path}.id`); text(t.title, `${path}.title`);
    for (const [i, step] of list(t.steps, `${path}.steps`, 32).entries()) {
      const at = `${path}.steps[${i}]`;
      if (step && 'action' in step) { obj(step, at, ['action', 'input', 'expect'], ['reason']); need(actions.has(step.action), 'ast_ref', `${at}: unknown action ${step.action}`); obj(step.input, `${at}.input`, [], Object.keys(step.input ?? {})); }
      else if (step && 'finalize' in step) { obj(step, at, ['finalize', 'expect'], ['reason']); obj(step.finalize, `${at}.finalize`, ['decision', 'choice']); }
      else if (step && 'view' in step) { obj(step, at, ['view', 'contains']); need(views.has(step.view), 'ast_ref', `${at}: unknown view ${step.view}`); text(step.contains, `${at}.contains`, 400); }
      else if (step && 'planner' in step) { obj(step, at, ['planner', 'present']); need(planner.some(r => r.id === step.planner), 'ast_ref', `${at}: unknown planner rule ${step.planner}`); need(typeof step.present === 'boolean', 'package_shape', `${at}.present`); }
      else fail('package_shape', `${at}: a step is an action, finalize, view or planner check`);
      if ('expect' in step) need(step.expect === 'committed' || step.expect === 'rejected', 'package_shape', `${at}.expect`);
    }
    tests.push(t as PackageTest);
  }
  for (const cap of caps) need(usedCaps.has(cap) || cap === 'tasks.review', 'capability_unused', `declared capability ${cap} is never used`);
  return { hash: packageHash(files), manifest: m, files, types, relations, actions, views, workflows, planner, migration, tests };
}
export function walkEffects(effects: Effect[], fn: (e: Effect) => void) {
  for (const e of effects) { fn(e); if (e.foreach) walkEffects(e.foreach.effects, fn); }
}
export function hasEvidenceRoute(action: ActionDef): boolean {
  let found = false; walkEffects(action.effects, e => { if (e.evidence) found = true; }); return found;
}
function parseView(value: unknown, path: string, refs: RefCheck, actions: Map<string, ActionDef>): ViewDef {
  const kind = (value as any)?.kind;
  const common = ['id', 'title', 'kind'];
  const actionRefs = (items: unknown, scope: Set<string>) => list(items ?? [], `${path}.actions`, 8).forEach((a, i) => {
    const r = obj(a, `${path}.actions[${i}]`, ['action', 'label', 'input']);
    need(actions.has(r.action), 'ast_ref', `${path}: unknown action ${r.action}`); text(r.label, 'label');
    for (const [k, v] of Object.entries(obj(r.input, 'input', [], Object.keys(r.input)))) {
      need(k in actions.get(r.action)!.inputs, 'ast_ref', `${path}: action ${r.action} has no input ${k}`);
      validateExpr(v, `${path}.actions[${i}].${k}`, scope, refs);
    }
  });
  let v: Record<string, any>;
  if (kind === 'table') {
    v = obj(value, path, [...common, 'rows', 'columns'], ['actions', 'empty']);
    validateExpr(v.rows, `${path}.rows`, new Set(), refs);
    list(v.columns, `${path}.columns`, 12).forEach((c, i) => { const col = obj(c, `${path}.columns[${i}]`, ['label', 'value']); text(col.label, 'label'); validateExpr(col.value, `${path}.columns[${i}]`, new Set(['row']), refs); });
    actionRefs(v.actions, new Set(['row']));
  } else if (kind === 'matrix') {
    v = obj(value, path, [...common, 'rows', 'columns', 'rowLabel', 'columnLabel', 'cell'], ['empty']);
    validateExpr(v.rows, `${path}.rows`, new Set(), refs); validateExpr(v.columns, `${path}.columns`, new Set(), refs);
    validateExpr(v.rowLabel, `${path}.rowLabel`, new Set(['row']), refs); validateExpr(v.columnLabel, `${path}.columnLabel`, new Set(['column']), refs);
    validateExpr(v.cell, `${path}.cell`, new Set(['row', 'column']), refs);
  } else if (kind === 'status') {
    v = obj(value, path, [...common, 'items']);
    list(v.items, `${path}.items`, 16).forEach((c, i) => { const it = obj(c, `${path}.items[${i}]`, ['label', 'value']); text(it.label, 'label'); validateExpr(it.value, `${path}.items[${i}]`, new Set(), refs); });
  } else if (kind === 'form') {
    v = obj(value, path, [...common, 'action']);
    need(actions.has(v.action), 'ast_ref', `${path}: unknown action ${v.action}`);
  } else fail('view_kind', `${path}: unsupported view kind ${JSON.stringify(kind)} (no raw HTML/JS/CSS views)`);
  name(v.id, `${path}.id`); text(v.title, `${path}.title`);
  return v as ViewDef;
}

// ---------- Evaluation ----------
export type ObligationView = { id: string; key: string; title: string; status: string; gate: string | null; subjects: string[] };
export type DecisionView = { id: string; question: string; subjects: string[]; choice: string | null; status: 'draft' | 'final' };
export type WorldView = {
  records: Map<string, RecordValue>; relations: Map<string, RelationValue>;
  obligations: ObligationView[]; decisions: Map<string, DecisionView>; subjectDigest: (ids: string[]) => string;
};
// Steps are charged in proportion to the work done (collection scans, hashed bytes).
// An optional wall-clock deadline bounds interactive evaluation (views, planner) as well.
export class Budget {
  steps = 0;
  readonly max: number;
  readonly deadline: number | null;
  constructor(max = LIMITS.steps, timeLimitMs: number | null = null) { this.max = max; this.deadline = timeLimitMs === null ? null : Date.now() + timeLimitMs; }
  tick(n = 1) {
    this.steps += n;
    need(this.steps <= this.max, 'budget_exhausted', `evaluation exceeded ${this.max} steps`);
    if (this.deadline !== null && Date.now() > this.deadline) fail('budget_exhausted', 'evaluation exceeded its time limit');
  }
}
// Logical size of a value, memoized per object, so shared references cannot hide exponential growth.
const sizes = new WeakMap<object, number>();
export function valueSize(v: unknown): number {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? 1 + (v.length >> 6) : 1;
  const known = sizes.get(v as object); if (known !== undefined) return known;
  let n = 1;
  for (const x of Array.isArray(v) ? v : Object.values(v as object)) { n += valueSize(x); if (n > 1e9) break; }
  sizes.set(v as object, n); return n;
}
const MAX_VALUE_SIZE = 50_000;
const bounded = <T>(v: T, where: string): T => { need(valueSize(v) <= MAX_VALUE_SIZE, 'budget_exhausted', `${where}: value too large`); return v; };
type Env = { world: WorldView; inputs: Record<string, Json>; vars: Map<string, any>; budget: Budget };

function asList(v: unknown, where: string): any[] { need(Array.isArray(v), 'type_error', `${where}: expected list`); return v; }
function asInt(v: unknown, where: string): number { need(Number.isSafeInteger(v), 'type_error', `${where}: expected integer`); return v as number; }
function checkedInt(v: number, where: string) { need(Number.isSafeInteger(v), 'arith_overflow', `${where}: integer overflow`); return v; }
function scalar(v: unknown): boolean { return v === null || ['string', 'number', 'boolean'].includes(typeof v); }
function recordObject(r: RecordValue) { return { id: r.id, type: r.type, ...r.data }; }

export function evaluate(expr: Expr, env: Env): any {
  env.budget.tick();
  const [op, arg] = Object.entries(expr)[0];
  const ev = (e: Expr) => evaluate(e, env);
  const loop = (spec: any, fn: (items: any[], each: (item: any, e: Expr) => any) => any) => {
    const items = asList(ev(spec.list), op);
    need(items.length <= LIMITS.listItems, 'budget_exhausted', `${op}: list exceeds ${LIMITS.listItems} items`);
    env.budget.tick(items.length);
    const each = (item: any, e: Expr) => {
      const previous = env.vars.get(spec.as); env.vars.set(spec.as, item);
      try { return ev(e); } finally { if (previous === undefined) env.vars.delete(spec.as); else env.vars.set(spec.as, previous); }
    };
    return fn(items, each);
  };
  switch (op) {
    case 'lit': return arg;
    case 'input': need(arg in env.inputs, 'type_error', `missing input ${arg}`); return env.inputs[arg];
    case 'var': need(env.vars.has(arg), 'type_error', `unbound ${arg}`); return env.vars.get(arg);
    case 'get': {
      const target = ev(arg[0]);
      need(target && typeof target === 'object' && !Array.isArray(target), 'type_error', `get ${arg[1]}: expected record`);
      return target[arg[1]] ?? null;
    }
    case 'record': { const id = ev(arg); const r = typeof id === 'string' ? env.world.records.get(id) : undefined; return r ? recordObject(r) : null; }
    case 'records': {
      env.budget.tick(env.world.records.size);
      const out = [...env.world.records.values()].filter(r => r.type === arg).sort((a, b) => a.id < b.id ? -1 : 1);
      need(out.length <= LIMITS.listItems, 'budget_exhausted', 'records: too many'); return out.map(recordObject);
    }
    case 'related': {
      const from = arg.from ? ev(arg.from) : undefined; const to = arg.to ? ev(arg.to) : undefined;
      env.budget.tick(env.world.relations.size);
      const out = [...env.world.relations.values()].filter(r => r.relation === arg.relation && (from === undefined || r.from === from) && (to === undefined || r.to === to))
        .sort((a, b) => a.id < b.id ? -1 : 1);
      return out.map(r => ({ id: r.id, from: r.from, to: r.to, ...r.data }));
    }
    case 'obligations': {
      const gate = arg.gate ? ev(arg.gate) : undefined; const subject = arg.subject ? ev(arg.subject) : undefined;
      env.budget.tick(env.world.obligations.length);
      const out = env.world.obligations.filter(o => (gate === undefined || o.gate === gate) &&
        (subject === undefined || o.subjects.includes(subject)) && (!arg.status || arg.status.includes(o.status)));
      return out.map(o => ({ ...o, subjects: [...o.subjects] }));
    }
    case 'decisions': {
      env.budget.tick(env.world.decisions.size);
      return [...env.world.decisions.values()].filter(d => !arg.status || d.status === arg.status).sort((a, b) => a.id < b.id ? -1 : 1).map(d => ({ ...d, subjects: [...d.subjects] }));
    }
    case 'decision': { const d = env.world.decisions.get(ev(arg)); return d ? { ...d, subjects: [...d.subjects] } : null; }
    case 'exists': return ev(arg) !== null;
    case 'subject_digest': {
      const ids = asList(ev(arg), 'subject_digest');
      // Hashing cost scales with the records hashed (each at most 64 KiB).
      env.budget.tick(1 + ids.length * 64); need(ids.length <= 64, 'budget_exhausted', 'subject_digest: too many subjects');
      return env.world.subjectDigest(ids);
    }
    case 'eq': case 'ne': {
      const [a, b] = arg.map(ev); need(scalar(a) && scalar(b), 'type_error', `${op}: compares scalars only`);
      need(a === null || b === null || typeof a === typeof b, 'type_error', `${op}: operand types differ (${typeof a} vs ${typeof b})`);
      return op === 'eq' ? a === b : a !== b;
    }
    case 'lt': case 'le': case 'gt': case 'ge': {
      const [a, b] = arg.map(ev);
      need((Number.isSafeInteger(a) && Number.isSafeInteger(b)) || (typeof a === 'string' && typeof b === 'string'), 'type_error', `${op}: expected two integers or two strings`);
      return op === 'lt' ? a < b : op === 'le' ? a <= b : op === 'gt' ? a > b : a >= b;
    }
    case 'add': case 'sub': case 'mul': case 'div': {
      const [a, b] = arg.map((e: Expr, i: number) => asInt(ev(e), `${op}[${i}]`));
      if (op === 'div') { need(b !== 0, 'arith_div_zero', 'division by zero'); return Math.trunc(a / b); }
      return checkedInt(op === 'add' ? a + b : op === 'sub' ? a - b : a * b, op);
    }
    case 'union': { const [a, b] = [asList(ev(arg[0]), 'union'), asList(ev(arg[1]), 'union')]; env.budget.tick(a.length + b.length); need([...a, ...b].every(scalar), 'type_error', 'union: scalars only'); const out = [...new Set([...a, ...b])]; need(out.length <= LIMITS.listItems, 'budget_exhausted', 'union: too many'); return out; }
    case 'in': { const [x, xs] = [ev(arg[0]), asList(ev(arg[1]), 'in')]; env.budget.tick(xs.length); return xs.includes(x); }
    case 'and': { for (const e of arg) { const v = ev(e); need(typeof v === 'boolean', 'type_error', 'and: expected boolean'); if (!v) return false; } return true; }
    case 'or': { for (const e of arg) { const v = ev(e); need(typeof v === 'boolean', 'type_error', 'or: expected boolean'); if (v) return true; } return false; }
    case 'not': { const v = ev(arg); need(typeof v === 'boolean', 'type_error', 'not: expected boolean'); return !v; }
    case 'if': { const c = ev(arg[0]); need(typeof c === 'boolean', 'type_error', 'if: expected boolean condition'); return ev(c ? arg[1] : arg[2]); }
    case 'concat': {
      const parts = arg.map(ev); need(parts.every((p: unknown) => typeof p === 'string' || Number.isSafeInteger(p)), 'type_error', 'concat: expected strings or integers');
      const out = parts.join(''); need(Buffer.byteLength(out) <= LIMITS.stringBytes, 'budget_exhausted', 'concat: string too long'); return out;
    }
    case 'list': return bounded(arg.map(ev), 'list');
    case 'len': { const v = ev(arg); need(typeof v === 'string' || Array.isArray(v), 'type_error', 'len: expected string or list'); return v.length; }
    case 'unique': { const xs = asList(ev(arg), 'unique'); env.budget.tick(xs.length); need(xs.every(scalar), 'type_error', 'unique: scalars only'); return [...new Set(xs)]; }
    case 'filter': return loop(arg, (items, each) => items.filter(i => { const v = each(i, arg.where); need(typeof v === 'boolean', 'type_error', 'filter: expected boolean'); return v; }));
    case 'map': return bounded(loop(arg, (items, each) => items.map(i => each(i, arg.to))), 'map');
    case 'any': return loop(arg, (items, each) => items.some(i => each(i, arg.where) === true));
    case 'all': return loop(arg, (items, each) => items.every(i => { const v = each(i, arg.where); need(typeof v === 'boolean', 'type_error', 'all: expected boolean'); return v; }));
    case 'count': return loop(arg, (items, each) => arg.where ? items.filter(i => each(i, arg.where) === true).length : items.length);
    case 'sum': return loop(arg, (items, each) => items.reduce((acc, i) => checkedInt(acc + asInt(each(i, arg.to), 'sum'), 'sum'), 0));
  }
  fail('ast_operator', `unsupported operator ${op}`);
}

// A proposal is data. The host authorization pass decides whether any of it happens.
export type Primitive =
  | { op: 'create_record'; type: string; id: string; data: Record<string, Json> }
  | { op: 'update_record'; type: string; id: string; data: Record<string, Json> }
  | { op: 'relate'; relation: string; from: string; to: string; data: Record<string, Json> }
  | { op: 'open_obligation'; key: string; title: string; subjects: string[]; gate: string | null; verdicts: string[];
      discharge: 'owner' | 'job'; independent: boolean; continuation: string }
  | { op: 'submit_evidence'; obligation: string; verdict: string; note: string; artifact: string | null }
  | { op: 'request_task'; kind: 'review'; obligation: string; prompt: string }
  | { op: 'draft_decision'; id: string; question: string; subjects: string[]; choice: string | null };
export type Evaluation = { ok: true; primitives: Primitive[]; steps: number } | { ok: false; reason: string; code: string; steps: number };

export function evaluateAction(pkg: Package, actionId: string, input: Record<string, Json>, world: WorldView, budget = new Budget()): Evaluation {
  try {
    const action = pkg.actions.get(actionId);
    need(action, 'unknown_action', `package has no action ${actionId}`);
    need(input && typeof input === 'object' && !Array.isArray(input), 'type_error', 'input must be an object');
    for (const key of Object.keys(input)) need(key in action.inputs, 'type_error', `unexpected input ${key}`);
    const inputs: Record<string, Json> = {};
    for (const [key, spec] of Object.entries(action.inputs)) {
      if (!(key in input)) { need(spec.optional || spec.default !== undefined, 'type_error', `missing input ${key}`); inputs[key] = spec.default ?? null; }
      else inputs[key] = checkValue(spec, input[key], `input.${key}`);
    }
    const env: Env = { world, inputs, vars: new Map(), budget };
    for (const b of action.let ?? []) env.vars.set(b.name, evaluate(b.value, env));
    for (const rule of action.requires ?? []) {
      const ok = evaluate(rule.when, env);
      need(typeof ok === 'boolean', 'type_error', 'requires: expected boolean');
      if (!ok) return { ok: false, code: 'precondition', reason: rule.reason, steps: budget.steps };
    }
    const primitives: Primitive[] = [];
    runEffects(action.effects, env, primitives);
    return { ok: true, primitives, steps: budget.steps };
  } catch (error: any) {
    return { ok: false, code: error.code ?? 'evaluation_error', reason: error.message, steps: budget.steps };
  }
}
function runEffects(effects: Effect[], env: Env, out: Primitive[]) {
  const ev = (e: Expr) => evaluate(e, env);
  const fields = (f: Record<string, Expr>) => Object.fromEntries(Object.entries(f).map(([k, e]) => [k, ev(e)]));
  const ids = (v: unknown, where: string) => { const xs = asList(v, where); need(xs.every(isRecordId) && xs.length <= 32, 'type_error', `${where}: expected record IDs`); return xs as string[]; };
  for (const effect of effects) {
    need(out.length < LIMITS.mutations, 'budget_exhausted', `action exceeds ${LIMITS.mutations} mutations`);
    const [kind, a] = Object.entries(effect)[0] as [string, any];
    if (kind === 'foreach') {
      const items = asList(ev(a.list), 'foreach'); need(items.length <= LIMITS.loopItems, 'budget_exhausted', 'foreach: too many items');
      for (const item of items) { env.vars.set(a.as, item); runEffects(a.effects, env, out); }
      env.vars.delete(a.as); continue;
    }
    env.budget.tick();
    if (kind === 'create') out.push({ op: 'create_record', type: a.type, id: ev(a.id), data: fields(a.fields) });
    else if (kind === 'update') out.push({ op: 'update_record', type: a.type, id: ev(a.id), data: fields(a.fields) });
    else if (kind === 'relate') out.push({ op: 'relate', relation: a.relation, from: ev(a.from), to: ev(a.to), data: fields(a.fields) });
    else if (kind === 'obligation') out.push({ op: 'open_obligation', key: ev(a.key), title: ev(a.title), subjects: ids(ev(a.subjects), 'subjects'),
      gate: ev(a.gate), verdicts: a.verdicts, discharge: a.discharge, independent: a.independent ?? false, continuation: a.continuation });
    else if (kind === 'evidence') out.push({ op: 'submit_evidence', obligation: ev(a.obligation), verdict: ev(a.verdict), note: ev(a.note), artifact: a.artifact ? ev(a.artifact) : null });
    else if (kind === 'task') out.push({ op: 'request_task', kind: 'review', obligation: ev(a.obligation), prompt: a.prompt });
    else if (kind === 'decision') out.push({ op: 'draft_decision', id: ev(a.id), question: ev(a.question), subjects: ids(ev(a.subjects), 'subjects'), choice: ev(a.choice) });
  }
}

export type Suggestion = { rule: string; action: string; label: string; input: Record<string, Json> };
export function evaluatePlanner(pkg: Package, world: WorldView, budget = new Budget()): { suggestions: Suggestion[]; error?: string } {
  const suggestions: Suggestion[] = [];
  try {
    for (const rule of pkg.planner) {
      const env: Env = { world, inputs: {}, vars: new Map(), budget };
      const when = evaluate(rule.when, env);
      need(typeof when === 'boolean', 'type_error', `planner ${rule.id}: expected boolean`);
      if (when) suggestions.push({ rule: rule.id, action: rule.suggest.action, label: rule.suggest.label,
        input: Object.fromEntries(Object.entries(rule.suggest.input).map(([k, e]) => [k, evaluate(e, env)])) });
    }
    return { suggestions };
  } catch (error: any) { return { suggestions: [], error: `${error.code ?? 'planner_error'}: ${error.message}` }; }
}

// View models contain only text, integers, and action bindings. The renderer
// displays them as inert text; nothing in a package becomes markup or script.
export type Cell = string | number | boolean | null;
export type ViewModel = { id: string; title: string; kind: string; error?: string; [key: string]: any };
function display(v: unknown): Cell {
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (v === null || typeof v === 'boolean' || Number.isSafeInteger(v)) return v as Cell;
  if (valueSize(v) > 2000) return '(too large to show)';
  if (Array.isArray(v)) return v.map(x => display(x)).join(', ');
  if (v && typeof v === 'object' && 'id' in v) return String((v as any).title ?? (v as any).id);
  return JSON.stringify(v);
}
export function evaluateView(view: ViewDef, world: WorldView, budget = new Budget()): ViewModel {
  const env: Env = { world, inputs: {}, vars: new Map(), budget };
  const withVar = (bindings: Record<string, any>, e: Expr) => { for (const [k, v] of Object.entries(bindings)) env.vars.set(k, v); try { return evaluate(e, env); } finally { for (const k of Object.keys(bindings)) env.vars.delete(k); } };
  try {
    if (view.kind === 'table') {
      const rows = asList(evaluate(view.rows, env), 'rows').slice(0, LIMITS.viewRows);
      return { id: view.id, title: view.title, kind: 'table', empty: view.empty ?? 'Nothing yet.', columns: view.columns.map((c: any) => c.label),
        rows: rows.map(row => ({ cells: view.columns.map((c: any) => display(withVar({ row }, c.value))),
          actions: (view.actions ?? []).map((a: any) => ({ action: a.action, label: a.label,
            input: Object.fromEntries(Object.entries(a.input).map(([k, e]) => [k, withVar({ row }, e as Expr)])) })) })) };
    }
    if (view.kind === 'matrix') {
      const rows = asList(evaluate(view.rows, env), 'rows').slice(0, 50); const columns = asList(evaluate(view.columns, env), 'columns').slice(0, 20);
      return { id: view.id, title: view.title, kind: 'matrix', empty: view.empty ?? 'Nothing to compare yet.',
        columns: columns.map(column => display(withVar({ column }, view.columnLabel))),
        rows: rows.map(row => ({ label: display(withVar({ row }, view.rowLabel)), cells: columns.map(column => display(withVar({ row, column }, view.cell))) })) };
    }
    if (view.kind === 'status') return { id: view.id, title: view.title, kind: 'status', items: view.items.map((i: any) => ({ label: i.label, value: display(evaluate(i.value, env)) })) };
    return { id: view.id, title: view.title, kind: 'form', action: view.action };
  } catch (error: any) {
    return { id: view.id, title: view.title, kind: view.kind, error: `${error.code ?? 'view_error'}: ${error.message}` };
  }
}

export function recordDigest(value: unknown) { return digest(value); }
