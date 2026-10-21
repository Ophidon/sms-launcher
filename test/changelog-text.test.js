'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitChange } = require('../src/changelog-text');

test('a changelog line becomes a tag, a headline and its details', () => {
  assert.deepEqual(splitChange('Radar: turn on a round map at the top right of the game under Gameplay. It shows the area close around Mario.'),
    { tag: 'Radar', fix: false, headline: 'Turn on a round map at the top right of the game under Gameplay', runOn: '', body: 'It shows the area close around Mario.' });
  assert.deepEqual(splitChange('The launcher has a new logo: a golden sun at the top left.'),
    { tag: null, fix: false, headline: 'The launcher has a new logo', runOn: '', body: 'A golden sun at the top left.' });
  assert.deepEqual(splitChange('Fixed every player\'s level restarting when the host lost a life in multiplayer.'),
    { tag: null, fix: true, headline: 'Fixed every player\'s level restarting when the host lost a life in multiplayer', runOn: '', body: '' });
});

test('a fix behind a tag is still a fix', () => {
  const change = splitChange('Multiplayer: fixed coins no longer being shared.');
  assert.equal(change.tag, 'Multiplayer');
  assert.equal(change.fix, true);
  assert.equal(change.headline, 'Fixed coins no longer being shared');
});

test('one long sentence is bold only up to its first clause, and the rest reads on', () => {
  const text = 'When the launcher\'s folder is too deep for Windows to build the game in, as with a portable launcher kept inside another app\'s folder, it now says so.';
  const change = splitChange(text);
  assert.equal(change.headline, 'When the launcher\'s folder is too deep for Windows to build the game in');
  assert.equal(change.headline + change.runOn, text);
  assert.equal(change.body, '');
});

test('a sentence that is not a tag keeps its colon in the headline cut', () => {
  const change = splitChange('Auto Save, on by default under Settings → Gameplay: the game saves by itself after Shine Sprites.');
  assert.equal(change.tag, null);
  assert.equal(change.headline, 'Auto Save, on by default under Settings → Gameplay');
  assert.equal(change.body, 'The game saves by itself after Shine Sprites.');
});

test('the run-on carries the details with it, and a comma in brackets is no place to cut', () => {
  const change = splitChange('Up to eight players play the host\'s level and save together as Mario, Luigi and Wario, sharing coins and lives. Friends can join once the host has picked a save file.');
  assert.equal(change.headline, 'Up to eight players play the host\'s level and save together as Mario');
  assert.equal(change.runOn, ', Luigi and Wario, sharing coins and lives. Friends can join once the host has picked a save file.');
  assert.equal(change.body, '');
  const tabs = splitChange('Settings now has tabs down the side (Gameplay, Display, Graphics, Controls, Manage game, Saves and Launcher), so each setting is easier to find.');
  assert.equal(tabs.headline, 'Settings now has tabs down the side (Gameplay, Display, Graphics, Controls, Manage game, Saves and Launcher)');
});
