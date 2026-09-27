import { createElement as h, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Field, ViewModel } from './lang.ts';
import type { Obligation, Decision, Witness } from './checker.ts';

// Trusted renderer. Package view models are data (text, integers, action
// bindings); React escapes every text node and nothing from a package becomes
// markup, attributes that execute, or script. The page ships no JavaScript.

export type Page = { title: string; csrf: string; body: ReactNode; notice?: { kind: 'error' | 'ok'; lines: string[] }; current?: string };
export function page({ title, csrf, body, notice, current }: Page): string {
  const doc = h('html', { lang: 'en' },
    h('head', null, h('meta', { charSet: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('title', null, `${title} · Workshop`), h('link', { rel: 'stylesheet', href: '/shell.css' })),
    h('body', null,
      h('a', { className: 'skip', href: '#main' }, 'Skip to content'),
      shellHandle(current),
      h('main', { id: 'main', tabIndex: -1 },
        notice ? h('div', { className: `notice ${notice.kind}`, role: notice.kind === 'error' ? 'alert' : 'status' },
          notice.lines.map((l, i) => h('p', { key: i }, l))) : null,
        body),
      h('footer', null, h('span', { hidden: true, 'data-csrf': csrf }))));
  return '<!doctype html>' + renderToStaticMarkup(doc);
}
// The protected handle is rendered by the host above any package content.
function shellHandle(current?: string) {
  return h('nav', { className: 'handle', 'aria-label': 'Workshop controls' },
    h('a', { href: '/project', className: 'brand' }, 'Workshop'),
    h('ul', null, ...[['Project', '/project'], ['Change this', '/change'], ['Versions & recovery', '/recovery'], ['Export', '/recovery#export'], ['Activity', '/inspect']]
      .map(([label, href]) => h('li', { key: href }, h('a', { href, 'aria-current': current === href ? 'page' : undefined }, label)))));
}
// A page for errors and missing things, always with a way forward.
export function messagePage(title: string, lines: string[], csrf = ''): string {
  return page({ title, csrf, body: h('div', null, h('h1', null, title), ...lines.map((l, i) => h('p', { key: i }, l)),
    h('p', null, h('a', { href: '/project' }, 'Back to the project'), ' · ', h('a', { href: '/recovery' }, 'Versions & recovery'))) });
}
const hidden = (name: string, value: string | number) => h('input', { type: 'hidden', name, value: String(value) });
const csrfField = (csrf: string) => hidden('__csrf', csrf);
// Each rendered form carries its own operation ID, so a double submit is recognised as the same request.
const opField = () => hidden('__op', `ui-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

export const STATUS_TEXT: Record<string, string> = {
  open: 'open', blocked: 'blocked', fulfilled: 'done', cancelled_by_owner: 'cancelled by you', superseded_by_owner: 'replaced by another review',
  previewable: 'ready to try', approved: 'approved', active: 'applied', rejected: 'rejected', stale: 'out of date', changes_requested: 'changes requested', approve: 'approved'
};
const say = (s: string) => STATUS_TEXT[s] ?? s.replaceAll('_', ' ');

// What the form knows about the project, so references are picked, not typed.
export type FormContext = {
  records: { id: string; type: string; title: string }[];
  decisions: { id: string; title: string }[];
  obligations: { id: string; title: string }[];
};
const range = (spec: Field) => spec.type === 'int' && (spec.min !== undefined || spec.max !== undefined) ? ` (${spec.min ?? '…'}–${spec.max ?? '…'})` : '';
function fieldInput(name: string, spec: Field, id: string, value: unknown, ctx?: FormContext, generates = false) {
  const required = !(spec.optional || spec.default !== undefined);
  const common = { id, name: `in.${name}`, required, defaultValue: value === undefined || value === null ? undefined : String(value) };
  const options = (items: { id: string; title: string }[], blank: string) => h('select', { ...common },
    h('option', { value: '' }, blank), items.map(r => h('option', { key: r.id, value: r.id }, r.title === r.id ? r.id : `${r.title} (${r.id})`)));
  if (ctx && spec.type === 'string') {
    const ofType = ctx.records.filter(r => r.type === name);
    if (ofType.length) return options(ofType, `Choose ${name.replaceAll('_', ' ')}…`);
    if (name === 'decision' && ctx.decisions.length) return options(ctx.decisions, 'Choose a decision…');
    if (name === 'obligation' && ctx.obligations.length) return options(ctx.obligations, 'Choose a review…');
    // Identifiers are generated from the title when left blank; otherwise `id` picks an existing item.
    if (name === 'key' || (name === 'id' && generates)) return h('input', { ...common, required: false, type: 'text', pattern: '[a-z][a-z0-9_-]{0,59}',
      placeholder: 'leave blank to generate', 'aria-describedby': `${id}-hint` });
    if (name === 'id' && ctx.records.length) return options(ctx.records, 'Choose an item…');
  }
  if (spec.type === 'enum') return h('select', common, spec.optional ? h('option', { value: '' }, '—') : null, spec.values.map(v => h('option', { key: v, value: v }, v.replaceAll('_', ' '))));
  if (spec.type === 'int') return h('input', { ...common, type: 'number', step: 1, min: spec.min, max: spec.max });
  if (spec.type === 'bool') return h('input', { id, name: `in.${name}`, type: 'checkbox', defaultChecked: value === true });
  if (spec.type === 'string' && (spec.max ?? 4096) > 300) return h('textarea', { ...common, rows: 3, maxLength: spec.max });
  return h('input', { ...common, type: 'text', maxLength: spec.type === 'string' ? spec.max : undefined, pattern: spec.type === 'artifact' ? '[0-9a-f]{64}' : undefined });
}
export function actionForm(opts: { csrf: string; world: string; revision: number; packageHash: string; action: { id: string; title: string; inputs: Record<string, Field> };
  prefill?: Record<string, unknown>; practice?: boolean; ctx?: FormContext; open?: boolean }) {
  const { action } = opts;
  // Optional artifact inputs need an upload the shell does not offer yet; they are left out.
  const inputs = Object.entries(action.inputs).filter(([, spec]) => !(spec.type === 'artifact' && (spec.optional || spec.default !== undefined)));
  return h('details', { className: 'action', id: `action-${action.id}`, open: opts.open || undefined },
    h('summary', null, opts.practice ? `Practice: ${action.title}` : action.title),
    h('form', { method: 'post', action: '/project/action', 'aria-label': action.title },
      csrfField(opts.csrf), opField(), hidden('__world', opts.world), hidden('__revision', opts.revision), hidden('__package', opts.packageHash), hidden('__action', action.id),
      inputs.map(([name, spec]) => {
        const id = `f-${opts.world}-${action.id}-${name}`;
        const creates = ['title', 'statement', 'question', 'name'].some(k => k in action.inputs);
        const generated = !!opts.ctx && spec.type === 'string' && (name === 'key' || (name === 'id' && creates));
        return h('div', { className: 'field', key: name }, h('label', { htmlFor: id }, name.replaceAll('_', ' '), range(spec), spec.optional || spec.default !== undefined || generated ? ' (optional)' : ''),
          fieldInput(name, spec, id, opts.prefill?.[name], opts.ctx, creates),
          generated ? h('span', { id: `${id}-hint`, className: 'meta' }, 'Lowercase letters, digits, - or _. Leave blank to generate one from the title.') : null);
      }),
      h('button', { type: 'submit' }, opts.practice ? `Practice: ${action.title}` : action.title)));
}

export function viewModel(v: ViewModel, linkBase = '/project') {
  if (v.error) return h('section', { className: 'view error', key: v.id, 'aria-labelledby': `v-${v.id}` },
    h('h3', { id: `v-${v.id}` }, v.title), h('p', { role: 'alert' }, `This view could not be shown: ${v.error}. The rest of the project and Recovery still work.`));
  if (v.kind === 'table') return h('section', { className: 'view', key: v.id, 'aria-labelledby': `v-${v.id}` }, h('h3', { id: `v-${v.id}` }, v.title),
    v.rows.length === 0 ? h('p', { className: 'empty' }, v.empty) :
      h('table', null, h('caption', { className: 'visually-hidden' }, v.title), h('thead', null, h('tr', null, v.columns.map((c: string, i: number) => h('th', { key: i, scope: 'col' }, c)),
        v.rows.some((r: any) => r.actions.length) ? h('th', { scope: 'col' }, 'Actions') : null)),
        h('tbody', null, v.rows.map((r: any, i: number) => h('tr', { key: i }, r.cells.map((c: unknown, j: number) => h('td', { key: j }, cell(c))),
          r.actions.length ? h('td', null, r.actions.map((a: any, k: number) => h('a', { key: k, href: `${linkBase}?prefill=${encodeURIComponent(JSON.stringify({ action: a.action, input: a.input }))}#action-${a.action}` }, a.label))) : null)))));
  if (v.kind === 'matrix') return h('section', { className: 'view', key: v.id, 'aria-labelledby': `v-${v.id}` }, h('h3', { id: `v-${v.id}` }, v.title),
    v.rows.length === 0 || v.columns.length === 0 ? h('p', { className: 'empty' }, v.empty) :
      h('table', { className: 'matrix' }, h('caption', { className: 'visually-hidden' }, v.title), h('thead', null, h('tr', null, h('td', null), v.columns.map((c: unknown, i: number) => h('th', { key: i, scope: 'col' }, cell(c))))),
        h('tbody', null, v.rows.map((r: any, i: number) => h('tr', { key: i }, h('th', { scope: 'row' }, cell(r.label)), r.cells.map((c: unknown, j: number) => h('td', { key: j }, cell(c))))))));
  if (v.kind === 'status') return h('section', { className: 'view', key: v.id, 'aria-labelledby': `v-${v.id}` }, h('h3', { id: `v-${v.id}` }, v.title),
    h('dl', null, v.items.map((it: any, i: number) => h(Fragment, { key: i }, h('dt', null, it.label), h('dd', null, cell(it.value))))));
  return h('section', { className: 'view', key: v.id }, h('h3', null, v.title), h('p', null, h('a', { href: `#action-${v.action}` }, 'Open form')));
}
const cell = (c: unknown) => c === null || c === undefined ? '—' : typeof c === 'boolean' ? (c ? 'yes' : 'no') : String(c);

export type CommitmentContext = {
  csrf: string; world: string; revision: number; obligations: Obligation[]; titles: Map<string, string>;
  waiting?: Set<string>; lastReview?: Map<string, { verdict: string; note: string }>; revisions?: Map<string, number>;
  authoringReady?: boolean; live?: { id: string; title: string }[]; transferable?: Map<string, string | null>;
};
export function commitments(opts: CommitmentContext) {
  const live = opts.obligations.filter(o => o.status === 'open' || o.status === 'blocked');
  const done = opts.obligations.filter(o => !(o.status === 'open' || o.status === 'blocked'));
  const name = (id: string) => opts.titles.get(id) ?? id;
  const disposeForm = (o: Obligation) => h('details', null, h('summary', null, 'Cancel or replace this review'),
    h('form', { method: 'post', action: '/protected/dispose', className: 'inline' },
      csrfField(opts.csrf), opField(), hidden('__world', o.world), hidden('__revision', opts.revisions?.get(o.world) ?? opts.revision), hidden('obligation', o.id),
      h('label', { htmlFor: `kind-${o.id}` }, 'What to do'), h('select', { id: `kind-${o.id}`, name: 'kind' }, h('option', { value: 'cancel' }, 'Cancel it'), h('option', { value: 'supersede' }, 'Replace it with another review')),
      h('label', { htmlFor: `succ-${o.id}` }, 'Replacement (only when replacing)'),
      h('select', { id: `succ-${o.id}`, name: 'successor' }, h('option', { value: '' }, '—'), (opts.live ?? []).filter(x => x.id !== o.id).map(x => h('option', { key: x.id, value: x.id }, x.title))),
      h('label', { htmlFor: `reason-${o.id}` }, 'Reason (required)'), h('input', { id: `reason-${o.id}`, name: 'reason', required: true, minLength: 3 }),
      h('button', { type: 'submit', className: 'secondary' }, 'Record')));
  return h('section', { className: 'commitments protected', 'aria-labelledby': 'commitments' },
    h('h2', { id: 'commitments' }, 'Outstanding commitments'),
    h('p', { className: 'hint' }, 'Reviews you have required. Workshop keeps them, not the app, and the decisions they gate stay blocked until they are done or you cancel them with a reason.'),
    live.length === 0 ? h('p', { className: 'empty' }, 'Nothing outstanding.') : h('ul', null, live.map(o => {
      const last = opts.lastReview?.get(o.id);
      return h('li', { key: o.id },
        h('strong', null, o.title), ` — ${say(o.status)}; covers ${o.subjects.map(name).join(', ')}`,
        o.renews ? h('span', { className: 'badge' }, ' (re-review: the subject changed after the earlier review)') : null,
        last ? h('p', { className: 'meta' }, `Last review: ${say(last.verdict)} — ${last.note}`) : null,
        h('div', { className: 'meta' }, `Needs ${o.policy.verdicts.map(say).join(' or ')} from ${o.policy.discharge === 'owner' ? 'you' : 'an independent review job'}.`),
        o.world !== opts.world ? h('p', { className: 'meta' }, `Belongs to the branch “${o.world}”, which you left when restoring a snapshot. `, h('a', { href: '/recovery#pending' }, 'Finish, move or cancel it in Versions & recovery.')) :
        o.policy.discharge === 'owner' ? h('form', { method: 'post', action: '/project/continue', className: 'inline' },
          csrfField(opts.csrf), opField(), hidden('__world', opts.world), hidden('__revision', opts.revision), hidden('obligation', o.id),
          h('label', { htmlFor: `verdict-${o.id}` }, 'Verdict'),
          h('select', { id: `verdict-${o.id}`, name: 'verdict' }, ['approve', 'changes_requested'].map(v => h('option', { key: v, value: v }, say(v)))),
          h('label', { htmlFor: `note-${o.id}` }, 'Note'), h('input', { id: `note-${o.id}`, name: 'note', required: true, maxLength: 4000 }),
          h('button', { type: 'submit' }, 'Record review'))
        : opts.waiting?.has(o.id) ? h('p', { className: 'meta' }, opts.authoringReady ? 'A review job is queued or running.' : 'A review job is queued. Nothing runs until you set up Codex (Change this → Authoring settings) and press “Run them with Codex”.')
        : h('form', { method: 'post', action: '/protected/review-again', className: 'inline' }, csrfField(opts.csrf), hidden('obligation', o.id),
            h('span', { className: 'meta' }, last ? 'The last review did not approve. ' : 'No review job is waiting. '), h('button', { type: 'submit' }, 'Request another review')),
        o.world === opts.world ? disposeForm(o) : null);
    })),
    done.length ? h('details', null, h('summary', null, `History (${done.length})`), h('ul', null, done.map(o => h('li', { key: o.id },
      `${o.title} — ${say(o.status)}${o.fulfillment ? ` (${say(o.fulfillment.verdict)} by ${o.fulfillment.principal === 'owner' ? 'you' : 'a review job'}: ${o.fulfillment.note})` : ''}${o.reason ? ` — ${o.reason}` : ''}${o.successor ? ` — replaced by ${opts.obligations.find(x => x.id === o.successor)?.title ?? o.successor}` : ''}${o.renewedBy ? ' — re-review opened after the subject changed' : ''}`)))) : null);
}
export function decisions(opts: { csrf: string; world: string; revision: number; decisions: Decision[]; titles: Map<string, string>; blocking?: Map<string, string[]> }) {
  if (!opts.decisions.length) return null;
  return h('section', { className: 'protected', 'aria-labelledby': 'decisions' }, h('h2', { id: 'decisions' }, 'Decisions'),
    opts.decisions.map(d => {
      const blocked = opts.blocking?.get(d.id) ?? [];
      return h('div', { key: d.id, className: 'decision' },
        h('h3', null, d.question), d.status === 'final' ? h('p', null, `Final: ${opts.titles.get(d.choice!) ?? d.choice}`) :
          h('div', null,
            blocked.length ? h('div', { className: 'meta' }, h('p', null, 'Not ready to finalize:'), h('ul', null, blocked.map((b, i) => h('li', { key: i }, b)))) : null,
            h('form', { method: 'post', action: '/protected/finalize', className: 'inline' },
              csrfField(opts.csrf), opField(), hidden('__world', opts.world), hidden('__revision', opts.revision), hidden('decision', d.id),
              h('label', { htmlFor: `choice-${d.id}` }, 'Choice'),
              h('select', { id: `choice-${d.id}`, name: 'choice' }, d.subjects.map(s => h('option', { key: s, value: s }, opts.titles.get(s) ?? s))),
              h('label', { className: 'check' }, h('input', { type: 'checkbox', name: 'confirm', required: true, disabled: blocked.length > 0 }), ' I understand a final decision cannot be changed'),
              h('button', { type: 'submit', disabled: blocked.length > 0 }, blocked.length ? 'Finalize (blocked)' : 'Finalize decision'))));
    }));
}
export function witnessList(ws: Witness[], titles: Map<string, string> = new Map()) {
  if (!ws.length) return h('p', null, 'No outstanding commitments are affected.');
  return h('ul', null, ws.map(w => h('li', { key: w.obligation, className: w.ok ? 'ok' : 'bad' },
    w.ok ? `${titles.get(w.obligation) ?? w.obligation}: keeps working (${w.route === 'pinned' ? 'it stays on the version of the app it was created in' : 'the new version takes it over'})`
      : `${titles.get(w.obligation) ?? w.obligation}: ${w.problems.join('; ')}`)));
}
export { h };
