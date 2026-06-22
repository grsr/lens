'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { read }      = require('./reader.js');
const { expand }    = require('./expander.js');
const { lower }     = require('./lowerer.js');
const { schedule }  = require('./scheduler.js');
const { encode }    = require('./snapshot.js');

// REPO points at the loupe repo root so prelude.loupe and patches/ resolve consistently.
const REPO = path.resolve(__dirname, '..');

function loadFile(rel) {
  const full = path.isAbsolute(rel) ? rel : path.join(REPO, rel);
  return fs.readFileSync(full, 'utf8');
}

function compile(patchPath) {
  const text     = loadFile(patchPath);
  const ast      = read(text);
  const expanded = expand(ast, { loadFile });
  const lowered  = lower(expanded);
  const scheduled = schedule(lowered);
  const snapshot  = encode(scheduled, lowered);
  return { snapshot, expanded, lowered, scheduled };
}

module.exports = { compile, loadFile };
