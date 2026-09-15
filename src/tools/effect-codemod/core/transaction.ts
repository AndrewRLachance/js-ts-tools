import type { PlannedFile } from "../contracts/rewrite";
import type {
  ProjectRequest,
  SemanticPort,
  SourcePort,
  ValidationPort,
  ValidationResult,
} from "../contracts/services";
import type { SemanticSnapshot } from "../contracts/semantics";
import { newDiagnostics } from "./diagnostics";

export class StaleSourceError extends Error {
  constructor(readonly filePath: string) {
    super(`Source changed after planning: ${filePath}`);
    this.name = "StaleSourceError";
  }
}

export class SourceRestoreError extends Error {
  constructor(readonly filePath: string) {
    super(`Failed to restore source after transactional validation: ${filePath}`);
    this.name = "SourceRestoreError";
  }
}

/**
 * Compatibility validator for custom semantic adapters without overlay support.
 * The production pipeline uses InMemoryValidationPort instead.
 */
export class TransactionalValidationPort implements ValidationPort {
  readonly #source: SourcePort;
  readonly #semantics: SemanticPort;

  constructor(source: SourcePort, semantics: SemanticPort) {
    this.#source = source;
    this.#semantics = semantics;
  }

  validate(
    request: ProjectRequest,
    files: readonly PlannedFile[],
    baseline: SemanticSnapshot,
  ): ValidationResult {
    const changed = files.filter((file) => file.originalText !== file.editedText);
    if (changed.length === 0) {
      return {
        ok: true,
        baselineDiagnostics: baseline.diagnostics,
        resultingDiagnostics: baseline.diagnostics,
        newDiagnostics: [],
      };
    }

    assertFresh(changed, this.#source);

    const staged: PlannedFile[] = [];
    let resulting: SemanticSnapshot | undefined;
    let thrown: unknown;

    try {
      for (const file of changed) {
        // Track before writing so a SourcePort that throws after a partial write
        // is still restored in finally.
        staged.push(file);
        this.#source.write(file.filePath, file.editedText);
      }
      resulting = this.#semantics.snapshot(request);
    } catch (error) {
      thrown = error;
    } finally {
      let restoreFailure: unknown;
      for (const file of [...staged].reverse()) {
        try {
          this.#source.write(file.filePath, file.originalText);
        } catch (error) {
          restoreFailure ??= error;
        }
      }

      for (const file of staged) {
        try {
          if (this.#source.read(file.filePath) !== file.originalText) {
            restoreFailure ??= new SourceRestoreError(file.filePath);
          }
        } catch (error) {
          restoreFailure ??= error;
        }
      }

      if (restoreFailure !== undefined) throw restoreFailure;
    }

    if (thrown !== undefined) throw thrown;
    if (!resulting) throw new Error("Transactional validation produced no semantic snapshot");

    const added = newDiagnostics(baseline.diagnostics, resulting.diagnostics);
    return {
      ok: added.length === 0,
      baselineDiagnostics: baseline.diagnostics,
      resultingDiagnostics: resulting.diagnostics,
      newDiagnostics: added,
    };
  }
}

export function commitPlannedFiles(files: readonly PlannedFile[], source: SourcePort): boolean {
  const changed = files.filter((file) => file.originalText !== file.editedText);
  if (changed.length === 0) return false;

  assertFresh(changed, source);
  const written: PlannedFile[] = [];
  try {
    for (const file of changed) {
      assertFresh([file], source);
      // Track before writing for the same partial-write safety as validation.
      written.push(file);
      source.write(file.filePath, file.editedText);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const file of [...written].reverse()) {
      try {
        source.write(file.filePath, file.originalText);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    for (const file of written) {
      try {
        if (source.read(file.filePath) !== file.originalText) failures.push(new SourceRestoreError(file.filePath));
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Commit failed and source rollback was incomplete.");
    throw error;
  }
  return true;
}

export function assertFresh(files: readonly PlannedFile[], source: SourcePort): void {
  for (const file of files) {
    if (source.read(file.filePath) !== file.originalText) {
      throw new StaleSourceError(file.filePath);
    }
  }
}
