'use strict';

// Points src/game-release.json at another game commit for a CI build: Beta's
// newest game, or the sms-pc-port commit its "Launcher build" check builds
// (.github/workflows/game-build.yml). Never committed.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'game-release.json');
const { REPOSITORY, COMMIT, DECOMP, VERSION } = process.env;
for (const [name, value] of Object.entries({ COMMIT, DECOMP }))
  if (!/^[0-9a-f]{40}$/.test(value || '')) throw new Error(`${name} must be a full commit hash, not "${value || ''}".`);
const game = JSON.parse(fs.readFileSync(file, 'utf8'));
Object.assign(game, { version: VERSION || 'ci', commit: COMMIT, decomp: DECOMP }, REPOSITORY ? { repository: REPOSITORY } : {});
fs.writeFileSync(file, `${JSON.stringify(game, null, 2)}\n`);
process.stdout.write(`Building game ${game.version}: ${game.repository} ${COMMIT} (decomp ${DECOMP})\n`);
