# Changelog

All notable changes to this extension are documented here.

## [0.0.1] - Unreleased

First working version.

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
- Developed and verified on Windows. The macOS and Linux lookup paths are implemented but have not
  been exercised yet.
