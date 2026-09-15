export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly filePath: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface SyntaxCandidate extends SourceRange {
  readonly id: string;
  readonly selectorId: string;
  readonly kind: string;
  readonly text: string;
  /** Adapter-owned AST handle. Rules must treat this as opaque. */
  readonly nativeNode?: unknown;
}

export interface ExtractedExpression extends SourceRange {
  readonly text: string;
}
