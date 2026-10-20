'use strict';

// Discord Rich Presence through the Discord app's local socket (a named pipe
// on Windows): a handshake with our application ID, then SET_ACTIVITY frames.
// Discord drops the activity when the socket closes, so stop() only closes it
// (or clears it, while the launcher listens for game invites).
// Without Discord running nothing happens; it is looked for again now and then.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const CLIENT_ID = '1557924964869480578';
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
// Discord accepts five activity updates per 20 seconds.
const MIN_INTERVAL = 4000;
const RETRY = 20000;

function encode(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// Socket bytes -> whole frames, keeping a partial frame for the next chunk.
function createDecoder(onFrame) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32LE(4)) {
      const op = buffer.readUInt32LE(0), end = 8 + buffer.readUInt32LE(4);
      let data = null;
      try { data = JSON.parse(buffer.toString('utf8', 8, end)); } catch (_) { /* not JSON */ }
      buffer = buffer.subarray(end);
      onFrame(op, data);
    }
  };
}

// Where Discord listens, most likely first: discord-ipc-0 in each folder before -1.
// Flatpak and Snap Discord, and Vesktop's Flatpak, put it in a subfolder.
function socketPaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const bases = [...new Set([env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean))];
  const folders = ['', 'app/com.discordapp.Discord', 'app/com.discordapp.DiscordCanary', 'snap.discord',
    'snap.discord-canary', '.flatpak/dev.vencord.Vesktop/xdg-run'];
  const paths = [];
  for (let i = 0; i < 10; ++i)
    for (const base of bases) for (const folder of folders) paths.push(path.posix.join(base, folder, `discord-ipc-${i}`));
  return paths;
}

// `listen` keeps the connection while no activity shows, so a friend's game
// invite still reaches the launcher (onJoin gets the invite's join secret);
// onJoinRequest hears friends who "Ask to Join", answered with reply().
function createPresence({ clientId = CLIENT_ID, platform = process.platform, paths = socketPaths(platform),
  exists = platform === 'win32' ? () => true : fs.existsSync, connect = target => net.createConnection(target),
  pid = process.pid, now = Date.now, setTimeout = global.setTimeout, clearTimeout = global.clearTimeout,
  log = () => {}, onJoin = null, onJoinRequest = null } = {}) {
  let socket = null, ready = false, connecting = false, timer = null, listening = false;
  // `sent` is the activity Discord shows: 'null' for none, as on a new connection.
  let wanted = null, sent = 'null', sentAt = -Infinity;
  const needed = () => Boolean(wanted) || listening;

  function later(callback, ms) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; callback(); }, ms);
  }

  function command(cmd, args, evt) {
    socket.write(encode(OP.FRAME, { cmd, args, evt, nonce: crypto.randomUUID() }));
  }

  function update() {
    if (!needed()) return;
    if (!socket) { if (!connecting) open(); return; }
    if (!ready) return;
    const body = JSON.stringify(wanted);
    if (body === sent) return;
    const wait = sentAt + MIN_INTERVAL - now();
    if (wait > 0) return later(update, wait);
    sent = body;
    sentAt = now();
    // no activity clears the one shown
    command('SET_ACTIVITY', wanted ? { pid, activity: wanted } : { pid });
  }

  function close() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (socket) { const closing = socket; socket = null; ready = false; closing.destroy(); }
  }

  function open() {
    connecting = true;
    const candidates = paths.filter(target => exists(target));
    const attempt = index => {
      if (!needed()) { connecting = false; return; }
      if (index >= candidates.length) { connecting = false; return later(update, RETRY); }
      const candidate = connect(candidates[index]);
      candidate.once('error', () => { candidate.destroy(); attempt(index + 1); });
      candidate.once('connect', () => {
        candidate.removeAllListeners('error');
        connecting = false;
        if (!needed()) return candidate.destroy();
        attach(candidate);
      });
    };
    attempt(0);
  }

  function dispatch(data) {
    if (data.evt === 'READY') {
      ready = true;
      if (onJoin) command('SUBSCRIBE', {}, 'ACTIVITY_JOIN');
      if (onJoinRequest) command('SUBSCRIBE', {}, 'ACTIVITY_JOIN_REQUEST');
      update();
    } else if (data.evt === 'ACTIVITY_JOIN' && typeof data.data?.secret === 'string') onJoin?.(data.data.secret);
    else if (data.evt === 'ACTIVITY_JOIN_REQUEST' && data.data?.user?.id) onJoinRequest?.(data.data.user);
    else if (data.evt === 'ERROR') log(data.cmd === 'SET_ACTIVITY'
      ? `Discord did not accept the activity: ${data.data?.message || 'unknown error'}`
      : `Discord refused ${data.cmd || 'a request'}: ${data.data?.message || 'unknown error'}`);
  }

  function attach(candidate) {
    socket = candidate;
    candidate.on('error', () => {});
    candidate.on('data', createDecoder((op, data) => {
      if (op === OP.PING) candidate.write(encode(OP.PONG, data));
      else if (op === OP.CLOSE) {
        log(`Discord closed the connection: ${data?.message || 'no reason given'}`);
        candidate.destroy();
      } else if (data) dispatch(data);
    }));
    candidate.on('close', () => {
      if (socket !== candidate) return;
      socket = null; ready = false; sent = 'null';
      if (needed()) later(update, RETRY);
    });
    candidate.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
  }

  return {
    set(activity) { wanted = activity || null; update(); },
    listen(on) {
      listening = Boolean(on);
      if (needed()) update();
      else { sent = 'null'; close(); }
    },
    // Answers a friend's "Ask to Join": an invite (with the join secret) or a no.
    reply(userId, accept) {
      if (!ready) return false;
      command(accept ? 'SEND_ACTIVITY_JOIN_INVITE' : 'CLOSE_ACTIVITY_REQUEST', { user_id: String(userId) });
      return true;
    },
    // Discord drops the activity when the socket closes; a listening launcher clears it instead.
    stop() {
      wanted = null;
      if (listening) return update();
      sent = 'null';
      close();
    }
  };
}

// How Discord starts the launcher when a friend's game invite is accepted with
// the launcher closed: it opens discord-<application ID>://, which each system
// sends to the program registered for it (what Discord's own discord-rpc
// library registers). Windows and macOS through Electron
// (app.setAsDefaultProtocolClient; macOS also needs the scheme in Info.plist,
// package.json's build.protocols); Linux through a hidden .desktop entry.
const launchScheme = (clientId = CLIENT_ID) => `discord-${clientId}`;

// A launcher argument (or macOS open-url) Discord started it with.
const isLaunchUrl = (value, clientId = CLIENT_ID) => typeof value === 'string' && value.startsWith(`${launchScheme(clientId)}:`);

// The Desktop Entry spec's quoting: arguments in double quotes, with " ` $ \ escaped; % doubled.
function desktopArg(value) {
  const text = String(value).replace(/%/g, '%%');
  return /^[A-Za-z0-9_\-.,/:=+]+$/.test(text) ? text : `"${text.replace(/(["`$\\])/g, '\\$1')}"`;
}

function desktopEntry({ execPath, args = [], clientId = CLIENT_ID, name = 'SMS Launcher' }) {
  return ['[Desktop Entry]', `Name=${name}`, `Exec=${[execPath, ...args].map(desktopArg).join(' ')} %u`, 'Type=Application',
    'NoDisplay=true', 'Categories=Discord;Games;', `MimeType=x-scheme-handler/${launchScheme(clientId)};`, ''].join('\n');
}

// Registers how to start the launcher (execPath with args), once: the Linux entry is only rewritten when it changed.
function registerLaunch({ execPath, args = [], clientId = CLIENT_ID, platform = process.platform, setProtocolClient,
  home = os.homedir(), env = process.env, run = (file, list) => execFile(file, list, () => {}) } = {}) {
  const scheme = launchScheme(clientId);
  if (platform !== 'linux') return setProtocolClient(scheme, execPath, args);
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const file = path.join(data, 'applications', `${scheme}.desktop`);
  const entry = desktopEntry({ execPath, args, clientId });
  try { if (fs.readFileSync(file, 'utf8') === entry) return false; } catch (_) { /* not there yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entry);
  run('xdg-mime', ['default', `${scheme}.desktop`, `x-scheme-handler/${scheme}`]);
  return true;
}

module.exports = { CLIENT_ID, OP, MIN_INTERVAL, RETRY, encode, createDecoder, socketPaths, createPresence,
  launchScheme, isLaunchUrl, desktopEntry, registerLaunch };
