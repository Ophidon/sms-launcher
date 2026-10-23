'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const achievements = require('../src/achievements');

function gameFolder(list) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-achievements-test-'));
  if (list) {
    fs.mkdirSync(path.join(root, 'ext', 'achievements'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ext', 'achievements', 'achievements.json'), JSON.stringify({ achievements: list }));
  }
  return root;
}

test('only the game\'s [achievement] lines are read', () => {
  assert.deepEqual(achievements.parseLine('[achievement] {"id":12,"time":1761170000}'), { id: 12, time: 1761170000 });
  assert.equal(achievements.isLine('[achievement] {"id":12}'), true);
  assert.equal(achievements.parseLine('[achievements] warning: achievement 63 can\'t find the 1-Up'), null);
  assert.equal(achievements.parseLine('[achievement] {"id":0,"time":1}'), null);
  assert.equal(achievements.parseLine('[achievement] {broken'), null);
  assert.ok(achievements.parseLine('[achievement] {"id":3}').time > 0);
});

test('the unlocks file keeps each achievement\'s first unlock and skips anything else', () => {
  const root = gameFolder(null), file = path.join(root, 'achievements.txt');
  fs.writeFileSync(file, '12 1761170000\r\n12 1761179999\nnot a line\n\n3 1761000000\n');
  assert.deepEqual([...achievements.readUnlocks(file)], [[12, 1761170000], [3, 1761000000]]);
  assert.equal(achievements.readUnlocks(path.join(root, 'missing.txt')).size, 0);
  fs.rmSync(root, { recursive: true });
});

test('the page lists the game\'s achievements with the player\'s unlocks', () => {
  const root = gameFolder([{ id: 1, title: 'Paint Job', description: 'Get the first Shine.', stage: 'Delfino Airstrip' },
    { id: 2, title: 'Guardian of the Statue', description: 'Clean the statue.', stage: 'Delfino Plaza' }, { title: 'no id' }]);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-achievements-user-'));
  fs.writeFileSync(achievements.file(userData), '2 1761170000\n');
  const state = achievements.state(root, { eclipse: false }, userData);
  assert.equal(state.supported, true);
  assert.equal(state.total, 2);
  assert.equal(state.unlocked, 1);
  assert.deepEqual(state.achievements.map(item => [item.id, item.unlockedAt]), [[1, null], [2, 1761170000]]);
  // Eclipse turns achievements off; an older game has no list.
  assert.equal(achievements.state(root, { eclipse: true }, userData).supported, false);
  const old = gameFolder(null);
  assert.equal(achievements.supported(old, { eclipse: false }), false);
  for (const folder of [root, userData, old]) fs.rmSync(folder, { recursive: true });
});
