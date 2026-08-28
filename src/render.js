'use strict';

// Turns a converted intermediate file into the HTML the webview shows.
//
// Two routes (requirements section 2):
//   documents, slides, drawings -> PDF, drawn by the vendored PDF.js.
//   spreadsheets                -> HTML, one tab per sheet. PDF would paginate a
//                                  sheet, which is the opposite of navigating it.
//
// Slides went through SVG until 2026-08-28. That route existed only because PDF.js
// could not be bundled yet, and it never actually worked on a real deck: LibreOffice
// wraps every slide in a hidden group that its own navigation script toggles, and
// reproducing that -- plus masters, backgrounds and per-slide visibility -- is a hole
// with no bottom. PDF gets all of it from LibreOffice for free.

const fs = require('node:fs');
const path = require('node:path');

const FAMILIES = {
  writer: { filter: 'pdf', outExt: 'pdf' },
  calc: { filter: 'html:HTML (StarCalc)', outExt: 'html' },
  impress: { filter: 'pdf', outExt: 'pdf' },
  draw: { filter: 'pdf', outExt: 'pdf' },
};

const BY_EXTENSION = {
  odt: 'writer', ott: 'writer', doc: 'writer', docx: 'writer', dot: 'writer',
  dotx: 'writer', rtf: 'writer', wpd: 'writer', fodt: 'writer', txt: 'writer',
  ods: 'calc', ots: 'calc', xls: 'calc', xlsx: 'calc', xlsm: 'calc',
  fods: 'calc', csv: 'calc', tsv: 'calc', dif: 'calc',
  odp: 'impress', otp: 'impress', ppt: 'impress', pptx: 'impress', fodp: 'impress',
  odg: 'draw', otg: 'draw', vsd: 'draw', vsdx: 'draw', fodg: 'draw',
};

// An unknown extension is attempted as Writer rather than rejected: LibreOffice opens
// well over a hundred formats and a whitelist would always be behind. A wrong guess
// costs one failed conversion with a clear message.
function familyFor(filePath) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return BY_EXTENSION[ext] || 'writer';
}

function pipelineFor(filePath) {
  const family = familyFor(filePath);
  return Object.assign({ family }, FAMILIES[family]);
}

function makeNonce() {
  let out = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// No connect-src at all: the zero-network principle is enforced here, not by convention.
// Three directives here exist because of PDF.js, and each one fails differently:
//
//   script-src   a nonce does NOT cover what a nonced module then IMPORTS -- CSP checks
//                imports against the source list, not the nonce. Without the origin,
//                PDF.js never loads.
//   worker-src   the worker is a separate document and needs its own directive.
//   connect-src  PDF.js fetches the PDF itself. Under `default-src 'none'` that fetch is
//                blocked and the tab stays empty with no useful error.
//
// The origin is always the webview's own. Nothing external is ever allowed, which is the
// zero-network principle from design.md -- enforced here rather than by convention.
function cspMeta(webview, nonce) {
  return (
    '<meta http-equiv="Content-Security-Policy" content="' +
    "default-src 'none'; " +
    'img-src ' + webview.cspSource + ' data: blob:; ' +
    'style-src ' + webview.cspSource + " 'unsafe-inline'; " +
    'font-src ' + webview.cspSource + '; ' +
    'connect-src ' + webview.cspSource + '; ' +
    "script-src 'nonce-" + nonce + "' " + webview.cspSource + '; ' +
    'worker-src ' + webview.cspSource + ' blob:;">'
  );
}

const BASE_CSS = `
  :root { color-scheme: light dark; }
  /* The body has to state its font size. Without it the bar was shrinking by .85 from
     a value we did not control, which landed at about 11px -- unreadable on a dense
     screen. Anchored to the size VS Code uses for its own interface instead. */
  body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
  /* The toolbar states its own font absolutely, never in em. The document stylesheet
     also targets bare div elements, so anything relative here would be measured
     against a size the document chose -- which is how the bar ended up at x-small. */
  .lop-bar { position: sticky; top: 0; z-index: 10; display: flex; gap: .3rem; align-items: center; flex-wrap: wrap; padding: .4rem .6rem; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
  .lop-bar button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; border-radius: 3px; padding: .25rem .7rem; cursor: pointer; }
  .lop-bar button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
  .lop-bar button[aria-selected="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  /* Secondary information, so it may be smaller -- but relative to a size that is now
     known, not to whatever the webview happened to inherit. */
  .lop-note { margin-left: auto; opacity: .75; font-size: .9em; }

  /* LibreOffice exports HTML that assumes white paper: its own colours (highlights,
     coloured headings) only make sense on a light surface, and on the editor's dark
     background the text comes out unreadable. So the document sits on paper by default,
     and the toolbar offers the editor theme for anyone who prefers it. */
  .lop-surface { background: #ffffff; color: #111111; }
  body[data-surface="editor"] .lop-surface { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  body[data-surface="editor"] .lop-surface * { color: inherit !important; background-color: transparent !important; border-color: var(--vscode-editorWidget-border, #8888) !important; }
  /* Images are the exception to the rule above, and the reason is not obvious: a logo
     exported from a document is usually dark ink on a TRANSPARENT background. On paper
     it reads fine; on a dark surface it disappears into it. CSS cannot recolour pixels,
     so the fix is to give the image back the white it was drawn against. */
  body[data-surface="editor"] .lop-surface img { background-color: #ffffff !important; padding: 2px; border-radius: 2px; }

  .lop-sheet { display: none; overflow: auto; padding: .75rem 1rem 2rem; }
  .lop-sheet[data-active="true"] { display: block; }
  .lop-sheet h1 { display: none; } /* the tab already names the sheet */
  .lop-sheet table { border-collapse: collapse; font-size: .85em; }
  .lop-sheet td, .lop-sheet th { border: 1px solid #c8c8c8; padding: .15rem .4rem; white-space: nowrap; }
  /* Hand tool. Selecting is the default; dragging suppresses it, or a drag would
     leave a trail of selected text behind it. */
  body[data-tool="pan"] .lop-stage, body[data-tool="pan"] .lop-sheet { cursor: grab; user-select: none; }
  body.lop-dragging, body.lop-dragging * { cursor: grabbing !important; user-select: none !important; }

  /* PDF text layer: invisible glyphs positioned over the canvas, which is the only
     way a rendered page can be selectable at all. Mirrors what PDF.js's own viewer
     stylesheet does; the library positions the spans, the CSS only has to get out of
     the way and keep them transparent. */
  .lop-page { position: relative; }
  /* Transcribed from PDF.js's own viewer.css, flattened out of its CSS nesting, and
     NOT reconstructed by reading the bundle -- the first attempt did that and got
     four things wrong at once. PDF.js styles nothing itself: it writes --font-height,
     --scale-x and --rotate on each span and puts left/top in percentages, and every
     line below is what turns those into geometry that lands on the glyphs.
     If PDF.js is ever updated, re-copy this block from its viewer.css. */
  .textLayer { color-scheme: only light; position: absolute; text-align: initial; inset: 0;
               overflow: clip; opacity: 1; line-height: 1;
               /* Inherited letter/word spacing would stretch every span off its glyphs. */
               letter-spacing: normal; word-spacing: normal;
               text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0;
               caret-color: CanvasText; z-index: 0;
               --min-font-size: 1;
               --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
               --min-font-size-inv: calc(1 / var(--min-font-size)); }
  .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre;
                             cursor: text; transform-origin: 0% 0%; user-select: text; }
  /* Only real text spans get sized. A .markedContent wrapper is structural. */
  .textLayer > :not(.markedContent),
  .textLayer .markedContent span:not(.markedContent) {
      z-index: 1;
      --font-height: 0; --scale-x: 1; --rotate: 0deg;
      font-size: calc(var(--text-scale-factor) * var(--font-height));
      transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
  .textLayer .markedContent { display: contents; }
  .textLayer span[role="img"] { user-select: none; cursor: default; }
  .textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0;
                             cursor: default; user-select: none; }
  .textLayer.selecting .endOfContent { top: 0; }
  .textLayer ::selection { background: rgba(0, 90, 220, .3); color: transparent; }
  /* A line break has no glyphs, so selecting one paints a stray block. */
  .textLayer br::selection { background: transparent; }
  .lop-sheet ::selection { background: rgba(0, 90, 220, .3); }

  .lop-pagebox { width: 3.2em; text-align: right; font: inherit; padding: .15rem .3rem; border-radius: 3px;
                 border: 1px solid var(--vscode-input-border, transparent);
                 background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .lop-of { opacity: .7; }
  .lop-sep { width: .75rem; }

  /* PDF route. The pages carry their own white, so no surface toggle applies here. */
  .lop-stage { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 1rem 0 2rem; }
  .lop-page { background: #ffffff; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 2px 14px rgba(0,0,0,.25); max-width: 100%; }
  .lop-page canvas { display: block; }

  .lop-message { padding: 2rem; max-width: 46rem; line-height: 1.55; }
  .lop-message h2 { margin-top: 0; font-size: 1.15em; }
  .lop-message code, .lop-message pre { font-family: var(--vscode-editor-font-family); font-size: .9em; }
  .lop-message pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: .6rem; border-radius: 4px; max-height: 14rem; overflow: auto; }
  .lop-message ol { padding-left: 1.2rem; }
`;

// Paper is the default surface, set on the element itself so it is right before any
// script runs. The toggle only ever moves it to "editor".
const SURFACE_BUTTON =
  '<button id="lop-surface" title="Switch between paper and the editor theme">Paper</button>';

// acquireVsCodeApi() may be called ONCE per webview and throws on the second call, so
// every script fragment below shares this one handle instead of asking for its own.
const VS_API = 'window.__lopVs = window.__lopVs || acquireVsCodeApi(); var vs = window.__lopVs;\n';

// The way out of a read-only preview. See requirements.md section 9: when someone needs
// to edit, recalculate or watch an animation, the preview does not compete with the real
// application, it hands the document over to it.
const EXTERNAL_BUTTON =
  '<button id="lop-external" title="Open this document outside VS Code, in its own window">Open externally</button>';

const EXTERNAL_SCRIPT = `
  (function () {
    var btn = document.getElementById('lop-external');
    if (!btn) { return; }
    btn.addEventListener('click', function () {
      window.__lopVs.postMessage({ type: 'openExternal' });
    });
  })();
`;

const SURFACE_SCRIPT = `
  (function () {
    var btn = document.getElementById('lop-surface');
    if (!btn) { return; }
    function apply(mode) {
      document.body.setAttribute('data-surface', mode);
      btn.textContent = mode === 'editor' ? 'Editor theme' : 'Paper';
    }
    var saved = null;
    try { saved = localStorage.getItem('lop-surface'); } catch (e) { saved = null; }
    apply(saved === 'editor' ? 'editor' : 'paper');
    btn.addEventListener('click', function () {
      var next = document.body.getAttribute('data-surface') === 'paper' ? 'editor' : 'paper';
      try { localStorage.setItem('lop-surface', next); } catch (e) { /* private mode */ }
      apply(next);
    });
  })();
`;

// A module script that fails to LOAD -- wrong MIME type, blocked by CSP, missing file --
// never executes, so a try/catch inside it catches nothing and the tab just stays empty.
// That is the one outcome design.md forbids. `preScript` is an ordinary script, so it
// always runs, and it installs the handlers that turn a silent failure into a message.
function shell(webview, nonce, bodyHtml, scriptBody, extraCss, opts) {
  const type = opts && opts.module ? ' type="module"' : '';
  const pre = opts && opts.preScript;
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    cspMeta(webview, nonce),
    // The document's own stylesheet goes FIRST and ours second. LibreOffice exports
    // rules like `body,div,table,... { font-size: x-small }`, meant for a standalone
    // page; emitted last they won over the body and shrank our own toolbar with it.
    extraCss ? '<style>' + extraCss + '</style>' : '',
    '<style>' + BASE_CSS + '</style>',
    '</head><body data-surface="paper">',
    bodyHtml,
    pre ? '<script nonce="' + nonce + '">' + pre + '</script>' : '',
    scriptBody ? '<script' + type + ' nonce="' + nonce + '">' + scriptBody + '</script>' : '',
    '</body></html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Viewer tools shared by the three render routes.
//
// Each route zooms a different thing -- a PDF canvas or an HTML table -- so each
// one supplies window.__lopZoom. Everything else here is identical for all three and
// is written once.
// ---------------------------------------------------------------------------

const ZOOM_BUTTONS =
  '<button id="lop-zoom-out" title="Zoom out (Ctrl + wheel)">-</button>' +
  '<button id="lop-zoom-in" title="Zoom in (Ctrl + wheel)">+</button>' +
  '<button id="lop-zoom-fit" title="Fit to width">Fit</button>';

const TOOL_BUTTON =
  '<button id="lop-tool" title="Switch between selecting text and dragging the page">Select</button>';

// Expects window.__lopZoom = { get(), set(v), fit() } to already exist.
const VIEWER_TOOLS = `
  (function () {
    var z = window.__lopZoom;
    var body = document.body;

    var zin = document.getElementById('lop-zoom-in');
    var zout = document.getElementById('lop-zoom-out');
    var zfit = document.getElementById('lop-zoom-fit');
    if (z && zin) {
      zin.addEventListener('click', function () { z.set(z.get() * 1.25); });
      zout.addEventListener('click', function () { z.set(z.get() / 1.25); });
      zfit.addEventListener('click', function () { z.fit(); });
      // Ctrl + wheel is what every viewer does, and the browser's own page zoom has
      // to be suppressed or both fire at once.
      window.addEventListener('wheel', function (e) {
        if (!e.ctrlKey) { return; }
        e.preventDefault();
        z.set(z.get() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }, { passive: false });
      window.addEventListener('keydown', function (e) {
        if (!e.ctrlKey) { return; }
        if (e.key === '+' || e.key === '=') { z.set(z.get() * 1.25); e.preventDefault(); }
        else if (e.key === '-') { z.set(z.get() / 1.25); e.preventDefault(); }
        else if (e.key === '0') { z.fit(); e.preventDefault(); }
      });
    }

    // Dragging and selecting are mutually exclusive -- a drag that also selects text
    // does neither well -- so they are a mode, exactly as in PDF.js's own viewer.
    var tool = document.getElementById('lop-tool');
    function setTool(mode) {
      body.dataset.tool = mode;
      if (tool) { tool.textContent = mode === 'pan' ? 'Pan' : 'Select'; }
      try { localStorage.setItem('lop-tool', mode); } catch (e) { /* private mode */ }
    }
    var savedTool = 'select';
    try { savedTool = localStorage.getItem('lop-tool') === 'pan' ? 'pan' : 'select'; } catch (e) { /* ignore */ }
    setTool(savedTool);
    if (tool) {
      tool.addEventListener('click', function () {
        setTool(body.dataset.tool === 'pan' ? 'select' : 'pan');
      });
    }

    var dragging = false, ox = 0, oy = 0, sx = 0, sy = 0;
    window.addEventListener('pointerdown', function (e) {
      // Middle button drags in either mode, which is what people expect; the left
      // button only drags when the hand tool is on.
      if (!(e.button === 1 || (e.button === 0 && body.dataset.tool === 'pan'))) { return; }
      if (e.target && e.target.closest && e.target.closest('.lop-bar')) { return; }
      dragging = true;
      ox = e.clientX; oy = e.clientY;
      sx = window.scrollX; sy = window.scrollY;
      body.classList.add('lop-dragging');
      e.preventDefault();
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) { return; }
      window.scrollTo(sx - (e.clientX - ox), sy - (e.clientY - oy));
    });
    function endDrag() {
      dragging = false;
      body.classList.remove('lop-dragging');
      // The selection is finished, so the absorbing element goes back to being a
      // zero-height strip. Leaving it expanded would block the next drag.
      var sel = document.querySelectorAll('.textLayer.selecting');
      for (var i = 0; i < sel.length; i += 1) { sel[i].classList.remove('selecting'); }
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  })();
`;

// Never let the tab go blank without saying why.
const FAILURE_REPORTER = `
  window.__lopFail = function (what) {
    var label = document.getElementById('lop-pages') || document.getElementById('lop-count');
    if (label) { label.textContent = 'could not be drawn'; }
    var stage = document.getElementById('lop-stage');
    if (!stage) { return; }
    if (stage.dataset.failed === '1') { return; }
    stage.dataset.failed = '1';
    stage.textContent = '';
    var box = document.createElement('div');
    box.className = 'lop-message';
    var h = document.createElement('h2');
    h.textContent = 'This document could not be drawn';
    var p = document.createElement('pre');
    p.textContent = String(what);
    box.appendChild(h);
    box.appendChild(p);
    stage.appendChild(box);
  };
  // Capture phase, because a script or worker that fails to load fires on the element,
  // not on window, and never bubbles.
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window && (e.target.src || e.target.href)) {
      window.__lopFail('failed to load: ' + (e.target.src || e.target.href));
    } else {
      window.__lopFail((e && e.message) || 'unknown error');
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    window.__lopFail((r && r.message) || String(r));
  });
`;

// LibreOffice's HTML export writes images as separate files next to the document and
// references them with URL-encoded relative names. A relative src never resolves inside a
// webview, so every one of them is rewritten to an asWebviewUri.
function rewriteLocalRefs(html, outDir, toUri) {
  return html.replace(/(<img\b[^>]*?\bsrc\s*=\s*")([^"]+)(")/gi, (whole, pre, value, post) => {
    if (/^(https?:|data:|vscode-|file:)/i.test(value)) {
      return whole;
    }
    let name;
    try {
      name = decodeURIComponent(value);
    } catch (_) {
      name = value;
    }
    const onDisk = path.join(outDir, name);
    if (!fs.existsSync(onDisk)) {
      return whole;
    }
    return pre + toUri(onDisk) + post;
  });
}

function stripScripts(html) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

function bodyOf(html) {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

function headStyles(html) {
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out.join('\n');
}

// Text documents go through PDF so the page survives: paper size, margins, headers,
// footers and page breaks, none of which HTML has a concept of.
//
// Pages are drawn only as they come into view. A 500-page document must not paint 500
// canvases before showing the first one, and the placeholder is sized from the page
// viewport up front so the scrollbar is honest from the start.
function renderPdf(converted, ctx) {
  const nonce = makeNonce();
  const unit = ctx.family === 'impress' ? 'slide' : 'page';
  const bar =
    '<div class="lop-bar">' +
    '<button id="lop-prev" title="Previous page (Page Up)">&#8593;</button>' +
    '<button id="lop-next" title="Next page (Page Down)">&#8595;</button>' +
    '<input id="lop-page" class="lop-pagebox" type="text" inputmode="numeric" ' +
    'aria-label="Page number" title="Type a page number and press Enter" value="1">' +
    '<span class="lop-of">/ <span id="lop-total">?</span></span>' +
    '<span class="lop-sep"></span>' +
    ZOOM_BUTTONS +
    TOOL_BUTTON +
    EXTERNAL_BUTTON +
    '<span id="lop-pages" class="lop-note">reading...</span></div>';

  const script = `
    import * as pdfjs from '${ctx.asset('media/pdfjs/pdf.min.js')}';
    ${VS_API}
    ${EXTERNAL_SCRIPT}

    // What gets copied is not always what the document means. Symbol fonts map their
    // glyphs into the Private Use Area with a 0xF000 offset, so a list bullet arrives
    // as U+F0B7 -- the middle dot 0xB7, displaced -- and pastes as garbage. Measured
    // in the ToUnicode map of a real document out of LibreOffice.
    document.addEventListener('copy', function (e) {
      var sel = document.getSelection();
      if (!sel || sel.isCollapsed) { return; }
      var node = sel.anchorNode;
      var el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el || !el.closest || !el.closest('.textLayer')) { return; }  // not our text
      var text = sel.toString();
      try { text = pdfjs.normalizeUnicode(text); } catch (err) { /* keep it raw */ }
      text = text.replace(/[\\uF000-\\uF0FF]/g, function (ch) {
        var code = ch.charCodeAt(0);
        // The one that actually appears, and it means a bullet, not a middle dot.
        if (code === 0xF0B7) { return '\\u2022'; }
        return String.fromCharCode(code - 0xF000);
      });
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    });

    var stage = document.getElementById('lop-stage');
    var label = document.getElementById('lop-pages');
    var saved = vs.getState() || {};
    var zoom = typeof saved.zoom === 'number' ? saved.zoom : 0;   // 0 means fit to width
    var doc = null;
    var painted = new Set();
    var holders = [];
    var at = 1;
    var bar = document.querySelector('.lop-bar');
    var pageBox = document.getElementById('lop-page');
    var total = document.getElementById('lop-total');

    function baseScale(page) {
      var natural = page.getViewport({ scale: 1 });
      var room = stage.clientWidth - 48;
      return Math.max(0.1, room / natural.width);
    }

    async function layout() {
      stage.textContent = '';
      painted.clear();
      holders = [];
      var first = await doc.getPage(1);
      var scale = zoom > 0 ? zoom : baseScale(first);
      effective = scale;
      var dpr = window.devicePixelRatio || 1;

      var seen = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) { return; }
          var holder = entry.target;
          var n = Number(holder.dataset.page);
          if (painted.has(n)) { return; }
          painted.add(n);
          doc.getPage(n).then(function (page) {
            var viewport = page.getViewport({ scale: scale });
            var canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = Math.floor(viewport.width) + 'px';
            canvas.style.height = Math.floor(viewport.height) + 'px';
            var ctx2d = canvas.getContext('2d');
            ctx2d.scale(dpr, dpr);
            holder.textContent = '';
            holder.appendChild(canvas);
            page.render({ canvasContext: ctx2d, viewport: viewport });

            // Selectable text. A canvas has no text, so PDF.js positions transparent
            // spans over it. This is an ENHANCEMENT: if it throws, the page is still
            // drawn, which is why it has its own guard and never touches the render.
            try {
              var tl = document.createElement('div');
              tl.className = 'textLayer';
              tl.style.setProperty('--total-scale-factor', String(scale));
              tl.style.width = Math.floor(viewport.width) + 'px';
              tl.style.height = Math.floor(viewport.height) + 'px';
              holder.appendChild(tl);
              new pdfjs.TextLayer({
                textContentSource: page.streamTextContent(),
                container: tl,
                viewport: viewport
              }).render().then(function () {
                // Without this, dragging past the end of a line keeps selecting
                // everything after it. The trick is PDF.js's own: an unselectable
                // element, last in the layer, that grows to cover it while a drag is
                // in progress and absorbs the overshoot instead of the next lines.
                var end = document.createElement('div');
                end.className = 'endOfContent';
                tl.appendChild(end);
                tl.addEventListener('mousedown', function () { tl.classList.add('selecting'); });
              }).catch(function () { tl.remove(); });
            } catch (e) {
              /* no selectable text on this page; the drawing is unaffected */
            }
          });
        });
      }, { root: null, rootMargin: '400px 0px' });

      for (var n = 1; n <= doc.numPages; n += 1) {
        var page = n === 1 ? first : null;
        var viewport = (page || first).getViewport({ scale: scale });
        var holder = document.createElement('div');
        holder.className = 'lop-page';
        holder.dataset.page = String(n);
        // Sized before anything is drawn, so the scrollbar does not lie while pages load.
        holder.style.width = Math.floor(viewport.width) + 'px';
        holder.style.height = Math.floor(viewport.height) + 'px';
        stage.appendChild(holder);
        holders.push(holder);
        seen.observe(holder);
      }
      total.textContent = String(doc.numPages);
      // A deck has slides, not pages. The route is the same; the word is not.
      var noun = doc.numPages === 1 ? '${unit}' : '${unit}s';
      label.textContent = doc.numPages + ' ' + noun +
        ' \\u00b7 read-only${ctx.elapsedMs ? ' \\u00b7 ' + ctx.elapsedMs + ' ms' : ''}';
    }

    // --- page navigation -------------------------------------------------------
    // The toolbar is sticky, so scrolling a page to y=0 would tuck its first lines
    // underneath it. Everything below offsets by the toolbar's real height.
    function barHeight() { return bar ? bar.getBoundingClientRect().height : 0; }

    function goToPage(n, remember) {
      if (!holders.length) { return; }
      at = Math.max(1, Math.min(Math.round(n) || 1, holders.length));
      var top = holders[at - 1].getBoundingClientRect().top + window.scrollY - barHeight() - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: remember === false ? 'auto' : 'smooth' });
      showPage(at);
    }

    function showPage(n) {
      at = n;
      if (document.activeElement !== pageBox) { pageBox.value = String(n); }
      vs.setState(Object.assign({}, vs.getState(), { page: n }));
    }

    // Which page is being read = the last one whose top has passed under the toolbar.
    // Recomputed on a frame rather than on every scroll event, so a long document does
    // not spend the scroll budget in this loop.
    var ticking = false;
    function trackPage() {
      if (ticking || !holders.length) { return; }
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var line = barHeight() + 40;
        var current = 1;
        for (var i = 0; i < holders.length; i += 1) {
          if (holders[i].getBoundingClientRect().top <= line) { current = i + 1; } else { break; }
        }
        if (current !== at) { showPage(current); }
        vs.setState(Object.assign({}, vs.getState(), { scrollY: window.scrollY }));
      });
    }
    window.addEventListener('scroll', trackPage, { passive: true });

    document.getElementById('lop-prev').addEventListener('click', function () { goToPage(at - 1); });
    document.getElementById('lop-next').addEventListener('click', function () { goToPage(at + 1); });
    pageBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { goToPage(Number(pageBox.value)); pageBox.blur(); }
    });
    pageBox.addEventListener('blur', function () { pageBox.value = String(at); });

    document.addEventListener('keydown', function (e) {
      if (e.target === pageBox) { return; }   // typing a page number is not navigation
      if (e.key === 'PageDown') { goToPage(at + 1); e.preventDefault(); }
      else if (e.key === 'PageUp') { goToPage(at - 1); e.preventDefault(); }
      else if (e.key === 'Home' && !e.ctrlKey) { goToPage(1); e.preventDefault(); }
      else if (e.key === 'End' && !e.ctrlKey) { goToPage(holders.length); e.preventDefault(); }
    });

    // --- zoom ------------------------------------------------------------------
    // Zooming re-lays out every page, so the reader would otherwise be thrown back to
    // the top. The page being read is kept instead of the scroll offset, which no
    // longer means the same thing at a different scale.
    var effective = 1;   // the scale actually in use, so "fit" can be zoomed FROM
    async function setZoom(z) {
      var keep = at;
      zoom = z;
      vs.setState(Object.assign({}, vs.getState(), { zoom: zoom }));
      await layout();
      goToPage(keep, false);
    }
    // The shared toolbar drives every route through this one object.
    window.__lopZoom = {
      get: function () { return zoom > 0 ? zoom : effective; },
      set: function (v) { setZoom(Math.max(0.1, Math.min(v, 8))); },
      fit: function () { setZoom(0); }
    };
    ${VIEWER_TOOLS}

    try {
      // The worker is fetched and handed over as a blob rather than by URL. Webview
      // resources live on a different origin than the webview document, and a Worker
      // cannot be constructed from a cross-origin URL; a blob is same-origin by
      // definition. PDF.js would otherwise fall back to running the parser on the UI
      // thread, which freezes the tab on a long document.
      var workerText = await (await fetch('${ctx.asset('media/pdfjs/pdf.worker.min.js')}')).text();
      pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([workerText], { type: 'text/javascript' })
      );

      // The bytes are fetched here rather than left to PDF.js, so a failure to read the
      // file surfaces as our error and not as an opaque one from inside the library.
      var bytes = new Uint8Array(await (await fetch('${ctx.toUri(converted)}')).arrayBuffer());
      doc = await pdfjs.getDocument({ data: bytes }).promise;
      await layout();
      // The remembered page beats the remembered offset: an offset means a different
      // place once the zoom or the window width has changed.
      if (saved.page && saved.page > 1) { goToPage(saved.page, false); }
      else if (saved.scrollY) { window.scrollTo(0, saved.scrollY); showPage(1); }
      else { showPage(1); }
    } catch (err) {
      window.__lopFail((err && err.message) || String(err));
    }
  `;

  return shell(ctx.webview, nonce, bar + '<div id="lop-stage" class="lop-stage"></div>', script, '', {
    module: true,
    preScript: FAILURE_REPORTER,
  });
}

// Calc export shape, confirmed against a real .xlsx:
//   <A NAME="table0"><h1>Hoja 1: <em>SheetName</em></h1></A> <table>...</table>
// Splitting on the anchors gives one panel per sheet; the <em> carries the real name.
function splitSheets(bodyHtml) {
  const anchor = /<a\s+name="table(\d+)"[^>]*>/gi;
  const marks = [];
  let m;
  while ((m = anchor.exec(bodyHtml)) !== null) {
    marks.push({ index: m.index, n: Number(m[1]) });
  }
  if (!marks.length) {
    return [{ name: 'Sheet 1', html: bodyHtml }];
  }
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : bodyHtml.length;
    const chunk = bodyHtml.slice(mark.index, end);
    const named = /<h1[^>]*>[^<]*<em>([\s\S]*?)<\/em>/i.exec(chunk) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(chunk);
    const name = named ? named[1].replace(/<[^>]+>/g, '').trim() : 'Sheet ' + (mark.n + 1);
    return { name: name || 'Sheet ' + (mark.n + 1), html: chunk };
  });
}

function renderCalc(converted, ctx) {
  const raw = fs.readFileSync(converted, 'utf8');
  const rewritten = rewriteLocalRefs(stripScripts(raw), path.dirname(converted), ctx.toUri);
  const sheets = splitSheets(bodyOf(rewritten));
  const nonce = makeNonce();

  const tabs = sheets
    .map((s, i) => '<button data-sheet="' + i + '" aria-selected="' + (i === 0) + '">' + escapeHtml(s.name) + '</button>')
    .join('');
  const panels = sheets
    .map((s, i) => '<div class="lop-sheet lop-surface" data-sheet="' + i + '" data-active="' + (i === 0) + '">' + s.html + '</div>')
    .join('');
  const note =
    '<span class="lop-note">' + sheets.length + ' sheet' + (sheets.length === 1 ? '' : 's') +
    ' &middot; read-only' + (ctx.elapsedMs ? ' &middot; ' + ctx.elapsedMs + ' ms' : '') + '</span>';

  const script = VS_API + SURFACE_SCRIPT + EXTERNAL_SCRIPT + `
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.lop-bar button[data-sheet]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('.lop-sheet'));
    function show(i) {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(Number(t.dataset.sheet) === i)); });
      panels.forEach(function (p) { p.setAttribute('data-active', String(Number(p.dataset.sheet) === i)); });
      vs.setState({ sheet: i });
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(Number(t.dataset.sheet)); }); });
    var st = vs.getState();
    if (st && typeof st.sheet === 'number' && st.sheet < panels.length) { show(st.sheet); }

    // A spreadsheet zooms with the CSS 'zoom' property rather than a transform: zoom
    // redoes the layout, so the table reflows and the scrollbars stay honest, while
    // transform: scale() would leave both describing the old size.
    var zoom = (st && typeof st.zoom === 'number') ? st.zoom : 1;
    function applyZoom() {
      panels.forEach(function (p) { p.style.zoom = String(zoom); });
      vs.setState(Object.assign({}, vs.getState(), { zoom: zoom }));
    }
    applyZoom();
    window.__lopZoom = {
      get: function () { return zoom; },
      set: function (v) { zoom = Math.max(0.25, Math.min(v, 6)); applyZoom(); },
      fit: function () { zoom = 1; applyZoom(); }
    };
    ${VIEWER_TOOLS}
  `;

  return shell(
    ctx.webview,
    nonce,
    '<div class="lop-bar">' + tabs + '<span class="lop-sep"></span>' +
      ZOOM_BUTTONS + TOOL_BUTTON + SURFACE_BUTTON + EXTERNAL_BUTTON + note + '</div>' + panels,
    script,
    headStyles(rewritten)
  );
}

// Only spreadsheets have a renderer of their own; everything else is a PDF.
const RENDERERS = { writer: renderPdf, calc: renderCalc, impress: renderPdf, draw: renderPdf };

function renderPreview(family, converted, ctx) {
  return (RENDERERS[family] || renderPdf)(converted, Object.assign({ family }, ctx));
}

function renderMessage(webview, title, bodyHtml) {
  const nonce = makeNonce();
  return shell(webview, nonce, '<div class="lop-message"><h2>' + escapeHtml(title) + '</h2>' + bodyHtml + '</div>', '');
}

function renderBusy(webview, label) {
  return renderMessage(webview, 'Converting with LibreOffice...', '<p>' + escapeHtml(label) + '</p>');
}

module.exports = {
  familyFor,
  pipelineFor,
  renderPreview,
  renderMessage,
  renderBusy,
  escapeHtml,
  splitSheets,
  rewriteLocalRefs,
  FAMILIES,
  BY_EXTENSION,
};
