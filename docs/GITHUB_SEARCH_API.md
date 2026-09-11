# github-import-search

Search GitHub for JavaScript/TypeScript files mentioning one or more npm
packages, validate their module references with the TypeScript parser, and save
immutable copies of matching blobs.

Requires Node.js 24.12+ and a GitHub access token.

```bash
export GITHUB_TOKEN=github_pat_...
npm run build
./bin/github-js-ts-search-cli.js lodash @tanstack/react-query
```

After installing or linking the package, use the installed command:

```bash
github-js-ts-search lodash @tanstack/react-query
```

Matching files are written under:

```text
downloads/files/<owner>/<repo>/<blob SHA>/<original path>
```

Use `--out`, or set `OUT_DIR`, to change the destination. The flag takes
precedence over the environment variable.

```bash
OUT_DIR=corpus github-js-ts-search lodash
github-js-ts-search --out corpus lodash
```

Every successful run atomically replaces `<output>/manifest.json`. The manifest
contains the exact saved blobs, detected references, per-query counts, and any
incomplete or truncated search status. Existing blob snapshots are not removed.

Recognized forms include:

```ts
import x from "pkg";
import { x } from "pkg/subpath";
import type { X } from "pkg";
import "pkg";
import pkg = require("pkg");
const x = require("pkg");
```

Dynamic imports and re-exports such as `export { x } from "pkg"` are
intentionally ignored.

## GitHub search limits

GitHub code search only considers indexed files on default branches, limits the
repositories and file sizes considered, and exposes at most 1,000 results per
query. This tool divides searches by extension, but it cannot guarantee an
exhaustive GitHub-wide corpus. Capped or incomplete queries are retained and
marked in the manifest and CLI warnings.
