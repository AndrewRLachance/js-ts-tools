import type { PlannedFile } from "../contracts/rewrite";
import type { SemanticSnapshot } from "../contracts/semantics";
import type { OverlaySemanticPort, ProjectRequest, SourcePort, ValidationPort, ValidationResult } from "../contracts/services";
import { newDiagnostics } from "./diagnostics";
import { assertFresh } from "./transaction";

/** Validate all proposed edits in one isolated semantic snapshot; never write source files. */
export class InMemoryValidationPort implements ValidationPort {
  constructor(private readonly source: SourcePort, private readonly semantics: OverlaySemanticPort) {}

  validate(request: ProjectRequest, files: readonly PlannedFile[], baseline: SemanticSnapshot): ValidationResult {
    const changed = files.filter((file) => file.originalText !== file.editedText);
    assertFresh(changed, this.source);
    const resulting = changed.length
      ? this.semantics.snapshotWithOverrides(request, new Map(changed.map((file) => [file.filePath, file.editedText])))
      : baseline;
    assertFresh(changed, this.source);
    const added = newDiagnostics(baseline.diagnostics, resulting.diagnostics);
    return {
      ok: added.length === 0,
      baselineDiagnostics: baseline.diagnostics,
      resultingDiagnostics: resulting.diagnostics,
      newDiagnostics: added,
    };
  }
}
