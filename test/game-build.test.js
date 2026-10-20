'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { gameBuildFiles } = require('../scripts/game-build-files');

const root = path.join(__dirname, '..');
const workflow = name => YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'));

test('the game build follows the smoke scripts to everything they use', () => {
  const files = gameBuildFiles();
  for (const file of ['scripts/smoke-build-tools.js', 'scripts/smoke-mac-tools.js', 'scripts/smoke-eclipse.js',
    'scripts/tool-run.js', 'scripts/build-eclipse.sh', 'src/build-tools.js', 'src/port.js', 'src/game-version.js',
    'src/game-release.json', 'src/tool-assets.json', 'src/mac-tool-assets.json', 'src/windows-dlls.js',
    '.github/workflows/game-build.yml', 'package-lock.json'])
    assert.ok(files.includes(file), `${file} is part of the game build`);
  for (const file of ['src/renderer.js', 'src/main.js', 'src/index.html', 'src/style.css', 'changelog.json', 'README.md'])
    assert.ok(!files.includes(file), `${file} is not part of the game build`);
});

test('a pull request builds only when it changes a file the game build uses', () => {
  const decide = changed => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sms-game-build-')), 'output');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'game-build-files.js')],
      { input: changed.join('\n'), encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    const decision = fs.readFileSync(output, 'utf8');
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
    return decision;
  };
  assert.equal(decide(['src/style.css', 'changelog.json']), 'build=false\n');
  assert.equal(decide(['src/style.css', 'src/build-tools.js']), 'build=true\n');
  assert.equal(decide([]), 'build=false\n');
});

test('only the workflow\'s own pull requests skip compiles; release, Beta and sms-pc-port always build', () => {
  const build = workflow('game-build.yml');
  assert.match(build.jobs.changes.env.FILTER, /github\.event_name == 'pull_request'/);
  assert.match(build.jobs.changes.env.FILTER, /contains\(github\.workflow_ref, '\/\.github\/workflows\/game-build\.yml@'\)/);
  const compiles = Object.keys(build.jobs).filter(name => name.startsWith('compile-'));
  assert.deepEqual([...compiles].sort(), ['compile-eclipse', 'compile-mac-port', 'compile-port']);
  for (const name of compiles) {
    assert.equal(build.jobs[name].needs, 'changes');
    assert.equal(build.jobs[name].if, "needs.changes.outputs.build == 'true'");
  }
  assert.deepEqual(build.jobs['game-build'].needs, ['changes', ...compiles]);
  assert.equal(build.jobs['game-build'].name, 'Game build');
});

test('each compile job keeps its own compiler cache, saved only outside pull requests', () => {
  const build = workflow('game-build.yml');
  const caches = [];
  for (const [name, job] of Object.entries(build.jobs).filter(([name]) => name.startsWith('compile-'))) {
    caches.push(...job.strategy.matrix.include.map(entry => entry.cache));
    const save = job.steps.find(step => step.name === 'Save compiler cache');
    assert.ok(save, `${name} saves its cache`);
    assert.match(save.if, /github\.event_name != 'pull_request'/);
    const restore = job.steps.find(step => step.name === 'Restore compiler cache');
    assert.equal(restore.with.key, save.with.key);
    assert.equal(restore.with['restore-keys'], 'sccache-game-${{ matrix.cache }}-');
  }
  assert.equal(new Set(caches).size, caches.length, 'cache names are unique');
  for (const cache of caches) assert.ok(!caches.some(other => other !== cache && other.startsWith(`${cache}-`)),
    `no cache's restore prefix also matches another's (${cache})`);
});

test('releases and Beta publish only after the game builds', () => {
  const release = workflow('release.yml');
  assert.equal(release.jobs['verify-game'].uses, './.github/workflows/game-build.yml');
  assert.equal(release.jobs['verify-game'].with['launcher-ref'], '${{ needs.prepare.outputs.tag }}');
  assert.ok(release.jobs.publish.needs.includes('verify-game'));
  const build = workflow('build.yml');
  assert.equal(build.jobs['verify-game'].uses, './.github/workflows/game-build.yml');
  assert.equal(build.jobs['verify-game'].if, "needs.plan.outputs.channel == 'beta'");
  assert.equal(build.jobs['verify-game'].with['game-commit'], '${{ needs.plan.outputs.game }}');
  assert.ok(build.jobs.publish.needs.includes('verify-game'));
  assert.match(build.jobs.publish.if, /contains\(fromJSON\('\["success", "skipped"\]'\), needs\.verify-game\.result\)/);
});

test('pin-game points the game release at another commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-pin-game-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.copyFileSync(path.join(root, 'scripts', 'pin-game.js'), path.join(dir, 'scripts', 'pin-game.js'));
    const file = path.join(dir, 'src', 'game-release.json');
    fs.writeFileSync(file, JSON.stringify({ version: '1', repository: 'https://example.com/game.git', branch: 'main',
      commit: 'a'.repeat(40), decomp: 'b'.repeat(40) }));
    const pin = env => spawnSync(process.execPath, [path.join(dir, 'scripts', 'pin-game.js')],
      { encoding: 'utf8', env: { ...process.env, REPOSITORY: '', VERSION: '', ...env } });
    assert.equal(pin({ COMMIT: 'c'.repeat(40), DECOMP: 'd'.repeat(40) }).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 'ci', repository: 'https://example.com/game.git',
      branch: 'main', commit: 'c'.repeat(40), decomp: 'd'.repeat(40) });
    assert.notEqual(pin({ COMMIT: 'main', DECOMP: 'd'.repeat(40) }).status, 0);
    assert.equal(pin({ COMMIT: 'e'.repeat(40), DECOMP: 'f'.repeat(40), REPOSITORY: 'https://example.com/fork.git',
      VERSION: '2026.10.19-beta.eeeeeee' }).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: '2026.10.19-beta.eeeeeee',
      repository: 'https://example.com/fork.git', branch: 'main', commit: 'e'.repeat(40), decomp: 'f'.repeat(40) });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
