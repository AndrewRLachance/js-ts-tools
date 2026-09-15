const test = require('node:test');
const assert = require('node:assert/strict');
const { EffectCodemod } = require('../../dist/tools/effect-codemod/core/pipeline');
const { RuleRegistry } = require('../../dist/tools/effect-codemod/core/registry');

function harness(rules, original = 'A', reject = () => false) {
  let disk = original, writes = 0;
  const filePath = '/project/input.ts';
  const source = { read: () => disk, write: (_file, text) => { disk = text; writes++; } };
  function dependencies(texts) {
    return {
      source: texts ? { read: () => texts.get(filePath), write: () => { throw Error('overlay write'); } } : source,
      discovery: { discover: (_request, selectors) => selectors.map(selector => {
        const text = texts ? texts.get(filePath) : disk;
        return { id: selector.id, selectorId: selector.id, filePath, kind: 'CallExpression', text, startOffset: 0, endOffset: text.length, start: { line: 1, column: 1 }, end: { line: 1, column: text.length + 1 } };
      }) },
      semantics: { snapshot: () => ({ rawTypeModel: {}, diagnostics: [] }) },
      astPatterns: { match: () => [] }, imports: { plan: () => [] },
      edits: { apply: (text, edits) => [...edits].sort((a, b) => b.start - a.start).reduce((s, e) => s.slice(0, e.start) + e.replacement + s.slice(e.end), text) },
      validation: { validate: (_request, files) => ({ ok: !files.some(file => reject(file.editedText)), baselineDiagnostics: [], resultingDiagnostics: [], newDiagnostics: files.some(file => reject(file.editedText)) ? ['invalid rewrite'] : [] }) },
    };
  }
  const deps = dependencies();
  deps.analysisSession = () => {
    const texts = new Map([[filePath, disk]]), originals = new Map(texts);
    return { texts, originals, dependencies: dependencies(texts), advance: files => files.forEach(file => texts.set(file.filePath, file.editedText)), assertFresh: () => assert.equal(disk, original) };
  };
  return { codemod: new EffectCodemod(new RuleRegistry(rules), deps), deps, disk: () => disk, writes: () => writes };
}
function rule(id, replacement, width) {
  return { id, target: 'map', selectors: [{ id, tsquery: 'CallExpression' }], description: id,
    analyze(candidate) {
      const text = replacement(candidate.text);
      return text === undefined ? { kind: 'skip', reason: 'Does not apply' } : { kind: 'convert', match: { ruleId: id, target: 'map', candidate, captures: {}, confidence: 'safe', evidence: [], metadata: { text } } };
    },
    rewrite(match) { return { replacements: [{ filePath: match.candidate.filePath, start: 0, end: width ?? match.candidate.endOffset, replacement: match.metadata.text, reason: id }], imports: [] }; },
  };
}
test('repeated source hashes prevent writes and identify a cycle', () => {
  const h = harness([rule('toggle', text => text === 'A' ? 'B' : 'A')]);
  const report = h.codemod.run({ maxPasses: 3, write: true });
  assert.equal(report.summary.stopReason, 'cycle'); assert.equal(report.validation.ok, false);
  assert.equal(h.disk(), 'A'); assert.equal(h.writes(), 0);
});
test('a failed later pass prevents even earlier validated edits from being written', () => {
  const h = harness([rule('progress', text => text === 'A' ? 'B' : 'bad')], 'A', text => text === 'bad');
  const report = h.codemod.run({ maxPasses: 3, write: true });
  assert.equal(report.summary.stopReason, 'validation-failed'); assert.equal(report.validation.ok, false);
  assert.ok(report.candidates.some(c => c.reasonCode === 'validation-failed'));
  assert.equal(h.disk(), 'A'); assert.equal(h.writes(), 0);
});
test('narrower edits win atomically and competing edits are deferred', () => {
  const h = harness([rule('wide', () => 'W'), rule('narrow', text => text === 'AB' ? 'X' : undefined, 1)], 'AB');
  const report = h.codemod.run({ maxPasses: 1 });
  assert.equal(report.files[0].editedText, 'XB');
  assert.equal(report.summary.converted, 1);
  assert.ok(report.candidates.some(c => c.ruleId === 'wide' && c.reasonCode === 'overlap-deferred'));
});
test('legacy adapters retain one-pass support and reject explicit repeated passes', () => {
  const h = harness([rule('map', () => 'B')]);
  const { analysisSession, ...legacy } = h.deps;
  const codemod = new EffectCodemod(new RuleRegistry([rule('map', () => 'B')]), legacy);
  assert.equal(codemod.run().summary.converted, 1);
  assert.throws(() => codemod.run({ maxPasses: 2 }), /analysis-session/);
  for (const maxPasses of [0, 11, 1.5, NaN]) assert.throws(() => codemod.run({ maxPasses }), /maxPasses/);
});

test('source freshness is checked again after the last validated pass before commit', () => {
  const h = harness([rule('map', () => 'B')]);
  const createSession = h.deps.analysisSession;
  h.deps.analysisSession = request => {
    const session = createSession(request);
    let advanced = false;
    return { ...session,
      advance(files) { session.advance(files); advanced = true; },
      assertFresh() { if (advanced) throw Error('Source changed after validation'); session.assertFresh(); },
    };
  };
  assert.throws(() => h.codemod.run({ maxPasses: 1, write: true }), /Source changed after validation/);
  assert.equal(h.disk(), 'A'); assert.equal(h.writes(), 0);
});
