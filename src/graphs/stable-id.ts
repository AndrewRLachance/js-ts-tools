import { Node } from "ts-morph";

export interface StableIdLocation {
  filePath: string;
  line: number;
  column: number;
  name: string;
}

export function getStableNodeId(node: Node, name: string): string {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  return [sourceFile.getFilePath(), start.line, start.column, name].join(":");
}

export function parseStableNodeId(id: string): StableIdLocation | undefined {
  if (id.startsWith("external:")) return undefined;
  const match = id.match(/^(.*):(\d+):(\d+):([^:]*)$/);
  if (!match) return undefined;
  return {
    filePath: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    name: match[4],
  };
}
