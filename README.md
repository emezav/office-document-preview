# Office Document Preview

Read-only preview of text documents, spreadsheets, slides and drawings inside a VS Code tab,
rendered by a headless LibreOffice. No window opens unless you ask for one.

> **Status: working prototype.** It previews documents, spreadsheets and presentations today. It is
> not published on the Marketplace yet, and there are known gaps -- see [Known limitations](#known-limitations).

## What it does

Open a `.docx`, `.xlsx` or `.pptx` -- or a `.odt`, `.vsdx`, `.rtf`, `.wpd` or anything else
LibreOffice can read -- and see it inside the editor, without leaving VS Code and without launching
LibreOffice's interface.

| Family | Formats | How it is shown |
| --- | --- | --- |
| Text documents | `odt` `doc` `docx` `rtf` `wpd` ... | Real pages with their margins and headers; paging and zoom |
| Spreadsheets | `ods` `xls` `xlsx` `csv` ... | One tab per sheet, scrollable, with zoom |
| Slides | `odp` `ppt` `pptx` ... | One slide per page, with paging and zoom |
| Drawings | `odg` `vsd` `vsdx` ... | Rendered as pages |

Every view zooms the same way -- the `-` / `+` / `Fit` buttons, `Ctrl` with the mouse wheel, or
`Ctrl` `+` / `-` / `0`. The **Select / Pan** button switches between selecting text and dragging the
page around; the middle mouse button drags in either mode. Text is selectable everywhere, including
over the rendered PDF pages.

File extensions are named above because they are what you search for; the products that write them
are not affiliated with this extension.

An unrecognised extension is attempted anyway rather than refused: LibreOffice reads well over a
hundred formats, and a wrong guess only costs a failed conversion with a clear message.

A **Paper / Editor theme** button switches between the document's own colours on white paper and the
editor's theme. Paper is the default, because exported office documents assume white paper.

**Open externally** hands the document to your system's default application, for when you need to do
something a preview cannot do. For a format your system has nothing registered for -- common with
ODF and the older formats -- the command **Office Document Preview: Open in LibreOffice** forces the
one application that is guaranteed to be installed.

## Requirements

**LibreOffice must be installed.** That is the only requirement -- there is no build step and no
npm dependency.

The extension looks for `soffice` in the usual install locations before falling back to the `PATH`,
because the standard Windows installer does *not* put it on the `PATH`. If it cannot find yours, set
`officeDocumentPreview.sofficePath` to the full path of the executable.

| System | Where it looks first |
| --- | --- |
| Windows | `%ProgramFiles%\LibreOffice\program\soffice.exe` |
| macOS | `/Applications/LibreOffice.app/Contents/MacOS/soffice` |
| Linux | the `PATH`, then `/usr/lib/libreoffice/program`, snap and flatpak locations |

**Any reasonably recent LibreOffice works.** Verified on Windows 11 with 26.2 and on Ubuntu 22.04
with the distribution's 7.3 -- versions years apart, converting the same documents identically. What
has *not* been exercised: macOS, and the snap and flatpak builds, whose sandbox cannot read files
outside your home directory. The extension detects that case and says so rather than failing
mysteriously, but nobody has run it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `officeDocumentPreview.sofficePath` | `""` | Full path to `soffice`. Wins over automatic detection. |
| `officeDocumentPreview.conversionTimeoutMs` | `90000` | Base time allowed for a conversion. |
| `officeDocumentPreview.conversionTimeoutPerMegabyteMs` | `15000` | Extra time per megabyte. Set to `0` for a flat timeout. |
| `officeDocumentPreview.conversionTimeoutMaxMs` | `600000` | Ceiling for the whole budget. |
| `officeDocumentPreview.cacheEnabled` | `true` | Reuse a conversion when the document has not changed. |
| `officeDocumentPreview.cacheMaxBytes` | `536870912` | Disk budget for the cache. `0` keeps it empty. |
| `officeDocumentPreview.cacheMaxAgeDays` | `30` | Drop cached conversions unused for this long. `0` never expires them. |
| `officeDocumentPreview.warnAboveBytes` | `20971520` | Ask before converting a file larger than this. |

**The conversion budget is not one number, because conversion time is not one number.**
Measured on this extension's own test documents:

| Document | Size | Time |
| --- | --- | --- |
| Spreadsheet, 5000 rows | 317 KB | 1.8 s |
| Text document, 11 pages | 620 KB | 3.3 s |
| Presentation, 13 slides | 13.4 MB | 33 s native, 73 s in a VM |
| Presentation, 23 slides | 10.6 MB | 42 s |

So the budget is a base plus an allowance per megabyte, capped. Size is only a proxy -- the 10.6 MB
deck takes *longer* than the 13.4 MB one because it has more slides -- so the allowance is generous.
The ceiling is what still catches a conversion that is stuck rather than slow: a password-protected
document waits for a prompt that never appears. **Every one of those numbers is a setting.**

**Converted documents are cached, so reopening a tab is instant.** The key is the file's
SHA-256, which is what makes the invalidation exact rather than approximate: edit the document
and its entry is replaced immediately, while touching, copying or moving a file that has not
changed keeps the work. Hashing costs milliseconds against the seconds above. The cache is
cleaned two ways -- entries unused for `cacheMaxAgeDays` are swept when the extension starts,
and the least recently used are dropped when `cacheMaxBytes` is exceeded.

## Running it from source

There is nothing to build. Open the folder in VS Code and press `F5`; the extension runs in a
development window. Then right-click a document in the explorer and choose **Office Document
Preview: Open Preview**.

The preview is always asked for, never imposed: the editor registers with `priority: "option"`, so
double-clicking a `.docx` still opens it the way it always did.

To check everything that does not need the interface:

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "<path to Code.exe>" scripts\smoke.js | Tee-Object -FilePath "$env:TEMP\smoke.txt" | Out-Null
Get-Content "$env:TEMP\smoke.txt"
```

That runs on the Node that VS Code ships inside Electron, so it works without Node installed.

It needs documents to convert, and it looks for them in `private/samples/` -- a directory that is
git-ignored and therefore empty in a fresh clone. **Drop any office files in there** and the bench
will pick them up. Real documents are worth far more than synthetic ones here: every interesting
bug this extension has had was found by a real file and missed by a made-up one.

## Known limitations

- **Spreadsheets are not paginated.** They are shown as tables, one tab per sheet, deliberately:
  going through PDF would paginate a sheet, which is the opposite of navigating it. Print layout,
  page breaks and repeated headers are not shown.
- **Nothing is editable.** No cell editing, no formula recalculation, no slide animations, no
  comments or tracked changes. What you see is the result the file already carried. When you need
  any of that, **Open externally** hands the document to the application that can do it.
- **No VS Code for the Web.** vscode.dev and github.dev cannot launch a local process. Remote SSH
  and dev containers work, provided LibreOffice is installed on the remote host.
- **Snap and flatpak builds of LibreOffice cannot read files outside your home directory**, and fail
  with a permission error the extension can only report, not fix.

## How it works

Each preview converts the file with `soffice --headless --convert-to` into a private temporary
directory, then renders the result in a webview. Conversions are strictly serialised and hold a lock
on the LibreOffice profile, because two at once against the same profile make one of them fail
without any error at all.

The intermediate format is chosen per family: **PDF** for everything except spreadsheets, drawn page
by page with a vendored PDF.js, and **HTML** for spreadsheets, one tab per sheet. Spreadsheets are
the exception for a reason: going through PDF would paginate a sheet, and a copied selection would
paste as flat text instead of a grid.

PDF.js (Apache-2.0) is vendored under `media/pdfjs/`. Only the two files needed to render are
shipped; `media/pdfjs/VENDORED.md` records where they came from and what was left out.

## License

MIT.
