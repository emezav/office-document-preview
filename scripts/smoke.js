'use strict';

// Headless smoke test for everything that does not need the VS Code UI.
//
// There is no Node on this development machine, so this runs on the Node that VS Code
// ships inside Electron:
//
//   ELECTRON_RUN_AS_NODE=1 "<path to Code.exe>" scripts/smoke.js
//
// It exercises the real pipeline against the files in private/samples/: locate soffice, convert
// each one, and parse the result the way the webview does. What it cannot cover is the
// custom editor and the webview themselves; those need F5.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// The modules are NOT required at the top. Requiring them here would run them before
// step 1 could report anything, so a syntax error killed the whole bench with a raw
// stack trace and the "Syntax" step could never actually fail for them -- it only ever
// checked extension.js, the one module it does not import. They are loaded after the
// syntax step instead.
let locateSoffice, ConversionQueue, convertOnce, runConversion, acquireProfileLock, lockPathFor, renderMod;

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log('  [' + mark + '] ' + label + (detail ? ' -- ' + detail : ''));
}

// extension.js requires the 'vscode' module, which only exists inside the extension host,
// so it gets a syntax check rather than a load.
function syntaxCheck(file) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    return null;
  } catch (err) {
    return err.message;
  }
}

async function main() {
  console.log('Node: ' + process.version);
  console.log('\n1. Syntax');
  let syntaxOk = true;
  for (const f of ['extension.js', 'locate.js', 'convert.js', 'render.js']) {
    const err = syntaxCheck(path.join(ROOT, 'src', f));
    if (err) syntaxOk = false;
    check('src/' + f, err === null, err || '');
  }
  if (!syntaxOk) {
    console.log('\nA module does not parse; nothing below could run.');
    process.exitCode = 1;
    return;
  }
  ({ locateSoffice } = require(path.join(ROOT, 'src', 'locate')));
  ({ ConversionQueue, convertOnce, runConversion, acquireProfileLock, lockPathFor } = require(
    path.join(ROOT, 'src', 'convert')
  ));
  renderMod = require(path.join(ROOT, 'src', 'render'));

  console.log('\n2. Locating LibreOffice');
  const located = locateSoffice('');
  check('soffice found', Boolean(located.path), located.path || 'looked in ' + located.searched.length + ' places');
  if (!located.path) {
    console.log('\nCannot continue without LibreOffice.');
    process.exitCode = 1;
    return;
  }

  console.log('\n3. Family routing');
  const routes = [
    ['a.docx', 'writer'], ['a.odt', 'writer'], ['a.xlsx', 'calc'], ['a.csv', 'calc'],
    ['a.pptx', 'impress'], ['a.odp', 'impress'], ['a.vsdx', 'draw'], ['a.unknown', 'writer'],
  ];
  for (const [name, want] of routes) {
    const got = renderMod.familyFor(name);
    check(name + ' -> ' + want, got === want, got);
  }

  console.log('\n4. Real conversions from private/samples/');
  // private/ is git-ignored: the fixtures stay on the author's disk and never reach the
  // repository. A fresh clone has no samples, so this degrades instead of crashing.
  const samplesDir = path.join(ROOT, 'private', 'samples');
  let samples = [];
  try {
    samples = fs.readdirSync(samplesDir).filter((f) => !f.startsWith('.'));
  } catch (_) {
    samples = [];
  }
  if (!samples.length) {
    console.log('  [SKIP] no fixtures in private/samples/ -- steps 4 to 6 need documents to convert.');
    console.log('\n' + (failures === 0 ? 'All checks passed (conversion steps skipped).' : failures + ' check(s) failed.'));
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }
  const queue = new ConversionQueue();
  const profileDir = path.join(os.tmpdir(), 'office-document-preview', 'smoke-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const produced = [];
  for (const name of samples) {
    const src = path.join(samplesDir, name);
    const pipeline = renderMod.pipelineFor(src);
    const outDir = path.join(os.tmpdir(), 'office-document-preview', 'smoke-' + Date.now() + '-' + produced.length);
    const started = Date.now();
    try {
      const res = await queue.enqueue(src, {
        soffice: located.path,
        profileDir,
        srcPath: src,
        outDir,
        filter: pipeline.filter,
        outExt: pipeline.outExt,
        timeoutMs: 60000,
      });
      const size = fs.statSync(res.outPath).size;
      check(
        name + ' [' + pipeline.family + ' -> ' + pipeline.outExt + ']',
        size > 0,
        (Date.now() - started) + ' ms, ' + size + ' bytes'
      );
      produced.push({ name, family: pipeline.family, outPath: res.outPath, outDir });
    } catch (err) {
      check(name + ' [' + pipeline.family + ']', false, (err && err.message) || String(err));
    }
  }

  console.log('\n5. Parsing the converted output the way the webview does');
  for (const item of produced) {
    if (item.outPath.endsWith('.pdf')) {
      // Three of the four families produce a PDF now, so the check is about the PDF
      // itself: it must be a real one, and carry the pages the document had.
      const buf = fs.readFileSync(item.outPath);
      const header = buf.subarray(0, 5).toString('latin1');
      const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      check(item.name + ': is a PDF with pages', header === '%PDF-' && pages > 0, header + ', ' + pages + ' page(s)');
      continue;
    }
    const raw = fs.readFileSync(item.outPath, 'utf8');
    if (item.family === 'calc') {
      const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
      const sheets = renderMod.splitSheets(body ? body[1] : raw);
      check(
        item.name + ': sheets detected',
        sheets.length > 0 && sheets.every((s) => s.name),
        sheets.map((s) => s.name).join(' | ')
      );
    }
  }

  console.log('\n6. Rendering a full webview document');
  const fakeWebview = { cspSource: 'vscode-webview://fake' };
  const renderCtx = (item) => ({
    webview: fakeWebview,
    toUri: (p) => 'vscode-webview://fake/' + path.basename(p),
    asset: (rel) => 'vscode-webview://fake/' + rel,
    title: item.name,
    elapsedMs: 0,
  });
  for (const item of produced) {
    try {
      const html = renderMod.renderPreview(item.family, item.outPath, renderCtx(item));
      const sane =
        html.startsWith('<!DOCTYPE html>') &&
        html.includes('Content-Security-Policy') &&
        !/<script(?![^>]*nonce=)/i.test(html);
      check(item.name + ': document built', sane, html.length + ' bytes of HTML');
    } catch (err) {
      check(item.name + ': document built', false, err.message);
    }
  }

  console.log('\n6b. The vendored PDF.js is present and actually referenced');
  {
    const vendored = ['pdf.min.js', 'pdf.worker.min.js', 'LICENSE'];
    for (const f of vendored) {
      const p = path.join(ROOT, 'media', 'pdfjs', f);
      let size = -1;
      try {
        size = fs.statSync(p).size;
      } catch (_) {
        size = -1;
      }
      check('media/pdfjs/' + f + ' exists', size > 0, size > 0 ? size + ' bytes' : 'MISSING');
    }
    const writerItem = produced.find((i) => i.family === 'writer');
    if (writerItem) {
      const html = renderMod.renderPreview('writer', writerItem.outPath, renderCtx(writerItem));
      // A path typo here produces a blank tab and nothing in any log, so the built
      // document is checked for the two URIs rather than trusted.
      check('the built page loads pdf.min.js', html.includes('media/pdfjs/pdf.min.js'), '');
      check('the built page sets workerSrc', html.includes('media/pdfjs/pdf.worker.min.js'), '');
      // Nonce alone does not cover imported modules; without the origin in script-src
      // PDF.js is blocked by CSP.
      check('CSP allows the module import', /script-src 'nonce-[^']+' vscode-webview:\/\/fake/.test(html), '');
      check('CSP allows the worker', /worker-src vscode-webview:\/\/fake/.test(html), '');
      // PDF.js fetches the PDF. Without connect-src the tab stays empty and the console
      // blames the wrong thing.
      check('CSP allows fetching the PDF', /connect-src vscode-webview:\/\/fake/.test(html), '');
      check('CSP still forbids everything external', /default-src 'none'/.test(html) && !/https?:/.test(html.slice(0, 1200)), '');
      check('the module script is type="module"', /<script type="module" nonce=/.test(html), '');
      // A module that fails to LOAD never runs, so its own try/catch catches nothing.
      // The reporter is a plain script for exactly that reason, and it must come first.
      check('a plain-script failure reporter is installed', html.includes('__lopFail'), '');
      check(
        'the reporter runs before the module',
        html.indexOf('__lopFail') < html.indexOf('type="module"'),
        ''
      );
      check('load failures are caught in the capture phase', /addEventListener\('error'[\s\S]{0,400}, true\)/.test(html), '');
      // .mjs is served with a MIME type the browser refuses for modules.
      check('nothing points at a .mjs file', !html.includes('.mjs'), '');
      // Page navigation: the controls and the keys must both be wired, and every
      // control the toolbar shows must be addressed by the script.
      const controls = ['lop-prev', 'lop-next', 'lop-page', 'lop-total', 'lop-zoom-in', 'lop-zoom-out', 'lop-zoom-fit'];
      const orphan = controls.filter((id) => {
        const inMarkup = html.includes('id="' + id + '"');
        const inScript = html.includes("getElementById('" + id + "')");
        return !(inMarkup && inScript);
      });
      check('every toolbar control is wired', orphan.length === 0, orphan.join(', '));
      check('the hand tool is offered and handled', html.includes('id="lop-tool"') && html.includes("dataset.tool"), '');
      check('Ctrl + wheel zooms', /wheel[\s\S]{0,300}ctrlKey/.test(html), '');
      check('the text layer is attempted', html.includes('pdfjs.TextLayer'), '');
      // PDF.js writes these custom properties on every span and styles NOTHING itself.
      // A stylesheet that does not consume them produces spans at the body's font size,
      // which looks like a working text layer until you try to select something.
      const consumed = ['--font-height', '--scale-x', '--rotate', '--total-scale-factor'].filter(
        (v) => new RegExp('var\\(' + v.replace(/-/g, '\\-')).test(html)
      );
      check(
        'the stylesheet consumes the text-layer variables',
        consumed.length === 4,
        consumed.length + '/4: ' + consumed.join(' ')
      );
      // The three rules that were each wrong on the first attempt. None of them makes
      // the page fail to render, so only a check like this catches a regression.
      const rules = {
        'markedContent is structural': /\.markedContent\s*\{\s*display:\s*contents/.test(html),
        'line breaks do not paint a block': /br::selection\s*\{\s*background:\s*transparent/.test(html),
        'inherited spacing is reset': /letter-spacing:\s*normal[\s\S]{0,40}word-spacing:\s*normal/.test(html),
        // Three halves of one mechanism: the rule, the element, and the class that
        // arms it. Any one missing and a drag past a line selects the rest of the page.
        'overshoot rule exists': /\.textLayer\.selecting \.endOfContent\s*\{\s*top:\s*0/.test(html),
        'overshoot element is created': /className\s*=\s*'endOfContent'/.test(html),
        'overshoot is armed and disarmed':
          /classList\.add\('selecting'\)/.test(html) && /classList\.remove\('selecting'\)/.test(html),
      };
      const broken = Object.keys(rules).filter((k) => !rules[k]);
      check('text-layer geometry rules are intact', broken.length === 0, broken.join('; '));
      // The text layer is an enhancement. If it could throw into the render path, a
      // document with odd text would stop being drawn at all.
      // Not a character-window regex: that broke the moment the block grew. This finds
      // the try that actually encloses the call -- the nearest one before it, with no
      // other try opening in between.
      const at = html.indexOf('pdfjs.TextLayer');
      const opens = html.lastIndexOf('try {', at);
      const closes = html.indexOf('} catch', at);
      const isolated =
        at !== -1 && opens !== -1 && closes > at && html.slice(opens, closes).split('try {').length === 2;
      check('the text layer cannot break the render', isolated, isolated ? '' : 'not inside a try/catch of its own');
      check(
        'copied text is repaired on the way out',
        html.includes("addEventListener('copy'") && html.includes('normalizeUnicode') && html.includes('0xF0B7'),
        ''
      );
      check('keyboard paging is bound', /PageDown[\s\S]{0,200}PageUp/.test(html), '');
      check('the sticky toolbar is offset when scrolling to a page', html.includes('barHeight()'), '');
    }
  }

  console.log('\n6d. The document cannot restyle our own chrome');
  {
    // LibreOffice exports `body,div,... { font-size: x-small }` for a standalone page.
    // Emitted after ours it shrank the toolbar, and only in the spreadsheet route,
    // which is why it survived every check until a user noticed.
    const calcItem = produced.find((i) => i.family === 'calc');
    if (calcItem) {
      const html = renderMod.renderPreview('calc', calcItem.outPath, renderCtx(calcItem));
      const ours = html.lastIndexOf('.lop-bar {');
      const theirs = html.indexOf('font-size:x-small');
      check(
        'our stylesheet is emitted after the document one',
        theirs === -1 || ours > theirs,
        theirs === -1 ? 'the document set no competing size' : 'ours at ' + ours + ', theirs at ' + theirs
      );
      check(
        'the toolbar font is absolute, not inherited',
        /\.lop-bar \{[^}]*font-size: var\(--vscode-font-size/.test(html),
        ''
      );
    }
  }

  console.log('\n6c. The viewer tools reach all three render routes');
  {
    // The same four capabilities, implemented three different ways. A route that
    // silently lacks one is exactly the kind of gap nobody notices until a user does.
    const routes = [
      ['writer', produced.find((i) => i.family === 'writer')],
      ['calc', produced.find((i) => i.family === 'calc')],
      ['impress', produced.find((i) => i.family === 'impress')],
    ];
    for (const [family, item] of routes) {
      if (!item) {
        continue;
      }
      const html = renderMod.renderPreview(family, item.outPath, renderCtx(item));
      const has = {
        'zoom buttons': html.includes('id="lop-zoom-in"') && html.includes('id="lop-zoom-out"'),
        'hand tool': html.includes('id="lop-tool"'),
        'ctrl+wheel': /wheel[\s\S]{0,300}ctrlKey/.test(html),
        'drag to scroll': html.includes('pointermove') && html.includes('scrollTo'),
        'zoom hook': html.includes('window.__lopZoom'),
      };
      const missing = Object.keys(has).filter((k) => !has[k]);
      check(family + ': has every viewer tool', missing.length === 0, missing.join(', ') || 'zoom, hand, wheel, drag');
    }

    // Both routes that load their content asynchronously must be able to say so. A
    // blank tab with no explanation is the one outcome design.md forbids, and it has
    // now happened twice -- once per route -- because the reporter was added to only one.
    for (const family of ['writer', 'impress']) {
      const item = produced.find((i) => i.family === family);
      if (!item) continue;
      const html = renderMod.renderPreview(family, item.outPath, renderCtx(item));
      check(family + ': reports its own failures', html.includes('__lopFail'), '');
    }

    // A deck is counted in slides, not pages: same route, different word.
    const slideItem = produced.find((i) => i.family === 'impress');
    if (slideItem) {
      const html = renderMod.renderPreview('impress', slideItem.outPath, renderCtx(slideItem));
      check('a deck is counted in slides', html.includes("'slide'") && !html.includes("'page'"), '');
      check('the slide page stays small', html.length < 200000, html.length + ' bytes');
    }
  }

  console.log('\n7. Manifest and code agree');
  {
    // A command declared in package.json but never registered fails only at runtime,
    // with an unhelpful "command not found" the first time a user clicks the menu item.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const extSrc = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');

    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    const registered = new Set(
      Array.from(extSrc.matchAll(/registerCommand\('([^']+)'/g)).map((m) => m[1])
    );
    const inMenus = new Set(
      Object.values(manifest.contributes.menus || {}).flat().map((i) => i.command)
    );
    const missing = [...declared].filter((c) => !registered.has(c));
    const extra = [...registered].filter((c) => !declared.has(c));
    const orphanMenu = [...inMenus].filter((c) => !declared.has(c));

    check('every declared command is registered', missing.length === 0, missing.join(', '));
    check('every registered command is declared', extra.length === 0, extra.join(', '));
    check('every menu item points at a declared command', orphanMenu.length === 0, orphanMenu.join(', '));

    const manifestView = manifest.contributes.customEditors[0].viewType;
    const codeView = (/VIEW_TYPE = '([^']+)'/.exec(extSrc) || [])[1];
    check('viewType matches between manifest and code', manifestView === codeView, manifestView + ' vs ' + codeView);

    // The menu 'when' clauses must not offer the preview for files the editor does not
    // claim, or the menu entry opens a tab that cannot render.
    const selectors = manifest.contributes.customEditors[0].selector.map((s) =>
      s.filenamePattern.replace('*.', '').toLowerCase()
    );
    const whenClauses = Object.values(manifest.contributes.menus || {})
      .flat()
      .map((i) => i.when || '');
    const uncovered = selectors.filter((ext) => whenClauses.some((w) => w && !w.includes('|' + ext + '|') && !w.includes('(' + ext + '|') && !w.includes('|' + ext + ')')));
    check('menu when-clauses cover every claimed extension', uncovered.length === 0, uncovered.join(', '));
  }

  console.log('\n8. Profile lock semantics');
  {
    const lockDir = path.join(os.tmpdir(), 'office-document-preview', 'lock-test');
    fs.rmSync(lockDir, { recursive: true, force: true });
    const lockPath = lockPathFor(lockDir);

    const first = await acquireProfileLock(lockDir, 500, 60000);
    check('lock file created', fs.existsSync(lockPath), lockPath);

    let refused = false;
    try {
      await acquireProfileLock(lockDir, 300, 60000);
    } catch (err) {
      refused = err && err.kind === 'busy';
    }
    check('a held lock refuses a second holder', refused, refused ? 'rejected with kind=busy' : 'IT LET BOTH IN');

    first.release();
    check('release removes the lock file', !fs.existsSync(lockPath), '');

    // A crashed holder must not disable the extension for ever.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
    const stolen = await acquireProfileLock(lockDir, 1000, 60000);
    check('a lock held by a dead process is stolen', true, 'pid 999999 was not alive');
    stolen.release();

    // ...and neither must an unparseable one, once it is old enough.
    fs.writeFileSync(lockPath, 'half-written garbage');
    const stolen2 = await acquireProfileLock(lockDir, 1000, -1);
    check('a stale unparseable lock is stolen', true, 'treated as stale past its deadline');
    stolen2.release();
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  console.log('\n9. Two conversions at once against one profile');
  {
    const src = path.join(samplesDir, samples[0]);
    const pipeline = renderMod.pipelineFor(src);
    const raceProfile = path.join(os.tmpdir(), 'office-document-preview', 'race-profile');
    fs.mkdirSync(raceProfile, { recursive: true });
    const job = (n, fn) =>
      fn({
        soffice: located.path,
        profileDir: raceProfile,
        srcPath: src,
        outDir: path.join(os.tmpdir(), 'office-document-preview', 'race-' + n),
        filter: pipeline.filter,
        outExt: pipeline.outExt,
        timeoutMs: 60000,
      });

    // Warm the profile first: its 25s creation would swamp the timings below.
    await job('warm', convertOnce);

    // NEGATIVE CONTROL. Without the lock this is the documented hazard: one side
    // fails with exit 1 and an empty stderr. If BOTH succeed here the experiment
    // proves nothing, and the positive result below is worthless.
    const unlocked = await Promise.allSettled([job('n1', runConversion), job('n2', runConversion)]);
    const unlockedOk = unlocked.filter((r) => r.status === 'fulfilled').length;
    check(
      'CONTROL: unlocked, one of the two fails',
      unlockedOk < 2,
      unlockedOk + '/2 succeeded' + (unlockedOk === 2 ? ' -- hazard did not reproduce, step 8 proves nothing' : '')
    );

    const locked = await Promise.allSettled([job('p1', convertOnce), job('p2', convertOnce)]);
    const lockedOk = locked.filter((r) => r.status === 'fulfilled').length;
    check(
      'locked, both succeed',
      lockedOk === 2,
      lockedOk + '/2 succeeded' +
        (lockedOk < 2 ? ' -- ' + locked.filter((r) => r.status === 'rejected').map((r) => (r.reason && r.reason.message) || '?').join('; ') : '')
    );
  }

  console.log('\n' + (failures === 0 ? 'All checks passed.' : failures + ' check(s) failed.'));
  // Not process.exit(): on Windows it truncates stdout still being flushed to a pipe.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
