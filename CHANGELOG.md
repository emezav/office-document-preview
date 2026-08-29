# Changelog

All notable changes to this extension are documented here.

## [0.1.0] - 2026-08-29

First public release.

Everything below has been exercised against real documents, not synthetic fixtures: a headless test
bench runs 122 checks, and the extension has been installed from a packaged `.vsix` on two Linux
distributions with LibreOffice versions years apart.

### Added

- Read-only preview of anything LibreOffice can open, inside a VS Code tab: text documents,
  spreadsheets, slides and drawings, plus the older formats LibreOffice still reads.
- **Open Preview** in the explorer and tab context menus, so the preview is one click away without
  taking over how files normally open.
- Page navigation for documents and slides: previous, next, a page box, and `PageUp` / `PageDown` /
  `Home` / `End`. The indicator follows the scroll.
- Zoom everywhere: `-` / `+` / `Fit`, `Ctrl` with the mouse wheel, and `Ctrl` `+` / `-` / `0`.
- Selectable text, including over rendered PDF pages, with symbol-font bullets repaired on copy.
- A **Select / Pan** switch for dragging the page; the middle mouse button drags in either mode.
- **Open externally**, and an **Open in LibreOffice** command for formats the system has nothing
  registered for.
- A **Paper / Editor theme** switch for spreadsheets.
- Settings for the `soffice` path, the conversion timeout and the large-file warning.

### Notes

- Conversions are serialised and hold a lock on the LibreOffice profile: two at once against the
  same profile make one of them fail silently.
- Nothing is ever written back to the document being previewed.
- Verified on Windows 11 with LibreOffice 26.2, and on Ubuntu 22.04 with the distribution's
  LibreOffice 7.3 -- installed from source and from a packaged `.vsix`. macOS is implemented but has
  not been exercised. Neither have the snap and flatpak builds of LibreOffice, whose sandbox is
  detected and explained but never tested.
