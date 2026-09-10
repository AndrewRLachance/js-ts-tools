import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateAstXPathPattern,
  matchAstXPathPattern,
  readAstXPathPattern,
  runAstXPath,
  type AstXPathMatchReport,
  type AstXPathSemanticMode,
  type AstXPathStrictness,
} from "./ast-xpath";

export type AstXPathOutputFormat = "json" | "text";

interface SharedMatchCliOptions {
  targetTsConfigFilePath?: string;
  semanticMode: AstXPathSemanticMode;
  sourceGlobs: string[];
  excludePathIncludes: string[];
  includeDeclarations: boolean;
  format: AstXPathOutputFormat;
  pretty: boolean;
  out?: string;
  failEmpty: boolean;
}

export type AstXPathCliOptions =
  | {
      command: "generate";
      exampleFilePath: string;
      tsConfigFilePath: string;
      strictness: AstXPathStrictness;
      pretty: boolean;
      out?: string;
      xmlOut?: string;
    }
  | ({
      command: "match";
      patternFilePath: string;
    } & SharedMatchCliOptions)
  | ({
      command: "run";
      exampleFilePath: string;
      tsConfigFilePath: string;
      strictness: AstXPathStrictness;
      patternOut?: string;
      xmlOut?: string;
    } & SharedMatchCliOptions);

export const AST_XPATH_HELP = `Usage:
  ast-xpath generate --example <file> [options]
  ast-xpath match --pattern <pattern.json> [options]
  ast-xpath run --example <file> [options]

Generate portable XPath 3.1 patterns from a marked TypeScript AST and match them across projects.

Example markers:
  /* ast-xpath-root */           Select the following AST node as the result root.
  /* ast-xpath-ignore */         Treat the following subtree as unconstrained.
  /* ast-xpath-ignore-start */   Begin an unconstrained subtree or sibling span.
  /* ast-xpath-ignore-end */     End an unconstrained subtree or sibling span.

Generation options:
  --example <file>               Marked TypeScript example file. Required.
  --tsconfig <path>              Example TypeScript config. Default: tsconfig.json.
  --strictness <exact|shape>     Exact values or structural shape. Default: exact.
  --xml-out <path>               Write the example AST XML document.
  --pattern-out <path>           Write the generated pattern in run mode.

Matching options:
  --pattern <file>               Generated pattern file. Required by match.
  --tsconfig <path>              Target TypeScript config in match mode. Default: tsconfig.json.
  --target-tsconfig <path>       Target config in run mode; defaults to the example config.
  --semantics <strict|structural> Enforce portable facts or use structural matching. Default: strict.
  --source <glob>                Restrict project files. Repeatable.
  --exclude <substring>          Exclude matching paths. Repeatable.
  --include-declarations         Include declaration files.
  --format <json|text>           Match output format. Default: json.
  --fail-empty                   Exit with status 2 when nothing matches.

Output options:
  --out <path>                   Write the primary JSON/text output to a file.
  --pretty                       Pretty-print JSON output.
  -h, --help                     Show this help message.
`;

export function parseAstXPathArgs(argv: string[]): AstXPathCliOptions | { help: true } {
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };
  const command = argv[0];
  if (command !== "generate" && command !== "match" && command !== "run") {
    throw new Error("expected subcommand: generate, match, or run");
  }
  let exampleFilePath: string | undefined;
  let patternFilePath: string | undefined;
  let tsConfigFilePath = "tsconfig.json";
  let tsConfigSpecified = false;
  let targetTsConfigFilePath: string | undefined;
  let strictness: AstXPathStrictness = "exact";
  let semanticMode: AstXPathSemanticMode = "strict";
  let semanticsSpecified = false;
  const sourceGlobs: string[] = [];
  const excludePathIncludes: string[] = [];
  let includeDeclarations = false;
  let format: AstXPathOutputFormat = "json";
  let pretty = false;
  let out: string | undefined;
  let xmlOut: string | undefined;
  let patternOut: string | undefined;
  let failEmpty = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--example":
        exampleFilePath = setOnce(exampleFilePath, requireValue(argv, ++index, arg), arg);
        break;
      case "--pattern":
        patternFilePath = setOnce(patternFilePath, requireValue(argv, ++index, arg), arg);
        break;
      case "--tsconfig":
        if (tsConfigSpecified) throw new Error("--tsconfig may only be specified once");
        tsConfigSpecified = true;
        tsConfigFilePath = requireValue(argv, ++index, arg);
        break;
      case "--target-tsconfig":
        targetTsConfigFilePath = setOnce(targetTsConfigFilePath, requireValue(argv, ++index, arg), arg);
        break;
      case "--strictness": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "exact" && value !== "shape") throw new Error(`invalid --strictness: ${value}`);
        strictness = value;
        break;
      }
      case "--source":
        sourceGlobs.push(requireValue(argv, ++index, arg));
        break;
      case "--semantics": {
        if (semanticsSpecified) throw new Error("--semantics may only be specified once");
        semanticsSpecified = true;
        const value = requireValue(argv, ++index, arg);
        if (value !== "strict" && value !== "structural") throw new Error(`invalid --semantics: ${value}`);
        semanticMode = value;
        break;
      }
      case "--exclude":
        excludePathIncludes.push(requireValue(argv, ++index, arg));
        break;
      case "--include-declarations":
        includeDeclarations = true;
        break;
      case "--format": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "json" && value !== "text") throw new Error(`invalid --format: ${value}`);
        format = value;
        break;
      }
      case "--pretty":
        pretty = true;
        break;
      case "--out":
        out = setOnce(out, requireValue(argv, ++index, arg), arg);
        break;
      case "--xml-out":
        xmlOut = setOnce(xmlOut, requireValue(argv, ++index, arg), arg);
        break;
      case "--pattern-out":
        patternOut = setOnce(patternOut, requireValue(argv, ++index, arg), arg);
        break;
      case "--fail-empty":
        failEmpty = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (command === "generate") {
    if (!exampleFilePath) throw new Error("generate requires --example <file>");
    rejectOptions(command, {
      patternFilePath,
      patternOut,
      targetTsConfigFilePath,
      semanticsSpecified,
      sourceGlobs,
      excludePathIncludes,
      includeDeclarations,
      format,
      failEmpty,
    });
    return {
      command,
      exampleFilePath,
      tsConfigFilePath,
      strictness,
      pretty,
      ...(out ? { out } : {}),
      ...(xmlOut ? { xmlOut } : {}),
    };
  }
  if (command === "match") {
    if (!patternFilePath) throw new Error("match requires --pattern <file>");
    if (exampleFilePath || xmlOut || patternOut || strictness !== "exact") {
      throw new Error("match does not accept generation options");
    }
    if (targetTsConfigFilePath && tsConfigSpecified) {
      throw new Error("match accepts only one of --tsconfig and --target-tsconfig");
    }
    if (pretty && format !== "json") throw new Error("--pretty is only valid with --format json");
    return {
      command,
      patternFilePath,
      ...((targetTsConfigFilePath ?? (tsConfigSpecified ? tsConfigFilePath : undefined))
        ? { targetTsConfigFilePath: targetTsConfigFilePath ?? tsConfigFilePath }
        : {}),
      semanticMode,
      sourceGlobs,
      excludePathIncludes,
      includeDeclarations,
      format,
      pretty,
      failEmpty,
      ...(out ? { out } : {}),
    };
  }
  if (!exampleFilePath) throw new Error("run requires --example <file>");
  if (patternFilePath) throw new Error("run does not accept --pattern");
  if (pretty && format !== "json") throw new Error("--pretty is only valid with --format json");
  return {
    command,
    exampleFilePath,
    tsConfigFilePath,
    strictness,
    ...(targetTsConfigFilePath ? { targetTsConfigFilePath } : {}),
    semanticMode,
    sourceGlobs,
    excludePathIncludes,
    includeDeclarations,
    format,
    pretty,
    failEmpty,
    ...(out ? { out } : {}),
    ...(xmlOut ? { xmlOut } : {}),
    ...(patternOut ? { patternOut } : {}),
  };
}

export function runAstXPathCli(options: AstXPathCliOptions, cwd = process.cwd()): number {
  if (options.command === "generate") {
    const generated = generateAstXPathPattern({
      cwd,
      exampleFilePath: options.exampleFilePath,
      tsConfigFilePath: options.tsConfigFilePath,
      strictness: options.strictness,
    });
    emit(`${JSON.stringify(generated.pattern, null, options.pretty ? 2 : undefined)}\n`, options.out, cwd);
    if (options.xmlOut) emit(`${generated.xml}\n`, options.xmlOut, cwd);
    return 0;
  }

  let report: AstXPathMatchReport;
  if (options.command === "match") {
    const patternPath = path.resolve(cwd, options.patternFilePath);
    report = matchAstXPathPattern({
      pattern: readAstXPathPattern(patternPath),
      cwd,
      targetTsConfigFilePath: options.targetTsConfigFilePath,
      semanticMode: options.semanticMode,
      sourceGlobs: options.sourceGlobs,
      excludePathIncludes: options.excludePathIncludes,
      includeDeclarations: options.includeDeclarations,
    });
  } else {
    const result = runAstXPath({
      cwd,
      exampleFilePath: options.exampleFilePath,
      tsConfigFilePath: options.tsConfigFilePath,
      targetTsConfigFilePath: options.targetTsConfigFilePath,
      semanticMode: options.semanticMode,
      strictness: options.strictness,
      sourceGlobs: options.sourceGlobs,
      excludePathIncludes: options.excludePathIncludes,
      includeDeclarations: options.includeDeclarations,
    });
    const { xml, ...matchReport } = result;
    report = matchReport;
    if (options.xmlOut) emit(`${xml}\n`, options.xmlOut, cwd);
    if (options.patternOut) emit(`${JSON.stringify(report.pattern, null, options.pretty ? 2 : undefined)}\n`, options.patternOut, cwd);
  }
  emit(formatAstXPathReport(report, options.format, options.pretty), options.out, cwd);
  return options.failEmpty && report.matches.length === 0 ? 2 : 0;
}

export function formatAstXPathReport(
  report: AstXPathMatchReport,
  format: AstXPathOutputFormat,
  pretty = false,
): string {
  if (format === "json") return `${JSON.stringify(report, null, pretty ? 2 : undefined)}\n`;
  const lines = report.matches.map((match) =>
    `${match.filePath}:${match.start.line}:${match.start.column}\t${match.kind}\t${match.text.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`
  );
  lines.push(
    `${report.summary.matches} match(es), ${report.summary.xpathCandidates} XPath candidate(s), ` +
    `${report.summary.semanticRejected} semantic rejection(s), ${report.summary.filesScanned} file(s) scanned`,
  );
  return `${lines.join("\n")}\n`;
}

export function mainAstXPath(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const options = parseAstXPathArgs(argv);
    if ("help" in options) {
      fs.writeSync(process.stdout.fd, AST_XPATH_HELP);
      return 0;
    }
    return runAstXPathCli(options, cwd);
  } catch (error) {
    process.stderr.write(`ast-xpath: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function setOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) throw new Error(`${option} may only be specified once`);
  return value;
}

function rejectOptions(
  command: "generate",
  values: {
    patternFilePath?: string;
    patternOut?: string;
    targetTsConfigFilePath?: string;
    semanticsSpecified: boolean;
    sourceGlobs: string[];
    excludePathIncludes: string[];
    includeDeclarations: boolean;
    format: AstXPathOutputFormat;
    failEmpty: boolean;
  },
): void {
  if (values.patternFilePath || values.patternOut || values.targetTsConfigFilePath || values.semanticsSpecified ||
      values.sourceGlobs.length > 0 ||
      values.excludePathIncludes.length > 0 || values.includeDeclarations ||
      values.format !== "json" || values.failEmpty) {
    throw new Error(`${command} does not accept matching options`);
  }
}

function emit(text: string, out: string | undefined, cwd: string): void {
  if (!out) {
    fs.writeSync(process.stdout.fd, text);
    return;
  }
  const outputPath = path.resolve(cwd, out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, "utf8");
}
