'use strict';

// Build both game targets on a 64-bit host using only the private archive.
// No disc image or compiled game is uploaded by this check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const buildTools = require('../src/build-tools');
const port = require('../src/port');
const game = require('../src/game-version');
const windowsDlls = require('../src/windows-dlls');
const { execFileSync, spawnSync } = require('node:child_process');
const capture = async (command, args, cwd, env) => execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim();
const { run, runMain } = require('./tool-run');

function executableType(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return { bits: header[4] === 2 ? '64' : '32', machine: header.readUInt16LE(18) };
    const pe = Buffer.alloc(112);
    fs.readSync(fd, pe, 0, pe.length, header.readUInt32LE(0x3c));
    if (header.readUInt16LE(0) !== 0x5a4d || pe.readUInt32LE(0) !== 0x4550)
      throw new Error(`Not a native executable: ${file}`);
    return { bits: pe.readUInt16LE(24) === 0x20b ? '64' : '32', machine: pe.readUInt16LE(4), pe };
  } finally { fs.closeSync(fd); }
}

// Some players' System32 holds older DLLs named like the build tools' own
// (libwinpthread-1.dll, zlib1.dll...), which Windows loads before the PATH's:
// GCC then fails without a message. A real system DLL under those names stands
// in for them, so the build and the game must get past them as the launcher's do.
const DECOYS = {
  System32: ['libwinpthread-1.dll', 'libgcc_s_seh-1.dll', 'zlib1.dll', 'libzstd.dll', 'libstdc++-6.dll', 'SDL2.dll'],
  SysWOW64: ['libwinpthread-1.dll', 'libgcc_s_dw2-1.dll', 'libstdc++-6.dll', 'SDL2.dll']
};

function plantSystemDecoys() {
  const planted = [];
  process.on('exit', () => { for (const file of planted) fs.rmSync(file, { force: true }); });
  for (const [folder, names] of Object.entries(DECOYS)) {
    const directory = path.join(process.env.SystemRoot, folder);
    for (const name of names.filter(name => !fs.existsSync(path.join(directory, name)))) {
      fs.copyFileSync(path.join(directory, 'version.dll'), path.join(directory, name));
      planted.push(path.join(directory, name));
    }
  }
  process.stdout.write(`Planted stand-in system DLLs: ${planted.join(', ')}\n`);
  return planted;
}

// What the launcher does before each build (main.js shieldBuildTools), with a
// check first that the stand-ins really break the compiler the way they do for players.
function shieldBuildTools(toolRoot, env, planted) {
  const msys = path.join(toolRoot, 'msys64');
  if (planted.length) {
    const probe = path.join(os.tmpdir(), 'sms-system-dll-probe.c');
    fs.writeFileSync(probe, 'int main(void) { return 0; }\n');
    const broken = spawnSync(path.join(msys, 'mingw64', 'bin', 'gcc.exe'), ['-c', probe, '-o', `${probe}.o`],
      { env, timeout: 60000, windowsHide: true, encoding: 'utf8' });
    if (broken.status === 0) throw new Error('The stand-in system DLLs did not break the unshielded compiler.');
    const found = windowsDlls.shieldToolchain(msys, { place: false }).conflicts.map(file => path.basename(file).toLowerCase());
    for (const name of ['libwinpthread-1.dll', 'zlib1.dll'])
      if (!found.includes(name)) throw new Error(`The launcher did not find the stand-in ${name}: ${found.join(', ')}`);
  }
  const result = windowsDlls.shieldToolchain(msys);
  if (result.errors.length) throw new Error(`Could not shield the build tools: ${result.errors.join('; ')}`);
  process.stdout.write(`Build tools' own DLLs placed beside their programs: ${result.placed.join(', ') || 'none needed'}\n`);
}

function shieldGameProgram(program, settings, env) {
  const result = windowsDlls.shield([program], port.gameRuntimeFolders(settings, env));
  if (result.errors.length) throw new Error(`Could not shield ${program}: ${result.errors.join('; ')}`);
}

async function main() {
  const userData = path.join(os.tmpdir(), process.platform === 'win32'
    ? 'SMS Launcher Private Tools CI' : 'sms-launcher-private-tools-ci');
  const manifestFile = process.env.SMS_TOOL_ASSET_MANIFEST;
  const generated = manifestFile ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const source = generated?.platforms[process.platform] || null;
  if (source) {
    source.toolset ||= generated.toolset;
    require('../src/tool-assets.json').platforms[process.platform] = source;
  }
  const archiveFile = source ? path.join(path.dirname(manifestFile), source.name) : null;
  await buildTools.prepare(userData, { forcePrivate: true, run, source, archiveFile,
    progress(percent, detail) {
      if (detail) process.stdout.write(`${detail}\n`);
      else if (percent !== null && percent % 10 === 0) process.stdout.write(`Download tools: ${percent}%\n`);
    }
  });
  if (buildTools.status(userData).mode !== 'private') throw new Error('Private tools were not prepared.');
  const toolRoot = buildTools.rootFor(userData);
  if (process.platform === 'win32') {
    const planted = process.env.SMS_SMOKE_SYSTEM32_DECOYS === '1' ? plantSystemDecoys() : [];
    shieldBuildTools(toolRoot, buildTools.environment(userData, { ...process.env, SMS_ARCH: '64' }), planted);
  }
  // Configure the self-tests with the game, so checking them needs no second
  // configure (on Windows that reapplies every decomp patch, almost two minutes).
  // Game revisions whose build.sh ignores it are reconfigured below.
  const base = { ...process.env, SMS_GX_BUILD_TESTS: 'ON', PATH: process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32') : '' };
  const checkoutEnv = buildTools.environment(userData, { ...base, SMS_ARCH: '64' });
  const git = process.platform === 'win32'
    ? path.join(checkoutEnv.MSYS2_ROOT, 'usr', 'bin', 'git.exe')
    : path.join(toolRoot, 'env', 'bin', 'git');
  if (!fs.existsSync(git)) throw new Error(`Private Git is missing: ${git}`);
  if (process.platform === 'win32') {
    // Without CA certificates every texture and cutscene download fails. Leave
    // out the Windows store, which differs between computers.
    await run(path.join(checkoutEnv.MSYS2_ROOT, 'mingw64', 'bin', 'python.exe'), ['-I', '-c',
      'import ssl; c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); c.set_default_verify_paths(); ' +
      'n = c.cert_store_stats()["x509_ca"]; print(n, "CA certificates"); assert n > 50, "no CA certificates"'],
    { env: checkoutEnv }, 'Check the bundled Python\'s CA certificates');
  }
  const root = path.join(os.tmpdir(), process.platform === 'win32'
    ? 'SMS Port Private Tools CI' : 'sms-port-private-tools-ci');
  if (fs.existsSync(root)) throw new Error(`Smoke build folder already exists: ${root}`);
  await game.checkout(root, { git, run, capture, env: checkoutEnv });
  if (process.platform === 'win32') {
    const env = buildTools.environment(userData, { ...base, SMS_ARCH: '32' });
    const probe = path.join(userData, 'Cross compiler path check');
    fs.mkdirSync(probe, { recursive: true });
    const header = path.join(probe, 'include with spaces.h');
    const input = path.join(probe, 'main.cpp');
    const output = path.join(probe, 'probe.exe');
    fs.writeFileSync(header, '#define EXPECTED_VALUE 0\n');
    fs.writeFileSync(input, 'int main(){return EXPECTED_VALUE;}\n');
    await run(path.join(env.MSYS2_ROOT, 'mingw64', 'bin', 'python.exe'),
      [path.join(root, 'tools', 'msys_cross_compile.py'), env.CXX, '-v', '-include', header, input, '-o', output],
      { cwd: probe, env }, 'Check 32-bit cross compiler with native Windows paths and spaces');
    const response = path.join(probe, 'link.rsp');
    const quote = file => `"${file.replaceAll('\\', '/')}"`;
    fs.writeFileSync(response, `-include ${quote(header)} ${quote(input)} -o ${quote(output)}`);
    await run(path.join(env.MSYS2_ROOT, 'mingw64', 'bin', 'python.exe'),
      [path.join(root, 'tools', 'msys_cross_compile.py'), env.CXX, `@${response}`],
      { cwd: probe, env }, 'Check Windows cross compiler response files');
    if (executableType(output).bits !== '32') throw new Error('The cross compiler path check did not produce a 32-bit game target.');
  }
  const canonical = file => fs.realpathSync.native(file).replaceAll('\\', '/').toLowerCase();
  const privatePrefix = `${canonical(toolRoot)}/`;
  const arches = process.env.SMS_SMOKE_ARCHES?.split(',') || ['64', '32'];
  for (const arch of arches) {
    if (!['64', '32'].includes(arch)) throw new Error(`Invalid game target: ${arch}`);
    const env = buildTools.environment(userData, { ...base, SMS_ARCH: arch });
    if (process.platform === 'win32') {
      const bash = path.join(env.MSYS2_ROOT, 'usr', 'bin', 'bash.exe');
      // A login shell would replace the selected target's runtime search path.
      await run(bash, ['-c', 'cd "$(cygpath -u "$1")" && ./build.sh', 'sms-launcher', root],
        { cwd: root, env }, `Build ${arch}-bit game using private Windows tools`);
    } else {
      await run(path.join(root, 'build.sh'), [], { cwd: root, env }, `Build ${arch}-bit game using private Linux tools`);
    }
    const settings = { arch, eclipse: false };
    const binary = port.binaryPath(root, settings);
    if (!fs.existsSync(binary)) throw new Error(`Build completed without ${binary}`);
    const cache = fs.readFileSync(path.join(path.dirname(binary), 'CMakeCache.txt'), 'utf8');
    const selectedTool = name => {
      const selected = cache.match(new RegExp(`^${name}:[^=]*=(.+)$`, 'm'))?.[1];
      if (!selected || !canonical(selected).startsWith(privatePrefix))
        throw new Error(`Build used a tool outside the private archive: ${name}=${selected || 'unknown'}`);
      return selected;
    };
    const compiler = selectedTool('CMAKE_CXX_COMPILER');
    // Bootlin's wrapper is itself x64; the .br_real file is the actual compiler.
    for (const file of [compiler, ...(fs.existsSync(`${compiler}.br_real`) ? [`${compiler}.br_real`] : [])])
      if (executableType(file).bits !== '64') throw new Error(`Compiler does not run on a 64-bit host: ${file}`);
    if (canonical(game.compilerToolRoot(root, settings)) !== canonical(toolRoot))
      throw new Error('The game did not record its private toolset correctly.');
    const type = executableType(binary);
    const expectedMachine = process.platform === 'win32' ? (arch === '64' ? 0x8664 : 0x14c) : (arch === '64' ? 62 : 3);
    if (type.bits !== arch || type.machine !== expectedMachine)
      throw new Error(`Expected a ${arch}-bit game, got ${JSON.stringify(type)}`);
    if (process.platform === 'win32') {
      for (const name of ['Python3_EXECUTABLE', 'CMAKE_MAKE_PROGRAM'])
        if (executableType(selectedTool(name)).bits !== '64') throw new Error(`${name} is not a 64-bit host tool.`);
      selectedTool('CMAKE_OBJCOPY');
      const machine = await capture(compiler, ['-dumpmachine'], root, env);
      if (machine !== (arch === '64' ? 'x86_64-w64-mingw32' : 'i686-w64-mingw32'))
        throw new Error(`Wrong Windows compiler target: ${machine}`);
      if (arch === '64') {
        if (type.pe.readBigUInt64LE(48) !== 0x400000n || (type.pe.readUInt16LE(94) & 0x60))
          throw new Error('The Windows x64 game image must stay below 4 GiB.');
        const cmake = path.join(env.MSYS2_ROOT, 'mingw64', 'bin', 'cmake.exe');
        await run(cmake, ['--build', path.dirname(binary), '--target', 'sms_windows_stack_test'], { cwd: root, env });
        shieldGameProgram(path.join(path.dirname(binary), 'sms_windows_stack_test.exe'), settings, env);
        await run(path.join(path.dirname(binary), 'sms_windows_stack_test.exe'), [], { cwd: root, env },
          'Check Windows x64 game stacks and thread exits');
      }
    }
    const loader = process.platform === 'linux' && arch === '32'
      ? path.join(env.SMS_LINUX32_ROOT, 'i686-buildroot-linux-gnu', 'sysroot', 'lib', 'ld-linux.so.2') : null;
    const invalidDisc = path.join(userData, 'intentionally-invalid.iso');
    // A tiny invalid fixture lets run.sh reach the game's own disc check.
    fs.writeFileSync(invalidDisc, Buffer.alloc(32));
    const startEnv = { ...env, SMS_GAME_EXECUTABLE: binary,
      SMS_SAVE_DIR: path.join(userData, 'test-saves'), SMS_DISC_IMAGE: invalidDisc };
    if (process.platform === 'win32') shieldGameProgram(binary, settings, env);
    const launch = process.platform === 'win32'
      ? port.commandFor(root, 'run', [invalidDisc], process.platform, startEnv)
      : { command: loader || binary,
        args: loader ? ['--library-path', env.SMS_LINUX32_LIBRARY_PATH, binary] : [], env: startEnv };
    // Windows launches through the same private Bash route as the application.
    const start = spawnSync(launch.command, launch.args,
      { cwd: root, timeout: 45000, encoding: 'utf8', windowsHide: true, env: launch.env });
    if (start.error || start.signal || start.status !== 1 || !start.stderr.includes('not a usable GameCube disc image')) {
      if (process.platform === 'win32') {
        const objdump = path.join(env.MSYS2_ROOT, 'mingw64', 'bin', 'objdump.exe');
        const imports = spawnSync(objdump, ['-p', binary], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
        process.stderr.write((imports.stdout || '').split('\n').filter(line => line.includes('DLL Name:')).join('\n') + '\n');
      }
      throw new Error(`${arch}-bit game did not reach the disc check: ${JSON.stringify({
        error: start.error?.message, status: start.status, signal: start.signal, stdout: start.stdout, stderr: start.stderr })}`);
    }
    const cmake = process.platform === 'win32'
      ? path.join(env.MSYS2_ROOT, 'mingw64', 'bin', 'cmake.exe') : path.join(toolRoot, 'env', 'bin', 'cmake');
    if (!/^SMS_GX_BUILD_TESTS:BOOL=ON$/m.test(cache))
      await run(cmake, ['-S', root, '-B', path.dirname(binary), '-DSMS_GX_BUILD_TESTS=ON'], { cwd: root, env });
    await run(cmake, ['--build', path.dirname(binary), '--target', 'gx_windowtest', '--parallel', '2'], { cwd: root, env });
    const windowTest = path.join(path.dirname(binary), 'platform', 'gx', process.platform === 'win32' ? 'gx_windowtest.exe' : 'gx_windowtest');
    if (process.platform === 'win32') {
      shieldGameProgram(windowTest, settings, env);
      await run(path.join(env.MSYS2_ROOT, 'usr', 'bin', 'bash.exe'),
        ['-c', '"$(cygpath -u "$1")"', 'sms-window-check', windowTest], { cwd: root, env }, 'Verify game window placement');
    } else {
      await run(loader || windowTest, loader ? ['--library-path', env.SMS_LINUX32_LIBRARY_PATH, windowTest] : [],
        { cwd: root, env }, 'Verify game window placement');
    }
    if (process.platform === 'linux' && arch === '32') {
      await run(cmake, ['--build', path.dirname(binary), '--target', 'gx_selftest', '--parallel', '2'], { cwd: root, env });
      const graphicsTest = path.join(path.dirname(binary), 'platform', 'gx', 'gx_selftest');
      await run(loader, ['--library-path', env.SMS_LINUX32_LIBRARY_PATH, graphicsTest, '--headless'],
        { cwd: root, env: { ...env, LIBGL_ALWAYS_SOFTWARE: '1' } }, 'Verify private 32-bit graphics runtime');
    }
    process.stdout.write(`Private x64-host tools compiled and started the ${arch}-bit game: ${binary}\n`);
  }
}

runMain(main);
