const test = require('node:test');
const assert = require('node:assert/strict');
const {createCodeAnalysisSession} = require('../dist/index.js');
test('shared session targets enclosing ranges and reuses graphs and patterns', () => {
  const text = 'function callee(x: number) { return x + 1; }\nexport function caller(value: number) { return callee(value); }';
  const session = createCodeAnalysisSession({root:'/fixture', sources:[{filePath:'a.ts',text}]});
  assert.deepEqual(session.stats,{projects:1,graphBuilds:0,patternRuns:0});
  const start = text.lastIndexOf('callee(value)');
  const range = {filePath:'a.ts',start,end:start+'callee(value)'.length};
  const slice = session.slice(range);
  assert.equal(slice.targets[0].name,'caller');
  const ids = slice.selections.map(s => s.node.id);
  session.patterns(ids); session.patterns(ids); session.graphs(ids); session.slice(range);
  assert.deepEqual(session.stats,{projects:1,graphBuilds:1,patternRuns:1});
  const model = session.types([session.nodeAt(range)]);
  assert.equal(model.types[model.targetTypes[0]].kind,'intrinsic');
  assert.equal(model.types[model.targetTypes[0]].name,'number');
  const whole = session.slice({filePath:'a.ts',start:0,end:text.length,sourceFile:true});
  assert.equal(whole.targets.length,2);
  assert.equal(session.slice(range,{maxNodes:1}).selections.length,1);
});
test('session cannot load files or dependencies from host filesystem', () => {
  const text = 'import { readFileSync } from "node:fs"; export const value = readFileSync("secret");';
  const session = createCodeAnalysisSession({root:'/fixture',sources:[{filePath:'a.ts',text}]});
  assert.ok(session.diagnostics().some(d => [2307,2792,2591].includes(d.getCode())));
  assert.throws(() => createCodeAnalysisSession({root:'/fixture', sources:[{filePath:'../outside.ts',text:''}]}));
  assert.throws(() => session.nodeAt({filePath:'a.ts', start:0,end:text.length+1}));
});

test('BOM and Unicode ranges retain original source offsets', () => {
  const text = '\uFEFF// 😀\nexport function entry(value: number) { return value; }';
  const session = createCodeAnalysisSession({root:'/fixture',sources:[{filePath:'a.ts',text}]});
  const range = {filePath:'a.ts',start:0,end:text.length,sourceFile:true};
  assert.equal(session.nodeAt(range).getFullText().length,text.length);
  assert.equal(session.slice(range).targets[0].name,'entry');
  const start = text.lastIndexOf('value');
  assert.equal(session.nodeAt({filePath:'a.ts',start,end:start+5}).getStart(),start);
});
