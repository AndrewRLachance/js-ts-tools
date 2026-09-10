#!/usr/bin/env node
"use strict";

const {
  AST_XPATH_HELP,
  formatAstXPathReport,
  mainAstXPath,
  parseAstXPathArgs,
  runAstXPathCli,
} = require("../dist/tools/ast-xpath-cli");

if (require.main === module) process.exitCode = mainAstXPath();

module.exports = {
  AST_XPATH_HELP,
  formatAstXPathReport,
  mainAstXPath,
  parseAstXPathArgs,
  runAstXPathCli,
};
