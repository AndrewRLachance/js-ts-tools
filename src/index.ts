export { buildGraphs } from "./tools/graph-api";
export type { SourceOptions, TargetOptions } from "./tools/graph-api";
export {
  createContextPack,
  estimateContextPackTokens,
  formatContextPack,
} from "./tools/context-pack";
export type {
  ContextChunkKind,
  ContextOmission,
  ContextPackFormat,
  ContextPackReport,
  ContextPackSeed,
  ContextSeedOrigin,
  ContextTextChunk,
  CreateContextPackOptions,
  FormatContextPackOptions,
  RankedContextSeed,
} from "./tools/context-pack";
export { analyzeCodeImpact } from "./tools/code-impact";
export type {
  AnalyzeCodeImpactOptions,
  ImpactDirection,
  ImpactNode,
  ImpactPath,
  ImpactPathStep,
  ImpactRelation,
  ImpactReport,
  ImpactedNode,
} from "./tools/code-impact";
export { createCodeSlice, formatCodeSlice } from "./tools/code-slice";
export type {
  CodeSliceFormat,
  CodeSliceLocation,
  CodeSliceReport,
  CreateCodeSliceOptions,
  FormatCodeSliceOptions,
  SliceBoundary,
  SliceFile,
  SliceImport,
  SlicePath,
  SlicePathKind,
  SlicePathStep,
  SliceRelation,
  SliceRole,
  SliceSelection,
  SliceSnippet,
} from "./tools/code-slice";
export {
  detectPatternsFromSources,
  patternKeys,
} from "./tools/code-patterns";
export type {
  DetectPatternsFromSourcesOptions,
} from "./tools/code-patterns";
export { collectAssociatedTypes } from "./collection/type-collector";
export type {
  CollectAssociatedTypesOptions,
  CollectAssociatedTypesResult,
} from "./collection/type-collector";
export {
  formatAssociatedTypes,
  saveAssociatedTypes,
} from "./collection/emit-collected";
export type { SaveAssociatedTypesOptions } from "./collection/emit-collected";
export { extractTypeModel } from "./tools/type-model";
export type {
  ExtractTypeModelOptions,
  TypeModel,
  TypeModelCallSite,
  TypeModelCallSiteKind,
  TypeModelCallSiteRef,
  TypeModelConditionalType,
  TypeModelDiagnostic,
  TypeModelDeclarationBundle,
  TypeModelExport,
  TypeModelGenericBinding,
  TypeModelGenericInstantiation,
  TypeModelJSDocComment,
  TypeModelIndexedAccessType,
  TypeModelKeyofType,
  TypeModelLocation,
  TypeModelMappedModifier,
  TypeModelMappedType,
  TypeModelModule,
  TypeModelModuleBase,
  TypeModelModuleV2,
  TypeModelModuleV3,
  TypeModelParameter,
  TypeModelProperty,
  TypeModelProject,
  TypeModelResolvedType,
  TypeModelScope,
  TypeModelSignature,
  TypeModelSignatureRef,
  TypeModelSymbol,
  TypeModelSymbolRef,
  TypeModelStringMappingType,
  TypeModelSubstitutionType,
  TypeModelTemplateLiteralType,
  TypeModelTupleElement,
  TypeModelTypeBase,
  TypeModelTypeParameter,
  TypeModelTypeRef,
  TypeModelV2,
  TypeModelV3,
} from "./tools/type-model";
export {
  generateTypeDeclarationsFromModel,
  saveTypeDeclarationsFromModel,
} from "./tools/type-model-declarations";
export type {
  GenerateTypeDeclarationsOptions,
  GeneratedTypeDeclarations,
  SavedTypeDeclarations,
  TypeModelDeclarationDiagnostic,
} from "./tools/type-model-declarations";
export {
  DEFAULT_IGNORE,
  createFromJsonFile,
  createStructure,
  extractStructure,
  readStructureFile,
  structureToJson,
  writeStructureFile,
} from "./tools/create-project";

export type {
  CreateFromJsonFileResult,
  CreateStructureOptions,
  ExtractStructureOptions,
  ProjectStructure,
  ProjectStructureValue,
  WriteStructureFileResult,
} from "./tools/create-project";
export {
  findPackageReferences,
  importsAnyPackage,
  searchGitHubPackageImports,
} from "./tools/github-js-ts-search";
export type {
  GitHubPackageImportMatch,
  GitHubPackageImportQueryStatus,
  GitHubPackageImportSearchReport,
  PackageReference,
  PackageReferenceKind,
  SearchGitHubPackageImportsOptions,
} from "./tools/github-js-ts-search";
