import type TS from "typescript";
import { applyTextEdits } from "../tsquery-cli";
import type { EffectSchemaCandidate, EffectSchemaFileChange } from "./contracts";

/** Complete the plugin's insertion-only structural refactor using original-source offsets.
 * Keep schema generation authoritative to the plugin; the adapter owns replacement/import plumbing.
 */
export function completeStructuralSchemaEdits(
  compiler: typeof TS,
  program: TS.Program,
  candidate: EffectSchemaCandidate,
  files: readonly EffectSchemaFileChange[],
): EffectSchemaFileChange[] {
  const ts = compiler;
  return files.map(file => {
    const source = program.getSourceFile(file.filePath)!;
    const newline = source.text.includes("\r\n") ? "\r\n" : "\n";
    const edits = file.edits.map(edit => ({ ...edit }));
    let target: TS.InterfaceDeclaration | TS.TypeAliasDeclaration | undefined;
    if (file.filePath === candidate.filePath) {
      const position = source.getPositionOfLineAndCharacter(candidate.line - 1, candidate.column - 1);
      const visit = (node: TS.Node) => {
        if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.getStart(source) === position) target = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!target) throw new Error("The selected declaration no longer matches the refactor target.");
    }
    const parsed = edits.map(edit => ts.createSourceFile("generated.ts", edit.replacement, ts.ScriptTarget.Latest, true));
    const emitsClass = target && parsed.some(fragment => fragment.statements.some(node => ts.isClassDeclaration(node) && node.name?.text === candidate.name));
    if (target && emitsClass) {
      const start = target.getStart(source), end = target.end;
      const alreadyReplaced = edits.some(edit => edit.start <= start && edit.end >= end);
      if (!alreadyReplaced) {
        if (edits.some(edit => edit.start < end && edit.end > start)) throw new Error("Plugin edits partially overlap the selected declaration.");
        // Insert the generated replacement after leading comments, retaining their attachment.
        for (const edit of edits) if (edit.start === target.pos && edit.end === target.pos) edit.start = edit.end = start;
        edits.push({ start, end, replacement: "" });
      }
    }
    const imports = (sf: TS.SourceFile) => sf.statements.flatMap(statement => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) return [];
      const clause = statement.importClause, bindings = clause.namedBindings;
      if (statement.moduleSpecifier.text === "effect" && bindings && ts.isNamedImports(bindings)) {
        return bindings.elements.filter(e => (e.propertyName ?? e.name).text === "Schema")
          .map(e => ({ name: e.name.text, node: e.name, value: !clause.isTypeOnly && !e.isTypeOnly }));
      }
      if (statement.moduleSpecifier.text === "effect/Schema") {
        const name = bindings && ts.isNamespaceImport(bindings) ? bindings.name : clause.name;
        return name ? [{ name: name.text, node: name, value: !clause.isTypeOnly }] : [];
      }
      return [];
    });
    const originalImports = imports(source);
    const pluginBinding = originalImports[0]?.name ?? "Schema";
    const checker = program.getTypeChecker();
    const inScope = checker.getSymbolsInScope(target ?? source, ts.SymbolFlags.Value | ts.SymbolFlags.Alias);
    const usable = originalImports.find(binding => binding.value && inScope.find(s => s.name === binding.name) === checker.getSymbolAtLocation(binding.node));
    const references: { edit: number; start: number; end: number }[] = [];
    parsed.forEach((fragment, index) => {
      const visit = (node: TS.Node) => {
        if (ts.isIdentifier(node) && node.text === pluginBinding && ((ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) || (ts.isQualifiedName(node.parent) && node.parent.left === node))) references.push({ edit: index, start: node.getStart(fragment), end: node.end });
        ts.forEachChild(node, visit);
      };
      visit(fragment);
    });
    if (references.length) {
      let binding = usable?.name ?? parsed.flatMap(imports).find(binding => binding.value)?.name;
      if (!binding) {
        const names = new Set<string>();
        const collect = (node: TS.Node) => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collect); };
        collect(source);
        // The intended Schema reference is not itself a generated declaration conflict.
        for (const fragment of parsed) for (const statement of fragment.statements) {
          if (ts.isClassDeclaration(statement) && statement.name) names.add(statement.name.text);
          if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
        binding = "Schema";
        if (names.has(binding)) {
          binding = "EffectSchema";
          for (let suffix = 2; names.has(binding); suffix++) binding = `EffectSchema${suffix}`;
        }
        const lastImport = source.statements.filter(ts.isImportDeclaration).at(-1);
        const shebang = source.text.startsWith("#!") ? source.text.indexOf("\n") + 1 : 0;
        const position = lastImport?.end ?? shebang;
        const imported = binding === "Schema" ? "Schema" : `Schema as ${binding}`;
        edits.push({ start: position, end: position, replacement: `${lastImport ? newline : ""}import { ${imported} } from "effect";${newline}` });
      }
      for (let index = 0; index < parsed.length; index++) {
        const replacements = references.filter(ref => ref.edit === index).map(ref => ({ start: ref.start, end: ref.end, replacement: binding! }));
        if (target?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          for (const statement of parsed[index].statements) {
            if (!ts.isClassDeclaration(statement) || statement.name?.text !== candidate.name || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
            const exported = statement.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
            if (exported) replacements.push({ start: exported.end, end: exported.end, replacement: " default" });
          }
        }
        edits[index].replacement = applyTextEdits(edits[index].replacement, replacements).replace(/\r?\n/g, newline);
      }
    }
    // Coalesce colocated insertions and the selected deletion into one original-coordinate edit.
    // Import insertion follows the plugin in the array, but must appear before generated code.
    const grouped = new Map<number, typeof edits>();
    for (const edit of edits) grouped.set(edit.start, [...grouped.get(edit.start) ?? [], edit]);
    const combined = [...grouped].map(([start, group]) => {
      const replacements = group.filter(edit => edit.end > start);
      if (replacements.length > 1) throw new Error("Overlapping completed refactor edits.");
      const insertions = group.filter(edit => edit.end === start);
      return { start, end: replacements[0]?.end ?? start,
        replacement: insertions.slice().reverse().map(edit => edit.replacement).join("") + (replacements[0]?.replacement ?? "") };
    }).sort((a,b) => a.start-b.start);
    for (let index=1; index<combined.length; index++) if (combined[index-1].end > combined[index].start) throw new Error("Overlapping completed refactor edits.");
    return { ...file, edits: combined, editedText: applyTextEdits(file.originalText, combined) };
  });
}
