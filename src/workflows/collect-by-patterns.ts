import { generateAstXPathPattern, matchAstXPathPattern } from "../tools/ast-xpath"
import { searchGitHubPackageImports } from "../tools/github-js-ts-search"

const SOURCE_LIBRARY = 'effect'
const GITHUB_TOKEN = ''
const OUTPUT_DIRECTORY = ''


searchGitHubPackageImports({
    packages: [SOURCE_LIBRARY],
    token: GITHUB_TOKEN,
    outputDirectory: OUTPUT_DIRECTORY
}).then(result => result)

// /home/ai-developer/development/automated-development/sample-project/pdf-processor/repository/apps/workers/image-processor/src/ocr.ts

// ast-xpath generate \
//   --example /home/ai-developer/development/automated-development/sample-project/pdf-processor/repository/apps/workers/image-processor/src/ocr.ts \
//   --strictness exact \
//   --tsconfig /home/ai-developer/development/automated-development/sample-project/pdf-processor/repository/apps/workers/image-processor/tsconfig.json \
//   --out patterns/audit.json \
//   --xml-out patterns/audit.xml

// ast-xpath match \
//   --pattern patterns/audit.json \
//   --source "src/**/*.ts" \
//   --pretty