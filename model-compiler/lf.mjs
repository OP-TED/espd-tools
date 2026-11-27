// Text files are published with LF line endings, whatever the checkout has.
//
// A Windows checkout with core.autocrlf turns the sources into CRLF. The envelope hashes are taken over
// LF-normalised text, but files copied verbatim would carry the checkout's line endings into the
// published model, so the same sources would publish different bytes on Windows and on Linux CI. Every
// text file the compiler copies therefore goes through here.

import fs from 'node:fs';
import path from 'node:path';

/** The text of a file with CRLF replaced by LF. */
export function readLf(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Write text with LF line endings, creating the folder when needed. */
export function writeLf(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'));
}

/** Copy a text file, normalising its line endings to LF. */
export function copyLf(from, to) {
  writeLf(to, readLf(from));
}
