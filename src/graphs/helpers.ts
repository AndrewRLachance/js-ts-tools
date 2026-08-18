import {
    BinaryExpression,
    Identifier,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
} from "ts-morph";
import { CallGraph, SerializedCallGraphNode } from "./call-graph";

export function getNearestOwnerName(node: Node): string | undefined {
    const owner = getNearestOwnerNode(node);

    if (!owner) return undefined;

    return getOwnerName(owner);
}

export function getNearestOwnerNode(node: Node): Node | undefined {
    return node.getFirstAncestor((ancestor) =>
            Node.isFunctionDeclaration(ancestor) ||
            Node.isMethodDeclaration(ancestor) ||
            Node.isConstructorDeclaration(ancestor) ||
            Node.isGetAccessorDeclaration(ancestor) ||
            Node.isSetAccessorDeclaration(ancestor) ||
            Node.isArrowFunction(ancestor) ||
            Node.isFunctionExpression(ancestor),
        );
}

export function getOwnerName(node: Node): string | undefined {
    if (Node.isFunctionDeclaration(node)) {
        return node.getName();
    }

    if (Node.isMethodDeclaration(node)) {
        const className = node
            .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
            ?.getName();

        return className ? `${className}.${node.getName()}` : node.getName();
    }

    if (Node.isConstructorDeclaration(node)) {
        const className = node
            .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
            ?.getName();

        return className ? `${className}.constructor` : "constructor";
    }

    if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
        const className = node
            .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
            ?.getName();

        return className ? `${className}.${node.getName()}` : node.getName();
    }

    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        const parent = node.getParent();

        if (Node.isVariableDeclaration(parent)) {
            return parent.getName();
        }

        if (Node.isPropertyAssignment(parent)) {
            return parent.getName();
        }

        if (Node.isBinaryExpression(parent)) {
            return parent.getLeft().getText();
        }
    }

    return undefined;
}

export function getNodeLocation(node: Node) {
  const sourceFile = node.getSourceFile();

  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());

  return {
    filePath: sourceFile.getFilePath(),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}
