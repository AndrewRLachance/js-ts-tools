const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { test } = require('node:test');
const { Effect, Exit, Cause } = require('effect');
const { runEffectCodemod } = require('../dist');

function fixture(t, files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-expanded-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.symlinkSync(path.resolve(__dirname, '../node_modules/effect'), path.join(cwd, 'node_modules/effect'), 'dir');
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', skipLibCheck: true }, include: ['*.ts'] }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), text);
  return cwd;
}
function load(text) {
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(require, module, module.exports);
  return module.exports;
}
function changed(report, name, fallback) { return report.files.find(file => file.filePath.endsWith('/' + name))?.editedText ?? fallback; }
function valid(report) { assert.equal(report.validation.ok, true, JSON.stringify(report.validation)); }

const forms = `import { Effect as E, Option, pipe } from 'effect';
import * as F from 'effect/Effect';
import { flatMap as chain, succeed as pure } from 'effect/Effect';
const Effect = { value: 42 };
export const block = E.flatMap(E.succeed(1), n => { /* keep before */ return E.succeed(n + 1); /* keep after */ });
export const direct = chain((n: number) => pure(n + 2))(pure(1));
export const curried = F.map((n: number) => Option.some(n));
export const validation = pipe(E.succeed(2), E.flatMap(n => n > 0 ? E.succeed(n) : E.fail('negative')));
export const names = E.flatMap(E.succeed(1), n => E.succeed(Effect.value + n));
export const asynchronous = E.map(async () => 1);
export const shadowed = (E: { flatMap: (f: () => number) => number }) => E.flatMap(() => 5);
`;
test('normalized calls handle aliases, blocks, curried overloads and preserve copied bindings', t => {
  const cwd = fixture(t, { 'input.ts': forms });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'] }); valid(report);
  const output = changed(report, 'input.ts', forms);
  assert.match(output, /E\.map\(E\.succeed\(1\), n => \{ \/\* keep before \*\/ return n \+ 1; \/\* keep after \*\/ \}\)/);
  assert.match(output, /F\.asSome|E\.asSome/);
  assert.match(output, /E\.(filterOrFail|liftPredicate)/);
  assert.ok(output.includes('Effect.value + n'));
  assert.ok(output.includes('E.map(async () => 1)'));
  assert.ok(output.includes('=> E.flatMap(() => 5)'));
  for (const text of [forms, output]) {
    const values = load(text);
    assert.equal(Effect.runSync(values.block), 2);
    assert.equal(Effect.runSync(values.direct), 3);
    assert.equal(Effect.runSync(values.validation), 2);
    assert.equal(Effect.runSync(values.names), 43);
    assert.ok(Effect.runSync(values.asynchronous(Effect.succeed(0))) instanceof Promise);
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'input.ts'), 'utf8'), forms);
  assert.ok(report.summary.passes >= 2);
});

test('direct imports allocate a collision-free namespace and never change a copied Effect binding', t => {
  const code = `import { flatMap as chain, succeed as pure } from 'effect/Effect';
const Effect = { n: 7 }; const EffectCodemod1 = 8;
export const value = chain(pure(1), n => pure(n + Effect.n + EffectCodemod1));`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map'] }); valid(report);
  const output = changed(report, 'input.ts', code);
  assert.match(output, /import \{ Effect as EffectCodemod2 \}/);
  assert.match(output, /EffectCodemod2\.map/);
  assert.equal(Effect.runSync(load(output).value), 16);
});

const guards = `import { Effect } from 'effect';
export const events: string[] = [];
const missing = () => { events.push('error'); return 'missing'; };
export const lookup = (input: { id: number } | undefined) => Effect.gen(function* () {
  const row = yield* Effect.sync(() => { events.push('source'); return input; });
  if (!row) return yield* Effect.fail(missing());
  return row.id;
});
export const typed = (input: number | undefined) => Effect.gen(function* () {
  const value = yield* Effect.succeed(input);
  if (value === undefined) { return yield* Effect.fail('missing'); }
  return value + 1;
});
export class Store {
  label = 'bad';
  lookup(input: number) { return Effect.gen(this, function* () {
    const value = yield* Effect.succeed(input);
    if (value < 0) return yield* Effect.fail(this.label + value);
    return value;
  }); }
}
export const complex = (input: number) => Effect.gen(function* () {
  const value = yield* Effect.succeed(input);
  if (value < 0) { events.push('extra'); return yield* Effect.fail('bad'); }
  return value;
});
`;
test('generator guards preserve narrowing, receiver binding, error laziness and event order', t => {
  const cwd = fixture(t, { 'input.ts': guards });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['filterOrFail'] }); valid(report);
  assert.equal(report.summary.converted, 3, JSON.stringify(report.candidates));
  const output = changed(report, 'input.ts', guards);
  assert.match(output, /Effect\.filterOrFail/);
  for (const text of [guards, output]) {
    const values = load(text), effect = values.lookup({ id: 4 });
    assert.deepEqual(values.events, []);
    assert.equal(Effect.runSync(effect), 4);
    assert.deepEqual(values.events, ['source']);
    assert.equal(Effect.runSync(Effect.flip(values.lookup(undefined))), 'missing');
    assert.deepEqual(values.events, ['source', 'source', 'error']);
    assert.equal(Effect.runSync(values.typed(2)), 3);
    assert.equal(Effect.runSync(Effect.flip(new values.Store().lookup(-1))), 'bad-1');
  }
});

test('generator yield-return and dense traversal retain lazy sequential execution and defects', t => {
  const code = `import { Effect } from 'effect';
export const events: string[] = [];
const source = () => { events.push('construct'); return Effect.sync(() => { events.push('source'); return 2; }); };
export const mapped = Effect.gen(function* () { const n = yield* source(); return n + 3; });
export const chained = Effect.gen(function* () { const n = yield* source(); return yield* Effect.sync(() => { events.push('next'); return n + 4; }); });
export const loop = Effect.gen(function* () { for (const n of [1, 2, 3]) { yield* Effect.sync(() => { events.push(String(n)); }); } });
export const failedLoop = Effect.gen(function* () { for (const n of [1, 2, 3]) { yield* (n === 2 ? Effect.fail('stop') : Effect.sync(() => events.push('failure-' + n))); } });
export const defectiveLoop = Effect.gen(function* () { for (const n of [1, 2, 3]) { yield* (n === 2 ? Effect.die('defect') : Effect.sync(() => events.push('defect-' + n))); } });
export const defect = Effect.gen(function* () { const n = yield* Effect.succeed(1); return JSON.parse('invalid') + n; });
`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map', 'flatMap', 'forEach'] }); valid(report);
  const output = changed(report, 'input.ts', code);
  assert.match(output, /Effect\.suspend/);
  assert.match(output, /Effect\.forEach/);
  for (const text of [code, output]) {
    const values = load(text);
    assert.deepEqual(values.events, []);
    assert.equal(Effect.runSync(values.mapped), 5);
    Effect.runSync(values.loop);
    assert.deepEqual(values.events, ['construct', 'source', '1', '2', '3']);
    assert.equal(Effect.runSync(values.chained), 6);
    assert.deepEqual(values.events.slice(-3), ['construct', 'source', 'next']);
    assert.equal(Effect.runSync(Effect.flip(values.failedLoop)), 'stop');
    const loopExit = Effect.runSyncExit(values.defectiveLoop);
    assert.ok(Exit.isFailure(loopExit)); assert.deepEqual(Array.from(Cause.defects(loopExit.cause)), ['defect']);
    assert.deepEqual(values.events.slice(-2), ['failure-1', 'defect-1']);
    const exit = Effect.runSyncExit(values.defect); assert.ok(Exit.isFailure(exit));
    assert.equal(Array.from(Cause.defects(exit.cause)).length, 1);
  }
});

test('bounded helper summaries follow selected imports and explain unsupported and recursive helpers', t => {
  const helper = `import { Effect } from 'effect'; export function plus(n: number) { return Effect.succeed(n + 1); } export function step(n: number) { return plus(n); }`;
  const code = `import { Effect } from 'effect'; import { step } from './helper';
export const result = Effect.flatMap(Effect.succeed(3), n => step(n));
function recur(n: number): Effect.Effect<number> { return recur(n); }
export const recursive = Effect.flatMap((n: number) => recur(n));
function mutated(n: number) { n++; return Effect.succeed(n); }
export const unsafe = Effect.flatMap((n: number) => mutated(n));`;
  const cwd = fixture(t, { 'input.ts': code, 'helper.ts': helper });
  const excluded = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map'], maxPasses: 1 }); valid(excluded);
  assert.equal(excluded.summary.converted, 0);
  const report = runEffectCodemod({ cwd, sources: ['*.ts'], targets: ['map'] }); valid(report);
  assert.equal(report.summary.converted, 1, JSON.stringify(report.candidates));
  assert.ok(report.candidates.some(c => c.reasonCode === 'analysis-limit'));
  const output = changed(report, 'input.ts', code);
  assert.match(output, /Effect\.map\(Effect\.succeed\(3\)/);
  assert.ok(output.includes('=> mutated(n)'));
  assert.equal(fs.readFileSync(path.join(cwd, 'helper.ts'), 'utf8'), helper);
});

test('pipeline composition exposes collection rules without moving callback work', t => {
  const code = `import { Effect, Option, pipe } from 'effect';
export const value = pipe([1, 2], Effect.findFirst(n => Effect.succeed(n > 1)), Effect.map(option => Option.isSome(option)));
export const mapped = Effect.succeed(1).pipe(Effect.flatMap(n => Effect.succeed(n + 1)));
`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'] }); valid(report);
  const output = changed(report, 'input.ts', code);
  assert.match(output, /Effect\.exists\(/);
  for (const text of [code, output]) {
    assert.equal(Effect.runSync(load(text).value), true);
    assert.equal(Effect.runSync(load(text).mapped), 2);
  }
});

test('subsequent passes expose simplifications and honor the explicit pass limit', t => {
  const code = `import { Effect } from 'effect'; export const value = Effect.flatMap(Effect.succeed(1), () => Effect.succeed(123));`;
  const cwd = fixture(t, { 'input.ts': code });
  const one = runEffectCodemod({ cwd, sources: ['input.ts'], maxPasses: 1 }); valid(one);
  assert.equal(one.summary.stopReason, 'pass-limit'); assert.equal(one.summary.converged, false);
  assert.match(changed(one, 'input.ts', code), /Effect\.map\(/);
  const repeated = runEffectCodemod({ cwd, sources: ['input.ts'] }); valid(repeated);
  assert.equal(repeated.summary.converted, 2); assert.equal(repeated.summary.converged, true);
  assert.equal(repeated.summary.passes, 3);
  assert.match(changed(repeated, 'input.ts', code), /Effect\.as\(/);
  assert.deepEqual(repeated.candidates.filter(c => c.status === 'converted').map(c => c.pass), [1, 2]);
});

test('helper summaries reject reassignment, nonprimitive coercion and the node budget', t => {
  const large = Array.from({ length: 110 }, () => 'n').join(' + ');
  const code = `import { Effect } from 'effect';
function reassigned(n: number) { return Effect.succeed(n + 1); }
reassigned = n => Effect.succeed(n + 2);
const huge = (n: number) => Effect.succeed(${large});
const object = (n: any) => Effect.succeed(n + n);
const first = (n: number) => second(n);
const second = (n: number) => third(n);
const third = (n: number) => fourth(n);
const fourth = (n: number) => Effect.succeed(n);
export const a = Effect.flatMap((n: number) => reassigned(n));
export const b = Effect.flatMap((n: number) => huge(n));
export const c = Effect.flatMap((n: any) => object(n));
export const d = Effect.flatMap((n: number) => first(n));`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map'] }); valid(report);
  assert.equal(report.summary.converted, 0);
  assert.ok(report.candidates.some(c => c.reason?.includes('reassigned')));
  assert.ok(report.candidates.some(c => c.reasonCode === 'analysis-limit'));
  assert.ok(report.candidates.some(c => c.reason?.includes('coercion')));
  assert.ok(report.candidates.some(c => c.reason?.includes('three helper edges')));
});

test('a guard that loses narrowing of another variable remains review-only', t => {
  const code = `import { Effect } from 'effect'; export const value = (other: string | undefined) => Effect.gen(function* () {
const row = yield* Effect.succeed(1);
if (other === undefined || row < 0) return yield* Effect.fail('bad');
return other.length + row;
});`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['filterOrFail'], write: true }); valid(report);
  assert.equal(report.summary.converted, 0); assert.equal(report.summary.review, 1);
  assert.equal(report.summary.written, false);
  assert.equal(fs.readFileSync(path.join(cwd, 'input.ts'), 'utf8'), code);
});

test('helper composition preserves evaluation even when the next callback ignores its input', t => {
  const code = `import { Effect } from 'effect';
const composed = (n: bigint) => Effect.map(Effect.succeed(1n / n), (_value) => 7);
export const success = Effect.flatMap(Effect.succeed(1n), n => composed(n));
export const defect = Effect.flatMap(Effect.succeed(0n), n => composed(n));`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map'] }); valid(report);
  assert.equal(report.summary.converted, 2);
  const output = changed(report, 'input.ts', code);
  for (const text of [code, output]) {
    const values = load(text);
    assert.equal(Effect.runSync(values.success), 7);
    const exit = Effect.runSyncExit(values.defect);
    assert.ok(Exit.isFailure(exit)); assert.equal(Array.from(Cause.defects(exit.cause)).length, 1);
  }
});

test('async option handlers retain Promise results and discarded callbacks retain comments', t => {
  const code = `import { Effect } from 'effect';
export const fold = Effect.match({ onFailure: () => false, onSuccess: async () => true });
export const constant = Effect.map(() => { /* explanation stays */ return 3; });`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'] }); valid(report);
  const output = changed(report, 'input.ts', code);
  assert.ok(output.includes('onSuccess: async () => true'));
  assert.ok(output.includes('/* explanation stays */'));
  for (const text of [code, output]) assert.ok(Effect.runSync(load(text).fold(Effect.succeed(1))) instanceof Promise);
});

test('guards preserve upstream compound failures and interruption without evaluating fallback errors', t => {
  const code = `import { Effect } from 'effect';
export let errors = 0;
export const checked = (source: Effect.Effect<number | undefined, string>) => Effect.gen(function* () {
const n = yield* source;
if (n === undefined) return yield* Effect.fail((errors++, 'missing'));
return n;
});`;
  // Mutation in the error expression is conservatively rejected; place its work in a factory instead.
  const safe = code.replace("export let errors = 0;", "export let errors = 0; const missing = () => { errors++; return 'missing'; };").replace("(errors++, 'missing')", 'missing()');
  const cwd = fixture(t, { 'input.ts': safe });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['filterOrFail'] }); valid(report);
  assert.equal(report.summary.converted, 1);
  const output = changed(report, 'input.ts', safe);
  for (const text of [safe, output]) {
    const values = load(text);
    const cause = Cause.parallel(Cause.fail('old'), Cause.die('defect'));
    const exit = Effect.runSyncExit(values.checked(Effect.failCause(cause)));
    assert.ok(Exit.isFailure(exit)); assert.deepEqual(exit.cause, cause);
    const interrupted = Effect.runSyncExit(values.checked(Effect.interrupt));
    assert.ok(Exit.isFailure(interrupted)); assert.ok(Cause.isInterruptedOnly(interrupted.cause));
    assert.equal(values.errors, 0);
  }
});

test('generator rewrites preserve initialization boundaries for captured bindings', t => {
  const code = `import { Effect } from 'effect';
const n = 7;
export const selfReference = Effect.gen(function* () { const n: number = yield* Effect.sync(() => n); return n; });
export const guard = Effect.gen(function* () {
function missing() { return row === undefined ? 'missing' : 'present'; }
const row = yield* Effect.succeed(undefined as number | undefined);
if (row === undefined) return yield* Effect.fail(missing());
return row;
});`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map', 'filterOrFail'] }); valid(report);
  assert.equal(report.summary.converted, 0);
  assert.ok(report.candidates.some(c => c.reason?.includes('temporal-dead-zone')));
  assert.equal(Effect.runSync(Effect.flip(load(code).guard)), 'missing');
  const exit = Effect.runSyncExit(load(code).selfReference);
  assert.ok(Exit.isFailure(exit));
});

test('guard error callbacks return object literals and bind the rejected value', t => {
  const code = `import { Effect } from 'effect';
export const checked = (input: number) => Effect.gen(function* () {
const value = yield* Effect.succeed(input);
if (value < 0) return yield* Effect.fail({ tag: 'negative', value });
return value;
});`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['filterOrFail'] }); valid(report);
  assert.equal(report.summary.converted, 1);
  for (const text of [code, changed(report, 'input.ts', code)]) {
    const values = load(text);
    assert.deepEqual(Effect.runSync(Effect.flip(values.checked(-2))), { tag: 'negative', value: -2 });
    assert.equal(Effect.runSync(values.checked(2)), 2);
  }
});

test('persistence snapshot guard regressions convert proven comparisons and retain dynamic digest checks', t => {
  // Reduced from the snapshot's 36 adjacent yield/failure-guard shapes:
  // sqlite-project-runtime.ts (deadline), sqlite-promotion-repository.ts
  // (prepared request, active tree, lineage state), and sqlite-replan-work-repository.ts (digest).
  const code = `import { Effect } from 'effect';
const fail = (message: string) => ({ tag: 'Integrity', message });
export const deadline = (input: number, deadline: number) => Effect.gen(function* () {
const now = yield* Effect.succeed(input);
if (now >= deadline) return yield* Effect.fail(fail('Project deadline expired'));
return now;
});
export const request = (input: { request: { requestDigest: string } }, expected: string) => Effect.gen(function* () {
const prepared = yield* Effect.succeed(input);
if (prepared.request.requestDigest !== expected) return yield* Effect.fail(fail('Promotion replay request differs'));
return prepared.request.requestDigest;
});
export const tree = (input: string, expected: string) => Effect.gen(function* () {
const tree = yield* Effect.succeed(input);
if (tree !== expected) return yield* Effect.fail(fail('Promotion active ref changed'));
return tree;
});
export const lineage = (input: { head: { state: string } } | undefined) => Effect.gen(function* () {
const state = yield* Effect.succeed(input);
if (state?.head.state !== 'lineageConfirming') return yield* Effect.fail(fail('Promotion has not reached lineage confirmation'));
return state.head.state;
});
export let digestCalls = 0;
const digest = (value: string) => { digestCalls++; return value; };
export const progress = (input: string, expected: string) => Effect.gen(function* () {
const progress = yield* Effect.succeed(input);
if (!progress || digest(progress) !== digest(expected)) return yield* Effect.fail(fail('Replan confirmed progress is unavailable'));
return progress;
});`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['filterOrFail'] }); valid(report);
  assert.ok(report.summary.converted >= 3, JSON.stringify(report.candidates));
  assert.ok(report.candidates.some(c => c.reason?.includes('unsupported syntax')));
  const exercise = text => {
    const values = load(text);
    const exits = [values.deadline(1, 2), values.deadline(2, 2),
      values.request({ request: { requestDigest: 'a' } }, 'a'), values.request({ request: { requestDigest: 'a' } }, 'b'),
      values.tree('a', 'a'), values.tree('a', 'b'), values.lineage(undefined), values.lineage({ head: { state: 'lineageConfirming' } }),
      values.progress('', 'a'), values.progress('a', 'a'), values.progress('a', 'b')].map(Effect.runSyncExit);
    return { exits, digestCalls: values.digestCalls };
  };
  assert.deepEqual(exercise(changed(report, 'input.ts', code)), exercise(code));
  assert.equal(fs.readFileSync(path.join(cwd, 'input.ts'), 'utf8'), code);
});

test('helper expansion evaluates unused arguments and literal captures at their original time', t => {
  const code = `import { Effect } from 'effect';
const unused = (_value: number) => Effect.succeed(7);
const captured = () => Effect.succeed(later);
export const argument = () => Effect.flatMap(Effect.succeed(1), () => unused(later));
export const capture = () => Effect.flatMap(Effect.succeed(1), () => captured());
export const helper = () => Effect.flatMap(Effect.succeed(1), () => futureHelper(1));
export const before = [Effect.runSyncExit(argument()), Effect.runSyncExit(capture()), Effect.runSyncExit(helper())];
const futureHelper = (_value: number) => Effect.succeed(3);
const later = 2;
export const after = [Effect.runSyncExit(argument()), Effect.runSyncExit(capture()), Effect.runSyncExit(helper())];`;
  const cwd = fixture(t, { 'input.ts': code });
  const report = runEffectCodemod({ cwd, sources: ['input.ts'], targets: ['map'] }); valid(report);
  assert.equal(report.summary.converted, 3);
  for (const text of [code, changed(report, 'input.ts', code)]) {
    const values = load(text);
    assert.ok(values.before.every(exit => Exit.isFailure(exit) && Array.from(Cause.defects(exit.cause))[0] instanceof ReferenceError));
    assert.deepEqual(values.after.map(exit => exit.value), [7, 2, 3]);
  }
});
