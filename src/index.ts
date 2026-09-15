export { buildGraphs } from './tools/graph-api'
export { analyzeCodeImpact } from './tools/code-impact'
export { createCodeSlice, formatCodeSlice } from './tools/code-slice'
export { createContextPack, estimateContextPackTokens, formatContextPack } from './tools/context-pack'

export type { SourceOptions, TargetOptions } from './tools/graph-api'
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
	RankedContextSeed
} from './tools/context-pack'
export type {
	AnalyzeCodeImpactOptions,
	ImpactDirection,
	ImpactNode,
	ImpactPath,
	ImpactPathStep,
	ImpactRelation,
	ImpactReport,
	ImpactedNode
} from './tools/code-impact'
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
	SliceSnippet
} from './tools/code-slice'
export { detectPatternsFromSources, patternKeys } from './tools/code-patterns'
export type { DetectPatternsFromSourcesOptions } from './tools/code-patterns'
export { collectAssociatedTypes } from './collection/type-collector'
export type { CollectAssociatedTypesOptions, CollectAssociatedTypesResult } from './collection/type-collector'
export { formatAssociatedTypes, saveAssociatedTypes } from './collection/emit-collected'
export type { SaveAssociatedTypesOptions } from './collection/emit-collected'
export { extractTypeModel } from './tools/type-model'
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
	TypeModelV3
} from './tools/type-model'
export {
	ExactDeclarationUnavailableError,
	generateTypeDeclarationsFromModel,
	saveTypeDeclarationsFromModel
} from './tools/type-model-declarations'
export type {
	GenerateTypeDeclarationsOptions,
	GeneratedTypeDeclarations,
	SavedTypeDeclarations,
	TypeModelDeclarationDiagnostic
} from './tools/type-model-declarations'
export {
	DEFAULT_IGNORE,
	createFromJsonFile,
	createStructure,
	extractStructure,
	readStructureFile,
	structureToJson,
	writeStructureFile
} from './tools/create-project'

export type {
	CreateFromJsonFileResult,
	CreateStructureOptions,
	ExtractStructureOptions,
	ProjectStructure,
	ProjectStructureValue,
	WriteStructureFileResult
} from './tools/create-project'
export { findPackageReferences, importsAnyPackage, searchGitHubPackageImports } from './tools/github-js-ts-search'
export type {
	GitHubPackageImportMatch,
	GitHubPackageImportQueryStatus,
	GitHubPackageImportSearchReport,
	PackageReference,
	PackageReferenceKind,
	SearchGitHubPackageImportsOptions
} from './tools/github-js-ts-search'

export type {
  OutputFormat,
  MutationAction,
  CliOptions,
  MatchLocation,
  MatchRecord,
  MutationFileReport,
  MutationReport
} from './tools/tsquery-cli'

export {
	main,
	run,
	globToRegExp,
	coalesceDeleteEdits,
	collectMatches,
	applyTextEdits,
	parseArgs,
	HELP
} from './tools/tsquery-cli'

export { DEFAULT_MAX_CONTINUATION_BYTES, convertTsPattern } from './tools/convert-ts-pattern'
export type {
	ConvertTsPatternOptions,
	TsPatternCandidateKind,
	TsPatternCandidateReport,
	TsPatternConversionReport,
	TsPatternFallbackKind,
	TsPatternFileReport,
	TsPatternLocation,
	TsPatternSkipReason,
	TsPatternValidationDiagnostic
} from './tools/convert-ts-pattern'

export {
	AST_XPATH_PATTERN_SCHEMA_VERSION,
	AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION,
	AST_XPATH_VERSION,
	AST_XPATH_XML_SCHEMA_VERSION,
	generateAstXPathPattern,
	matchAstXPathPattern,
	readAstXPathPattern,
	runAstXPath,
	serializeAstToXml
} from './tools/ast-xpath'
export type {
	AstXPathDiagnostic,
	AstXPathIgnoredRange,
	AstXPathLocation,
	AstXPathMatch,
	AstXPathMatchReport,
	AstXPathMatchSummary,
	AstXPathPattern,
	AstXPathPatternV1,
	AstXPathPatternV2,
	AstXPathRange,
	AstXPathSemanticMode,
	AstXPathSemanticFact,
	AstXPathSignatureParameterFact,
	AstXPathSymbolIdentity,
	AstXPathTemplateField,
	AstXPathTemplateGap,
	AstXPathTemplateNode,
	AstXPathStrictness,
	GenerateAstXPathPatternOptions,
	GeneratedAstXPathPattern,
	MatchAstXPathPatternOptions,
	RunAstXPathOptions
} from './tools/ast-xpath'
export {
	AST_XPATH_HELP,
	formatAstXPathReport,
	mainAstXPath,
	parseAstXPathArgs,
	runAstXPathCli
} from './tools/ast-xpath-cli'
export type {
	AstXPathCliOptions,
	AstXPathOutputFormat
} from './tools/ast-xpath-cli'

export { convertConditionalToEffectSchemaV3 } from './tools/conditional-to-effect-schema-v3'
export type {
  ConversionMode,
  ConversionDiagnostic,
  ThrowConstraint,
  ConvertConditionalToEffectSchemaV3Options,
  ConvertConditionalToEffectSchemaV3Result,
} from './tools/conditional-to-effect-schema-v3'

export { runEffectCodemod } from './tools/effect-v3-codemod'
export type { EffectCodemodOptions, EffectCodemodReport } from './tools/effect-v3-codemod'
export type { EffectTarget } from './tools/effect-codemod/contracts/effect-target'
export * as effectCodemod from './tools/effect-codemod'

export { createEffectSchemaSession } from './tools/effect-schema'
export type * from './tools/effect-schema/contracts'
export { EFFECT_SCHEMA_HELP, parseEffectSchemaArgs, mainEffectSchema } from './tools/effect-schema-cli'
export type { EffectSchemaCliOptions, EffectSchemaCliIO } from './tools/effect-schema-cli'

export { createCodeAnalysisSession } from "./tools/code-analysis-session";
export type { CodeAnalysisSession, CodeAnalysisSessionOptions, AnalysisRange } from "./tools/code-analysis-session";
export { ts as analysisTypeScript } from "ts-morph";
