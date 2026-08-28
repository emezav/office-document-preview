'use strict';

// Runs `soffice --convert-to`. Three measured behaviours of LibreOffice are
// load-bearing here, and none of them is what you would assume:
//
//   1. Two conversions sharing a profile: one fails in silence (exit 1, empty stderr,
//      --outdir not even created). Hence the strictly serial queue.
//   2. The exit code does not tell you whether the conversion worked. Success is decided
//      by the expected file existing and being non-empty.
//   3. Arguments must go through spawn as an array. A filter like 'html:HTML (StarCalc)'
//      that passes through a shell splits at the space and produces a Writer filter plus
//      a phantom input file.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BENIGN_STDERR = /Could not find platform independent libraries/i;

// LibreOffice's own config directory, as a file:// URL. Building it by hand rather than
// with Uri.toString() keeps the drive-letter colon unescaped, which soffice requires.
function toFileUrl(fsPath) {
  let p = fsPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) {
    p = '/' + p;
  }
  return 'file://' + p.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
}

// ---------------------------------------------------------------------------
// Cross-process lock on the LibreOffice profile.
//
// ConversionQueue serialises within one extension host. It cannot see a second
// VS Code window, and two windows share one globalStorage profile -- which is
// exactly the case where one conversion fails with exit 1, empty stderr and no
// --outdir at all. So the profile gets a lock file that every process must hold.
//
// The lock must be stealable, or a crash leaves the extension permanently dead:
// the holder writes its pid and a timestamp, and a waiter takes over when the
// holder is gone or has clearly overrun.
// ---------------------------------------------------------------------------

const LOCK_POLL_MS = 120;

function lockPathFor(profileDir) {
  return path.join(profileDir, '.conversion.lock');
}

function processAlive(pid) {
  if (!pid || pid === process.pid) {
    return pid === process.pid;
  }
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching it
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // alive, just not ours to signal
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    return null; // unreadable or half-written: treat as stale
  }
}

function lockIsStale(lockPath, staleAfterMs) {
  const held = readLock(lockPath);
  if (!held) {
    // A lock we cannot parse is only stale once it is also old, so a file caught
    // mid-write is not stolen from a healthy holder.
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > staleAfterMs;
    } catch (_) {
      return true;
    }
  }
  if (!processAlive(held.pid)) {
    return true;
  }
  return Date.now() - held.at > staleAfterMs;
}

async function acquireProfileLock(profileDir, waitMs, staleAfterMs) {
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = lockPathFor(profileDir);
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      // 'wx' fails when the file exists: that is the atomic part.
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return {
        release() {
          const held = readLock(lockPath);
          if (!held || held.pid === process.pid) {
            try {
              fs.rmSync(lockPath, { force: true });
            } catch (_) {
              /* someone already cleaned it */
            }
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      if (lockIsStale(lockPath, staleAfterMs)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch (_) {
          /* another waiter got there first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw {
          kind: 'busy',
          message: 'Another VS Code window is using LibreOffice. It did not free up in time.',
          stderr: '',
        };
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    // Killing the direct child leaves soffice.bin running; /T takes the tree.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_) {
      try {
        child.kill('SIGKILL');
      } catch (_ignored) {
        /* already gone */
      }
    }
  }
}

/**
 * One conversion, holding the profile lock for its whole duration.
 *
 * @param {object} opts
 * @param {string} opts.soffice     executable path
 * @param {string} opts.profileDir  dedicated UserInstallation directory
 * @param {string} opts.srcPath     document to convert
 * @param {string} opts.outDir      unique directory for this preview
 * @param {string} opts.filter      value for --convert-to
 * @param {string} opts.outExt      extension the filter produces, without the dot
 * @param {number} opts.timeoutMs
 */
async function convertOnce(opts) {
  const timeoutMs = opts.timeoutMs;
  const lock = await acquireProfileLock(
    opts.profileDir,
    opts.lockWaitMs != null ? opts.lockWaitMs : timeoutMs + 60000,
    // A holder that has overrun its own timeout by this much is not coming back.
    timeoutMs + 15000
  );
  try {
    return await runConversion(opts);
  } finally {
    lock.release();
  }
}

function runConversion(opts) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(opts.outDir, { recursive: true });

    const expected = path.join(
      opts.outDir,
      path.basename(opts.srcPath, path.extname(opts.srcPath)) + '.' + opts.outExt
    );
    try {
      fs.rmSync(expected, { force: true });
    } catch (_) {
      /* nothing there yet */
    }

    const args = [
      '-env:UserInstallation=' + toFileUrl(opts.profileDir),
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--convert-to',
      opts.filter,
      '--outdir',
      opts.outDir,
      opts.srcPath,
    ];

    const child = spawn(opts.soffice, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', () => {
      /* soffice narrates the conversion; we judge by the file */
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject({ kind: 'spawn', message: err.message, stderr: '' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject({ kind: 'timeout', message: 'The conversion exceeded ' + opts.timeoutMs + ' ms.', stderr });
        return;
      }
      // Deliberately not looking at `code`: it reports 1 on success and 0 on failure.
      let size = -1;
      try {
        size = fs.statSync(expected).size;
      } catch (_) {
        size = -1;
      }
      if (size > 0) {
        resolve({ outPath: expected, stderr, exitCode: code });
        return;
      }
      const noise = stderr
        .split(/\r?\n/)
        .filter((l) => l.trim() && !BENIGN_STDERR.test(l))
        .join('\n');
      reject({
        kind: size === 0 ? 'empty' : 'nooutput',
        message: 'LibreOffice produced no usable output (exit code ' + code + ').',
        stderr: noise,
      });
    });
  });
}

// Serial by design, not as a stopgap: see the note at the top of the file.
class ConversionQueue {
  constructor() {
    this._pending = new Map(); // key -> {opts, resolve, reject}
    this._order = [];
    this._running = false;
  }

  /**
   * A second request for the same key replaces the queued one instead of piling up,
   * so holding down Ctrl+S does not produce a backlog of conversions.
   */
  enqueue(key, opts) {
    return new Promise((resolve, reject) => {
      const existing = this._pending.get(key);
      if (existing) {
        existing.reject({ kind: 'superseded', message: 'Replaced by a newer request.', stderr: '' });
      } else {
        this._order.push(key);
      }
      this._pending.set(key, { opts, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._running) {
      return;
    }
    this._running = true;
    try {
      while (this._order.length) {
        const key = this._order.shift();
        const job = this._pending.get(key);
        this._pending.delete(key);
        if (!job) {
          continue;
        }
        try {
          job.resolve(await convertOnce(job.opts));
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this._running = false;
    }
  }
}

module.exports = {
  ConversionQueue,
  convertOnce,
  toFileUrl,
  acquireProfileLock,
  lockPathFor,
  // Exported for the test bench only: it is the unlocked path, and the negative
  // control needs it to show that the hazard the lock prevents is real.
  runConversion,
};
