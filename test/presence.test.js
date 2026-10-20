'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../src/presence');

const GAMEPLAY = 5, TITLE = 8, MOVIE = 6;

function game(fields) {
  return { state: GAMEPLAY, area: 1, episode: 0, shines: 0, blueCoins: 0, lives: 3, saveFile: 0, paused: 0, cutscene: 0, ...fields };
}

test('only the game\'s [presence] lines are read', () => {
  assert.deepEqual(presence.parseLine('[presence] {"state":5,"area":2,"episode":1}'), { state: 5, area: 2, episode: 1 });
  assert.equal(presence.isPresenceLine('[presence] {"state":5}'), true);
  for (const line of ['[port] platform ready', '[presence] not json', '[presence] {"area":2}', '', undefined])
    assert.equal(presence.parseLine(line), null);
});

test('a level shows its stage, episode, Shines and blue coins', () => {
  const activity = presence.activity(game({ area: 2, episode: 1, shines: 34, blueCoins: 12, lives: 5 }),
    { startedAt: 1700000000000, playtime: 42 * 3600 * 1000 });
  assert.equal(activity.details, 'Bianco Hills · Down with Petey Piranha!');
  assert.equal(activity.state, '34 / 120 Shines · 12 / 240 Blue Coins');
  assert.deepEqual(activity.timestamps, { start: 1700000000000 });
  assert.equal(activity.assets.large_image, 'bianco_hills');
  assert.equal(activity.assets.large_text, '5 lives · 42 h played');
  assert.equal(activity.assets.small_text, 'Played with SMS Launcher');
  assert.deepEqual(activity.buttons.map(button => button.url), [presence.LAUNCHER_URL, presence.DISCORD_URL]);
});

test('places, secret courses and bosses are named for their stage', () => {
  const details = fields => presence.activity(game(fields)).details;
  assert.equal(details({ area: 1 }), 'Delfino Plaza');
  assert.equal(details({ area: 0x1e }), 'Secret course · Ricco Harbor');
  assert.equal(details({ area: 0x37 }), 'Boss fight · Bianco Hills');
  assert.equal(details({ area: 0x34 }), 'Corona Mountain');
  assert.equal(details({ area: 7, episode: 2 }), 'Hotel Delfino · Mysterious Hotel Delfino');
  assert.equal(details({ area: 0xd, episode: 0 }), 'Pinna Park · Mecha-Bowser Appears!');
  assert.equal(details({ area: 200 }), undefined, 'an unknown area says only that the game is running');
});

test('menus, movies and pauses say so', () => {
  assert.equal(presence.activity(game({ area: 15 })).details, 'On the title screen');
  assert.equal(presence.activity(game({ state: 2 })).details, 'Starting up');
  assert.equal(presence.activity(game({ state: MOVIE })).details, 'Watching a cutscene');
  const select = presence.activity(game({ state: TITLE, area: 3, shines: 9 }));
  assert.equal(select.details, 'Choosing an episode');
  assert.equal(select.state, 'Ricco Harbor · 9 / 120 Shines');
  assert.equal(presence.activity(game({ area: 4, paused: 1, shines: 2 })).state, 'Paused · 2 / 120 Shines');
  assert.equal(presence.activity(game({ area: 4, cutscene: 1 })).state, 'Watching a cutscene');
});

test('Eclipse has its own areas, so only its counts are shown', () => {
  const activity = presence.activity(game({ area: 2, shines: 1, blueCoins: 3 }), { eclipse: true });
  assert.equal(activity.details, 'Playing Super Mario Eclipse');
  assert.equal(activity.state, '1 Shine · 3 Blue Coins');
  assert.equal(activity.assets.large_image, 'eclipse');
});

test('before the game reports anything, and in an older game, the activity is plain', () => {
  const activity = presence.activity(null, { startedAt: 5 });
  assert.equal(activity.details, undefined);
  assert.equal(activity.state, undefined);
  assert.equal(activity.assets.large_image, 'logo');
});

test('a room game can be joined from Discord: party, join secret, and no buttons beside Join', () => {
  const party = { code: 'KQ7M2D', players: 3, maxPlayers: 8 };
  const result = presence.activity({ state: 5, area: 2, episode: 0, shines: 4 }, { startedAt: 1, party });
  assert.equal(result.details, 'Bianco Hills · Road to the Big Windmill');
  assert.equal(result.state, 'Multiplayer');
  assert.deepEqual(result.party.size, [3, 8]);
  assert.equal(result.party.id, presence.partyId('KQ7M2D'));
  assert.ok(!result.party.id.includes('KQ7M2D'), 'the party ID does not give the code away');
  assert.deepEqual(result.secrets, { join: 'sms-room:KQ7M2D' });
  assert.equal(result.buttons, undefined);
  assert.equal(presence.secretRoom(result.secrets.join), 'KQ7M2D');
  assert.equal(presence.secretRoom('something else'), null);
  assert.equal(presence.activity({ state: 5, area: 2, episode: 0, paused: true }, { party }).state, 'Paused · Multiplayer');
  // the size stays one Discord takes
  assert.deepEqual(presence.activity(null, { party: { code: 'KQ7M2D', players: 0, maxPlayers: 0 } }).party.size, [1, 8]);
  assert.ok(presence.activity(null, {}).buttons, 'alone, the buttons stay');
});
