'use strict';

// Downloads that fail partway (a dropped connection, a timeout, a server that
// is briefly down) are tried again a few times before the player sees an
// error. What can't get better by waiting (a 404, a checksum on a server that
// keeps sending the wrong file, the player pressing Stop) is marked permanent.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Git's messages for a ref, repository or login that isn't there, and for a
// download the player stopped: trying again gives the same answer.
const GIT_PERMANENT = /not our ref|couldn't find remote ref|Repository not found|Authentication failed|could not read Username|terminated by/i;

// HTTP statuses worth another try: the server timed out, rate limited us, or failed.
const retryableStatus = status => status === 408 || status === 429 || status >= 500;

// attempt(n) until it succeeds, it fails `tries` times, or permanent(error).
async function retrying(attempt, { tries = 3, wait = sleep, delay = n => n * 2000, permanent = () => false,
  onRetry = () => {} } = {}) {
  for (let n = 1; ; n++) {
    try { return await attempt(n); }
    catch (error) {
      // ENOENT: a program or file that is missing won't appear by waiting.
      if (n >= tries || error?.permanent || error?.code === 'ENOENT' || permanent(error)) throw error;
      onRetry(error, n);
      await wait(delay(n));
    }
  }
}

// An error for an HTTP status, permanent unless waiting might change it.
function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  error.permanent = !retryableStatus(status);
  return error;
}

module.exports = { sleep, GIT_PERMANENT, retryableStatus, retrying, httpError };
