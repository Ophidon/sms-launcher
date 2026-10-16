'use strict';

// Customize Mario in the game: Mario's textures repainted in the player's
// colours, written as a texture pack the game reads before every other one
// (SMS_MARIO_LOOK). Each image is named after the disc texture it replaces, as
// the game names pack textures; where an HD pack has that texture, its HD
// image is the one repainted, so Mario stays HD.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const { rarc } = require('./archive');
const j3d = require('./j3d');
const colors = require('./mario-colors');
const image = require('./texture-image');
const { xxh64 } = require('./xxh64');
const { partOf } = require('./mario-model');

// Bumped whenever baking changes, so older packs are made again.
const VERSION = 1;
// The parts' order when several cover one texel of the atlas.
const PRIORITY = ['cap', 'head', 'hands', 'feet', 'body', 'aloha', 'eye', 'mouth'];
// Super Mario Eclipse's other playable characters, each with a model of its own.
const OTHER_CHARACTERS = ['data/luigi.szs', 'data/piantissimo.szs', 'data/shadow_mario.szs'];

// The game's pack name for a disc texture (gx_hires.cpp hiresName).
function packName({ width, height, mipmapped, level, format }) {
  return `tex1_${width}x${height}${mipmapped ? '_m' : ''}_${xxh64(level)}_${format}`;
}

// Every texture Mario's colours touch: its pack name, its disc pixels, and the
// parts (with their triangles) drawn with it. Eyes have five blink frames,
// drawn with the same triangles.
function targets(model) {
  const byName = new Map();
  const eyeFrames = model.textures.filter(t => /^H_ma_eye\d/i.test(t.name));
  model.shapes.forEach((shape, i) => {
    const part = partOf(shape, model, i);
    if (!colors.PARTS[part]) return;
    const material = model.materials[shape.material];
    const sources = part === 'eye' ? eyeFrames : [model.textures[material.textures[0]]];
    for (const source of sources) {
      const name = packName(source);
      if (!byName.has(name)) byName.set(name, { name, source, parts: new Map() });
      const parts = byName.get(name).parts;
      if (!parts.has(part)) parts.set(part, []);
      parts.get(part).push(shape);
    }
  });
  return [...byName.values()];
}

// The pack names of the textures other characters on this disc draw. The game
// finds pack images by texture, not by model, so a texture Mario shares with
// them (Eclipse's Luigi and Piantissimo use his mouth) is left as it is.
function othersTextures(disc) {
  const names = new Set();
  for (const archive of OTHER_CHARACTERS) {
    if (!disc.files.has(archive)) continue;
    for (const [file, data] of rarc(disc.file(archive)))
      if (/\.bmd$/i.test(file)) for (const texture of j3d.parseBmd(data).textures) names.add(packName(texture));
  }
  return names;
}

// The images the game would load for each name, from these pack folders, in
// the game's order (the first folder with a name wins).
function packIndex(directories) {
  const index = new Map();
  const walk = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      // Folders linked into a pack count, as the game follows them.
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) try { folder = fs.statSync(file).isDirectory(); } catch (_) { continue; }
      if (folder) { if (entry.name !== 'widescreen_stars_fix') walk(file); continue; }
      const match = /^(tex1_.+?)(_arb)?\.(png|dds)$/i.exec(entry.name);
      if (match && !index.has(match[1])) index.set(match[1], file);
    }
  };
  for (const directory of directories) walk(directory);
  return index;
}

// One texture repainted: each part's texels sorted into regions and repainted,
// then merged, each texel from the first part (by PRIORITY) that covers it.
function repaint({ width, height, rgba }, parts, references, chosen, { wrapS = 0, wrapT = 0 } = {}) {
  const out = Uint8Array.from(rgba), lightness = colors.lightness(rgba);
  const painted = [...parts.entries()].sort(([a], [b]) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b)).map(([part, shapes]) => {
    const covered = new Uint8Array(width * height);
    for (const shape of shapes) colors.coverage(width, height, shape.uv, shape.index, covered, wrapS, wrapT);
    const texture = { rgba, width, height, mask: colors.classify(rgba, width, height, part, covered), lightness };
    Object.assign(texture, colors.blendEdges(texture, references));
    return { mask: texture.mask, pixels: colors.recolor(texture, references, chosen) };
  });
  const done = new Uint8Array(width * height);
  for (const { mask, pixels } of painted) for (let i = 0; i < done.length; i++) {
    if (done[i] || mask[i] === 255) continue;
    done[i] = 1;
    out.set(pixels.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return out;
}

function stamp(file) {
  try { const s = fs.statSync(file); return [file, s.size, s.mtimeMs]; } catch (_) { return [file, 0, 0]; }
}

// Writes the pack for `look` into `directory` (replacing what was there) and
// returns it, or removes it and returns null when no colour is chosen. A pack
// already made for the same look, disc and HD images is kept as it is.
// `rom` is the disc the game plays (Eclipse's own with Eclipse on); `references`
// are the regions' typical colours from loadMario, so the game matches the
// customizer's preview.
function bake({ rom, look, references, packDirectories = [], directory }) {
  const chosen = colors.normalize(look?.colors);
  if (!Object.keys(chosen).length) {
    fs.rmSync(directory, { recursive: true, force: true });
    return null;
  }
  const disc = new Disc(rom);
  let files, shared;
  try { files = rarc(disc.file('data/mario.szs')); shared = othersTextures(disc); }
  finally { disc.close(); }
  const model = j3d.parseBmd(files.get('bmd/ma_mdl1.bmd'));
  const index = packIndex(packDirectories);
  const list = targets(model).filter(target => !shared.has(target.name)).map(target => ({ ...target, hd: index.get(target.name) || null }));
  const key = crypto.createHash('sha256').update(JSON.stringify({
    VERSION, chosen, rom: stamp(rom), hd: list.map(t => t.hd && stamp(t.hd)),
  })).digest('hex');
  try {
    if (JSON.parse(fs.readFileSync(path.join(directory, 'look.json'), 'utf8')).key === key) return directory;
  } catch (_) { /* not made yet */ }

  const temporary = `${directory}.making`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  for (const target of list) {
    const source = target.hd ? image.readImage(target.hd) : target.source;
    const pixels = repaint(source, target.parts, references, chosen, target.source);
    fs.writeFileSync(path.join(temporary, `${target.name}.png`), image.writePng(source.width, source.height, pixels));
  }
  fs.writeFileSync(path.join(temporary, 'look.json'), JSON.stringify({ key, colors: chosen }, null, 2));
  fs.rmSync(directory, { recursive: true, force: true });
  fs.renameSync(temporary, directory);
  return directory;
}

module.exports = { bake, packName, targets, othersTextures, packIndex, repaint };
