import type * as ts from "typescript";
import type { ImportRequirement } from "./rewrite";
import type { CallExpressionLike } from "../core/ts-syntax";

export interface NormalizedCall {
  readonly original: ts.CallExpression;
  readonly call: CallExpressionLike;
  readonly operator: string;
  readonly dataLast: boolean;
}

/** Compiler-backed capabilities for the current, immutable source version. */
export interface SyntaxAnalysis {
  readonly checker: ts.TypeChecker;
  readonly selectedFiles: ReadonlySet<string>;
  operator(node: ts.Node): string | undefined;
  effectResult(node: ts.Expression): boolean;
  normalize(node: ts.CallExpression): NormalizedCall | undefined;
  effectReference(node: ts.Node): { text: string; imports: readonly ImportRequirement[] };
  helperResult(node: ts.CallExpression): HelperResult;
  checkRewrite?(filePath: string, start: number, end: number, text: string, imports: readonly ImportRequirement[]): readonly string[];
}

export type HelperResult =
  | { readonly kind: "resolved"; readonly operator: "succeed" | "fail"; readonly value: string; readonly helpers: readonly string[] }
  | { readonly kind: "unproven" | "analysis-limit"; readonly reason: string };
