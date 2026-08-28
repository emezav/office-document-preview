PDF.js 6.2.108 -- https://github.com/mozilla/pdf.js
Apache License 2.0, see LICENSE in this directory.

Vendored, not installed: this machine has no npm, and none is needed. These files come
straight from the published pdfjs-dist package over HTTP.

  https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz
  sha256 B3E68D5CDA70551A90B3F771419D379E20FC788CE056FA32DE73608E01DF47F4

What is deliberately NOT here, and why:

  standard_fonts/  780 KB.  Only needed for PDFs that reference the 14 standard fonts
                            without embedding them. Measured on a real document out of
                            LibreOffice: all 7 fonts carried a /FontFile and were subset
                            (BAAAAA+ tags). LibreOffice embeds what it uses.
  cmaps/           1.2 MB.  Predefined CJK CMaps. LibreOffice writes Identity-H with
                            embedded fonts instead.
  wasm/            1.5 MB.  JPEG 2000 and JBIG2 decoding. LibreOffice exports images as
                            DCTDecode or FlateDecode.

If a PDF ever needs one of those, PDF.js degrades: it substitutes a font or skips an
image, rather than failing to open the document. If that turns out to bite, the fix is
to copy the directory here and point the matching option at it.

Renamed from .mjs to .js on purpose. The content is unchanged ES modules; what matters
is the MIME type VS Code's resource server sends, and it serves .js as text/javascript.
A module script whose response has the wrong MIME type is refused by the browser and
never runs -- with no error inside the page, only in the webview console.
