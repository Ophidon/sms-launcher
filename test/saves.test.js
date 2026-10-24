'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const saves = require('../src/saves');

test('switching build tools preserves custom saves in place and keeps the old build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-tool-switch-'));
  const build = path.join(root, 'build');
  const previous = path.join(root, 'build.previous');
  const card = path.join(build, 'card-a');
  try {
    fs.mkdirSync(card, { recursive: true });
    fs.writeFileSync(path.join(build, 'CMakeCache.txt'), 'old compiler');
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'existing progress');
    fs.writeFileSync(path.join(card, 'index.txt'), 'memory card index');
    const backup = saves.moveBuildKeepingSaves(build, previous, card, path.join(root, 'backups'));
    assert.equal(backup.count, 2);
    assert.equal(fs.readFileSync(path.join(card, 'GMSE01.dat'), 'utf8'), 'existing progress');
    assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'memory card index');
    assert.equal(fs.readFileSync(path.join(previous, 'CMakeCache.txt'), 'utf8'), 'old compiler');
    assert.equal(fs.existsSync(path.join(build, 'CMakeCache.txt')), false);
    assert.equal(fs.readFileSync(path.join(previous, 'card-a', 'GMSE01.dat'), 'utf8'), 'existing progress');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the game gets a Windows save folder it can create and write', () => {
  assert.equal(saves.gameSaveDirectory('C:\\Users\\Shadow\\AppData\\Roaming\\sms-port\\card-a', 'win32'),
    'C:/Users/Shadow/AppData/Roaming/sms-port/card-a');
  assert.equal(saves.gameSaveDirectory('/home/me/.local/share/sms-port/card-a', 'linux'), '/home/me/.local/share/sms-port/card-a');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-prepare-'));
  const card = path.join(root, 'sms-port', 'card-a');
  try {
    assert.equal(saves.prepareSaveDirectory(card, 'linux'), card);
    assert.equal(fs.statSync(card).isDirectory(), true);
    assert.equal(saves.prepareSaveDirectory(card, 'linux'), card);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed save restore puts the original build and progress back', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-tool-rollback-'));
  const build = path.join(root, 'build');
  const previous = path.join(root, 'build.previous');
  const originalCopy = fs.copyFileSync;
  try {
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, 'CMakeCache.txt'), 'old compiler');
    fs.writeFileSync(path.join(build, 'GMSE01.dat'), 'existing progress');
    context.mock.method(fs, 'copyFileSync', (source, destination, ...args) => {
      if (String(destination).includes('.restore-')) throw new Error('Restore could not write the file');
      return originalCopy(source, destination, ...args);
    });
    assert.throws(() => saves.moveBuildKeepingSaves(build, previous, build, path.join(root, 'backups')), /could not write/);
    assert.equal(fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'), 'old compiler');
    assert.equal(fs.readFileSync(path.join(build, 'GMSE01.dat'), 'utf8'), 'existing progress');
    assert.equal(fs.existsSync(previous), false);
  } finally { context.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('save path follows the port defaults and explicit configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-path-'));
  try {
    assert.equal(saves.saveDirectory(root, { HOME: '/home/player' }, 'linux'),
      path.resolve('/home/player', '.local', 'share', 'sms-port', 'card-a'));
    assert.equal(saves.saveDirectory(root, { APPDATA: 'C:\\Users\\Player\\AppData\\Roaming' }, 'win32'),
      path.resolve('C:\\Users\\Player\\AppData\\Roaming', 'sms-port', 'card-a'));
    fs.writeFileSync(path.join(root, 'settings.txt'), 'save_dir = my-card\n');
    assert.equal(saves.saveDirectory(root, {}, 'linux'), path.join(root, 'my-card'));
    assert.equal(saves.saveDirectory(root, { SMS_SAVE_DIR: 'override' }, 'linux'), path.join(root, 'override'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup refuses a custom memory card inside a removable build folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-clean-'));
  try {
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'build', 'linux-64', 'card-a')), true);
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'build32', 'card-a')), true);
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'rom', 'card-a')), false);
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'builds', 'card-a')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verified backup restores old progress and preserves current files first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-backup-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), Buffer.from('first progress'));
    fs.writeFileSync(path.join(card, 'GMSE01.stat'), Buffer.from('metadata'));
    fs.writeFileSync(path.join(card, 'disc.iso'), Buffer.from('not a save'));
    const first = saves.backupSaves(card, backups, 'before-play');
    assert.equal(first.count, 2);
    assert.equal(fs.existsSync(path.join(first.directory, 'files', 'disc.iso')), false);
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), Buffer.from('later progress'));
    const result = saves.restoreBackup(first.id, card, backups);
    assert.equal(fs.readFileSync(path.join(card, 'GMSE01.dat'), 'utf8'), 'first progress');
    assert.equal(result.restored, 2);
    assert.equal(fs.readFileSync(path.join(result.previous, 'files', 'GMSE01.dat'), 'utf8'), 'later progress');
    assert.equal(saves.listBackups(backups).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mods\' files beside the card are backed up and restored with it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-mods-'));
  const card = path.join(root, 'card-a');
  const mods = path.join(root, 'card-a-mods');
  const backups = path.join(root, 'backups');
  try {
    assert.equal(saves.modSaveDirectory(`${card}${path.sep}`), mods);
    fs.mkdirSync(card);
    fs.mkdirSync(path.join(mods, 'randomizer', 'GMSE01-A'), { recursive: true });
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'first progress');
    fs.writeFileSync(path.join(mods, 'randomizer', 'settings.txt'), 'all unlocks');
    fs.writeFileSync(path.join(mods, 'randomizer', 'GMSE01-A', 'seed.bin'), 'seed 1');
    fs.writeFileSync(path.join(mods, 'randomizer', 'GMSE01-A', 'seed.bin.tmp'), 'half written');
    const first = saves.backupSaves(card, backups);
    assert.equal(first.count, 1);
    assert.equal(first.mods, 2);
    // later: another seed, a file of another mod
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'later progress');
    fs.writeFileSync(path.join(mods, 'randomizer', 'GMSE01-A', 'seed.bin'), 'seed 2');
    fs.mkdirSync(path.join(mods, 'other'));
    fs.writeFileSync(path.join(mods, 'other', 'x'), 'later');
    const result = saves.restoreBackup(first.id, card, backups);
    assert.equal(result.restoredMods, 2);
    assert.equal(fs.readFileSync(path.join(mods, 'randomizer', 'GMSE01-A', 'seed.bin'), 'utf8'), 'seed 1');
    assert.equal(fs.readFileSync(path.join(mods, 'randomizer', 'settings.txt'), 'utf8'), 'all unlocks');
    assert.equal(fs.existsSync(path.join(mods, 'other')), false);
    assert.equal(fs.existsSync(path.join(mods, 'randomizer', 'GMSE01-A', 'seed.bin.tmp')), false);
    // what was there before the restore is in its own backup
    assert.equal(fs.readFileSync(path.join(result.previous, 'mods', 'randomizer', 'GMSE01-A', 'seed.bin'), 'utf8'), 'seed 2');
    assert.equal(fs.readFileSync(path.join(result.previous, 'mods', 'other', 'x'), 'utf8'), 'later');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a backup from before mods\' files leaves the current ones; one with none clears them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-mods-old-'));
  const card = path.join(root, 'card-a');
  const mods = path.join(root, 'card-a-mods');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'progress');
    const none = saves.backupSaves(card, backups);
    // an older launcher's backup: no `mods` in its manifest
    const old = saves.backupSaves(card, backups);
    const manifestPath = path.join(old.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.mods;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.mkdirSync(path.join(mods, 'randomizer'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'randomizer', 'settings.txt'), 'kept');
    saves.restoreBackup(old.id, card, backups);
    assert.equal(fs.readFileSync(path.join(mods, 'randomizer', 'settings.txt'), 'utf8'), 'kept');
    saves.restoreBackup(none.id, card, backups);
    assert.equal(fs.existsSync(mods), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tampered mod file in a backup does not replace current progress', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-mods-bad-'));
  const card = path.join(root, 'card-a');
  const mods = path.join(root, 'card-a-mods');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(card);
    fs.mkdirSync(path.join(mods, 'm'), { recursive: true });
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'safe');
    fs.writeFileSync(path.join(mods, 'm', 'seed'), 'safe seed');
    const snapshot = saves.backupSaves(card, backups);
    fs.writeFileSync(path.join(snapshot.directory, 'mods', 'm', 'seed'), 'tampered');
    assert.throws(() => saves.restoreBackup(snapshot.id, card, backups), /verification failed/i);
    // a manifest path out of the folder is refused too
    const manifestPath = path.join(snapshot.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.mods = [{ name: '../escape', hash: manifest.mods[0].hash }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => saves.restoreBackup(snapshot.id, card, backups), /verification failed/i);
    assert.equal(fs.readFileSync(path.join(mods, 'm', 'seed'), 'utf8'), 'safe seed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupted backup does not replace current progress', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-corrupt-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'safe');
    const snapshot = saves.backupSaves(card, backups);
    fs.writeFileSync(path.join(snapshot.directory, 'files', 'GMSE01.dat'), 'tampered');
    assert.throws(() => saves.restoreBackup(snapshot.id, card, backups), /verification failed/i);
    assert.equal(fs.readFileSync(path.join(card, 'GMSE01.dat'), 'utf8'), 'safe');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a multiplayer guest save lives beside the memory card, not in it', () => {
  assert.equal(saves.guestSaveDirectory(path.join('/data', 'sms-port', 'card-a')), path.join('/data', 'sms-port', 'multiplayer-guest'));
});

test('an older launcher\'s guest save is moved out of the card folder, so backups work again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-guest-'));
  const card = path.join(root, 'card-a');
  try {
    fs.mkdirSync(path.join(card, 'multiplayer-guest'), { recursive: true });
    fs.writeFileSync(path.join(card, 'super_mario_sunshine.dat'), 'mine');
    fs.writeFileSync(path.join(card, 'multiplayer-guest', 'super_mario_sunshine.dat'), 'host');
    assert.throws(() => saves.backupSaves(card, path.join(root, 'backups')), /unexpected folder: multiplayer-guest/);
    assert.equal(saves.moveOldGuestSaves(card), true);
    assert.equal(fs.readFileSync(path.join(root, 'multiplayer-guest', 'super_mario_sunshine.dat'), 'utf8'), 'host');
    assert.equal(saves.backupSaves(card, path.join(root, 'backups')).count, 1);
    assert.equal(saves.moveOldGuestSaves(card), false, 'nothing left to move');
    // with a guest save beside the card already, the old copy is dropped
    fs.mkdirSync(path.join(card, 'multiplayer-guest'));
    assert.equal(saves.moveOldGuestSaves(card), true);
    assert.equal(fs.existsSync(path.join(card, 'multiplayer-guest')), false);
    assert.equal(fs.readFileSync(path.join(root, 'multiplayer-guest', 'super_mario_sunshine.dat'), 'utf8'), 'host');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
