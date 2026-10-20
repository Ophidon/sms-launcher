'use strict';

// The files the game build check (.github/workflows/game-build.yml) depends on:
// the smoke scripts and everything they load, found by following their relative
// requires and the scripts they name (scripts/build-eclipse.sh). A pull request
// that changes none of them cannot change how the game builds, so its check
// skips the compiles. Given changed files on stdin, says whether to build.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENTRY = ['scripts/smoke-build-tools.js', 'scripts/smoke-mac-tools.js', 'scripts/smoke-eclipse.js'];
// Not loaded by the scripts, but part of the check all the same.
const ALWAYS = ['.github/workflows/game-build.yml', 'scripts/game-build-files.js', 'package-lock.json'];

function gameBuildFiles(root = ROOT) {
  const named = new Map();
  for (const dir of ['src', 'scripts']) {
    for (const name of fs.readdirSync(path.join(root, dir))) named.set(name, [...named.get(name) || [], `${dir}/${name}`]);
  }
  const found = new Set();
  const pending = [...ENTRY];
  while (pending.length) {
    const file = pending.pop();
    if (found.has(file) || !isFile(root, file)) continue;
    found.add(file);
    if (!file.endsWith('.js')) continue;
    // Any string naming a file is followed, required or not: building for a
    // change that turns out not to matter costs minutes, missing one costs a release.
    for (const [, literal] of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/['"`]([^'"`\s]+)['"`]/g)) {
      if (/^\.\.?\//.test(literal)) pending.push(...resolve(root, path.posix.dirname(file), literal));
      else if (/\.(js|json|sh|py)$/.test(literal)) pending.push(...named.get(literal) || []);
    }
  }
  return [...new Set([...ALWAYS, ...found])].sort();
}

function resolve(root, dir, request) {
  const base = path.posix.join(dir, request);
  if (base.startsWith('..')) return [];
  const file = [base, `${base}.js`, `${base}.json`, `${base}/index.js`].find(candidate => isFile(root, candidate));
  return file ? [file] : [];
}

function isFile(root, file) {
  try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; }
}

if (require.main === module) {
  const files = new Set(gameBuildFiles());
  const changed = fs.readFileSync(0, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  const used = changed.filter(file => files.has(file));
  process.stdout.write(used.length
    ? `Changes what the game build uses:\n  ${used.join('\n  ')}\n`
    : `None of the ${changed.length} changed files is used by the game build.\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${used.length > 0}\n`);
}

module.exports = { gameBuildFiles };
