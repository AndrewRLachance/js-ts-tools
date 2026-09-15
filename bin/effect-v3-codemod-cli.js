#!/usr/bin/env node
"use strict";

const api = require("../dist/tools/effect-v3-codemod-cli");

if (require.main === module) process.exitCode = api.mainEffectCodemod();

module.exports = api;
