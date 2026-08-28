'use strict';

// Read-only custom editor that previews anything LibreOffice can open.

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { locateSoffice, clearLocateCache, isSandboxed } = require('./locate');
const { ConversionQueue } = require('./convert');
const render = require('./render');

const VIEW_TYPE = 'officeDocumentPreview.preview';
const TEMP_ROOT = path.join(os.tmpdir(), 'office-document-preview');
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function config() {
  return vscode.workspace.getConfiguration('officeDocumentPreview');
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Previews that died without disposing leave their directory behind; sweep them on start.
function sweepOrphans() {
  let entries;
  try {
    entries = fs.readdirSync(TEMP_ROOT, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TEMP_ROOT, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > ORPHAN_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (_) {
      /* another window may own it */
    }
  }
}

function notFoundPage(webview, searched) {
  const list = searched.map((p) => '<li><code>' + render.escapeHtml(p) + '</code></li>').join('');
  return render.renderMessage(
    webview,
    'LibreOffice was not found',
    '<p>This extension previews documents by converting them with a headless LibreOffice. ' +
      'No <code>soffice</code> executable was found in any of these locations:</p>' +
      '<ol>' + list + '</ol>' +
      '<p>Install LibreOffice, or set <code>officeDocumentPreview.sofficePath</code> to the full path of ' +
      'the executable. On Windows the standard installer does <em>not</em> add it to the PATH; it ' +
      'normally lives at <code>C:\\Program Files\\LibreOffice\\program\\soffice.exe</code>.</p>'
  );
}

function failurePage(webview, err, sandboxed) {
  if (err.kind === 'timeout') {
    return render.renderMessage(
      webview,
      'The conversion timed out',
      '<p>' + render.escapeHtml(err.message) + '</p>' +
        '<p>The usual cause is a <strong>password-protected document</strong>: headless LibreOffice ' +
        'waits for a password prompt that never appears. Raise ' +
        '<code>officeDocumentPreview.conversionTimeoutMs</code> if the document is simply very large.</p>'
    );
  }
  if (err.kind === 'busy') {
    return render.renderMessage(
      webview,
      'LibreOffice is busy',
      '<p>' + render.escapeHtml(err.message) + '</p>' +
        '<p>Only one conversion can run at a time, because two at once against the same ' +
        'LibreOffice profile make one of them fail without any error at all. Save the file ' +
        'again, or reopen the tab, to retry.</p>'
    );
  }
  const sandboxNote = sandboxed
    ? '<p><strong>This looks like a snap or flatpak build of LibreOffice.</strong> Those cannot read ' +
      'files outside your home directory, which fails exactly like this. Installing the distribution ' +
      'package instead is the only fix.</p>'
    : '';
  return render.renderMessage(
    webview,
    'LibreOffice could not convert this file',
    '<p>' + render.escapeHtml(err.message) + '</p>' +
      sandboxNote +
      (err.stderr ? '<p>What LibreOffice reported:</p><pre>' + render.escapeHtml(err.stderr) + '</pre>' : '') +
      '<p>Save the file again, or reopen the tab, to retry.</p>'
  );
}

class LibreOfficePreviewProvider {
  constructor(context, queue) {
    this.context = context;
    this.queue = queue;
    this.profileDir = path.join(context.globalStorageUri.fsPath, 'lo-profile');
  }

  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document, panel, _token) {
    const srcPath = document.uri.fsPath;
    const tempDir = path.join(TEMP_ROOT, crypto.randomUUID());
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(this.profileDir, { recursive: true });

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(tempDir), this.context.extensionUri],
    };

    const run = () => this.convertAndShow(document, panel, tempDir);

    // Reconvert when the file changes on disk.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(srcPath), path.basename(srcPath))
    );
    watcher.onDidChange(run);
    watcher.onDidCreate(run);

    panel.webview.onDidReceiveMessage((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'retry') run();
      if (msg.type === 'openExternal') {
        // The system's default application, which is what "native viewer" means to
        // someone who has another suite installed. Forcing LibreOffice is the separate
        // openInLibreOffice command.
        vscode.env.openExternal(vscode.Uri.file(srcPath));
      }
      if (msg.type === 'openSetting') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'officeDocumentPreview.sofficePath');
      }
    });

    panel.onDidDispose(() => {
      watcher.dispose();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {
        /* best effort */
      }
    });

    await run();
  }

  async convertAndShow(document, panel, tempDir) {
    const webview = panel.webview;
    const srcPath = document.uri.fsPath;
    const label = path.basename(srcPath);

    const located = locateSoffice(config().get('sofficePath', ''));
    if (!located.path) {
      webview.html = notFoundPage(webview, located.searched);
      return;
    }

    const warnAbove = config().get('warnAboveBytes', 20971520);
    if (warnAbove > 0) {
      let size = 0;
      try {
        size = fs.statSync(srcPath).size;
      } catch (_) {
        size = 0;
      }
      if (size > warnAbove) {
        const go = await vscode.window.showWarningMessage(
          label + ' is ' + humanBytes(size) + '. Converting it may take a while.',
          'Convert anyway',
          'Cancel'
        );
        if (go !== 'Convert anyway') {
          webview.html = render.renderMessage(
            webview,
            'Preview cancelled',
            '<p>The file was not converted. Reopen the tab to try again.</p>'
          );
          return;
        }
      }
    }

    const pipeline = render.pipelineFor(srcPath);
    webview.html = render.renderBusy(webview, label);

    const started = Date.now();
    try {
      const result = await this.queue.enqueue(srcPath, {
        soffice: located.path,
        profileDir: this.profileDir,
        srcPath,
        outDir: tempDir,
        filter: pipeline.filter,
        outExt: pipeline.outExt,
        timeoutMs: config().get('conversionTimeoutMs', 30000),
      });
      if (panel.visible === false && panel.active === false) {
        // Still render: the tab may simply be in the background.
      }
      webview.html = render.renderPreview(pipeline.family, result.outPath, {
        webview,
        toUri: (p) => webview.asWebviewUri(vscode.Uri.file(p)).toString(),
        // Files that ship with the extension -- the vendored PDF.js -- as opposed to
        // the converted document, which lives in the temporary directory.
        asset: (rel) =>
          webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...rel.split('/'))).toString(),
        title: label,
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      if (err && err.kind === 'superseded') {
        return; // a newer save is already on its way
      }
      webview.html = failurePage(webview, err || { message: 'Unknown failure', stderr: '' }, isSandboxed(located.path));
    }
  }
}

// A command can be invoked from the explorer (which passes a uri), from the palette
// while a document is open, or from inside a preview tab. The last one matters: a
// custom editor is NOT a text editor, so activeTextEditor is undefined there and
// looking only at it makes the command silently useless in the very tab that offers it.
function resolveTargetUri(uri) {
  if (uri) {
    return uri;
  }
  const group = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;
  const tab = group && group.activeTab;
  if (tab && tab.input && tab.input.uri) {
    return tab.input.uri;
  }
  const editor = vscode.window.activeTextEditor;
  return editor ? editor.document.uri : null;
}

function activate(context) {
  sweepOrphans();
  const queue = new ConversionQueue();
  const provider = new LibreOfficePreviewProvider(context, queue);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('officeDocumentPreview.detectLibreOffice', () => {
      clearLocateCache();
      const found = locateSoffice(config().get('sofficePath', ''));
      if (found.path) {
        vscode.window.showInformationMessage('LibreOffice found at: ' + found.path);
      } else {
        vscode.window.showErrorMessage(
          'LibreOffice was not found. Looked in: ' + found.searched.slice(0, 6).join(', ')
        );
      }
    })
  );

  // The editor registers with priority "option", so without this the only way in is
  // "Open With..." and then picking from a list -- two steps to do the obvious thing.
  context.subscriptions.push(
    vscode.commands.registerCommand('officeDocumentPreview.open', async (uri) => {
      const target = resolveTargetUri(uri);
      if (!target) {
        vscode.window.showWarningMessage('Select a document in the explorer, then run this command.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    })
  );

  // The fallback for a format the system has nothing registered for, which is common
  // with the legacy and ODF formats this extension makes a point of opening.
  context.subscriptions.push(
    vscode.commands.registerCommand('officeDocumentPreview.openInLibreOffice', async (uri) => {
      const target = resolveTargetUri(uri);
      if (!target) {
        vscode.window.showWarningMessage('Open a document first, then run this command.');
        return;
      }
      const located = locateSoffice(config().get('sofficePath', ''));
      if (!located.path) {
        vscode.window.showErrorMessage('LibreOffice was not found. Set officeDocumentPreview.sofficePath.');
        return;
      }
      // No --headless, and deliberately no -env:UserInstallation: the visible window
      // must use the user's own profile. Pointing it at the extension's dedicated
      // profile would collide with conversions exactly as described in requirements 4.
      const child = spawn(located.path, [target.fsPath], {
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.on('error', (err) => {
        vscode.window.showErrorMessage('Could not start LibreOffice: ' + err.message);
      });
      child.unref();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('officeDocumentPreview.sofficePath')) {
        clearLocateCache();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
