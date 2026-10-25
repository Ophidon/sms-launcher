'use strict';

// Windows looks for a program's DLLs in the program's own folder, then in
// System32 and the Windows folder, and only then on the PATH. Programs that
// rely on the PATH for their DLLs load any same-named DLL another installer put
// in System32 instead: GCC's cc1.exe (in lib\gcc, away from mingw64\bin) stops
// on an old libwinpthread-1.dll there ("entry point clock_gettime64 not found")
// and GCC fails without a message, and the game's sms.exe would do the same.
// So each such program gets the DLLs it imports placed beside it.
const fs = require('node:fs');
const path = require('node:path');

const I386 = 0x14c;

function read(fd, position, length) {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
}

// A PE file's machine and the DLL names in its import table, or null for
// anything else.
function imports(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const dos = read(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = dos.readUInt32LE(0x3c);
    const coff = read(fd, pe, 24);
    if (coff.length < 24 || coff.readUInt32LE(0) !== 0x4550) return null;
    const machine = coff.readUInt16LE(4);
    const optionalSize = coff.readUInt16LE(20);
    const optional = read(fd, pe + 24, optionalSize);
    // The import directory is the second data directory.
    const directories = { 0x10b: 96, 0x20b: 112 }[optional.length >= 2 ? optional.readUInt16LE(0) : 0];
    if (!directories || optional.length < directories + 16) return { machine, dlls: [] };
    const importRva = optional.readUInt32LE(directories + 8);
    const sections = read(fd, pe + 24 + optionalSize, coff.readUInt16LE(6) * 40);
    const offset = rva => {
      for (let at = 0; at + 40 <= sections.length; at += 40) {
        const start = sections.readUInt32LE(at + 12);
        const size = Math.max(sections.readUInt32LE(at + 8), sections.readUInt32LE(at + 16));
        if (rva >= start && rva < start + size) return rva - start + sections.readUInt32LE(at + 20);
      }
      return -1;
    };
    const dlls = [];
    for (let at = importRva ? offset(importRva) : -1; at >= 0 && dlls.length < 512; at += 20) {
      const descriptor = read(fd, at, 20);
      if (descriptor.length < 20 || descriptor.every(byte => byte === 0)) break;
      const name = offset(descriptor.readUInt32LE(12));
      if (name < 0) continue;
      const text = read(fd, name, 260);
      const end = text.indexOf(0);
      dlls.push(text.subarray(0, end < 0 ? text.length : end).toString('latin1'));
    }
    return { machine, dlls };
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function listing(folder) {
  try { return new Map(fs.readdirSync(folder).map(name => [name.toLowerCase(), name])); }
  catch (_) { return new Map(); }
}

// The DLLs a program imports from the folders (the first folder that has one
// wins), and the DLLs those import, for the program's own architecture. MSYS
// and Cygwin DLLs stay put: a second msys-2.0.dll would be a separate MSYS.
function needed(file, folders) {
  const program = imports(file);
  if (!program) return null;
  const listings = folders.map(listing);
  const found = new Map();
  const seen = new Set();
  const pending = [...program.dlls];
  while (pending.length) {
    const name = pending.shift().toLowerCase();
    if (seen.has(name) || /^(msys-|cyg)/.test(name)) continue;
    seen.add(name);
    for (const [index, folder] of folders.entries()) {
      const actual = listings[index].get(name);
      const dll = actual && path.join(folder, actual);
      const info = dll && imports(dll);
      if (!info || info.machine !== program.machine) continue;
      found.set(name, dll);
      pending.push(...info.dlls);
      break;
    }
  }
  return { machine: program.machine, dlls: [...found.values()] };
}

function sameFile(a, b) {
  try {
    const one = fs.statSync(a), two = fs.statSync(b);
    return one.size === two.size && Math.trunc(one.mtimeMs) === Math.trunc(two.mtimeMs);
  } catch (_) { return false; }
}

// Puts the DLL beside the program: a hard link where the folders share a
// drive, otherwise a copy with the same modified time, so the next check
// finds it current. Returns whether it changed anything.
function place(dll, directory) {
  const target = path.join(directory, path.basename(dll));
  if (path.resolve(path.dirname(dll)).toLowerCase() === path.resolve(directory).toLowerCase() || sameFile(dll, target)) return false;
  fs.rmSync(target, { force: true });
  try { fs.linkSync(dll, target); }
  catch (_) {
    fs.copyFileSync(dll, target);
    const stat = fs.statSync(dll);
    fs.utimesSync(target, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  }
  return true;
}

// The same-named DLLs Windows would load first: System32 (SysWOW64 for a
// 32-bit program on 64-bit Windows), then the Windows folder.
function systemCopies(names, machine, environment = process.env) {
  const windows = environment.SystemRoot || environment.SYSTEMROOT || environment.windir;
  if (!windows) return [];
  const wow64 = path.join(windows, 'SysWOW64');
  const folders = [machine === I386 && fs.existsSync(wow64) ? wow64 : path.join(windows, 'System32'), windows];
  return folders.flatMap(folder => {
    const files = listing(folder);
    return names.flatMap(name => files.has(name.toLowerCase()) ? [path.join(folder, files.get(name.toLowerCase()))] : []);
  });
}

// Gives each program the DLLs it imports from the folders, beside it (unless
// place is false), and reports the DLLs newly placed, the same-named copies
// Windows has of any DLL they need, and what could not be placed.
function shield(programs, folders, { place: placing = true, environment = process.env } = {}) {
  const placed = new Set(), conflicts = new Set(), errors = [];
  for (const program of programs) {
    const found = needed(program, folders);
    if (!found) continue;
    for (const file of systemCopies(found.dlls.map(dll => path.basename(dll)), found.machine, environment)) conflicts.add(file);
    if (!placing) continue;
    for (const dll of found.dlls) {
      try { if (place(dll, path.dirname(program))) placed.add(path.basename(dll)); }
      catch (error) { errors.push(`${path.basename(dll)} beside ${program}: ${error.message}`); }
    }
  }
  return { placed: [...placed], conflicts: [...conflicts], errors };
}

// The MinGW programs that sit outside <prefix>\bin and so find their DLLs only
// through the PATH: GCC's compilers and helpers (lib\gcc\<target>\<version>)
// and the binutils GCC runs (<target>\bin).
function toolchainPrograms(msys, prefix = 'mingw64') {
  const root = path.join(msys, prefix);
  const folders = [];
  for (const parent of [path.join(root, 'lib', 'gcc'), path.join(root, 'libexec', 'gcc')])
    for (const target of listing(parent).values()) {
      if (parent.endsWith(path.join('lib', 'gcc'))) folders.push(path.join(root, target, 'bin'));
      for (const version of listing(path.join(parent, target)).values()) folders.push(path.join(parent, target, version));
    }
  return [...new Set(folders)].flatMap(folder => [...listing(folder).values()]
    .filter(name => name.toLowerCase().endsWith('.exe')).map(name => path.join(folder, name)));
}

function shieldToolchain(msys, options = {}) {
  const prefixes = ['mingw64', 'mingw32'].filter(prefix => fs.existsSync(path.join(msys, prefix, 'bin')));
  const results = prefixes.map(prefix => shield(toolchainPrograms(msys, prefix), [path.join(msys, prefix, 'bin')], options));
  return { placed: [...new Set(results.flatMap(result => result.placed))],
    conflicts: [...new Set(results.flatMap(result => result.conflicts))],
    errors: results.flatMap(result => result.errors) };
}

// The DLLs a program imports, directly or through the DLLs it finds in the
// folders, that are neither there (for its own architecture) nor Windows' own:
// what it would miss with nothing on the PATH. Null for a file that is not a
// program. API sets (api-ms-win-*) are Windows' own, without files.
function unresolved(program, folders, { environment = process.env } = {}) {
  const info = imports(program);
  if (!info) return null;
  const listings = folders.map(listing);
  const seen = new Set(), missing = [];
  const pending = [...info.dlls];
  while (pending.length) {
    const name = pending.shift().toLowerCase();
    if (seen.has(name) || /^(api|ext)-ms-/.test(name)) continue;
    seen.add(name);
    const found = folders.map((folder, index) => listings[index].has(name) && imports(path.join(folder, listings[index].get(name))))
      .find(dll => dll && dll.machine === info.machine);
    if (found) pending.push(...found.dlls);
    else missing.push(name);
  }
  const system = new Set(systemCopies(missing, info.machine, environment).map(file => path.basename(file).toLowerCase()));
  return missing.filter(name => !system.has(name));
}

module.exports = { imports, needed, systemCopies, shield, toolchainPrograms, shieldToolchain, unresolved };
