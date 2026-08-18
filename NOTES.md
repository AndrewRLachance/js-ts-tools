After building make sure you ```npm link```.

TODOs:
1. Turn into multi-tool CLI
2. Create module version
3. Allow memgraph graph generation to be incremental (takes too long atm)
4. create memgraph API


Build/Run Flow:
- npm run build

Local:
- npm link
- context-pack --source "src/**/*.ts" --task "repair request validation"
- context-pack --source "src/**/*.ts" --task-file task.md --symbol Example.run --format json --pretty
- code-impact --source "src/**/*.ts" --symbol Example.run --pretty
- code-slice --source "src/**/*.ts" --symbol Example.run --pretty
- code-slice --source "src/**/*.ts" --at src/example.ts:47 --format markdown
- code-patterns --source "src/**/*.ts" --min-confidence medium --pretty
- collect-types --name Example --source src/types.ts --out generated/types.ts
- json-jspath
- code-graph
- create-project

chmod +x bin/*.js
