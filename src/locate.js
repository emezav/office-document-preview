'use strict';

// Finds the LibreOffice executable.
//
// The PATH is searched LAST on Windows and macOS on purpose: the standard Windows
// installer does not put soffice on the PATH, so trusting the PATH first reports
// "not installed" on the most common setup there.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let cached = null;

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function fromPathEnv(names) {
  const raw = process.env.PATH || '';
  const dirs = raw.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.com', ''] : [''];
  const found = [];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (existsFile(candidate)) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}

// Ordered list of places to look, most specific first.
function candidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(pf, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(pf86, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(pf, 'LibreOffice 7', 'program', 'soffice.exe'),
      ...fromPathEnv(['soffice']),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      path.join(home, 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
      '/opt/homebrew/bin/soffice',
      ...fromPathEnv(['soffice']),
    ];
  }
  return [
    ...fromPathEnv(['soffice', 'libreoffice']),
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/opt/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
    '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.libreoffice.LibreOffice'),
  ];
}

/**
 * @param {string} configuredPath value of officeDocumentPreview.sofficePath ('' when unset)
 * @returns {{path: string|null, searched: string[], source: string}}
 */
function locateSoffice(configuredPath) {
  if (configuredPath && configuredPath.trim()) {
    const p = configuredPath.trim();
    return {
      path: existsFile(p) ? p : null,
      searched: [p],
      source: 'setting officeDocumentPreview.sofficePath',
    };
  }
  if (cached) {
    return cached;
  }
  const searched = candidates();
  const hit = searched.find(existsFile) || null;
  cached = { path: hit, searched, source: hit ? 'automatic detection' : 'automatic detection (failed)' };
  return cached;
}

function clearLocateCache() {
  cached = null;
}

// A snap or flatpak build cannot read files outside $HOME. Knowing this up front
// turns an unexplained permission error into a message the user can act on.
function isSandboxed(sofficePath) {
  if (!sofficePath) {
    return false;
  }
  return sofficePath.includes('/snap/') || sofficePath.includes('flatpak');
}

module.exports = { locateSoffice, clearLocateCache, isSandboxed };
