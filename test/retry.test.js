'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retrying, httpError, GIT_PERMANENT } = require('../src/retry');

test('a failing download is tried again after a growing pause, up to its tries', async () => {
  const waits = [], retried = [];
  let calls = 0;
  const result = await retrying(async n => { calls++; if (n < 3) throw new Error(`drop ${n}`); return 'done'; },
    { wait: async ms => waits.push(ms), onRetry: (error, n) => retried.push([error.message, n]) });
  assert.equal(result, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);
  assert.deepEqual(retried, [['drop 1', 1], ['drop 2', 2]]);
  calls = 0;
  await assert.rejects(retrying(async () => { calls++; throw new Error('still down'); }, { wait: async () => {} }), /still down/);
  assert.equal(calls, 3);
});

test('what waiting cannot fix fails at once', async () => {
  const once = async error => {
    let calls = 0;
    await assert.rejects(retrying(async () => { calls++; throw error; }, { wait: async () => {},
      permanent: failure => GIT_PERMANENT.test(failure.message) }));
    return calls;
  };
  assert.equal(await once(httpError('missing', 404)), 1);
  assert.equal(await once(httpError('forbidden', 403)), 1);
  assert.equal(await once(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })), 1);
  assert.equal(await once(new Error("fatal: couldn't find remote ref nope")), 1);
  assert.equal(await once(new Error('remote: Repository not found.')), 1);
  // Busy, rate limited, or a dropped connection: worth another try.
  assert.equal(await once(httpError('busy', 503)), 3);
  assert.equal(await once(httpError('slow down', 429)), 3);
  assert.equal(await once(new Error('fatal: early EOF')), 3);
});
