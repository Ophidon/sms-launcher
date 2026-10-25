#!/usr/bin/env python3
"""Run one of the port's installers with downloads that survive a dropped connection.

usage: resume_downloads.py SCRIPT [ARGS...]

The port's installers (HD textures, Eclipse, HD cutscenes, language packs)
download multi-gigabyte files with urllib.request.urlopen and fail outright
when the connection drops, stalls or the server is briefly down. This wraps
urlopen so such a download waits, reconnects and carries on from the byte it
had reached (an HTTP Range request), up to TRIES times, before the installer
sees an error. The installer still owns its URLs, checksums and installation:
a download resumed into a different file fails its checksum as before.
texture-progress.py uses it too.

What a download had received is also kept on disk (KEEP, under the game's
folder) until it completes, so a later try, the installer's own or the next
Update & play after the launcher was stopped or closed, carries on from there
instead of starting over. It is used only when the server says the file is
unchanged (the same ETag or Last-Modified, and an If-Range request it answers
with the rest); otherwise the download starts over.
"""

import hashlib
import http.client
import json
import os
import runpy
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

TRIES = 5
# A connection that sends nothing for this long counts as dropped, not as
# slow: without it a stalled download waits forever.
TIMEOUT = 60
# Where unfinished downloads are kept between tries, relative to the
# installer's working folder (the game's), and for how long.
KEEP = os.environ.get("SMS_DOWNLOAD_KEEP") or os.path.join("mods", ".downloads", "resume")
KEEP_DAYS = 14


def say(message):
    print(message, flush=True)


def mib(n):
    return "%.0f MiB" % (n / 1048576.0)


class Permanent(OSError):
    """A failure waiting won't fix; installers still see an OSError."""


def transient(error):
    if isinstance(error, Permanent):
        return False
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (408, 429) or error.code >= 500
    if isinstance(error, urllib.error.URLError):
        return not isinstance(error.reason, (ssl.SSLCertVerificationError, ValueError))
    return isinstance(error, (OSError, http.client.HTTPException))


def pause(attempt):
    time.sleep(min(2 ** attempt, 20))


def range_start(response):
    return (response.headers.get("Content-Range") or "").split(" ")[-1].split("-")[0]


def forget(*paths):
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


def prune(folder):
    try:
        names = os.listdir(folder)
    except OSError:
        return
    oldest = time.time() - KEEP_DAYS * 86400
    for name in names:
        path = os.path.join(folder, name)
        try:
            if os.path.getmtime(path) < oldest:
                os.remove(path)
        except OSError:
            pass


def request_from(target, headers=None):
    if isinstance(target, urllib.request.Request):
        # The installer's own headers only. urllib adds Host (and others) to the
        # request it opened; copied here, a Host of github.com would follow the
        # redirect to GitHub's download servers, which answer "Domain Not Found".
        own = {name: value for name, value in target.headers.items() if name.lower() != "host"}
        request = urllib.request.Request(target.full_url, headers=own, method=target.get_method())
    else:
        request = urllib.request.Request(target)
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    return request


class ResumingResponse:
    """The first response's headers, with a body read across reconnections."""

    def __init__(self, open_url, target, timeout):
        self.open_url, self.target, self.timeout = open_url, target, timeout
        for attempt in range(1, TRIES + 1):
            try:
                self.response = self.first = open_url(target, timeout=timeout)
                break
            except (OSError, http.client.HTTPException) as error:
                if attempt == TRIES or not transient(error):
                    raise
                say("  could not connect (%s); trying again (%d of %d)" % (error, attempt + 1, TRIES))
                pause(attempt)
        length = self.first.headers.get("Content-Length")
        self.total = int(length) if self.first.status == 200 and length and length.isdigit() else None
        self.validator = self.first.headers.get("ETag") or self.first.headers.get("Last-Modified")
        self.received = 0
        # kept: the file of what was received, for a later try; earlier: the
        # part of it from an earlier try, read back before the rest arrives.
        self.kept = self.earlier = None
        self.keep()

    def keep(self):
        if self.total is None or not self.validator:
            return
        url = self.target.full_url if isinstance(self.target, urllib.request.Request) else str(self.target)
        name = os.path.join(KEEP, hashlib.sha256(url.encode("utf-8")).hexdigest()[:24])
        self.part, self.record = name + ".part", name + ".json"
        wanted = {"url": url, "validator": self.validator, "total": self.total}
        try:
            prune(KEEP)
            with open(self.record, encoding="utf-8") as f:
                had = os.path.getsize(self.part) if json.load(f) == wanted else 0
        except (OSError, ValueError):
            had = 0
        if 0 < had < self.total:
            resumed = None
            try:
                resumed = self.open_url(request_from(self.target, {"Range": "bytes=%d-" % had,
                                                                   "If-Range": self.validator}), timeout=self.timeout)
                if resumed.status == 206 and range_start(resumed) == str(had):
                    self.earlier, self.kept = open(self.part, "rb"), open(self.part, "ab")
                    self.first.close()
                    self.response = resumed
                    say("  carrying on from the %s of %s downloaded before" % (mib(had), mib(self.total)))
                    return
            except (OSError, http.client.HTTPException):
                pass
            for f in (resumed, self.earlier, self.kept):
                if f is not None:
                    f.close()
            self.earlier = self.kept = None
        # Nothing to carry on from: keep this download from its first byte.
        try:
            os.makedirs(KEEP, exist_ok=True)
            forget(self.part, self.record)
            self.kept = open(self.part, "wb")
            with open(self.record, "w", encoding="utf-8") as f:
                json.dump(wanted, f)
        except OSError:
            self.stop_keeping()

    def stop_keeping(self, done=False):
        if self.kept is not None:
            try:
                self.kept.close()
            except OSError:
                pass
        if self.earlier is not None:
            self.earlier.close()
        self.kept = self.earlier = None
        if done:
            forget(self.part, self.record)

    def read(self, amt=None):
        if amt is None or amt < 0:
            parts = []
            while True:
                part = self.read(1 << 20)
                if not part:
                    return b"".join(parts)
                parts.append(part)
        if self.earlier is not None:
            chunk = self.earlier.read(amt)
            if chunk:
                self.received += len(chunk)
                return chunk
            self.earlier.close()
            self.earlier = None
        failures = 0
        while True:
            try:
                if self.response is None:
                    self.response = self.reopen()
                chunk = self.response.read(amt)
                # http.client returns b"" when a connection with a known length
                # closes early, rather than raising.
                if not chunk and amt and self.total is not None and self.received < self.total:
                    raise http.client.IncompleteRead(b"", self.total - self.received)
                self.received += len(chunk)
                self.save(chunk)
                return chunk
            except (OSError, http.client.HTTPException) as error:
                failures += 1
                # Without a known length there is nothing to resume against.
                if failures >= TRIES or self.total is None or not transient(error):
                    raise
                self.drop()
                say("  the download stopped at %s of %s (%s); resuming (try %d of %d)"
                    % (mib(self.received), mib(self.total), error or type(error).__name__, failures + 1, TRIES))
                pause(failures)

    def save(self, chunk):
        if self.kept is None:
            return
        try:
            self.kept.write(chunk)
        except OSError:
            # A full disk fails the installer's own copy too; this only stops keeping.
            self.stop_keeping(done=True)
            return
        if self.received >= self.total:
            # Complete: the installer has it all and checks it; nothing to carry on from.
            self.stop_keeping(done=True)

    def reopen(self):
        headers = {"Range": "bytes=%d-" % self.received}
        if self.validator:
            headers["If-Range"] = self.validator
        response = self.open_url(request_from(self.target, headers), timeout=self.timeout)
        if response.status == 206:
            start = range_start(response)
            if start != str(self.received):
                response.close()
                raise Permanent("the server resumed the download at the wrong place")
            return response
        # The whole file again: the server can't resume, or the file changed.
        length = response.headers.get("Content-Length")
        if response.status != 200 or (length and int(length) != self.total):
            response.close()
            raise Permanent("the file changed on the server during the download")
        skip = self.received
        while skip:
            data = response.read(min(skip, 1 << 20))
            if not data:
                response.close()
                raise http.client.IncompleteRead(b"", skip)
            skip -= len(data)
        return response

    def drop(self):
        if self.response is not None and self.response is not self.first:
            try:
                self.response.close()
            except OSError:
                pass
        self.response = None

    def close(self):
        self.drop()
        self.first.close()
        self.stop_keeping()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False

    def __iter__(self):
        while True:
            chunk = self.read(1 << 16)
            if not chunk:
                return
            yield chunk

    def __getattr__(self, name):
        return getattr(self.first, name)


def resuming(open_url):
    def urlopen(url, data=None, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, **kwargs):
        if timeout is socket._GLOBAL_DEFAULT_TIMEOUT:
            timeout = TIMEOUT
        # Uploads, and requests that already ask for part of a file, go as they are.
        ranged = isinstance(url, urllib.request.Request) and url.has_header("Range")
        if data is not None or kwargs or ranged:
            return open_url(url, data, timeout, **kwargs)
        return ResumingResponse(open_url, url, timeout)
    return urlopen


def install():
    urllib.request.urlopen = resuming(urllib.request.urlopen)


def run(script, args):
    """Run SCRIPT as __main__ with ARGS, as python would."""
    original_argv, original_path = sys.argv, list(sys.path)
    try:
        sys.argv = [script] + list(args)
        sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
        runpy.run_path(script, run_name="__main__")
    finally:
        sys.argv, sys.path[:] = original_argv, original_path


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: resume_downloads.py SCRIPT [ARGS...]")
    original = urllib.request.urlopen
    install()
    try:
        run(sys.argv[1], sys.argv[2:])
    finally:
        urllib.request.urlopen = original


if __name__ == "__main__":
    main()
