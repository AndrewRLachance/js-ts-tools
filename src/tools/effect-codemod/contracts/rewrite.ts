export interface TextReplacement {
  readonly filePath: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly reason: string;
}

export interface ImportRequirement {
  readonly moduleSpecifier: string;
  readonly importedName: string;
  readonly localName?: string;
  readonly typeOnly?: boolean;
}

export interface RewritePlan {
  readonly replacements: readonly TextReplacement[];
  readonly imports: readonly ImportRequirement[];
}

export interface PlannedFile {
  readonly filePath: string;
  readonly originalText: string;
  readonly editedText: string;
  readonly replacements: readonly TextReplacement[];
}
