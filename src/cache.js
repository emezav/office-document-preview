'use strict';

// Keeps converted documents so that closing and reopening a tab does not pay for the
// conversion again. The measured cost is what justifies it: a 13 MB presentation takes
// 33 seconds on a native machine and 73 in a virtual one, while hashing the same file
// costs tens of milliseconds. Reopening a tab is a common thing to do; waiting a minute
// for a result that was already computed is not acceptable.
//
// The key is the CONTENT hash, not the path or the timestamp, and that is what makes the
// invalidation correct rather than approximate:
//
//   - Edit the document and the hash changes, so the old entry can never be served. There
//     is no window in which a stale preview looks current.
//   - Touching a file without changing it, or moving it, does not throw the work away.
//   - A timestamp would get both of those backwards. Copies, checkouts and restores all
//     rewrite mtime without changing a byte.
//
// Nothing here is authoritative: every entry can be deleted at any moment and the only
// consequence is a slow conversion. So all the failure paths degrade to a miss rather
// than propagating -- a broken cache must never be worse than no cache.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENTRY_FILE = 'entry.json';
const HASH_CHUNK = 1024 * 1024;

/**
 * SHA-256 of the file's bytes, read in chunks so a large document is not held in memory
 * all at once.
 *
 * @param {string} srcPath
 * @returns {string} hex digest
 */
function hashFile(srcPath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(srcPath, 'r');
  try {
    const buf = Buffer.alloc(HASH_CHUNK);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, HASH_CHUNK, null);
      if (read <= 0) {
        break;
      }
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The directory name for an entry. The output extension is part of it because the same
 * bytes can legitimately be wanted in more than one intermediate format, and serving a
 * PDF where HTML was asked for would fail in a way that looks like a corrupt document.
 */
function keyFor(hash, outExt) {
  return hash + '-' + outExt;
}

function entryDir(root, key) {
  return path.join(root, key);
}

function readEntry(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ENTRY_FILE), 'utf8'));
  } catch (_) {
    return null; // absent, half-written or corrupt: all of them mean "miss"
  }
}

/**
 * Look an entry up. A hit requires the metadata AND the converted file itself to be
 * present and non-empty: the directory surviving is not evidence that its contents did.
 *
 * @returns {{dir: string, outPath: string, entry: object}|null}
 */
function lookup(root, key) {
  const dir = entryDir(root, key);
  const entry = readEntry(dir);
  if (!entry || !entry.outFile) {
    return null;
  }
  const outPath = path.join(dir, entry.outFile);
  let size = -1;
  try {
    size = fs.statSync(outPath).size;
  } catch (_) {
    return null;
  }
  if (size <= 0) {
    return null;
  }
  // Touch it so pruning can evict by least-recently-used rather than by age of creation.
  try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
  } catch (_) {
    /* an unwritable cache still serves reads */
  }
  return { dir, outPath, entry };
}

/**
 * Move a finished conversion into the cache. The whole directory travels, not just the
 * converted file: the HTML route emits sibling PNGs that the page references by relative
 * name, and separating them from their page breaks every image at once.
 *
 * The move is a rename, which is atomic on one filesystem, so a reader never sees a
 * half-populated entry.
 *
 * @returns {{dir: string, outPath: string}|null} null when the entry could not be stored
 */
function commit(root, key, fromDir, outPath, meta) {
  const dir = entryDir(root, key);
  const outFile = path.basename(outPath);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(fromDir, ENTRY_FILE),
      JSON.stringify({
        source: meta.source,
        hash: meta.hash,
        outExt: meta.outExt,
        outFile,
        at: meta.at,
      })
    );
    fs.renameSync(fromDir, dir);
    return { dir, outPath: path.join(dir, outFile) };
  } catch (err) {
    // EEXIST or ENOTEMPTY means another window converted the same bytes while we did.
    // Its entry is as good as ours, so take it instead of fighting over the name.
    if (err && (err.code === 'EEXIST' || err.code === 'ENOTEMPTY' || err.code === 'EPERM')) {
      const theirs = lookup(root, key);
      if (theirs) {
        return { dir: theirs.dir, outPath: theirs.outPath };
      }
    }
    return null;
  }
}

/**
 * Drop every entry that came from this source path except the one just stored.
 *
 * This is what the user asked for in so many words: when the document changes, the
 * previous conversion is deleted rather than left to age out. Without it, editing a
 * document ten times would leave ten copies of it in the cache, and only the pruning
 * budget would ever notice.
 *
 * @returns {string[]} the keys removed, so a caller can report what it did
 */
function dropOthersFor(root, source, keepKey) {
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (_) {
    return removed;
  }
  for (const name of names) {
    if (name === keepKey) {
      continue;
    }
    const dir = entryDir(root, name);
    const entry = readEntry(dir);
    if (!entry || entry.source !== source) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (_) {
      /* in use by another window; the budget will get it later */
    }
  }
  return removed;
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += dirSize(full);
      continue;
    }
    try {
      total += fs.statSync(full).size;
    } catch (_) {
      /* vanished mid-walk */
    }
  }
  return total;
}

/**
 * Evict least-recently-used entries until the cache fits its budget.
 *
 * A budget of 0 disables the cache by emptying it, which is the honest reading of
 * "allow it no space" -- quietly keeping what is already there would make the setting
 * a lie.
 *
 * @returns {{before: number, after: number, removed: string[]}}
 */
function prune(root, maxBytes) {
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return { before: 0, after: 0, removed };
  }
  const entries = [];
  for (const e of names) {
    if (!e.isDirectory()) {
      continue;
    }
    const dir = entryDir(root, e.name);
    let used = 0;
    let bytes = 0;
    try {
      used = fs.statSync(dir).mtimeMs;
    } catch (_) {
      continue;
    }
    bytes = dirSize(dir);
    entries.push({ name: e.name, dir, used, bytes });
  }
  const before = entries.reduce((sum, e) => sum + e.bytes, 0);
  let total = before;
  // Oldest use first: the entry nobody has opened in longest is the cheapest to lose.
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (total <= maxBytes) {
      break;
    }
    try {
      fs.rmSync(e.dir, { recursive: true, force: true });
      total -= e.bytes;
      removed.push(e.name);
    } catch (_) {
      /* another window owns it */
    }
  }
  return { before, after: total, removed };
}

/**
 * Remove entries nobody has opened for longer than maxAgeMs.
 *
 * The size budget alone is not enough, and the gap is easy to miss: pruning only ever
 * runs when a conversion is committed, so a cache belonging to documents the user has
 * stopped opening is never looked at again. It just sits on the disk. This is the sweep
 * that runs at startup, where the cost is paid once and nobody is waiting.
 *
 * Age is measured from LAST USE, not from creation, because `lookup` touches the entry
 * on every hit. A document opened every week is never evicted for being old; one opened
 * once and forgotten is.
 *
 * @param {number} maxAgeMs 0 or less disables the age limit entirely
 * @returns {{removed: string[], kept: number}}
 */
function sweepAged(root, maxAgeMs, now) {
  const removed = [];
  let kept = 0;
  if (!(maxAgeMs > 0)) {
    return { removed, kept };
  }
  const at = typeof now === 'number' ? now : Date.now();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return { removed, kept };
  }
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const dir = entryDir(root, e.name);
    let used;
    try {
      used = fs.statSync(dir).mtimeMs;
    } catch (_) {
      continue;
    }
    if (at - used <= maxAgeMs) {
      kept += 1;
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(e.name);
    } catch (_) {
      /* another window owns it; the next start will get it */
    }
  }
  return { removed, kept };
}

module.exports = {
  hashFile,
  sweepAged,
  keyFor,
  entryDir,
  lookup,
  commit,
  dropOthersFor,
  prune,
  dirSize,
  ENTRY_FILE,
};
