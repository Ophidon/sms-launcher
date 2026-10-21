'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const port = require('../src/port');
const gameSettings = require('../src/game-settings');

function written(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-game-settings-'));
  const file = gameSettings.file(dir);
  fs.writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify({ settings }));
  return { dir, file };
}

test('the settings changed in the game become the launcher\'s, in its own values', () => {
  const { dir, file } = written({ msaa: 4, fxaa: true, widescreen: '21:9', musicVolume: 40, display: 'monitor2',
    exclusiveResolution: '2560x1440', fullscreenMode: 'exclusive', rumbleStrength: 75, vsync: 'adaptive' });
  try {
    const before = port.normalizeSettings({});
    const after = port.normalizeSettings(gameSettings.merge(before, gameSettings.read(file)));
    assert.deepEqual([after.msaa, after.fxaa, after.widescreen, after.musicVolume, after.display, after.exclusiveResolution,
      after.fullscreenMode, after.rumbleStrength, after.vsync], [4, true, '21:9', 40, 'monitor2', '2560x1440', 'exclusive', 75, 'adaptive']);
    assert.deepEqual(gameSettings.changedKeys(before, after).sort(),
      ['display', 'exclusiveResolution', 'fullscreenMode', 'fxaa', 'msaa', 'musicVolume', 'rumbleStrength', 'vsync', 'widescreen']);
    // unchanged settings stay the launcher's
    assert.equal(after.volume, before.volume);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a picture setting changed in the game makes the preset Custom unless the game chose the preset', () => {
  const ultra = port.normalizeSettings({ graphicsPreset: 'ultra', resolution: 4, msaa: 8, fxaa: true, anisotropic: 16, heatHaze: true });
  assert.equal(ultra.graphicsPreset, 'ultra');
  assert.equal(port.normalizeSettings(gameSettings.merge(ultra, { msaa: 2 })).graphicsPreset, 'custom');
  const high = { graphicsPreset: 'high', resolution: 3, msaa: 4, fxaa: true, anisotropic: 8, sharpen: 0, presentFilter: 'bilinear', heatHaze: true };
  assert.equal(port.normalizeSettings(gameSettings.merge(ultra, high)).graphicsPreset, 'high');
});

test('only the settings the game\'s menu has are taken, and a bad file changes nothing', () => {
  const { dir, file } = written({ msaa: 2, eclipse: true, arch: '32', keyBindings: { a: 'b' }, renderer: 'vulkan', volume: { loud: 1 } });
  try {
    assert.deepEqual(gameSettings.read(file), { msaa: 2 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const text of ['', '{', '[]', 'null', '{"settings": [1]}']) {
    const bad = written(text);
    try { assert.deepEqual(gameSettings.read(bad.file), {}, text); }
    finally { fs.rmSync(bad.dir, { recursive: true, force: true }); }
  }
  assert.deepEqual(gameSettings.read(path.join(os.tmpdir(), 'no-such-dir', 'game-settings.json')), {});
});

test('values the launcher does not offer fall back to its own (normalizeSettings)', () => {
  const after = port.normalizeSettings(gameSettings.merge(port.normalizeSettings({ resolution: 3 }), { resolution: 6, widescreen: 'wide', frameRate: 45 }));
  assert.deepEqual([after.resolution, after.widescreen, after.frameRate], [4, '16:9', 60]);
});
