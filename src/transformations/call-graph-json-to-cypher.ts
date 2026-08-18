import * as fs from "node:fs";

type CallGraphItem = {
  id: string;
  name?: string;
  calls?: string[];
};

type FunctionNode = {
  id: string;
  name: string;
  file?: string;
  line?: number;
  column?: number;
  external: boolean;
};

const ID_PATTERN = /^(.*?):(\d+):(\d+):(.+)$/;

function parseFunctionId(rawId: string): FunctionNode {
  if (rawId.startsWith("external:")) {
    return {
      id: rawId,
      name: rawId.replace(/^external:/, ""),
      external: true,
    };
  }

  const match = rawId.match(ID_PATTERN);

  if (!match) {
    return {
      id: rawId,
      name: rawId,
      external: false,
    };
  }

  const [, file, line, column, symbol] = match;

  return {
    id: rawId,
    name: symbol,
    file,
    line: Number(line),
    column: Number(column),
    external: false,
  };
}

function cypherString(value: string): string {
  // JSON.stringify gives valid quoted strings for Cypher in normal cases.
  return JSON.stringify(value);
}

function cypherValue(value: string | number | boolean): string {
  if (typeof value === "string") return cypherString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function cypherProps(props: FunctionNode): string {
  const entries = Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${cypherValue(value as string | number | boolean)}`);

  return `{ ${entries.join(", ")} }`;
}

function convert(inputJsonPath: string, outputCypherPath: string): void {
  const raw = fs.readFileSync(inputJsonPath, "utf8");
  const data = JSON.parse(raw) as CallGraphItem[];

  const nodes = new Map<string, FunctionNode>();

  for (const item of data) {
    const parsed = parseFunctionId(item.id);

    nodes.set(item.id, {
      ...parsed,
      name: item.name ?? parsed.name,
    });

    for (const calledId of item.calls ?? []) {
      if (!nodes.has(calledId)) {
        nodes.set(calledId, parseFunctionId(calledId));
      }
    }
  }

  const lines: string[] = [];

  lines.push("CREATE CONSTRAINT ON (f:Function) ASSERT f.id IS UNIQUE;");
  lines.push("");

  for (const node of nodes.values()) {
    lines.push(
      `MERGE (f:Function {id: ${cypherString(node.id)}}) ` +
        `SET f += ${cypherProps(node)};`
    );
  }

  lines.push("");

  for (const item of data) {
    for (const calledId of item.calls ?? []) {
      lines.push(
        `MATCH ` +
          `(caller:Function {id: ${cypherString(item.id)}}), ` +
          `(callee:Function {id: ${cypherString(calledId)}}) ` +
          `MERGE (caller)-[:CALLS]->(callee);`
      );
    }
  }

  fs.writeFileSync(outputCypherPath, lines.join("\n"), "utf8");
}

const [, , inputJsonPath = "/home/ai-developer/development/js-ts-tools/junk/rubric-callgraph.json", outputCypherPath = "callgraph.cypher"] =
  process.argv;

convert(inputJsonPath, outputCypherPath);