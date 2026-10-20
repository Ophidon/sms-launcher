'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const discord = require('../src/discord');

test('frames survive being split across chunks and joined in one', () => {
  const frames = [];
  const decode = discord.createDecoder((op, data) => frames.push([op, data]));
  const bytes = Buffer.concat([discord.encode(1, { evt: 'READY' }), discord.encode(3, { n: 1 })]);
  decode(bytes.subarray(0, 5));
  decode(bytes.subarray(5, 20));
  decode(bytes.subarray(20));
  assert.deepEqual(frames, [[1, { evt: 'READY' }], [3, { n: 1 }]]);
});

test('Discord is looked for in its usual places, discord-ipc-0 first', () => {
  assert.equal(discord.socketPaths('win32')[0], '\\\\?\\pipe\\discord-ipc-0');
  const paths = discord.socketPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.equal(paths[0], '/run/user/1000/discord-ipc-0');
  assert.ok(paths.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
  assert.ok(paths.includes('/tmp/snap.discord/discord-ipc-0'));
  assert.ok(paths.indexOf('/tmp/discord-ipc-0') < paths.indexOf('/run/user/1000/discord-ipc-1'));
});

// A stand-in for the Discord app on a local socket.
function fakeDiscord(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-discord-'));
  // Windows can only listen on a named pipe, which is also where Discord is found there.
  const file = process.platform === 'win32' ? `\\\\?\\pipe\\${path.basename(dir)}-discord-ipc-0`
    : path.join(dir, 'discord-ipc-0');
  const received = [], waiters = [];
  let client = null;
  const server = net.createServer(socket => {
    client = socket;
    socket.on('data', discord.createDecoder((op, data) => {
      received.push({ op, data });
      if (op === discord.OP.HANDSHAKE) socket.write(discord.encode(discord.OP.FRAME, { cmd: 'DISPATCH', evt: 'READY' }));
      waiters.splice(0).forEach(resolve => resolve());
    }));
  });
  t.after(() => { client?.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const next = count => received.length >= count ? Promise.resolve()
    : new Promise(resolve => waiters.push(resolve)).then(() => next(count));
  const send = data => client.write(discord.encode(discord.OP.FRAME, data));
  return new Promise(resolve => server.listen(file, () => resolve({ file, received, next, send, closed: () => new Promise(done => {
    if (!client || client.destroyed) return done();
    client.once('close', done);
  }) })));
}

test('an activity is sent after the handshake, and repeats and bursts are held back', async t => {
  const fake = await fakeDiscord(t);
  let clock = 1000;
  const timers = [];
  const presence = discord.createPresence({ clientId: '42', platform: process.platform, paths: [fake.file], pid: 7,
    now: () => clock, setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => {} });
  presence.set({ details: 'Bianco Hills' });
  await fake.next(2);
  assert.deepEqual(fake.received[0], { op: discord.OP.HANDSHAKE, data: { v: 1, client_id: '42' } });
  assert.equal(fake.received[1].data.cmd, 'SET_ACTIVITY');
  assert.deepEqual(fake.received[1].data.args, { pid: 7, activity: { details: 'Bianco Hills' } });

  presence.set({ details: 'Bianco Hills' });
  presence.set({ details: 'Ricco Harbor' });
  assert.equal(timers.length, 1, 'the second change waits for the rate limit');
  assert.equal(timers[0].ms, discord.MIN_INTERVAL);
  clock += discord.MIN_INTERVAL;
  timers[0].callback();
  await fake.next(3);
  assert.deepEqual(fake.received[2].data.args.activity, { details: 'Ricco Harbor' });

  presence.stop();
  await fake.closed();
});

test('without Discord nothing connects, and it is looked for again later', () => {
  const timers = [], connects = [];
  const presence = discord.createPresence({ platform: 'linux', paths: ['/nonexistent/discord-ipc-0'],
    connect: target => { connects.push(target); throw new Error('not expected'); },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout: () => {} });
  presence.set({ details: 'Delfino Plaza' });
  assert.deepEqual(connects, []);
  assert.deepEqual(timers.map(timer => timer.ms), [discord.RETRY]);
  presence.stop();
});

test('listening, the launcher hears game invites and join requests, and clears the activity rather than leaving', async t => {
  const fake = await fakeDiscord(t);
  let clock = 1000;
  const timers = [], joins = [], asks = [];
  const presence = discord.createPresence({ clientId: '42', platform: process.platform, paths: [fake.file], pid: 7,
    now: () => clock, setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => {}, onJoin: secret => joins.push(secret), onJoinRequest: user => asks.push(user) });
  presence.listen(true);
  await fake.next(3);
  assert.deepEqual(fake.received.slice(1).map(({ data }) => [data.cmd, data.evt]),
    [['SUBSCRIBE', 'ACTIVITY_JOIN'], ['SUBSCRIBE', 'ACTIVITY_JOIN_REQUEST']], 'no activity while only listening');

  fake.send({ cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN', data: { secret: 'sms-room:KQ7M2D' } });
  fake.send({ cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN_REQUEST', data: { user: { id: '99', username: 'luigi' } } });
  for (let i = 0; i < 40 && asks.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(joins, ['sms-room:KQ7M2D']);
  assert.equal(asks[0].id, '99');

  assert.equal(presence.reply('99', true), true);
  await fake.next(4);
  assert.deepEqual([fake.received[3].data.cmd, fake.received[3].data.args], ['SEND_ACTIVITY_JOIN_INVITE', { user_id: '99' }]);

  presence.set({ details: 'Bianco Hills' });
  await fake.next(5);
  assert.deepEqual(fake.received[4].data.args, { pid: 7, activity: { details: 'Bianco Hills' } });
  clock += discord.MIN_INTERVAL;
  presence.stop();
  await fake.next(6);
  assert.deepEqual(fake.received[5].data.args, { pid: 7 }, 'the game closed: the activity is cleared');

  presence.listen(false);
  await fake.closed();
});

test('Discord can start the launcher: Electron registers it on Windows and macOS, a hidden entry on Linux', t => {
  const calls = [];
  discord.registerLaunch({ platform: 'win32', clientId: '42', execPath: 'C:\\SMS Launcher.exe',
    setProtocolClient: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['discord-42', 'C:\\SMS Launcher.exe', []]]);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-discord-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runs = [];
  const linux = () => discord.registerLaunch({ platform: 'linux', clientId: '42', execPath: '/home/me/My Games/SMS-Launcher.AppImage',
    args: ['--no-sandbox'], home, env: {}, run: (...args) => runs.push(args) });
  assert.equal(linux(), true);
  const entry = fs.readFileSync(path.join(home, '.local/share/applications/discord-42.desktop'), 'utf8');
  assert.match(entry, /^Exec="\/home\/me\/My Games\/SMS-Launcher.AppImage" --no-sandbox %u$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/discord-42;$/m);
  assert.match(entry, /^NoDisplay=true$/m);
  assert.deepEqual(runs, [['xdg-mime', ['default', 'discord-42.desktop', 'x-scheme-handler/discord-42']]]);
  assert.equal(linux(), false, 'unchanged: written once');
  assert.equal(runs.length, 1);

  assert.equal(discord.isLaunchUrl('discord-42://', '42'), true);
  assert.equal(discord.isLaunchUrl('--no-sandbox', '42'), false);
});
