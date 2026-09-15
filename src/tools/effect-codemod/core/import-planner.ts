import type { ImportRequirement, TextReplacement } from "../contracts/rewrite";

export interface ExistingImport {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

interface ImportedBinding {
  readonly moduleSpecifier: string;
  readonly importedName: string;
  readonly localName: string;
  readonly typeOnly: boolean;
}

/**
 * Plans one deterministic insertion for all imports that are not already
 * satisfied. Existing declarations are not rewritten; this preserves comments,
 * formatting, and import assertions/attributes. TypeScript validation is the
 * final guard against local-name collisions.
 */
export function planImportInsertion(
  filePath: string,
  sourceText: string,
  requirements: readonly ImportRequirement[],
  existingImports: readonly ExistingImport[],
): readonly TextReplacement[] {
  const normalized = dedupeRequirements(requirements);
  if (normalized.length === 0) return [];

  const existingBindings = existingImports.flatMap(parseNamedBindings);
  const missing = normalized.filter((requirement) => !isSatisfied(requirement, existingBindings));
  if (missing.length === 0) return [];

  const eol = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const declarations = renderDeclarations(missing, eol);
  const insertionOffset = existingImports.length > 0
    ? Math.min(...existingImports.map((item) => item.startOffset))
    : preambleEnd(sourceText);

  let replacement = declarations;
  if (insertionOffset > 0 && !endsWithLineBreak(sourceText.slice(0, insertionOffset))) {
    replacement = eol + replacement;
  }
  if (!replacement.endsWith(eol)) replacement += eol;

  return [{
    filePath,
    start: insertionOffset,
    end: insertionOffset,
    replacement,
    reason: "import-reconciliation",
  }];
}

function dedupeRequirements(requirements: readonly ImportRequirement[]): ImportRequirement[] {
  const seen = new Set<string>();
  const output: ImportRequirement[] = [];
  for (const requirement of requirements) {
    const localName = requirement.localName ?? requirement.importedName;
    const key = `${requirement.moduleSpecifier}\u0000${requirement.importedName}\u0000${localName}\u0000${Boolean(requirement.typeOnly)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(requirement);
  }
  return output;
}

function parseNamedBindings(existing: ExistingImport): ImportedBinding[] {
  const text = existing.text.trim();
  const match = /^import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+(["'])([^"']+)\3(?:\s+with\s+\{[\s\S]*\})?\s*;?$/u.exec(text);
  if (!match) return [];

  const clauseTypeOnly = Boolean(match[1]);
  const body = match[2] ?? "";
  const moduleSpecifier = match[4] ?? "";
  const bindings: ImportedBinding[] = [];

  for (const rawPart of body.split(",")) {
    let part = rawPart.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gu, "").trim();
    if (!part) continue;
    let typeOnly = clauseTypeOnly;
    if (part.startsWith("type ")) {
      typeOnly = true;
      part = part.slice(5).trim();
    }
    const alias = /^([^\s]+)\s+as\s+([^\s]+)$/u.exec(part);
    const importedName = alias?.[1] ?? part;
    const localName = alias?.[2] ?? importedName;
    if (!isIdentifier(importedName) || !isIdentifier(localName)) continue;
    bindings.push({ moduleSpecifier, importedName, localName, typeOnly });
  }
  return bindings;
}

function isSatisfied(requirement: ImportRequirement, existing: readonly ImportedBinding[]): boolean {
  const localName = requirement.localName ?? requirement.importedName;
  return existing.some((binding) =>
    binding.moduleSpecifier === requirement.moduleSpecifier
    && binding.importedName === requirement.importedName
    && binding.localName === localName
    && (Boolean(requirement.typeOnly) || !binding.typeOnly)
  );
}

function renderDeclarations(requirements: readonly ImportRequirement[], eol: string): string {
  const groups = new Map<string, ImportRequirement[]>();
  for (const requirement of requirements) {
    const key = `${requirement.moduleSpecifier}\u0000${Boolean(requirement.typeOnly)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(requirement);
    groups.set(key, bucket);
  }

  return [...groups.values()]
    .sort((a, b) => {
      const left = a[0];
      const right = b[0];
      if (!left || !right) return 0;
      return left.moduleSpecifier.localeCompare(right.moduleSpecifier)
        || Number(Boolean(left.typeOnly)) - Number(Boolean(right.typeOnly));
    })
    .map((group) => {
      const first = group[0];
      if (!first) return "";
      const names = [...group]
        .sort((a, b) => (a.localName ?? a.importedName).localeCompare(b.localName ?? b.importedName))
        .map((item) => item.localName && item.localName !== item.importedName
          ? `${item.importedName} as ${item.localName}`
          : item.importedName)
        .join(", ");
      const typeKeyword = first.typeOnly ? "type " : "";
      return `import ${typeKeyword}{ ${names} } from ${JSON.stringify(first.moduleSpecifier)};`;
    })
    .filter(Boolean)
    .join(eol);
}

function preambleEnd(sourceText: string): number {
  let offset = 0;
  if (sourceText.startsWith("#!")) {
    const newline = sourceText.indexOf("\n");
    offset = newline === -1 ? sourceText.length : newline + 1;
  }

  // Preserve leading triple-slash directives and contiguous leading comments.
  while (offset < sourceText.length) {
    const rest = sourceText.slice(offset);
    const directive = /^(?:[ \t]*\/\/\/[^\n]*(?:\r?\n|$))/u.exec(rest);
    if (directive) {
      offset += directive[0].length;
      continue;
    }
    const lineComment = /^(?:[ \t]*\/\/[^\n]*(?:\r?\n|$))/u.exec(rest);
    if (lineComment) {
      offset += lineComment[0].length;
      continue;
    }
    const blockComment = /^(?:[ \t]*\/\*[\s\S]*?\*\/[ \t]*(?:\r?\n|$))/u.exec(rest);
    if (blockComment) {
      offset += blockComment[0].length;
      continue;
    }
    break;
  }
  return offset;
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

function isIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/u.test(value);
}
