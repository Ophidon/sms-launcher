'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dlls = require('../src/windows-dlls');
const port = require('../src/port');

const AMD64 = 0x8664, I386 = 0x14c;

// A minimal PE image: one section holding the import descriptors and the names.
function pe(machine, imports = []) {
  const plus = machine === AMD64;
  const optionalSize = plus ? 240 : 224;
  const sectionTable = 0x40 + 24 + optionalSize;
  const raw = 0x200, rva = 0x1000;
  const file = Buffer.alloc(raw + 0x1000);
  file.write('MZ', 0, 'latin1');
  file.writeUInt32LE(0x40, 0x3c);
  file.writeUInt32LE(0x4550, 0x40);
  file.writeUInt16LE(machine, 0x44);
  file.writeUInt16LE(1, 0x46);
  file.writeUInt16LE(optionalSize, 0x54);
  file.writeUInt16LE(plus ? 0x20b : 0x10b, 0x58);
  file.writeUInt32LE(rva, 0x58 + (plus ? 112 : 96) + 8);
  file.write('.idata', sectionTable, 'latin1');
  file.writeUInt32LE(0x1000, sectionTable + 8);
  file.writeUInt32LE(rva, sectionTable + 12);
  file.writeUInt32LE(0x1000, sectionTable + 16);
  file.writeUInt32LE(raw, sectionTable + 20);
  let name = (imports.length + 1) * 20;
  imports.forEach((dll, index) => {
    file.writeUInt32LE(rva + name, raw + index * 20 + 12);
    file.write(`${dll}\0`, raw + name, 'latin1');
    name += dll.length + 1;
  });
  return file;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-windows-dlls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('reads the machine and imported DLL names of 64-bit and 32-bit programs', t => {
  const directory = tempDir(t);
  assert.deepEqual(dlls.imports(write(path.join(directory, 'a.exe'), pe(AMD64, ['zlib1.dll', 'KERNEL32.dll']))),
    { machine: AMD64, dlls: ['zlib1.dll', 'KERNEL32.dll'] });
  assert.deepEqual(dlls.imports(write(path.join(directory, 'b.exe'), pe(I386, ['libgcc_s_dw2-1.dll']))),
    { machine: I386, dlls: ['libgcc_s_dw2-1.dll'] });
  assert.equal(dlls.imports(write(path.join(directory, 'c.exe'), 'not a program')), null);
  assert.equal(dlls.imports(path.join(directory, 'missing.exe')), null);
});

test('GCC gets its DLLs beside it once, and System32 copies of them are reported', t => {
  const directory = tempDir(t);
  const msys = path.join(directory, 'msys64');
  const bin = path.join(msys, 'mingw64', 'bin');
  const gccDir = path.join(msys, 'mingw64', 'lib', 'gcc', 'x86_64-w64-mingw32', '16.2.0');
  const cc1 = write(path.join(gccDir, 'cc1.exe'), pe(AMD64, ['libmpc-3.dll', 'libwinpthread-1.dll', 'msys-2.0.dll', 'KERNEL32.dll']));
  const as = write(path.join(msys, 'mingw64', 'x86_64-w64-mingw32', 'bin', 'as.exe'), pe(AMD64, ['zlib1.dll']));
  write(path.join(bin, 'libmpc-3.dll'), pe(AMD64, ['libgmp-10.dll']));
  write(path.join(bin, 'libgmp-10.dll'), pe(AMD64));
  write(path.join(bin, 'libwinpthread-1.dll'), pe(AMD64));
  write(path.join(bin, 'zlib1.dll'), pe(AMD64));
  write(path.join(bin, 'msys-2.0.dll'), pe(AMD64));
  const windows = path.join(directory, 'Windows');
  write(path.join(windows, 'System32', 'libwinpthread-1.dll'), 'an older copy');
  write(path.join(windows, 'System32', 'zlib1.dll'), 'an older copy');
  const environment = { SystemRoot: windows };

  assert.deepEqual(dlls.toolchainPrograms(msys).sort(), [as, cc1].sort());
  const checked = dlls.shieldToolchain(msys, { place: false, environment });
  assert.deepEqual(checked.placed, []);
  assert.deepEqual(checked.conflicts.sort(), ['libwinpthread-1.dll', 'zlib1.dll'].map(name => path.join(windows, 'System32', name)));
  assert.equal(fs.existsSync(path.join(gccDir, 'libmpc-3.dll')), false);

  const first = dlls.shieldToolchain(msys, { environment });
  assert.deepEqual(first.placed.sort(), ['libgmp-10.dll', 'libmpc-3.dll', 'libwinpthread-1.dll', 'zlib1.dll']);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(fs.readdirSync(gccDir).sort(), ['cc1.exe', 'libgmp-10.dll', 'libmpc-3.dll', 'libwinpthread-1.dll']);
  assert.deepEqual(fs.readFileSync(path.join(gccDir, 'libmpc-3.dll')), fs.readFileSync(path.join(bin, 'libmpc-3.dll')));
  assert.ok(fs.existsSync(path.join(path.dirname(as), 'zlib1.dll')));
  // A second MSYS runtime would be a separate MSYS: it never moves.
  assert.equal(fs.existsSync(path.join(gccDir, 'msys-2.0.dll')), false);
  assert.deepEqual(dlls.shieldToolchain(msys, { environment }).placed, []);

  // A copy that no longer matches the build tools' DLL is replaced.
  fs.rmSync(path.join(gccDir, 'libgmp-10.dll'));
  write(path.join(gccDir, 'libgmp-10.dll'), 'stale');
  assert.deepEqual(dlls.shieldToolchain(msys, { environment }).placed, ['libgmp-10.dll']);
  assert.deepEqual(fs.readFileSync(path.join(gccDir, 'libgmp-10.dll')), fs.readFileSync(path.join(bin, 'libgmp-10.dll')));
});

test('a 32-bit game gets 32-bit runtime DLLs, and SysWOW64 copies are the ones reported', t => {
  const directory = tempDir(t);
  const msys = path.join(directory, 'msys64');
  const settings = { arch: '32' };
  const env = { MSYS2_ROOT: msys, SMS_WINDOWS_32_CROSS: '1' };
  const folders = port.gameRuntimeFolders(settings, env);
  assert.deepEqual(folders, [path.join(msys, 'opt', 'i686-w64-mingw32', 'bin'), path.join(msys, 'mingw32', 'bin')]);
  assert.deepEqual(port.gameRuntimeFolders({ arch: '64' }, { MSYS2_ROOT: msys }), [path.join(msys, 'mingw64', 'bin')]);
  // The 64-bit libstdc++ comes first on the search list but does not fit a 32-bit game.
  const search = [path.join(msys, 'mingw64', 'bin'), ...folders];
  write(path.join(search[0], 'libstdc++-6.dll'), pe(AMD64));
  write(path.join(folders[0], 'libstdc++-6.dll'), pe(I386, ['libgcc_s_dw2-1.dll']));
  write(path.join(folders[0], 'libgcc_s_dw2-1.dll'), pe(I386));
  write(path.join(folders[1], 'SDL2.dll'), pe(I386));
  const game = write(path.join(directory, 'game', 'build', 'windows-32', 'sms.exe'), pe(I386, ['SDL2.dll', 'libstdc++-6.dll']));
  const windows = path.join(directory, 'Windows');
  write(path.join(windows, 'System32', 'SDL2.dll'), 'a 64-bit copy Windows never gives a 32-bit game');
  write(path.join(windows, 'SysWOW64', 'libgcc_s_dw2-1.dll'), 'an older copy');

  const result = dlls.shield([game], search, { environment: { SystemRoot: windows } });
  assert.deepEqual(result.placed.sort(), ['SDL2.dll', 'libgcc_s_dw2-1.dll', 'libstdc++-6.dll']);
  assert.deepEqual(result.conflicts, [path.join(windows, 'SysWOW64', 'libgcc_s_dw2-1.dll')]);
  assert.equal(dlls.imports(path.join(path.dirname(game), 'libstdc++-6.dll')).machine, I386);
});

test('a game that is not a Windows program is left alone', t => {
  const directory = tempDir(t);
  const game = write(path.join(directory, 'build', 'sms.exe'), 'installed executable');
  write(path.join(directory, 'msys64', 'mingw64', 'bin', 'SDL2.dll'), pe(AMD64));
  assert.deepEqual(dlls.shield([game], [path.join(directory, 'msys64', 'mingw64', 'bin')]), { placed: [], conflicts: [], errors: [] });
  assert.deepEqual(fs.readdirSync(path.dirname(game)), ['sms.exe']);
});
