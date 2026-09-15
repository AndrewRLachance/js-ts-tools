import { resolve } from "node:path";
import type {
  JsTsToolsTypeModel,
  JsTsToolsCallSite,
  JsTsToolsLocation,
  JsTsToolsResolvedType,
  JsTsToolsSignature,
  JsTsToolsSymbol,
} from "./js-ts-tools-type-model";
import type {
  SemanticCallSite,
  SemanticLocation,
  SemanticModelIndex,
  SemanticSignature,
  SemanticSymbol,
  SemanticType,
} from "../contracts/semantics";

/** Boundary retained for adapter substitution and focused testing. */
export interface TypeModelCallSiteBridge {
  extract(rawTypeModel: JsTsToolsTypeModel): readonly SemanticCallSite[];
}

/**
 * Exact adapter over the public JsTsToolsTypeModel contracts supplied by js-ts-tools.
 * No reflective field guessing is used.
 */
export class TypedTypeModelIndex implements SemanticModelIndex, TypeModelCallSiteBridge {
  readonly #model: JsTsToolsTypeModel;
  readonly #cwd: string;
  readonly #symbols = new Map<string, SemanticSymbol>();
  readonly #types = new Map<string, SemanticType>();
  readonly #signatures = new Map<string, SemanticSignature>();
  readonly #callSites = new Map<string, SemanticCallSite>();
  readonly #callSitesByLocation = new Map<string, SemanticCallSite[]>();

  constructor(model: JsTsToolsTypeModel, cwd: string) {
    this.#model = model;
    this.#cwd = cwd;

    for (const symbol of Object.values(model.symbols)) {
      this.#symbols.set(symbol.id, normalizeSymbol(symbol));
    }
    for (const type of Object.values(model.types)) {
      this.#types.set(type.id, normalizeType(type));
    }
    for (const signature of Object.values(model.signatures)) {
      this.#signatures.set(signature.id, normalizeSignature(signature));
    }
    for (const callSite of Object.values(model.callSites)) {
      const normalized = normalizeCallSite(callSite);
      this.#callSites.set(normalized.id, normalized);
      const key = this.#locationKey(normalized.location);
      const bucket = this.#callSitesByLocation.get(key) ?? [];
      bucket.push(normalized);
      this.#callSitesByLocation.set(key, bucket);
    }
  }

  extract(rawTypeModel: JsTsToolsTypeModel): readonly SemanticCallSite[] {
    if (rawTypeModel !== this.#model) {
      return new TypedTypeModelIndex(rawTypeModel, this.#cwd).allCallSites();
    }
    return this.allCallSites();
  }

  allCallSites(): readonly SemanticCallSite[] {
    return [...this.#callSites.values()];
  }

  symbol(id: string): SemanticSymbol | undefined {
    return this.#symbols.get(id);
  }

  type(id: string): SemanticType | undefined {
    return this.#types.get(id);
  }

  signature(id: string): SemanticSignature | undefined {
    return this.#signatures.get(id);
  }

  callSite(id: string): SemanticCallSite | undefined {
    return this.#callSites.get(id);
  }

  callSitesAt(location: SemanticLocation, kind?: SemanticCallSite["kind"]): readonly SemanticCallSite[] {
    const values = this.#callSitesByLocation.get(this.#locationKey(location)) ?? [];
    return kind === undefined ? values : values.filter((callSite) => callSite.kind === kind);
  }

  resolveAliasSymbol(id: string): SemanticSymbol | undefined {
    let current = this.symbol(id);
    const seen = new Set<string>();
    while (current?.aliasTargetId !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      current = this.symbol(current.aliasTargetId);
    }
    return current;
  }

  isEffectPackageSymbol(id: string, expectedName?: string): boolean {
    const symbol = this.resolveAliasSymbol(id);
    if (!symbol) return false;
    if (expectedName !== undefined && symbol.name !== expectedName) return false;
    return symbol.declarations.some((location) => isEffectPackagePath(this.#canonicalPath(location.filePath)));
  }

  isEffectModuleSymbol(id: string, moduleName: string, expectedName?: string): boolean {
    const symbol = this.resolveAliasSymbol(id);
    if (!symbol) return false;
    if (expectedName !== undefined && symbol.name !== expectedName) return false;
    return symbol.declarations.some((location) => {
      const path = this.#canonicalPath(location.filePath);
      return isEffectPackagePath(path) && isEffectModulePath(path, moduleName);
    });
  }

  isTypeScriptLibSymbol(id: string, expectedName?: string): boolean {
    const symbol = this.resolveAliasSymbol(id);
    if (!symbol) return false;
    if (expectedName !== undefined && symbol.name !== expectedName) return false;
    return symbol.declarations.some((location) => isTypeScriptLibPath(this.#canonicalPath(location.filePath)));
  }

  isEffectType(typeId: string): boolean {
    return this.#isEffectType(typeId, new Set());
  }

  callSiteCalleeIsEffectFunction(callSite: SemanticCallSite, expectedName: string): boolean {
    return callSite.resolution === "resolved"
      && callSite.calleeSymbolId !== undefined
      && this.isEffectModuleSymbol(callSite.calleeSymbolId, "Effect", expectedName);
  }

  callSiteResultIsEffect(callSite: SemanticCallSite): boolean {
    return this.isEffectType(callSite.resultTypeId);
  }

  callSiteResultIsEffectTransformer(callSite: SemanticCallSite): boolean {
    const raw = this.#model.types[callSite.resultTypeId];
    if (raw?.kind !== "object" || raw.callSignatures.length === 0) return false;
    return raw.callSignatures.every((id) => {
      const signature = this.#model.signatures[id];
      return signature?.parameters.length === 1
        && this.isEffectType(signature.parameters[0]!.type)
        && this.isEffectType(signature.returnType);
    });
  }

  #isEffectType(typeId: string, seen: Set<string>): boolean {
    if (seen.has(typeId)) return false;
    seen.add(typeId);

    const raw = this.#model.types[typeId];
    if (!raw) return false;

    if (raw.aliasSymbolId !== undefined && this.isEffectModuleSymbol(raw.aliasSymbolId, "Effect", "Effect")) {
      return true;
    }

    switch (raw.kind) {
      case "reference":
        return this.isEffectModuleSymbol(raw.symbolId, "Effect", "Effect") || this.#isEffectType(raw.target, seen);
      case "external":
        return this.isEffectModuleSymbol(raw.symbolId, "Effect", "Effect");
      case "object":
        return raw.symbolId !== undefined && this.isEffectModuleSymbol(raw.symbolId, "Effect", "Effect");
      case "intersection":
        return raw.types.some((member) => this.#isEffectType(member, seen));
      case "union":
        return raw.types.length > 0 && raw.types.every((member) => this.#isEffectType(member, new Set(seen)));
      case "typeParameter":
        return raw.constraint !== undefined && this.#isEffectType(raw.constraint, seen);
      case "substitution":
        return this.#isEffectType(raw.baseType, seen);
      default:
        return false;
    }
  }

  #canonicalPath(filePath: string): string {
    return resolve(this.#cwd, filePath).replaceAll("\\", "/");
  }

  #locationKey(location: SemanticLocation): string {
    return `${this.#canonicalPath(location.filePath)}:${location.line}:${location.column}`;
  }
}

function normalizeLocation(location: JsTsToolsLocation): SemanticLocation {
  return { filePath: location.filePath, line: location.line, column: location.column };
}

function normalizeSymbol(symbol: JsTsToolsSymbol): SemanticSymbol {
  return {
    id: symbol.id,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    flags: [...symbol.flags],
    external: symbol.external,
    declarations: symbol.declarations.map(normalizeLocation),
    ...(symbol.aliasTarget === undefined ? {} : { aliasTargetId: symbol.aliasTarget }),
    ...(symbol.declaredType === undefined ? {} : { declaredTypeId: symbol.declaredType }),
    ...(symbol.valueType === undefined ? {} : { valueTypeId: symbol.valueType }),
    raw: symbol,
  };
}

function normalizeType(type: JsTsToolsResolvedType): SemanticType {
  return {
    id: type.id,
    kind: type.kind,
    displayText: type.displayText,
    flags: [...type.flags],
    ...(type.aliasSymbolId === undefined ? {} : { aliasSymbolId: type.aliasSymbolId }),
    raw: type,
  };
}

function normalizeSignature(signature: JsTsToolsSignature): SemanticSignature {
  return {
    id: signature.id,
    kind: signature.kind,
    parameters: signature.parameters.map((parameter) => ({
      name: parameter.name,
      typeId: parameter.type,
      optional: parameter.optional,
      rest: parameter.rest,
      annotation: parameter.annotation,
    })),
    returnTypeId: signature.returnType,
    returnAnnotation: signature.returnAnnotation,
    raw: signature,
  };
}

function normalizeCallSite(callSite: JsTsToolsCallSite): SemanticCallSite {
  return {
    id: callSite.id,
    kind: callSite.kind,
    location: normalizeLocation(callSite.location),
    resolution: callSite.resolution,
    resultTypeId: callSite.resultType,
    ...(callSite.calleeSymbolId === undefined ? {} : { calleeSymbolId: callSite.calleeSymbolId }),
    ...(callSite.declarationSignatureId === undefined ? {} : { declarationSignatureId: callSite.declarationSignatureId }),
    ...(callSite.resolvedSignatureId === undefined ? {} : { resolvedSignatureId: callSite.resolvedSignatureId }),
    ...(callSite.genericInstantiation === undefined
      ? {}
      : {
          genericInstantiation: {
            complete: callSite.genericInstantiation.complete,
            bindings: callSite.genericInstantiation.bindings.map((binding) => ({
              parameterName: binding.parameterName,
              parameterTypeId: binding.parameterType,
              typeId: binding.type,
              source: binding.source,
            })),
          },
        }),
    raw: callSite,
  };
}

function isEffectPackagePath(filePath: string): boolean {
  return /\/node_modules\/effect\//u.test(filePath)
    || /\/node_modules\/.+\/node_modules\/effect\//u.test(filePath)
    || /\/packages\/effect\/(?:src|dist)\//u.test(filePath);
}

function isEffectModulePath(filePath: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`/(?:dist/(?:dts|cjs|esm)|src)/${escaped}(?:\\.d)?\\.(?:ts|mts|cts|js)$`, "u").test(filePath)
    || new RegExp(`/effect/${escaped}(?:\\.d)?\\.(?:ts|mts|cts|js)$`, "u").test(filePath);
}

function isTypeScriptLibPath(filePath: string): boolean {
  return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(filePath)
    || /\/node_modules\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(filePath);
}
