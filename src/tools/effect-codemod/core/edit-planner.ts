import type { EditPort, SourcePort } from "../contracts/services";
import type { PlannedFile, TextReplacement } from "../contracts/rewrite";

function assertNonOverlapping(replacements: readonly TextReplacement[]): void {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = -1;
  for (const edit of sorted) {
    if (edit.start < previousEnd) {
      throw new Error(`Overlapping replacements in ${edit.filePath} near offset ${edit.start}`);
    }
    if (edit.start < 0 || edit.end < edit.start) {
      throw new Error(`Invalid replacement range in ${edit.filePath}: ${edit.start}..${edit.end}`);
    }
    previousEnd = edit.end;
  }
}

export function planFiles(
  replacements: readonly TextReplacement[],
  source: SourcePort,
  editor: EditPort,
): readonly PlannedFile[] {
  const byFile = new Map<string, TextReplacement[]>();
  for (const replacement of replacements) {
    const bucket = byFile.get(replacement.filePath) ?? [];
    bucket.push(replacement);
    byFile.set(replacement.filePath, bucket);
  }

  return [...byFile.entries()].map(([filePath, fileReplacements]) => {
    assertNonOverlapping(fileReplacements);
    const originalText = source.read(filePath);
    const editedText = editor.apply(originalText, fileReplacements);
    return { filePath, originalText, editedText, replacements: fileReplacements };
  });
}
