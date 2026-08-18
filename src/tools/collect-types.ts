import { saveAssociatedTypes } from '../collection/emit-collected'
import { collectAssociatedTypes } from '../collection/type-collector'

/**
 * @example 
 collectAllTypes(
	['AbstractReasoningGraph'],
	'/home/ai-developer/development/automated-development/sample-project/pdf-processor/repository/packages/edi-document/tsconfig.json',
	'/home/ai-developer/development/automated-development/sample-project/pdf-processor/repository/packages/edi-document/src/blackboard/reasoning-graph.ts',
	'/home/ai-developer/development/automated-development/js-ts-tools/junk/some-types.ts'
)
	.then(() => console.log('done'))
	.catch((error: unknown) => {
		console.error(error)
		process.exitCode = 1
	})
 */
export async function collectAllTypes(
	sourceNames: string[],
	tsConfigFilePath: string,
	sourceFilePath: string,
	outputFilePath: string
): Promise<string> {
	const result = collectAssociatedTypes({
		names: sourceNames,
		tsConfigFilePath,
		sourceFilePath,

		// Keep this true if you want a genuinely self-contained closure for
		// dependencies such as type-fest's Tagged.
		includeNodeModules: true,

		// Do not copy Promise, Array, PropertyKey, etc. from lib.es*.d.ts.
		includeTypeScriptLibs: false
	})

	return await saveAssociatedTypes(result, outputFilePath, {
		banner: '/* Generated associated type closure. */'
	})
}
