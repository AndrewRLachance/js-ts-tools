"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const ts = require("typescript");
const {
  parseConvertTsPatternArgs,
  runConvertTsPattern,
  mainConvertTsPattern,
  formatConvertTsPatternReport,
} = require("../dist/tools/convert-ts-pattern-cli");
const { convertTsPattern } = require("../dist/tools/convert-ts-pattern");

describe("convertTsPattern", () => {
  it("converts scalar, reversed, OR, discriminated, and ternary conditions", () => {
    const fixture = createFixture({
      "src/input.ts": `
type Result =
  | { type: "success"; value: number }
  | { type: "error"; error: Error }
  | { type: "other" };

export function scalar(status: "open" | "pending" | "closed") {
  if ("open" === status || status === "pending") {
    return "active";
  } else {
    return "inactive";
  }
}

export function discriminated(result: Result) {
  if (result.type === "success") {
    return result.value;
  } else if (result.type === "error") {
    return result.error.message.length;
  } else {
    return undefined;
  }
}

export const ternary = (status: "ready" | "waiting") =>
  status === "ready" ? "yes" : "no";
`,
    });
    const sourcePath = path.join(fixture, "src/input.ts");
    const original = fs.readFileSync(sourcePath, "utf8");

    const preview = convert(fixture);
    assert.deepEqual(preview.summary, { candidates: 3, converted: 3, skipped: 0, filesChanged: 1 });
    assert.equal(preview.written, false);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), original);

    const applied = convert(fixture, { write: true });
    assert.equal(applied.written, true);
    const output = fs.readFileSync(sourcePath, "utf8");
    assert.match(output, /^\nimport \{ match \} from "ts-pattern";/);
    assert.match(output, /return match\(status\)\n    \.with\("open", "pending", \(\) => "active"\)\n    \.otherwise\(\(\) => "inactive"\);/);
    assert.match(output, /match\(result\)\n    \.with\(\{ type: "success" \}, \(result\) => result\.value\)/);
    assert.match(output, /\.otherwise\(\(\) => undefined\);/);
    assert.match(output, /match\(status\)\n    \.with\("ready", \(\) => "yes"\)\n    \.otherwise\(\(\) => "no"\)/);
    assertNoDiagnostics(fixture);

    const second = convert(fixture, { write: true });
    assert.deepEqual(second.summary, { candidates: 0, converted: 0, skipped: 0, filesChanged: 0 });
    assert.equal(second.written, false);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), output);
  });

  it("converts return, block, throw, grouped, and imperative switches", () => {
    const fixture = createFixture({
      "src/switches.ts": `
export function returns(status: "ready" | "failed" | "other") {
  switch (status) {
    // ready case
    case "ready": {
      const value = 1;
      return value;
    }
    // failed case
    case "failed":
      throw new Error("failed");
    // fallback case
    default:
      return 0;
  }
}

export function grouped(status: "open" | "pending" | "closed", log: string[]) {
  switch (status) {
    case "open":
    case "pending":
      log.push("active");
      break;
    default:
      log.push("closed");
      break;
  }
  log.push("done");
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 2);
    const output = fs.readFileSync(path.join(fixture, "src/switches.ts"), "utf8");
    assert.match(output, /return match\(status\)[\s\S]*const value = 1;[\s\S]*return value;[\s\S]*throw new Error\("failed"\)/);
    assert.match(output, /\/\/ ready case[\s\S]*\.with\("ready"/);
    assert.match(output, /\/\/ failed case[\s\S]*\.with\("failed"/);
    assert.match(output, /\/\/ fallback case[\s\S]*\.otherwise/);
    assert.match(output, /\.with\("open", "pending", \(\) => \{\n      log\.push\("active"\);/);
    assert.match(output, /\n  log\.push\("done"\);/);
    assert.doesNotMatch(output, /switch \(/);
    assertNoDiagnostics(fixture);
  });

  it("merges, reuses, and deterministically aliases colliding imports", () => {
    const fixture = createFixture({
      "src/merge.ts": `
import { P } from "ts-pattern";
export function merge(x: "a" | "b") {
  if (x === "a") return 1;
  else return 2;
}
`,
      "src/alias.ts": `
import { match as patternMatch } from "ts-pattern";
export function alias(x: "a" | "b") {
  if (x === "a") return 1;
  else return 2;
}
`,
      "src/collision.ts": `
const match = () => 0;
const matchTsPattern = () => 1;
export function collision(x: "a" | "b") {
  if (x === "a") return 1;
  else return 2;
}
`,
      "src/shadow.ts": `
import { match as patternMatch } from "ts-pattern";
export function shadow(x: "a" | "b") {
  const patternMatch = () => 0;
  if (x === "a") return patternMatch();
  else return 2;
}
`,
      "src/existing-both.ts": `
import { match as choose, P as Patterns } from "ts-pattern";
const allowed = (x: string) => x.length > 0;
export function existingBoth(x: "a" | "b" | "c") {
  if ((x === "a" || x === "b") && allowed(x)) return 1;
  else return 2;
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 5);
    assert.equal(report.summary.skipped, 0);
    assert.match(fs.readFileSync(path.join(fixture, "src/merge.ts"), "utf8"), /import \{ P, match \} from "ts-pattern";/);
    assert.match(fs.readFileSync(path.join(fixture, "src/alias.ts"), "utf8"), /return patternMatch\(x\)/);
    const collision = fs.readFileSync(path.join(fixture, "src/collision.ts"), "utf8");
    assert.match(collision, /import \{ match as matchTsPattern2 \} from "ts-pattern";/);
    assert.match(collision, /return matchTsPattern2\(x\)/);
    const shadow = fs.readFileSync(path.join(fixture, "src/shadow.ts"), "utf8");
    assert.match(shadow, /import \{ match as patternMatch, match \} from "ts-pattern";/);
    assert.match(shadow, /return match\(x\)/);
    const existingBoth = fs.readFileSync(path.join(fixture, "src/existing-both.ts"), "utf8");
    assert.match(existingBoth, /return choose\(x\)/);
    assert.match(existingBoth, /Patterns\.union\("a", "b"\)/);
    assertNoDiagnostics(fixture);
  });

  it("reports deterministic skip reasons and leaves unsupported source unchanged", () => {
    const fixture = createFixture({
      "src/skips.ts": `
declare function getStatus(): string;

export function loose(x: string) {
  if (x == "a") return 1;
  else return 2;
}
export function effectful() {
  if (getStatus() === "a") return 1;
  else return 2;
}
export function inconsistent(x: string, y: string) {
  if (x === "a") return 1;
  else if (y === "b") return 2;
  else return 3;
}
export function missing(x: string) {
  while (x.length > 0) {
    if (x === "a") return 1;
    break;
  }
  return 2;
}
export function fallthrough(x: string) {
  switch (x) {
    case "a": console.log(x);
    case "b": return 2;
    default: return 3;
  }
}
export function continuing(values: string[]) {
  outer: for (const value of values) {
    if (value === "a") continue outer;
    else console.log(value);
  }
}
`,
    });
    const sourcePath = path.join(fixture, "src/skips.ts");
    const original = fs.readFileSync(sourcePath, "utf8");
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 0);
    assert.deepEqual(
      report.files[0].candidates.map((candidate) => candidate.reasonCode),
      ["loose-equality", "effectful-subject", "inconsistent-subject", "outer-control-flow", "switch-fallthrough", "labeled-control-flow"],
    );
    assert.equal(fs.readFileSync(sourcePath, "utf8"), original);
  });

  it("converts safe missing fallbacks while preserving runtime fallthrough", () => {
    const source = `
export function run() {
  const events: string[] = [];
  const imperative = (value: "a" | "b" | "c") => {
    if (value === "a") events.push("a");
    else if (value === "b") events.push("b");
    events.push("after");
  };
  const terminal = (value: "a" | "b") => {
    if (value === "a") return 1;
  };
  const nested = (outer: boolean, value: "a" | "b") => {
    const seen: string[] = [];
    if (outer) {
      {
        if (value === "a") return ["matched"];
        // inner continuation
        seen.push("inner");
      }
    }
    if (value === "b") seen.push("shared-b");
    seen.push("shared");
    return seen;
  };
  const mutating = (input: "a" | "b") => {
    let value = input;
    if (value === "a") return value;
    value = "a";
    return value;
  };
  const imperativeSwitch = (value: "a" | "b" | "c") => {
    switch (value) {
      case "a": events.push("switch-a"); break;
      case "b": events.push("switch-b");
    }
    events.push("switch-after");
  };
  const groupedSwitch = (value: "a" | "b" | "c") => {
    switch (value) {
      case "a":
      case "b": events.push("grouped"); break;
      case "c":
    }
  };
  const returningSwitch = (value: "a" | "b" | "c") => {
    switch (value) {
      case "a": return 1;
      case "b": return 2;
    }
    return 3;
  };
  imperative("a");
  imperative("c");
  imperativeSwitch("a");
  imperativeSwitch("c");
  groupedSwitch("a");
  groupedSwitch("c");
  return {
    events,
    terminal: [terminal("a"), terminal("unexpected" as "a")],
    nested: [nested(true, "a"), nested(true, "b"), nested(false, "b")],
    mutated: mutating("b"),
    switched: [returningSwitch("a"), returningSwitch("c")],
  };
}
`;
    const originalFixture = createFixture({ "src/runtime.ts": source });
    const transformedFixture = createFixture({ "src/runtime.ts": source });
    const report = convert(transformedFixture, { write: true });
    const converted = report.files[0].candidates.filter((candidate) => candidate.action === "converted");
    assert.equal(converted.some((candidate) => candidate.fallbackKind === "implicit-noop"), true);
    assert.equal(converted.some((candidate) => candidate.fallbackKind === "implicit-undefined"), true);
    assert.equal(converted.some((candidate) => candidate.fallbackKind === "absorbed-continuation"), true);
    assert.equal(converted.every((candidate) => candidate.terminator === "otherwise"), true);
    const transformed = fs.readFileSync(path.join(transformedFixture, "src/runtime.ts"), "utf8");
    assert.match(transformed, /\.otherwise\(\(\) => \{\}\)/);
    assert.match(transformed, /\.otherwise\(\(\) => undefined\)/);
    assert.match(transformed, /value = "a";/);
    assert.match(transformed, /\/\/ inner continuation/);
    assert.deepEqual(compileAndLoad(transformedFixture).run(), compileAndLoad(originalFixture).run());
    assertNoDiagnostics(transformedFixture);
    const second = convert(transformedFixture, { write: true });
    assert.equal(second.summary.converted > 0, true);
    const converged = fs.readFileSync(path.join(transformedFixture, "src/runtime.ts"), "utf8");
    const third = convert(transformedFixture, { write: true });
    assert.equal(third.summary.converted, 0);
    assert.equal(fs.readFileSync(path.join(transformedFixture, "src/runtime.ts"), "utf8"), converged);
  });

  it("rejects unsafe or over-budget absorbed continuations precisely", () => {
    const fixture = createFixture({
      "src/continuations.ts": `
export function loop(value: string) {
  while (value.length > 0) {
    if (value === "a") return 1;
    break;
  }
  return 2;
}
export async function waiting(value: string) {
  if (value === "a") return 1;
  await Promise.resolve();
  return 2;
}
export function captured(value: string) {
  const read = () => moved;
  if (value === "a") return 1;
  const moved = 2;
  return read();
}
export function nestedBudget(outer: boolean, value: string) {
  if (outer) {
    if (value === "a") return 1;
  }
  return 2;
}
`,
    });
    const report = convert(fixture, { maxContinuationBytes: 0 });
    const reasons = report.files[0].candidates.map((candidate) => candidate.reasonCode);
    assert.equal(reasons.includes("outer-control-flow"), true);
    assert.equal(reasons.includes("await"), true);
    assert.equal(reasons.includes("scope-change"), true);
    assert.equal(reasons.includes("continuation-too-large"), true);
    assert.equal(report.query.maxContinuationBytes, 0);

    const budgetFixture = createFixture({
      "src/budget.ts": `
export function first(outer: boolean, value: string) {
  if (outer) { if (value === "a") return 1; }
  return 2;
}
export function second(outer: boolean, value: string) {
  if (outer) { if (value === "a") return 1; }
  return 2;
}
`,
    });
    const budgetReport = convert(budgetFixture, { maxContinuationBytes: 15 });
    const budgetCandidates = budgetReport.files[0].candidates;
    assert.equal(budgetCandidates.filter((candidate) =>
      candidate.fallbackKind === "absorbed-continuation").length, 1);
    assert.equal(budgetCandidates.filter((candidate) =>
      candidate.reasonCode === "continuation-too-large").length, 1);
  });

  it("rejects conversions that add diagnostics while tolerating baseline errors", () => {
    const fixture = createFixture({
      "src/diagnostic.ts": `
const existing: number = "baseline";
export function property(holder: { status: "a" | "b" }) {
  if (holder.status === "a") return holder.status satisfies "a";
  else return holder.status satisfies "b";
}
`,
    });
    const report = convert(fixture);
    assert.equal(report.summary.candidates, 1);
    assert.equal(report.summary.converted, 0);
    assert.equal(report.files[0].candidates[0].reasonCode, "validation-failed");
    assert.equal(report.files[0].candidates[0].diagnostics.length > 0, true);
  });

  it("preserves branch comments and supports control flow contained in a branch", () => {
    const fixture = createFixture({
      "src/comments.ts": `
export function comments(x: "a" | "b", values: number[]) {
  // dispatch comment
  if (x === "a") {
    // branch comment
    for (const value of values) {
      if (value === 0) continue;
      console.log(value);
    }
  } else {
    // fallback comment
    console.log("b");
  }
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 1);
    const output = fs.readFileSync(path.join(fixture, "src/comments.ts"), "utf8");
    assert.match(output, /\/\/ dispatch comment\n  match\(x\)/);
    assert.match(output, /\/\/ branch comment/);
    assert.match(output, /if \(value === 0\)\n\s+continue;/);
    assert.match(output, /\/\/ fallback comment/);
    assertNoDiagnostics(fixture);
  });

  it("reports async, generator, scope, boolean, assignment, and discriminator skips", () => {
    const fixture = createFixture({
      "src/more-skips.ts": `
export async function waiting(x: string) {
  if (x === "a") await Promise.resolve();
  else console.log(x);
}
export function* yielding(x: string) {
  if (x === "a") yield 1;
  else yield 2;
}
export function scoped(x: string) {
  if (x === "a") { var changed = 1; console.log(changed); }
  else console.log(x);
}
export function boolean(x: string) {
  if (x === "a" && x.length > 0) return 1;
  else return 2;
}
export function assignment(x: string, y: string) {
  if ((x = y) === "a") return 1;
  else return 2;
}
export function discriminator(value: { type: string; kind: string }) {
  if (value.type === "a") return 1;
  else if (value.kind === "b") return 2;
  else return 3;
}
`,
    });
    const report = convert(fixture);
    assert.deepEqual(
      report.files[0].candidates.map((candidate) => candidate.reasonCode),
      ["await", "yield", "scope-change", undefined, "effectful-subject", undefined],
    );
    assert.equal(report.files[0].candidates.at(-1).kind, "structural-if");
  });

  it("uses exhaustive fallback handlers only when coverage is compiler-proven", () => {
    const fixture = createFixture({
      "src/exhaustive.ts": `
type State = "a" | "b";
declare function unexpected(): number;
export function covered(value: State) {
  if (value === "a") return 1;
  else if (value === "b") return 2;
  else return unexpected();
}
export function partial(value: State) {
  if (value === "a") return 1;
  else return unexpected();
}
export function referencing(value: State) {
  if (value === "a") return 1;
  else if (value === "b") return 2;
  else return value;
}
enum Mode { A = "a", B = "b" }
export function enumCovered(value: Mode) {
  if (value === Mode.A) return 1;
  else if (value === Mode.B) return 2;
  else return unexpected();
}
export function switchCovered(value: State) {
  switch (value) {
    case "a": return 1;
    case "b": return 2;
    default: return unexpected();
  }
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.deepEqual(
      report.files[0].candidates.map((candidate) => candidate.terminator),
      ["exhaustive", "otherwise", "otherwise", "exhaustive", "exhaustive"],
    );
    const output = fs.readFileSync(path.join(fixture, "src/exhaustive.ts"), "utf8");
    assert.match(output, /function covered[\s\S]*\.exhaustive\(\(\) => unexpected\(\)\);/);
    assert.match(output, /function partial[\s\S]*\.otherwise\(\(\) => unexpected\(\)\);/);
    assert.match(output, /function referencing[\s\S]*\.otherwise\(\(value\) => value\);/);
    assert.match(output, /function enumCovered[\s\S]*\.exhaustive\(\(\) => unexpected\(\)\);/);
    assert.match(output, /function switchCovered[\s\S]*\.exhaustive\(\(\) => unexpected\(\)\);/);
    assertNoDiagnostics(fixture);
  });

  it("converts deep and fully optional discriminator paths", () => {
    const fixture = createFixture({
      "src/deep.ts": `
type Deep =
  | { meta: { state: "a"; amount: number } }
  | { meta: { state: "b"; label: string } };
type Optional = { meta?: { state?: "a" | "b" } } | undefined;
export function deep(value: Deep) {
  if (value.meta.state === "a") return value.meta.amount;
  else if (value.meta.state === "b") return value.meta.label.length;
  else return 0;
}
export function optional(value: Optional) {
  if (value?.meta?.state === "a") return "a";
  else return "other";
}
export function unsafe(value: { meta: { state: string } } | undefined) {
  if (value?.meta.state === "a") return 1;
  else return 2;
}
export function computed(value: Deep) {
  if (value["meta"].state === "a") return 1;
  else return 2;
}
export function nullable(value: Deep | undefined) {
  if (value.meta.state === "a") return 1;
  else return 2;
}
`,
    });
    const baselineDiagnostics = diagnosticMessages(fixture);
    const report = convert(fixture, { write: true });
    assert.equal(report.files[0].candidates[0].terminator, "exhaustive");
    assert.deepEqual(
      report.files[0].candidates.map((candidate) => [candidate.action, candidate.discriminator, candidate.reasonCode]),
      [
        ["converted", "meta.state", undefined],
        ["converted", "meta.state", undefined],
        ["skipped", undefined, "unsupported-discriminator"],
        ["skipped", undefined, "unsupported-discriminator"],
        ["skipped", undefined, "unsupported-discriminator"],
      ],
    );
    const output = fs.readFileSync(path.join(fixture, "src/deep.ts"), "utf8");
    assert.match(output, /\.with\(\{ meta: \{ state: "a" \} \}, \(value\) => value\.meta\.amount\)/);
    assert.match(output, /match\(value\)[\s\S]*\.with\(\{ meta: \{ state: "a" \} \}, \(\) => "a"\)/);
    assert.match(output, /if \(value\?\.meta\.state === "a"\)/);
    assert.match(output, /if \(value\["meta"\]\.state === "a"\)/);
    assert.match(output, /if \(value\.meta\.state === "a"\)/);
    assert.deepEqual(diagnosticMessages(fixture), baselineDiagnostics);
  });

  it("converts pattern guards, guarded unions, guard-only conditions, and type predicates", () => {
    const fixture = createFixture({
      "src/guards.ts": `
type Value = { kind: "a"; amount: number } | { kind: "b"; label: string };
const allowed = (status: string) => status.length > 0;
const isA = (value: Value): value is Extract<Value, { kind: "a" }> => value.kind === "a";
export function pattern(status: "a" | "b" | "c") {
  if ((status === "a" || status === "b") && allowed(status)) return "yes";
  else return "no";
}
export function guarded(value: Value) {
  if (isA(value)) return value.amount;
  else return value.label.length;
}
export function mixed(value: Value) {
  if (value.kind === "a") return value.amount;
  else if (value.label.length > 0) return value.label.length;
  else return value.label.length;
}
export function relational(value: number) {
  if (value > 0) return "positive";
  else return "other";
}
export function method(value: string) {
  if (value.startsWith("x")) return "x";
  else return "other";
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 5);
    assert.equal(report.files[0].candidates.filter((candidate) => candidate.kind === "guard-if").length, 4);
    const output = fs.readFileSync(path.join(fixture, "src/guards.ts"), "utf8");
    assert.match(output, /import \{ match, P \} from "ts-pattern";/);
    assert.match(output, /\.with\(P\.union\("a", "b"\), \(status\) => allowed\(status\), \(\) => "yes"\)/);
    assert.match(output, /\.when\(\(value\) => isA\(value\), \(value\) => value\.amount\)/);
    assert.match(output, /\.when\(\(value\) => value > 0, \(\) => "positive"\)/);
    assert.match(output, /\.when\(\(value\) => value\.startsWith\("x"\), \(\) => "x"\)/);
    assertNoDiagnostics(fixture);
  });

  it("aliases P and reports ambiguous or effectful guard subjects", () => {
    const fixture = createFixture({
      "src/guard-skips.ts": `
const P = 1;
const PTsPattern = 2;
const allowed = (value: string) => true;
export function aliased(value: "a" | "b" | "c") {
  if ((value === "a" || value === "b") && allowed(value)) return 1;
  else return 2;
}
export function ambiguous(value: number, minimum: number) {
  if (value > minimum) return 1;
  else return 2;
}
export function effectful(value: number) {
  if (value++ > 0) return 1;
  else return 2;
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.deepEqual(
      report.files[0].candidates.map((candidate) => candidate.reasonCode),
      [undefined, "ambiguous-guard-subject", "effectful-guard"],
    );
    const output = fs.readFileSync(path.join(fixture, "src/guard-skips.ts"), "utf8");
    assert.match(output, /import \{ match, P as PTsPattern2 \} from "ts-pattern";/);
    assert.match(output, /PTsPattern2\.union\("a", "b"\)/);
  });

  it("converts heterogeneous paths and mixed scalar-object alternatives", () => {
    const fixture = createFixture({
      "src/structural.ts": `
type Result =
  | "loading"
  | { type: "success"; value: number; meta?: undefined; errorCode?: undefined }
  | { type: "failure"; value?: undefined; meta?: { kind: "retry"; delay: number }; errorCode?: 404 | 500 };
const allowed = (value: Result) => value !== "loading";
export function heterogeneous(result: Result) {
  if (result === "loading") return 0;
  else if (result.type === "success") return result.value;
  else if (result.meta?.kind === "retry") return result.meta.delay;
  else if (result.errorCode === 404) return 404;
  else return -1;
}
export function mixedOr(result: Result) {
  if (result === "loading" || result.type === "success") return "active";
  else return "failed";
}
export function guardedMixed(result: Result) {
  if ((result === "loading" || result.type === "success") && allowed(result)) return "active";
  else return "failed";
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.deepEqual(report.files[0].candidates.map((candidate) => candidate.kind), [
      "structural-if", "structural-if", "structural-if",
    ]);
    assert.deepEqual(report.files[0].candidates[0].discriminators, ["type", "meta.kind", "errorCode"]);
    assert.deepEqual(report.files[0].candidates[1].discriminators, ["type"]);
    assert.equal(report.files[0].candidates[1].discriminator, "type");
    assert.match(formatConvertTsPatternReport(report, "text"), /discriminators: type, meta\.kind, errorCode/);
    const output = fs.readFileSync(path.join(fixture, "src/structural.ts"), "utf8");
    assert.match(output, /\.with\("loading", \(\) => 0\)/);
    assert.match(output, /\.with\(\{ type: "success" \}, \(result\) => result\.value\)/);
    assert.match(output, /\.with\(\{ meta: \{ kind: "retry" \} \}, \(result\) => result\.meta\.delay\)/);
    assert.match(output, /\.with\("loading", \{ type: "success" \}, \(\) => "active"\)/);
    assert.match(output, /P\.union\("loading", \{ type: "success" \}\)/);
    assertNoDiagnostics(fixture);
  });

  it("renders native typeof, instanceof, numeric, and string patterns", () => {
    const fixture = createFixture({
      "src/native-patterns.ts": `
class Box { constructor(readonly value: number) {} }
export function primitive(value: unknown) {
  if (typeof value === "string") return value.length;
  else if ("number" === typeof value) return value.toFixed(1);
  else if (typeof value === "bigint") return value + 1n;
  else if (typeof value === "boolean") return !value;
  else if (typeof value === "symbol") return value.description;
  else if (typeof value === "undefined") return "undefined";
  else return "other";
}
export function objectType(value: unknown) {
  if (typeof value === "object") return "object";
  else return "other";
}
export function functionType(value: unknown) {
  if (typeof value === "function") return "function";
  else return "other";
}
export function instance(value: unknown) {
  if (value instanceof Box) return value.value;
  else return 0;
}
export function range(value: unknown) {
  if (typeof value === "number" && value >= 0 && 10 >= value) return value.toFixed(0);
  else return "outside";
}
export function exclusive(value: unknown) {
  if (typeof value === "number" && value > 0 && value < 10) return value;
  else return 0;
}
export function bigintRange(value: unknown) {
  if (typeof value === "bigint" && value > 0n) return value;
  else return 0n;
}
export function integer(value: unknown) {
  if (Number.isInteger(value)) return value.toFixed(0);
  else return "other";
}
export function finite(value: unknown) {
  if (Number.isFinite(value)) return value.toFixed(0);
  else return "other";
}
export function stringMethod(value: unknown) {
  if (typeof value === "string" && value.startsWith("x")) return value.toUpperCase();
  else return "other";
}
export function stringLength(value: unknown) {
  if (typeof value === "string" && value.length >= 3) return value;
  else return "short";
}
export function moreStrings(value: unknown) {
  if (typeof value === "string" && value.endsWith("z")) return "suffix";
  else if (typeof value === "string" && value.includes("x")) return "included";
  else if (typeof value === "string" && value.length === 2) return "exact";
  else if (typeof value === "string" && 5 > value.length) return "bounded";
  else return "other";
}
export function regex(value: unknown) {
  if (typeof value === "string" && /^x/.test(value)) return value;
  else return "other";
}
export function unsafeRegex(value: unknown) {
  if (typeof value === "string" && /^x/g.test(value)) return value;
  else return "other";
}
declare function boxConstructor(): typeof Box;
export function dynamicInstance(value: unknown) {
  if (value instanceof boxConstructor()) return "box";
  else return "other";
}
export function coercive(value: any) {
  if (value > 0) return "positive";
  else return "other";
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 16, JSON.stringify(report.files[0].candidates, null, 2));
    const output = fs.readFileSync(path.join(fixture, "src/native-patterns.ts"), "utf8");
    assert.match(output, /\.with\(P\.string, \(value\) => value\.length\)/);
    assert.match(output, /\.with\(P\.number, \(value\) => value\.toFixed\(1\)\)/);
    assert.match(output, /\.with\(P\.bigint, \(value\) => value \+ 1n\)/);
    assert.match(output, /\.with\(void 0, \(\) => "undefined"\)/);
    assert.match(output, /objectType[\s\S]*\.when\(\(value\) => typeof value === "object"/);
    assert.match(output, /functionType[\s\S]*\.when\(\(value\) => typeof value === "function"/);
    assert.match(output, /\.with\(P\.instanceOf\(Box\), \(value\) => value\.value\)/);
    assert.match(output, /P\.number\.between\(0, 10\)/);
    assert.match(output, /P\.intersection\(P\.number\.gt\(0\), P\.number\.lt\(10\)\)/);
    assert.match(output, /P\.bigint\.gt\(0n\)/);
    assert.match(output, /P\.number\.int\(\)/);
    assert.match(output, /P\.number\.finite\(\)/);
    assert.match(output, /P\.string\.startsWith\("x"\)/);
    assert.match(output, /P\.string\.minLength\(3\)/);
    assert.match(output, /P\.string\.endsWith\("z"\)/);
    assert.match(output, /P\.string\.includes\("x"\)/);
    assert.match(output, /P\.string\.length\(2\)/);
    assert.match(output, /P\.string\.maxLength\(4\)/);
    assert.match(output, /P\.string\.regex\(\/\^x\/\)/);
    assert.match(output, /unsafeRegex[\s\S]*\.when\(\(value\) => typeof value === "string" && \/\^x\/g\.test\(value\)/);
    assert.match(output, /dynamicInstance[\s\S]*\.when\(\(value\) => value instanceof boxConstructor\(\)/);
    assert.match(output, /coercive[\s\S]*\.when\(\(value\) => value > 0/);
    assertNoDiagnostics(fixture);
  });

  it("converts strict inequality with P.not and preserves signed-zero equality", () => {
    const fixture = createFixture({
      "src/negative.ts": `
enum Mode { Open = "open", Closed = "closed" }
type Value = { type: "a"; amount: number } | { type: "b"; label: string };
const allowed = (value: string) => value.length > 0;
export function scalar(value: "open" | "closed") {
  if (value !== "closed") return "open";
  else return "closed";
}
export function enumValue(value: Mode) {
  if (value !== Mode.Closed) return Mode.Open;
  else return Mode.Closed;
}
export function deep(value: Value) {
  if (value.type !== "b") return value.amount;
  else return value.label;
}
export function type(value: unknown) {
  if (typeof value !== "string") return "not-string";
  else return value.length;
}
export function zero(value: number) {
  if (value !== 0) return "nonzero";
  else return "zero";
}
export function zeroEqual(value: number) {
  if (value === -0) return "zero";
  else return "nonzero";
}
export function guarded(value: "a" | "b") {
  if (value !== "b" && allowed(value)) return "a";
  else return "other";
}
export function heterogeneousOr(value: { type: string; kind: string }) {
  if (value.type !== "a" || value.kind !== "b") return "different";
  else return "same";
}
export const ternary = (value: string | number) =>
  typeof value !== "string" ? 0 : value.length;
export function switchZero(value: number) {
  switch (value) {
    case 0: return "zero";
    default: return "other";
  }
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.equal(report.summary.converted, 10, JSON.stringify(report.files[0].candidates, null, 2));
    const output = fs.readFileSync(path.join(fixture, "src/negative.ts"), "utf8");
    assert.match(output, /P\.not\("closed"\)/);
    assert.match(output, /P\.not\(Mode\.Closed\)/);
    assert.match(output, /\{ type: P\.not\("b"\) \}/);
    assert.match(output, /P\.not\(P\.string\)/);
    assert.match(output, /P\.not\(P\.number\.between\(0, 0\)\)/);
    assert.match(output, /P\.number\.between\(-0, -0\)/);
    assert.match(output, /\.with\(P\.not\("b"\), \(value\) => allowed\(value\), \(\) => "a"\)/);
    assert.match(output, /\.with\(\{ type: P\.not\("a"\) \}, \{ kind: P\.not\("b"\) \}, \(\) => "different"\)/);
    assert.match(output, /P\.not\(P\.string\)[\s\S]*const value = tsPatternValue as string;[\s\S]*return value\.length;/);
    assert.match(output, /ternary[\s\S]*P\.not\(P\.string\)[\s\S]*\.otherwise\(\(value\) => value\.length\)/);
    assert.match(output, /switchZero[\s\S]*P\.number\.between\(0, 0\)/);
    assertNoDiagnostics(fixture);
  });

  it("keeps optional negation exact and rejects invalid typeof tags", () => {
    const fixture = createFixture({
      "src/native-fallbacks.ts": `
export function optional(value: { kind?: string }) {
  if (value.kind !== "a") return "different";
  else return "same";
}
export function optionalType(value: { meta?: { kind?: string } } | undefined) {
  if (typeof value?.meta?.kind === "undefined") return "missing";
  else return value.meta.kind;
}
export function invalid(value: unknown) {
  if (typeof value === "date") return "date";
  else return "other";
}
`,
    });
    const report = convert(fixture, { write: true });
    assert.deepEqual(report.files[0].candidates.map((candidate) => candidate.reasonCode), [
      undefined, "validation-failed", "unsupported-pattern",
    ], JSON.stringify(report.files[0].candidates, null, 2));
    const output = fs.readFileSync(path.join(fixture, "src/native-fallbacks.ts"), "utf8");
    assert.match(output, /optional[\s\S]*\.when\(\(value\) => value\.kind !== "a"/);
    assert.match(output, /if \(typeof value\?\.meta\?\.kind === "undefined"\)/);
    assert.match(output, /if \(typeof value === "date"\)/);
  });

  it("preserves structural, predicate, coercion, signed-zero, and instanceof behavior at runtime", () => {
    const source = `
class Box { constructor(readonly value: number) {} }
type Input =
  | "loading"
  | { type: "ok"; value: number; meta?: undefined }
  | { type: "other"; value?: undefined; meta?: { kind: "retry" } };

export function run() {
  const log: string[] = [];
  const structural = (input: Input) => {
    if (input === "loading") return "loading";
    else if (input.type === "ok") return String(input.value);
    else if (input.meta?.kind === "retry") return "retry";
    else { log.push("fallback"); return "other"; }
  };
  const checked = (value: string) => { log.push(\`checked:\${value}\`); return value.startsWith("x"); };
  const ordered = (value: unknown) => {
    if (typeof value === "string" && checked(value)) return "yes";
    else return "no";
  };
  const nativeNumber = (value: unknown) => {
    if (typeof value === "number" && value > 0) return "positive";
    else return "other";
  };
  const coercive = (value: any) => {
    if (value > 0) return "positive";
    else return "other";
  };
  const throwingString = (value: any) => {
    if (value.startsWith("x")) return "x";
    else return "other";
  };
  const zeroEqual = (value: number) => {
    if (value === 0) return "zero";
    else return "other";
  };
  const zeroNotEqual = (value: number) => {
    if (value !== -0) return "other";
    else return "zero";
  };
  const instance = (value: unknown) => {
    if (value instanceof Box) return value.value;
    else return -1;
  };
  const regex = (value: unknown) => {
    if (typeof value === "string" && /^x/.test(value)) return "x";
    else return "other";
  };
  let thrown = "none";
  try { throwingString(null); } catch (error) { thrown = error instanceof Error ? error.name : "unknown"; }
  return {
    results: [
      structural("loading"),
      structural({ type: "ok", value: 2 }),
      structural({ type: "other", meta: { kind: "retry" } }),
      structural({ type: "other" }),
      ordered(1), ordered("x"), ordered("a"),
      nativeNumber("2"), coercive("2"),
      zeroEqual(0), zeroEqual(-0), zeroNotEqual(0), zeroNotEqual(-0),
      instance(new Box(4)), instance({ value: 4 }),
      regex("xyz"), regex(1), thrown,
    ],
    log,
  };
}
`;
    const originalFixture = createFixture({ "src/runtime.ts": source });
    const transformedFixture = createFixture({ "src/runtime.ts": source });
    const report = convert(transformedFixture, { write: true });
    assert.equal(report.summary.converted, 10);
    const transformed = fs.readFileSync(path.join(transformedFixture, "src/runtime.ts"), "utf8");
    assert.match(transformed, /P\.number\.gt\(0\)/);
    assert.match(transformed, /P\.number\.between\(0, 0\)/);
    assert.match(transformed, /P\.not\(P\.number\.between\(-0, -0\)\)/);
    assert.match(transformed, /P\.instanceOf\(Box\)/);
    assert.deepEqual(compileAndLoad(transformedFixture).run(), compileAndLoad(originalFixture).run());
  });

  it("preserves guard order, optional short-circuiting, and exhaustive fallback behavior at runtime", () => {
    const source = `
type State = "a" | "b";
type Optional = { meta?: { state?: "a" | "b" } } | undefined;

export function run() {
  const log: string[] = [];
  const allowed = (status: string) => {
    log.push(\`guard:\${status}\`);
    return status === "a";
  };
  const inspect = (value: Optional) => {
    log.push("optional-guard");
    return value !== undefined;
  };
  const guarded = (status: "a" | "b" | "c") => {
    if ((status === "a" || status === "b") && allowed(status)) {
      log.push(\`hit:\${status}\`);
      return "yes";
    } else {
      log.push(\`miss:\${status}\`);
      return "no";
    }
  };
  const optional = (value: Optional) => {
    if (value?.meta?.state === "a" && inspect(value)) return "a";
    else return "other";
  };
  const covered = (value: State) => {
    if (value === "a") return "a";
    else if (value === "b") return "b";
    else {
      log.push("unexpected");
      return "fallback";
    }
  };
  const results = [
    guarded("a"),
    guarded("b"),
    guarded("c"),
    optional(undefined),
    optional({ meta: { state: "a" } }),
    covered("unexpected" as State),
  ];
  return { log, results };
}
`;
    const originalFixture = createFixture({ "src/runtime.ts": source });
    const transformedFixture = createFixture({ "src/runtime.ts": source });
    const report = convert(transformedFixture, { write: true });
    assert.equal(report.summary.converted, 3);
    const transformed = fs.readFileSync(path.join(transformedFixture, "src/runtime.ts"), "utf8");
    assert.match(transformed, /P\.union\("a", "b"\)/);
    assert.match(transformed, /\{ meta: \{ state: "a" \} \}/);
    assert.match(transformed, /\.exhaustive\(\(\) => \{/);
    assert.deepEqual(compileAndLoad(transformedFixture).run(), compileAndLoad(originalFixture).run());
    const second = convert(transformedFixture, { write: true });
    assert.deepEqual(second.summary, { candidates: 0, converted: 0, skipped: 0, filesChanged: 0 });
    assert.equal(fs.readFileSync(path.join(transformedFixture, "src/runtime.ts"), "utf8"), transformed);
  });
});

describe("convert-ts-pattern CLI", () => {
  it("parses repeatable project options and rejects incompatible modes", () => {
    const parsed = parseConvertTsPatternArgs([
      "--source", "src/**/*.ts",
      "--source", "packages/**/*.ts",
      "--exclude", ".generated.ts",
      "--tsconfig", "config/tsconfig.json",
      "--max-continuation-bytes", "2048",
      "--pretty",
    ]);
    assert.equal("help" in parsed, false);
    if ("help" in parsed) return;
    assert.deepEqual(parsed.sourceGlob, ["src/**/*.ts", "packages/**/*.ts"]);
    assert.deepEqual(parsed.excludePathIncludes, [".generated.ts"]);
    assert.equal(parsed.maxContinuationBytes, 2048);
    assert.equal(parsed.write, false);
    assert.throws(() => parseConvertTsPatternArgs(["--source", "src/**/*.ts", "--dry-run", "--write"]), /mutually exclusive/);
    assert.throws(() => parseConvertTsPatternArgs([]), /missing required option/);
    assert.throws(() => parseConvertTsPatternArgs([
      "--source", "src/**/*.ts", "--max-continuation-bytes", "-1",
    ]), /non-negative integer/);
    assert.throws(() => parseConvertTsPatternArgs([
      "--source", "src/**/*.ts", "--max-continuation-bytes", "1", "--max-continuation-bytes", "2",
    ]), /only be specified once/);
  });

  it("writes JSON reports separately from source and supports text output", () => {
    const fixture = createFixture({
      "src/input.ts": `export function f(x: "a" | "b") { if (x === "a") return 1; else return 2; }\n`,
    });
    runConvertTsPattern({
      sourceGlob: "src/**/*.ts",
      write: false,
      format: "text",
      pretty: false,
      out: "reports/preview.txt",
    }, fixture);
    assert.match(fs.readFileSync(path.join(fixture, "reports/preview.txt"), "utf8"), /terminator: otherwise/);
    assert.match(fs.readFileSync(path.join(fixture, "reports/preview.txt"), "utf8"), /fallback-kind: explicit/);

    const code = runConvertTsPattern({
      sourceGlob: "src/**/*.ts",
      write: true,
      format: "json",
      pretty: true,
      out: "reports/result.json",
    }, fixture);
    assert.equal(code, 0);
    const report = JSON.parse(fs.readFileSync(path.join(fixture, "reports/result.json"), "utf8"));
    assert.equal(report.summary.converted, 1);
    assert.match(fs.readFileSync(path.join(fixture, "src/input.ts"), "utf8"), /return match\(x\)/);

    runConvertTsPattern({
      sourceGlob: "src/**/*.ts",
      write: false,
      format: "text",
      pretty: false,
      out: "reports/result.txt",
    }, fixture);
    assert.match(fs.readFileSync(path.join(fixture, "reports/result.txt"), "utf8"), /dry-run: 0 candidate\(s\)/);
  });

  it("returns conventional help and error exit statuses", () => {
    const output = captureWrites("stdout", () => mainConvertTsPattern(["--help"]));
    assert.equal(output.result, 0);
    assert.match(output.text, /convert-ts-pattern --source/);
    const error = captureWrites("stderr", () => mainConvertTsPattern([]));
    assert.equal(error.result, 1);
    assert.match(error.text, /missing required option/);
  });

  it("rejects a report path selected through a source glob", () => {
    const fixture = createFixture({
      "src/input.ts": `export const value = 1;\n`,
    });
    assert.throws(() => runConvertTsPattern({
      sourceGlob: "src/**/*.ts",
      write: true,
      format: "json",
      pretty: false,
      out: "src/input.ts",
    }, fixture), /--out cannot overwrite a selected source file/);
    assert.equal(fs.readFileSync(path.join(fixture, "src/input.ts"), "utf8"), "export const value = 1;\n");
  });
});

function convert(fixture, overrides = {}) {
  return convertTsPattern({
    sourceGlob: "src/**/*.ts",
    tsConfigFilePath: "tsconfig.json",
    cwd: fixture,
    ...overrides,
  });
}

function createFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "convert-ts-pattern-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, "../node_modules/ts-pattern"), path.join(root, "node_modules/ts-pattern"), "dir");
  for (const [relative, text] of Object.entries(files)) {
    const fileName = path.join(root, relative);
    fs.mkdirSync(path.dirname(fileName), { recursive: true });
    fs.writeFileSync(fileName, text);
  }
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }));
  return root;
}

function assertNoDiagnostics(fixture) {
  assert.deepEqual(diagnosticMessages(fixture), []);
}

function diagnosticMessages(fixture) {
  const configPath = path.join(fixture, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fixture, undefined, configPath);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

function compileAndLoad(fixture) {
  const configPath = path.join(fixture, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fixture, undefined, configPath);
  const outDir = path.join(fixture, "out");
  const options = {
    ...parsed.options,
    noEmit: false,
    outDir,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
  const program = ts.createProgram(parsed.fileNames, options);
  const emit = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics];
  assert.deepEqual(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
  const entry = path.join(outDir, "runtime.js");
  delete require.cache[require.resolve(entry)];
  return require(entry);
}

function findCandidate(report, suffix) {
  return report.files.find((file) => file.filePath.endsWith(suffix)).candidates[0];
}

function captureWrites(streamName, operation) {
  const stream = process[streamName];
  const original = stream.write;
  let text = "";
  stream.write = (chunk) => { text += String(chunk); return true; };
  try {
    return { result: operation(), text };
  } finally {
    stream.write = original;
  }
}
