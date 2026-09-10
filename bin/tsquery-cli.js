#!/usr/bin/env node
"use strict";

const { main, run, globToRegExp, coalesceDeleteEdits, collectMatches, applyTextEdits, parseArgs, HELP } = require('../dist/tools/tsquery-cli');

if (require.main === module) process.exitCode = main();

module.exports = { main, run, globToRegExp, coalesceDeleteEdits, collectMatches, applyTextEdits, parseArgs, HELP };
