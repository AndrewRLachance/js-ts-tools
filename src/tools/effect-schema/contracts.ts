export interface EffectSchemaSessionOptions {
  cwd?: string;
  tsconfig?: string;
  /** Timeout for each server request; defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface EffectSchemaLocation { line: number; column: number }

export interface EffectSchemaCandidate {
  id: string;
  filePath: string;
  name: string;
  qualifiedName: string;
  kind: "interface" | "type";
  generic: boolean;
  /** Position of the declaration name, using 1-based UTF-16 coordinates. */
  line: number;
  column: number;
  range: { start: EffectSchemaLocation; end: EffectSchemaLocation };
}

export interface EffectSchemaCandidateQuery { filePath?: string; search?: string }

export interface EffectSchemaDiagnostic {
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
  message: string;
  filePath?: string;
  start?: number;
  length?: number;
  line?: number;
  column?: number;
}

export interface EffectSchemaValidation {
  ok: boolean;
  baselineDiagnostics: EffectSchemaDiagnostic[];
  resultingDiagnostics: EffectSchemaDiagnostic[];
  newErrors: EffectSchemaDiagnostic[];
}

export interface EffectSchemaTextEdit { start: number; end: number; replacement: string }

export interface EffectSchemaFileChange {
  filePath: string;
  originalText: string;
  editedText: string;
  edits: EffectSchemaTextEdit[];
}

export interface EffectSchemaPreview {
  id: string;
  candidate: EffectSchemaCandidate;
  available: boolean;
  reason?: string;
  refactorName?: string;
  actionName?: string;
  files: EffectSchemaFileChange[];
  diff: string;
  validation: EffectSchemaValidation | null;
}

export interface EffectSchemaApplyResult { written: boolean; filePaths: string[] }

export interface EffectSchemaSession {
  readonly project: { cwd: string; tsconfig: string; typescriptVersion: string; pluginVersion: string };
  listCandidates(query?: EffectSchemaCandidateQuery): Promise<EffectSchemaCandidate[]>;
  preview(candidateId: string): Promise<EffectSchemaPreview>;
  apply(previewId: string): Promise<EffectSchemaApplyResult>;
  close(): Promise<void>;
}
