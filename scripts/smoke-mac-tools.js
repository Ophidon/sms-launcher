'use strict';

// No ROM, game data, or compiled executable is uploaded by this test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const buildTools = require('../src/build-tools');
const port = require('../src/port');
const game = require('../src/game-version');
const { execFileSync } = require('node:child_process');
const capture = async (command, args, cwd, env) => execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim();
const { run, runMain } = require('./tool-run');

// SMS_SMOKE_ARCHES: the game builds to compile, 64 (x86_64, run by Rosetta on
// Apple Silicon; the default) and/or arm64 (the Apple Silicon build).
const ARCHES = (process.env.SMS_SMOKE_ARCHES || '64').split(',').map(arch => arch.trim()).filter(Boolean);

async function main() {
  if (process.platform !== 'darwin') throw new Error('Run this smoke test on macOS.');
  for (const arch of ARCHES)
    if (!['64', 'arm64'].includes(arch) || arch === 'arm64' && process.arch !== 'arm64')
      throw new Error(`This Mac cannot build the ${arch} game.`);
  // Reproduce an app opened from Finder, without Homebrew's shell initialization.
  const finder = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  delete finder.HOMEBREW_PREFIX;
  delete finder.CC;
  delete finder.CXX;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sms Mac tools ci-'));
  try {
    const manifestFile = process.env.SMS_TOOL_ASSET_MANIFEST;
    const generated = manifestFile ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
    const source = generated?.platforms[process.arch] || null;
    if (source) {
      source.toolset ||= generated.toolset;
      require('../src/mac-tool-assets.json').platforms[process.arch] = source;
    }
    const archiveFile = source ? path.join(path.dirname(manifestFile), source.name) : null;
    const rosetta = ARCHES.includes('64');
    await buildTools.prepare(userData, { forcePrivate: true, run, source, archiveFile, archives: true, rosetta,
      progress(percent, detail) { if (detail) process.stdout.write(`${detail}\n`); }
    });
    const report = await buildTools.check(userData, { env: finder, refresh: true, archives: true, rosetta });
    if (!report.ready || report.mode !== 'private') throw new Error(report.message);
    process.stdout.write(`Private Mac preflight passed with Finder's PATH: ${finder.PATH}\n`);
    if (ARCHES.includes('arm64')) checkLlvm(userData, finder);
    const root = path.join(userData, 'port');
    {
      const env = buildTools.environment(userData, finder);
      env.PATH = `${env.SMS_BUILD_TOOLS_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`;
      await game.checkout(root, { run, capture, env });
    }
    for (const arch of ARCHES) {
      if (arch === 'arm64' && !fs.existsSync(path.join(root, 'tools', 'gameptr'))) {
        process.stdout.write('This game version has no Apple Silicon build yet; skipping arm64.\n');
        continue;
      }
      const env = buildTools.environment(userData, { ...finder, SMS_ARCH: arch });
      env.PATH = `${env.SMS_BUILD_TOOLS_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`;
      await compile(root, arch, env, userData);
    }
  } finally { fs.rmSync(userData, { recursive: true, force: true }); }
}

// The Apple Silicon game's compiler links a program, whatever the game version
// (an older one skips the arm64 build below): Apple's linker is particular
// about the libLTO.dylib clang names.
function checkLlvm(userData, finder) {
  const env = buildTools.environment(userData, { ...finder, SMS_ARCH: 'arm64' });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-llvm-'));
  try {
    for (const [compiler, file, source] of [['clang', 'probe.c', 'int main(void) { return 0; }\n'],
      ['clang++', 'probe.cpp', '#include <string>\nint main() { return std::string("ok").size() == 2 ? 0 : 1; }\n']]) {
      fs.writeFileSync(path.join(scratch, file), source);
      const result = spawnSync(path.join(env.SMS_LLVM_BIN, compiler), ['-arch', 'arm64', path.join(scratch, file), '-o',
        path.join(scratch, 'probe')], { env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`The toolset's ${compiler} cannot build a program: ${result.stderr || result.error?.message}`);
      if (spawnSync(path.join(scratch, 'probe')).status !== 0) throw new Error(`The program ${compiler} built does not run.`);
    }
    process.stdout.write(`The Apple Silicon compiler builds and links programs: ${env.SMS_LLVM_BIN}\n`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

async function compile(root, arch, env, userData) {
  const binary = port.binaryPath(root, { arch, eclipse: false });
  try {
    await run(path.join(root, 'build.sh'), [], { cwd: root, env }, `Compile Sunshine (${arch}) on Mac without a ROM`);
  } catch (error) {
    // Finish independent compilation units to report every compiler error.
    // The original failed build still fails this test.
    const build = path.dirname(binary);
    if (fs.existsSync(path.join(build, 'build.ninja')))
      await run(path.join(env.SMS_BUILD_TOOLS_BIN, 'ninja'), ['-C', build, '-k', '0', 'sms'],
        { env }, 'Collect remaining Mac compiler errors').catch(() => {});
    throw error;
  }
  if (!fs.existsSync(binary)) throw new Error(`Missing binary: ${binary}`);
  const cache = fs.readFileSync(path.join(path.dirname(binary), 'CMakeCache.txt'), 'utf8');
  const target = arch === 'arm64' ? 'arm64' : 'x86_64';
  if (!new RegExp(`^CMAKE_OSX_ARCHITECTURES:STRING=${target}$`, 'm').test(cache)) throw new Error(`Mac build must target ${target}.`);
  const compiler = cache.match(/^CMAKE_CXX_COMPILER:[^=]*=(.+)$/m)?.[1];
  const objcopy = cache.match(/^SMS_OBJCOPY:[^=]*=(.+)$/m)?.[1];
  if (arch === 'arm64') {
    // LLVM's own clang, beside the llvm-config the pass plugin was built with.
    if (!compiler?.startsWith(env.SMS_LLVM_BIN) || env.SMS_LLVM_BIN === env.SMS_BUILD_TOOLS_BIN)
      throw new Error(`Expected the toolset's LLVM compiler: ${compiler}`);
    if (!fs.existsSync(path.join(path.dirname(compiler), 'llvm-config'))) throw new Error('llvm-config is not beside the compiler.');
    if (!objcopy?.startsWith(env.SMS_LLVM_BIN)) throw new Error(`Unexpected system LLVM tool: ${objcopy}`);
    const archs = (await capture('/usr/bin/lipo', ['-archs', binary], root, env)).split(/\s+/);
    if (archs.join() !== 'arm64') throw new Error(`The Apple Silicon game is ${archs.join(', ')}.`);
    await run('/usr/bin/codesign', ['--verify', '--strict', binary], { env }, 'Check the game\'s signature');
  } else {
    if (!compiler?.startsWith(env.SMS_BUILD_TOOLS_BIN)) throw new Error(`Expected the Apple compiler wrapper: ${compiler}`);
    const wrapper = fs.readFileSync(compiler, 'utf8');
    if (!wrapper.includes('exec /usr/bin/clang++')) throw new Error('Mac builds must use the compiler from Apple Command Line Tools.');
    if (!objcopy?.startsWith(env.SMS_BUILD_TOOLS_BIN)) throw new Error(`Unexpected system LLVM tool: ${objcopy}`);
    await run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { env }, 'Check Intel execution support');
  }
  await run('/usr/bin/file', [binary], { env });
  const start = spawnSync(binary, [], { cwd: root, timeout: 15000, encoding: 'utf8',
    env: { ...env, SMS_HEADLESS: '1', SMS_SAVE_DIR: path.join(userData, 'test-saves'),
      SMS_DISC_IMAGE: path.join(userData, 'intentionally-missing.iso') } });
  if (start.error || start.signal || start.status !== 1 || !start.stderr.includes('not a usable GameCube disc image'))
    throw new Error(`The Mac executable did not reach the expected missing-disc check: ${start.error?.message || start.stderr}`);
  process.stdout.write('Mac executable loaded successfully and correctly requires a disc image.\n');
  const cmake = path.join(env.SMS_BUILD_TOOLS_BIN, 'cmake');
  await run(cmake, ['-S', root, '-B', path.dirname(binary), '-DSMS_GX_BUILD_TESTS=ON'], { cwd: root, env });
  await run(cmake, ['--build', path.dirname(binary), '--target', 'gx_windowtest', '--parallel', '2'], { cwd: root, env });
  await run(path.join(path.dirname(binary), 'platform', 'gx', 'gx_windowtest'), [], { cwd: root, env },
    'Verify game window placement on Mac');
  process.stdout.write(`Mac build succeeded: ${binary}\n`);
}

runMain(main);
