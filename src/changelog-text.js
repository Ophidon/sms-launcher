'use strict';

// Turns one changelog line into what the What's new page shows: an optional
// tag ("Multiplayer: …"), a short bold headline, and the rest as details.
// Lines in changelog.json stay plain sentences; this only finds where to cut.
(function (root) {
  const TAG = /^([A-Z][A-Za-z]+(?: [A-Za-z]+){0,2}):\s+([\s\S]+)$/;
  const SENTENCE = /^([\s\S]+?[.!?])(?:\s+|$)([\s\S]*)$/;
  const LONG_HEADLINE = 95, LONGEST_CLAUSE = 120;

  const capitalize = text => text ? text[0].toUpperCase() + text.slice(1) : text;

  // The first ", " far enough in to make a headline, outside brackets: "tabs (Gameplay, Display)" stays whole.
  function clauseEnd(sentence) {
    let depth = 0;
    for (let i = 0; i < Math.min(sentence.length, LONGEST_CLAUSE); i++) {
      if (sentence[i] === '(') depth++;
      else if (sentence[i] === ')') depth = Math.max(0, depth - 1);
      else if (i >= 30 && !depth && sentence.startsWith(', ', i)) return i;
    }
    return -1;
  }

  function splitChange(text) {
    text = String(text || '').trim();
    let tag = null, rest = text;
    const prefix = text.match(TAG);
    if (prefix) { tag = prefix[1]; rest = capitalize(prefix[2]); }
    const fix = /^Fixed\b/.test(rest);
    // The headline is the first sentence, or the words before a colon in it.
    const sentence = rest.match(SENTENCE);
    let headline = sentence ? sentence[1] : rest, body = sentence ? sentence[2] : '';
    const colon = rest.indexOf(': ');
    if (colon > 0 && colon < LONG_HEADLINE && colon < headline.length) {
      headline = rest.slice(0, colon);
      body = capitalize(rest.slice(colon + 2));
    }
    // One long sentence keeps reading on from its first clause: only that part is bold.
    // Its details then follow on in the same paragraph.
    let runOn = '';
    const comma = headline.length > LONG_HEADLINE ? clauseEnd(headline) : -1;
    if (comma >= 0) {
      runOn = headline.slice(comma) + (body ? ` ${body}` : '');
      headline = headline.slice(0, comma);
      body = '';
    }
    if (!runOn) headline = headline.replace(/\.$/, '');
    return { tag, fix, headline, runOn, body };
  }

  const api = { splitChange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.smsChangelogText = api;
})(typeof globalThis === 'object' ? globalThis : this);
