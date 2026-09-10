#!/usr/bin/env node
"use strict";

const api = require("../dist/tools/convert-ts-pattern-cli");

if (require.main === module) process.exitCode = api.mainConvertTsPattern();

module.exports = api;
