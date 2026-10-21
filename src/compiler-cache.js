'use strict';

// A compiler cache (ccache) for game builds. Every update builds the game in a
// folder of its own (game-version.js), so without one each build compiles all
// of it again. ccache keeps what each source file compiled to, under a hash of
// that file, its headers and its compiler's flags, and hands it back while
// they are the same: a build of Super Mario Eclipse reuses the game's files
// compiled for Sunshine, and an update compiles only what changed. The game's
// CMake runs the compiler through it when SMS_COMPILER_CACHE names it.
//
// ccache's own release, checked against these hashes, is downloaded on first
// use (about 2 MB). The game builds as before without it.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { fetchVerified } = require('./build-tools');

const VERSION = '4.14.2';
const RELEASE = `https://github.com/ccache/ccache/releases/download/v${VERSION}`;
// entry: the program in the archive. Linux's is static, so it runs on any distribution.
const ASSETS = {
  linux: { name: `ccache-${VERSION}-linux-x86_64-musl-static.tar.gz`,
    sha256: 'd540ba01f160addbd3dd5e18eda9bd34005591b095c09ac8ae9d0a1b655e7ef5',
    entry: `ccache-${VERSION}-linux-x86_64-musl-static/ccache` },
  darwin: { name: `ccache-${VERSION}-darwin.tar.gz`,
    sha256: 'cf240009630b605b775c7c5c7b7105a3b196c79f31af322c1557969aa28003fc',
    entry: `ccache-${VERSION}-darwin/ccache` },
  win32: { name: `ccache-${VERSION}-windows-x86_64.zip`,
    sha256: '6993ce645e53192cec592ee23186200b574ac4c59097ecde8d9cfd681b47ae84',
    entry: `ccache-${VERSION}-windows-x86_64/ccache.exe` }
};
// About 15 game builds' worth; ccache removes the files used longest ago.
const MAX_SIZE = '2G';

function directory(userData) { return path.join(userData, 'compiler-cache'); }

// Named ccache: it takes its name from its file's (ccache-4.14.2 says it is "ccache-4.14").
function executable(userData, platform = process.platform) {
  return path.join(directory(userData), 'bin', VERSION, platform === 'win32' ? 'ccache.exe' : 'ccache');
}

function works(program) {
  const result = spawnSync(program, ['--version'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  return result.status === 0 && String(result.stdout).includes(`ccache version ${VERSION}`);
}

// One file from a zip archive (Windows' ccache comes as one): found through the
// archive's central directory, stored or deflated.
function unzipEntry(archive, name) {
  const data = fs.readFileSync(archive);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('The archive is not a zip file.');
  let at = data.readUInt32LE(end + 16);
  for (let index = data.readUInt16LE(end + 10); index > 0; index--) {
    if (data.readUInt32LE(at) !== 0x02014b50) break;
    const method = data.readUInt16LE(at + 10), packed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    if (data.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      if (data.readUInt32LE(local) !== 0x04034b50) break;
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      const stored = data.subarray(start, start + packed);
      const file = method === 0 ? stored : method === 8 ? zlib.inflateRawSync(stored) : null;
      if (!file || file.length !== size) throw new Error(`Could not unpack ${name}.`);
      return file;
    }
    at += 46 + nameLength + extra + comment;
  }
  throw new Error(`The archive has no ${name}.`);
}

async function unpack(archive, asset, staging) {
  if (asset.name.endsWith('.zip')) {
    fs.writeFileSync(path.join(staging, 'ccache'), unzipEntry(archive, asset.entry));
    return path.join(staging, 'ccache');
  }
  await require('tar').x({ file: archive, cwd: staging, strict: true,
    filter: name => name.replace(/^\.\//, '') === asset.entry });
  return path.join(staging, ...asset.entry.split('/'));
}

// The cache's program, downloaded if this version isn't there yet. Throws when
// it can't be had or doesn't run on this computer.
async function prepare(userData, { platform = process.platform, download = fetchVerified, log = () => {} } = {}) {
  const asset = ASSETS[platform];
  if (!asset) throw new Error('there is none for this system');
  const program = executable(userData, platform);
  if (fs.existsSync(program) && works(program)) return program;
  const bin = path.dirname(path.dirname(program));
  fs.mkdirSync(path.dirname(program), { recursive: true });
  const staging = fs.mkdtempSync(path.join(directory(userData), '.download-'));
  try {
    log('Setting up the compiler cache, which makes later game builds faster…');
    const archive = path.join(staging, asset.name);
    try { await download(`${RELEASE}/${asset.name}`, archive, asset.sha256); }
    catch (error) { throw new Error(`its download failed (${error.message})`); }
    const unpacked = await unpack(archive, asset, staging);
    fs.chmodSync(unpacked, 0o755);
    fs.renameSync(unpacked, program);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  if (!works(program)) {
    fs.rmSync(program, { force: true });
    throw new Error('it does not run on this computer');
  }
  // Other versions' programs, from earlier launchers.
  for (const name of fs.readdirSync(bin))
    if (name !== VERSION) fs.rmSync(path.join(bin, name), { force: true, recursive: true });
  return program;
}

// A build's environment with the cache in. Paths in the game folder being
// built (`root`) are hashed relative to it, so a build in another version's
// folder finds the files this one compiled; paths outside it (the build tools)
// stay as they are. A player's own ccache settings are left out, so they can't
// turn it off or point it elsewhere for these builds.
function environment(env, program, { userData, root, platform = process.platform }) {
  const own = Object.fromEntries(Object.entries(env).filter(([key]) => !/^CCACHE_/i.test(key)));
  const native = file => platform === 'win32' ? file.replaceAll('\\', '/') : file;
  return {
    ...own,
    SMS_COMPILER_CACHE: native(program),
    CCACHE_DIR: path.join(directory(userData), 'files'),
    CCACHE_CONFIGPATH: path.join(directory(userData), 'ccache.conf'),
    CCACHE_MAXSIZE: MAX_SIZE,
    CCACHE_BASEDIR: native(path.resolve(root)),
    // Debug information would name the build folder; release builds have none.
    CCACHE_NOHASHDIR: '1',
    // The Intel Mac build compiles with Apple's clang through wrapper scripts,
    // which stay the same when Xcode updates the compiler: ask it its version.
    ...(platform === 'darwin' ? { CCACHE_COMPILERCHECK: '%compiler% --version' } : {})
  };
}

// For Free up space: the compiled files go; the program stays.
async function clear(userData) {
  await fs.promises.rm(path.join(directory(userData), 'files'), { recursive: true, force: true, maxRetries: 3 });
}

module.exports = { VERSION, ASSETS, MAX_SIZE, directory, executable, prepare, environment, clear, unzipEntry };
