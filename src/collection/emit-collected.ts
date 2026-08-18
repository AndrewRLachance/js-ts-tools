import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  Node,
  type VariableStatement
} from 'ts-morph'
import {
  type CollectedDeclaration,
  type CollectAssociatedTypesResult
} from './type-collector'

export interface SaveAssociatedTypesOptions {
  /**
   * Optional generated-file banner.
   */
  banner?: string
}

/**
 * Formats a collected type closure without performing any I/O.
 */
export function formatAssociatedTypes(
  result: CollectAssociatedTypesResult,
  options: SaveAssociatedTypesOptions = {}
): string {
  const body = result.declarations
    .map(getCollectedDeclarationText)
    .filter((text) => text.length > 0)
    .join('\n\n')

  const sections: string[] = []

  if (options.banner?.trim()) {
    sections.push(options.banner.trim())
  }

  sections.push(body)

  return `${sections.join('\n\n').trim()}\n`
}

/**
 * Writes the collected dependency closure using the declarations' original
 * source text.
 *
 * This intentionally does NOT use:
 *
 *   declaration.getStructure()
 *   SourceFile.fixMissingImports()
 *   SourceFile.organizeImports()
 *
 * Reconstructing or code-fixing the AST is unnecessary here and was the source
 * of the ts-morph ManipulationError in the previous implementation.
 */
export async function saveAssociatedTypes(
  result: CollectAssociatedTypesResult,
  outputFilePath: string,
  options: SaveAssociatedTypesOptions = {}
): Promise<string> {
  const absoluteOutputPath = path.resolve(outputFilePath)
  const outputText = formatAssociatedTypes(result, options)

  await mkdir(path.dirname(absoluteOutputPath), {
    recursive: true
  })

  await writeFile(absoluteOutputPath, outputText, 'utf8')

  return absoluteOutputPath
}

function getCollectedDeclarationText(
  declaration: CollectedDeclaration
): string {
  /*
   * Collected unique-symbol support is stored as a VariableStatement already,
   * so getFullText() produces the complete:
   *
   *   declare const taggedType: unique symbol;
   *
   * statement rather than only the VariableDeclaration fragment.
   */
  if (Node.isVariableStatement(declaration)) {
    return getVariableStatementText(declaration)
  }

  return declaration.getFullText().trim()
}

function getVariableStatementText(statement: VariableStatement): string {
  return statement.getFullText().trim()
}
