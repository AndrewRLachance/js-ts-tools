import { readFileSync, writeFileSync } from "node:fs";
import type { SourcePort } from "../contracts/services";

export class NodeSourcePort implements SourcePort {
  read(filePath: string): string {
    return readFileSync(filePath, "utf8");
  }

  write(filePath: string, text: string): void {
    writeFileSync(filePath, text, "utf8");
  }
}
