#!/usr/bin/env node
"use strict";

const api = require("../dist/tools/conditional-to-effect-schema-v3-cli");

if (require.main === module) process.exitCode = api.mainConditionalToEffectSchemaV3();

module.exports = api;
