#!/usr/bin/env node
"use strict";

const api = require("../dist/tools/effect-schema-cli");
if (require.main === module) {
  api.mainEffectSchema().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`effect-schema: ${error.message}\n`);
    process.exitCode = 1;
  });
}
module.exports = api;
