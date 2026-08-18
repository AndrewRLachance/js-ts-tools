import * as fs from "node:fs";

type DeclaredAt = {
  filePath: string;
  line: number;
  column: number;
};

type Initializer = {
  definedBy: string;
  dependsOn?: string[];
};


type SymbolItem = {
  id: string;
  name: string;
  owner?: string;
  kind: "variable" | "parameter" | string;
  declaredAt?: DeclaredAt;
  initializer?: Initializer;
  assignments?: Assignment[];
  reads?: string[];
};

type Assignment =
  | string
  | {
      value?: string;
      expression?: string;
      definedBy?: string;
      dependsOn?: string[];
      location?: {
        filePath: string;
        line: number;
        column: number;
      };
      line?: number;
      column?: number;
    };

type NormalizedAssignment = {
  value: string;
  dependsOn: string[];
  filePath?: string;
  line?: number;
  column?: number;
};

function cypherString(value: string): string {
  return JSON.stringify(value);
}

function cypherValue(value: string | number | boolean): string {
  if (typeof value === "string") return cypherString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function cypherProps(
  props: Record<string, string | number | boolean | undefined | null>
): string {
  const entries = Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      return `${key}: ${cypherValue(value as string | number | boolean)}`;
    });

  return `{ ${entries.join(", ")} }`;
}

function normalizeAssignment(assignment: Assignment): NormalizedAssignment {
  if (typeof assignment === "string") {
    return {
      value: assignment,
      dependsOn: [],
    };
  }

  return {
    value:
      assignment.value ??
      assignment.expression ??
      assignment.definedBy ??
      JSON.stringify(assignment),
    dependsOn: assignment.dependsOn ?? [],
    filePath: assignment.location?.filePath,
    line: assignment.location?.line ?? assignment.line,
    column: assignment.location?.column ?? assignment.column,
  };
}
function convert(inputJsonPath: string, outputCypherPath: string): void {
  const raw = fs.readFileSync(inputJsonPath, "utf8");
  const data = JSON.parse(raw) as SymbolItem[];

  const lines: string[] = [];

  // Keep this compatible with the previous call-graph model.
  lines.push("CREATE CONSTRAINT ON (fn:Function) ASSERT fn.name IS UNIQUE;");
  lines.push("CREATE CONSTRAINT ON (s:Symbol) ASSERT s.id IS UNIQUE;");
  lines.push("CREATE CONSTRAINT ON (file:File) ASSERT file.path IS UNIQUE;");
  lines.push("CREATE CONSTRAINT ON (expr:Expression) ASSERT expr.id IS UNIQUE;");
  lines.push("CREATE CONSTRAINT ON (ref:Reference) ASSERT ref.name IS UNIQUE;");
  lines.push("");

  for (const item of data) {
    lines.push(
      `MERGE (s:Symbol {id: ${cypherString(item.id)}}) ` +
        `SET s += ${cypherProps({
          id: item.id,
          name: item.name,
          kind: item.kind,
          owner: item.owner,
          filePath: item.declaredAt?.filePath,
          line: item.declaredAt?.line,
          column: item.declaredAt?.column,
        })};`
    );

    if (item.owner) {
      lines.push(
        `MERGE (owner:Function {name: ${cypherString(item.owner)}});`
      );

      lines.push(
        `MATCH ` +
          `(owner:Function {name: ${cypherString(item.owner)}}), ` +
          `(s:Symbol {id: ${cypherString(item.id)}}) ` +
          `MERGE (owner)-[:OWNS]->(s);`
      );
    }

    if (item.declaredAt?.filePath) {
      lines.push(
        `MERGE (file:File {path: ${cypherString(item.declaredAt.filePath)}});`
      );

      lines.push(
        `MATCH ` +
          `(s:Symbol {id: ${cypherString(item.id)}}), ` +
          `(file:File {path: ${cypherString(item.declaredAt.filePath)}}) ` +
          `MERGE (s)-[:DECLARED_IN]->(file);`
      );
    }

    if (item.initializer) {
      const initializerId = `${item.id}#initializer`;

      lines.push(
        `MERGE (expr:Expression {id: ${cypherString(initializerId)}}) ` +
          `SET expr += ${cypherProps({
            id: initializerId,
            kind: "initializer",
            value: item.initializer.definedBy,
          })};`
      );

      lines.push(
        `MATCH ` +
          `(s:Symbol {id: ${cypherString(item.id)}}), ` +
          `(expr:Expression {id: ${cypherString(initializerId)}}) ` +
          `MERGE (s)-[:INITIALIZED_BY]->(expr);`
      );

      for (const dep of item.initializer.dependsOn ?? []) {
        lines.push(`MERGE (ref:Reference {name: ${cypherString(dep)}});`);

        lines.push(
          `MATCH ` +
            `(expr:Expression {id: ${cypherString(initializerId)}}), ` +
            `(ref:Reference {name: ${cypherString(dep)}}) ` +
            `MERGE (expr)-[:DEPENDS_ON]->(ref);`
        );
      }
    }

    for (const [index, rawAssignment] of (item.assignments ?? []).entries()) {
      const assignment = normalizeAssignment(rawAssignment);
      const assignmentId = `${item.id}#assignment:${index}`;

    lines.push(
    `MERGE (expr:Expression {id: ${cypherString(assignmentId)}}) ` +
        `SET expr += ${cypherProps({
        id: assignmentId,
        kind: "assignment",
        value: assignment.value,
        index,
        filePath: assignment.filePath,
        line: assignment.line,
        column: assignment.column,
        })};`
    );

      lines.push(
        `MATCH ` +
          `(s:Symbol {id: ${cypherString(item.id)}}), ` +
          `(expr:Expression {id: ${cypherString(assignmentId)}}) ` +
          `MERGE (s)-[:ASSIGNED]->(expr);`
      );

      for (const dep of assignment.dependsOn) {
        lines.push(`MERGE (ref:Reference {name: ${cypherString(dep)}});`);

        lines.push(
          `MATCH ` +
            `(expr:Expression {id: ${cypherString(assignmentId)}}), ` +
            `(ref:Reference {name: ${cypherString(dep)}}) ` +
            `MERGE (expr)-[:DEPENDS_ON]->(ref);`
        );
      }
    }

    for (const [index, readName] of (item.reads ?? []).entries()) {
      const readEdgeId = `${item.id}#read:${index}:${readName}`;

      lines.push(`MERGE (ref:Reference {name: ${cypherString(readName)}});`);

      lines.push(
        `MATCH ` +
          `(s:Symbol {id: ${cypherString(item.id)}}), ` +
          `(ref:Reference {name: ${cypherString(readName)}}) ` +
          `MERGE (s)-[r:READS {id: ${cypherString(readEdgeId)}}]->(ref) ` +
          `SET r.index = ${index};`
      );
    }

    lines.push("");
  }

  fs.writeFileSync(outputCypherPath, lines.join("\n"), "utf8");
}

const [, , inputJsonPath = "/home/ai-developer/development/js-ts-tools/junk/rubric-definitionUseGraph.json", outputCypherPath = "definitionUseGraph.cypher"] =
  process.argv;

convert(inputJsonPath, outputCypherPath);