// solve.js — makefun-site 1.0.0 output-compatible static site generator, built for speed.
// run(input) returns the same object tree ({path: text}) as the reference build() for every input,
// byte for byte (slug rules, front matter, template dialect, markdown subset, report, ordering).

// ---------------------------------------------------------------- shared text rules

/** The top-level directories no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** The names every template render sees as constants for the whole build. */
const BUILD_CONSTANTS = new Set(['site', 'tags', 'recent']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const HAS_ESC_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped (fast path: strings without any return as-is). */
function escapeHtml(text) {
  if (!HAS_ESC_RE.test(text)) return text;
  let out = '';
  const n = text.length;
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 38) { out += text.slice(seg, i) + '&amp;'; seg = i + 1; }
    else if (c === 60) { out += text.slice(seg, i) + '&lt;'; seg = i + 1; }
    else if (c === 62) { out += text.slice(seg, i) + '&gt;'; seg = i + 1; }
    else if (c === 34) { out += text.slice(seg, i) + '&quot;'; seg = i + 1; }
    else if (c === 39) { out += text.slice(seg, i) + '&#39;'; seg = i + 1; }
  }
  return out + text.slice(seg);
}

const WS_LT128 = new Uint8Array(128);
for (const c of [32, 9, 10, 11, 12, 13]) WS_LT128[c] = 1;

/** Whether a char code is JavaScript `\s`. */
function isWsCode(c) {
  if (c < 128) return WS_LT128[c] === 1;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of `text`: its runs of characters other than whitespace (no allocation). */
function wordsOf(text) {
  const n = text.length;
  let count = 0;
  let inWord = false;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c >= 33 && c !== 0xa0) {
      if (!inWord) { inWord = true; count++; }
    } else if (c === 0xa0 || (c < 33 && WS_LT128[c] === 1)) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

/** `s` trimmed of spaces and tabs at both ends. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (b > a && s.charCodeAt(b - 1) <= 32 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Whether `s` is all spaces and tabs (the empty string is). */
function isBlankST(s) {
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARKS_RE = /\p{M}/gu;

/** The slug of `text` (README, "Text"): NFKD, combining marks dropped, runs of non-alnum one "-". */
function slugify(text) {
  let plain = text;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(MARKS_RE, '');
      break;
    }
  }
  const n = plain.length;
  let out = '';
  let gap = false;
  for (let i = 0; i < n; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  const e = out.length;
  let b = e;
  while (b > 0 && out.charCodeAt(b - 1) === 45) b--;
  if (b !== e) out = out.slice(0, b);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. { v } or { error }. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { v: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { v: raw };
}

function fmDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return FM_DATE_ERR;
  let y = 0;
  let mo = 0;
  let d = 0;
  for (let i = 0; i < 10; i++) {
    const c = raw.charCodeAt(i);
    if (i === 4 || i === 7) continue;
    if (c < 48 || c > 57) return FM_DATE_ERR;
    const v = c - 48;
    if (i < 4) y = y * 10 + v;
    else if (i < 7) mo = mo * 10 + v;
    else d = d * 10 + v;
  }
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return FM_DATE_ERR;
  return { v: raw };
}
const FM_DATE_ERR = { error: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const s = fmDate(raw);
      return 'error' in s ? { error: `key "date": ${s.error}` } : s;
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { v: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { v: tags };
    }
    case 'draft':
      return raw === 'true' ? { v: true } : raw === 'false' ? { v: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (!fmNameOk(raw)) return { error: 'key "layout": not a template name' };
      return { v: raw };
    }
    case 'slug': {
      if (!fmSlugOk(raw)) return { error: 'key "slug": not a slug' };
      return { v: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** /^[a-z0-9-]+$/ */
function fmNameOk(raw) {
  const n = raw.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and at most 64 characters */
function fmSlugOk(raw) {
  const n = raw.length;
  if (n === 0 || n > 64) return false;
  if (raw.charCodeAt(0) === 45 || raw.charCodeAt(n - 1) === 45) return false;
  let prevDash = false;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else {
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
      prevDash = false;
    }
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const n = text.length;
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // The closing ---, scanning lines from 1.
  let cur = firstNl + 1;
  let close = -1;
  let closeEnd = -1;
  let idx = 1;
  while (cur <= n) {
    const nl = text.indexOf('\n', cur);
    const end = nl === -1 ? n : nl;
    if (end - cur === 3 && text.charCodeAt(cur) === 45 && text.charCodeAt(cur + 1) === 45 && text.charCodeAt(cur + 2) === 45) {
      close = idx;
      closeEnd = end;
      break;
    }
    if (nl === -1) break;
    idx++;
    cur = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  cur = firstNl + 1;
  for (let i = 1; i < close; i++) {
    const nl = text.indexOf('\n', cur);
    const line = text.slice(cur, nl === -1 ? n : nl);
    cur = nl + 1;
    if (isBlankST(line) || line.charCodeAt(0) === 35) continue;
    // /^([a-z_]+):(?: (.*))?$/ by hand
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    let raw;
    if (k > 0 && line.charCodeAt(k) === 58) {
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) {
        raw = line.slice(k + 2);
        let e = raw.length;
        while (e > 0) { const c = raw.charCodeAt(e - 1); if (c !== 32 && c !== 9) break; e--; }
        raw = e === raw.length ? raw : raw.slice(0, e);
      } else raw = null;
    } else raw = null;
    if (raw === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.v;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd < n ? text.slice(closeEnd + 1) : '' };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
const ESC_FLAGS = new Uint8Array(128);
for (const c of '\\`*_[]()#+-.!>') ESC_FLAGS[c.charCodeAt(0)] = 1;
const ESCAPED_ONE = new Array(128).fill('');
for (const c of '\\`*_[]()#+-.!>') ESCAPED_ONE[c.charCodeAt(0)] = escapeHtml(c);

/** The chars that end an inline plain run: the syntax chars and the HTML-escapable five. */
const RUN_BREAK = new Uint8Array(128);
for (const c of '\\`*[&<>"\'') RUN_BREAK[c.charCodeAt(0)] = 1;
const ESC_STR = new Array(128).fill('');
ESC_STR[38] = '&amp;';
ESC_STR[60] = '&lt;';
ESC_STR[62] = '&gt;';
ESC_STR[34] = '&quot;';
ESC_STR[39] = '&#39;';

/** Whether `line` is all spaces and tabs. */
const isBlankLine = isBlankST;

/** Whether `line` closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  return isBlankST(line.length === 3 ? '' : line.slice(3));
}

/** A fence line's language, or null when it opens no fence. */
function fenceLangOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  const n = line.length;
  let j = 3;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < n; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** A heading line's [level, text], or null (its text is never empty). */
function headingOf(line) {
  let j = 0;
  const n = line.length;
  while (j < 6 && j < n && line.charCodeAt(j) === 35) j++;
  if (j === 0) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let a = j + 1;
  while (a < n) { const d = line.charCodeAt(a); if (d !== 32 && d !== 9) break; a++; }
  let b = n;
  while (b > a) { const d = line.charCodeAt(b - 1); if (d !== 32 && d !== 9) break; b--; }
  if (b === a) return null;
  return [j, a === j + 1 && b === n ? line.slice(a) : line.slice(a, b)];
}

/** Whether `line` is a thematic break: --- or *** then spaces or tabs only. */
function isThematicBreak(line) {
  const h = line.charCodeAt(0);
  if (!((h === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) || (h === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  return isBlankST(line.length === 3 ? '' : line.slice(3));
}

/** An ordered-list line's [number, content], or null. */
function orderedOf(line) {
  let j = 0;
  const n = line.length;
  while (j < n && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return [Number(line.slice(0, j)), trimST(line.slice(j + 2))];
}

/** Whether `line` continues a list item: two or more spaces then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  return line.length > 2 && !isWsCode(line.charCodeAt(2));
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9 && c !== 96 && c !== 35 && c !== 45 && c !== 42) return false;
  if (isBlankLine(line)) return true;
  if (c === 96 && fenceLangOf(line) !== null) return true;
  if (c === 35 && headingOf(line) !== null) return true;
  return isThematicBreak(line);
}

/** The first index from `from` where `s` holds `**` outside a backslash escape, or -1. */
function findStrongClose(s, from) {
  const n = s.length;
  for (let j = from; j <= n - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESC_FLAGS[s.charCodeAt(j + 1)]) { j++; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds `]` outside a backslash escape, or -1. */
function findBracketClose(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESC_FLAGS[s.charCodeAt(j + 1)]) { j++; continue; }
    if (c === 93) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESC_FLAGS[s.charCodeAt(j + 1)]) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Whether `s` holds whitespace. */
function hasWs(s) {
  for (let i = s.length - 1; i >= 0; i--) {
    if (isWsCode(s.charCodeAt(i))) return true;
  }
  return false;
}

/** `s` rendered inline, left to right; `link(target)` is a link's href. */
function inline(s, link) {
  const special = /[\[\*`\\&<>"']/g;
  let out = '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c > 127 || !RUN_BREAK[c]) {
      special.lastIndex = i + 1;
      const m = special.exec(s);
      const j = m === null ? n : m.index;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === 92) {
      if (i + 1 < n && ESC_FLAGS[s.charCodeAt(i + 1)]) {
        out += ESCAPED_ONE[s.charCodeAt(i + 1)];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findBracketClose(s, i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    out += ESC_STR[c];
    i++;
  }
  return out;
}

/** `src` rendered: { html, toc, excerpt }. `link(target)` resolves a link's href. */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const L = lines.length;
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < L) {
    const line = lines[i];
    const c0 = line.length === 0 ? 32 : line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLangOf(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        let codeHtml = '';
        for (let b = 0; b < body.length; b++) codeHtml += escapeHtml(body[b]) + '\n';
        parts.push(`<pre><code${cls}>${codeHtml}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const head = headingOf(line);
      if (head !== null) {
        const depth = head[0];
        const htext = head[1];
        const id = uniqueSlug(slugify(htext), ids);
        const html = inline(htext, link);
        parts.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isThematicBreak(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < L) {
          const ln = lines[i];
          const b0 = ln.charCodeAt(0);
          if ((b0 === 45 || b0 === 42) && ln.charCodeAt(1) === 32) { items.push(trimST(ln.slice(2))); i++; continue; }
          if (isContinued(ln)) { items[items.length - 1] += '\n' + trimST(ln); i++; continue; }
          break;
        }
        let listHtml = '';
        for (const item of items) listHtml += `<li>${inline(item, link)}</li>\n`;
        parts.push(`<ul>\n${listHtml}</ul>\n`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimST(l);
        if (l !== '') body.push(l);
      }
      parts.push(body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const first = orderedOf(line);
      if (first !== null) {
        const items = [];
        let start = first[0];
        items.push(first[1]);
        i++;
        while (i < L) {
          const ln = lines[i];
          const o = orderedOf(ln);
          if (o !== null) { items.push(o[1]); i++; continue; }
          if (isContinued(ln)) { items[items.length - 1] += '\n' + trimST(ln); i++; continue; }
          break;
        }
        let listHtml = '';
        for (const item of items) listHtml += `<li>${inline(item, link)}</li>\n`;
        parts.push(`${start !== 1 ? `<ol start="${start}">` : '<ol>'}\n${listHtml}</ol>\n`);
        continue;
      }
    }
    const body = [trimST(line)];
    i++;
    while (i < L) {
      const ln = lines[i];
      const lc = ln.length === 0 ? 32 : ln.charCodeAt(0);
      if (lc === 32 || lc === 9 || lc === 96 || lc === 35 || lc === 45 || lc === 42) {
        if (endsParagraph(ln)) break;
      }
      let t = ln;
      if (t.length !== 0) {
        const te = t.charCodeAt(t.length - 1);
        if (te === 32 || te === 9 || t.charCodeAt(0) === 32 || t.charCodeAt(0) === 9) t = trimST(t);
      }
      body.push(t);
      i++;
    }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// -- optimization: runs of nodes whose output is the same at every render of one build become one
// cached chunk. A node is constant when it reads only site/tags/recent (never loop-bound, never an
// include: includes stay dynamic so their depth rule keeps its meaning).

/** Whether `node` renders the same on every render of a build; `bound` collects loop-bound names. */
function nodeConst(nd, bound) {
  switch (nd.kind) {
    case 'text':
      return true;
    case 'var':
    case 'raw':
      return BUILD_CONSTANTS.has(nd.path[0]) && !bound.has(nd.path[0]);
    case 'if':
      return BUILD_CONSTANTS.has(nd.path[0]) && !bound.has(nd.path[0]) && nodesConst(nd.then, bound) && (nd.else === null || nodesConst(nd.else, bound));
    case 'for':
      return BUILD_CONSTANTS.has(nd.path[0]) && !bound.has(nd.path[0]) && nodesConst(nd.body, bound === EMPTY_BOUND ? new Set([nd.name]) : new Set([...bound, nd.name]));
    default:
      return false;
  }
}

const EMPTY_BOUND = new Set();

function nodesConst(nodes, bound) {
  for (const nd of nodes) {
    if (!nodeConst(nd, bound)) return false;
  }
  return true;
}

/** `nodes` rewritten: runs of constant value nodes become one cached chunk node. */
function optimizeNodes(nodes, bound) {
  const out = [];
  let run = null;
  let runValue = false;
  const flush = () => {
    if (run !== null) {
      out.push({ kind: 'chunk', nodes: run, cell: { v: null } });
      run = null;
      runValue = false;
    }
  };
  for (const nd of nodes) {
    if (nd.kind !== 'text' && nodeConst(nd, bound)) {
      if (run === null) run = [];
      run.push(nd);
      if (nd.kind !== 'text') runValue = true;
      continue;
    }
    flush();
    if (nd.kind === 'if') {
      out.push({ kind: 'if', not: nd.not, path: nd.path, then: optimizeNodes(nd.then, bound), else: nd.else === null ? null : optimizeNodes(nd.else, bound) });
    } else if (nd.kind === 'for') {
      const inner = bound === EMPTY_BOUND ? new Set([nd.name]) : new Set([...bound, nd.name]);
      out.push({ kind: 'for', name: nd.name, path: nd.path, body: optimizeNodes(nd.body, inner) });
    } else if (nd.kind === 'text') {
      const last = out[out.length - 1];
      if (last !== undefined && last.kind === 'text') last.text += nd.text;
      else out.push({ kind: 'text', text: nd.text });
    } else if (nd.kind === 'include') {
      out.push({ kind: 'include', name: nd.name, boundArr: [...bound], memoNames: null, memo: null });
    } else out.push(nd);
  }
  flush();
  return out;
}

/** The names a subtree reads through includes: `free` (unbound, per-render) and `keyable` (site loop values). */
function collectNames(nodes, bound, free, keyable, tpls, visiting) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'chunk':
      case 'text':
        break;
      case 'var':
      case 'raw':
        collectName(nd.path[0], bound, free, keyable);
        break;
      case 'if':
        collectName(nd.path[0], bound, free, keyable);
        collectNames(nd.then, bound, free, keyable, tpls, visiting);
        if (nd.else !== null) collectNames(nd.else, bound, free, keyable, tpls, visiting);
        break;
      case 'for': {
        collectName(nd.path[0], bound, free, keyable);
        const inner = bound === EMPTY_BOUND ? new Set([nd.name, 'loop']) : new Set([...bound, nd.name, 'loop']);
        collectNames(nd.body, inner, free, keyable, tpls, visiting);
        break;
      }
      case 'include': {
        const t = tpls.get(nd.name);
        if (t !== undefined && !visiting.has(nd.name)) {
          visiting.add(nd.name);
          collectNames(t.nodes, bound, free, keyable, tpls, visiting);
          visiting.delete(nd.name);
        }
        break;
      }
    }
  }
}

function collectName(p0, bound, free, keyable) {
  if (BUILD_CONSTANTS.has(p0)) return;
  if (bound.has(p0)) keyable.add(p0);
  else free.add(p0);
}

const LOOP_KEY_PATHS = [['loop', 'index'], ['loop', 'first'], ['loop', 'last'], ['loop', 'length']];

/** Walk one template's tree setting up include-site memos (targets must all be parsed first). */
/** Walk one template's tree setting up include-site memos (targets must all be parsed first). */
function analyzeIncludes(nodes, tpls) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'include': {
        const t = tpls.get(nd.name);
        if (t === undefined) break;
        const bound = new Set(nd.boundArr);
        const free = new Set();
        const keyable = new Set();
        collectNames(t.nodes, bound, free, keyable, tpls, new Set([nd.name]));
        if (free.size > 0) break;
        const slots = [];
        for (const name of keyable) {
          if (name === 'loop') {
            for (const p of LOOP_KEY_PATHS) slots.push(p);
            continue;
          }
          slots.push([name]);
        }
        nd.memoNames = slots;
        nd.memo = new Map();
        break;
      }
      case 'if':
        analyzeIncludes(nd.then, tpls);
        if (nd.else !== null) analyzeIncludes(nd.else, tpls);
        break;
      case 'for':
        analyzeIncludes(nd.body, tpls);
        break;
      default:
        break;
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  if (path.length === 1) return v;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`; `tpls` holds the parsed templates; `depth` the include depth. */
function renderNodes(nodes, scope, tpls, depth) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    switch (nd.kind) {
      case 'chunk': {
        const cell = nd.cell;
        if (cell.v === null) cell.v = renderNodes(nd.nodes, scope, tpls, depth);
        out += cell.v;
        break;
      }
      case 'text':
        out += nd.text;
        break;
      case 'var': {
        const v = lookup(scope, nd.path);
        out += escapeHtml(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'raw': {
        const v = lookup(scope, nd.path);
        out += typeof v === 'string' ? v : textOf(v);
        break;
      }
      case 'if': {
        const v = lookup(scope, nd.path);
        const t = v !== undefined && v !== null && v !== false && v !== '' && v !== 0 && (!Array.isArray(v) || v.length > 0);
        const branch = t !== nd.not ? nd.then : nd.else;
        if (branch !== null) out += renderNodes(branch, scope, tpls, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const loop = { index: 1, first: true, last: len === 1, length: len };
        const vars = {};
        vars[nd.name] = null;
        vars.loop = loop;
        const innerScope = { vars, parent: scope };
        for (let j = 0; j < len; j++) {
          const x = xs[j];
          vars[nd.name] = x;
          loop.index = j + 1;
          loop.first = j === 0;
          loop.last = j === len - 1;
          out += renderNodes(nd.body, innerScope, tpls, depth);
        }
        break;
      }
      case 'include': {
        const t = tpls.get(nd.name);
        if (t === undefined) break;
        const memo = nd.memo;
        if (memo !== null && depth + t.height < INCLUDE_DEPTH) {
          const names = nd.memoNames;
          let m = memo;
          for (let q = 0; q < names.length; q++) {
            const v = lookup(scope, names[q]);
            let nx = m.get(v);
            if (nx === undefined) {
              nx = new Map();
              m.set(v, nx);
            }
            m = nx;
          }
          if (m.done !== undefined) {
            out += m.done;
            break;
          }
          const s = renderNodes(t.nodes, scope, tpls, depth + 1);
          m.done = s;
          out += s;
        } else if (depth < INCLUDE_DEPTH) {
          out += renderNodes(t.nodes, scope, tpls, depth + 1);
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CRLF_RE = /\r\n?/g;

/** Parsed-template cache across runs, keyed by source (the raw trees are immutable). */
const templateCache = new Map();

const MAX_HEIGHT = 1073741823;

/** A link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading_minutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const b = s.post ? s.card : cardOf(s);
  return {
    title: b.title,
    url: b.url,
    date: b.date,
    date_long: b.date_long,
    summary: b.summary,
    excerpt: b.excerpt,
    reading_minutes: b.reading_minutes,
    tags: b.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A source's tags, each slug once, in its own order (as { name, slug }). */
function ownTags(s) {
  const tags = s.data.tags;
  if (tags === undefined || tags === null) return [];
  const seen = new Set();
  const out = [];
  for (const name of tags) {
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug });
  }
  return out;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of tNames) {
    const src = input.templates[name];
    let raw = templateCache.get(src);
    if (raw === undefined) {
      try {
        raw = parseTemplate(name, src);
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        report.push(err.message);
        continue;
      }
      templateCache.set(src, raw);
    }
    templates.set(name, { nodes: optimizeNodes(raw, EMPTY_BOUND), height: 0 });
  }
  // Include-chain heights (cycle-safe: a cycle renders depth-dependently and is never memoized).
  const heights = new Map();
  const heightOf = (name, visiting) => {
    let h = heights.get(name);
    if (h !== undefined) return h;
    if (visiting.has(name)) return MAX_HEIGHT;
    visiting.add(name);
    const t = templates.get(name);
    let max = 0;
    if (t !== undefined) max = heightWalk(t.nodes, visiting);
    visiting.delete(name);
    heights.set(name, max);
    return max;
  };
  const heightWalk = (nodes, visiting) => {
    let max = 0;
    for (const nd of nodes) {
      switch (nd.kind) {
        case 'include': {
          const h = 1 + heightOf(nd.name, visiting);
          if (h > max) max = h;
          break;
        }
        case 'if': {
          const h1 = heightWalk(nd.then, visiting);
          if (h1 > max) max = h1;
          if (nd.else !== null) {
            const h2 = heightWalk(nd.else, visiting);
            if (h2 > max) max = h2;
          }
          break;
        }
        case 'for': {
          const h = heightWalk(nd.body, visiting);
          if (h > max) max = h;
          break;
        }
        default:
          break;
      }
    }
    return max;
  };
  for (const name of tNames) heightOf(name, new Set());
  for (const [name, t] of templates) t.height = heightOf(name, new Set());
  for (const t of templates.values()) analyzeIncludes(t.nodes, templates);
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(CRLF_RE, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter; refused sources reported and dropped, and so are drafts.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;
  for (const s of kept) sources.push(s);

  // 3. Permalinks: each slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const memo = new Map();
    const link = (target) => {
      const hit = memo.get(target);
      if (hit !== undefined) return hit;
      let r;
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
        r = target;
      } else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) r = bySource.get(path).url + frag;
        else if (path !== null && staticPaths.has(path)) r = `${base}/${path}${frag}`;
        else {
          report.push(`broken-link ${s.path} -> ${target}`);
          r = target;
        }
      }
      memo.set(target, r);
      return r;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. Collections: newest first, then by slug; each post's neighbours.
  const posts = [];
  for (const s of sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page, the index pages, the tag pages and the tags page; then statics.
  const output = {};
  for (const p of posts) p.card = cardOf(p);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const root = { site, tags: allTags, recent, ...vars };
    return renderNodes(t.nodes, { vars: root, parent: null }, templates, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and unparsed template, sorted, then the counts.
  const pagesCount = sources.reduce((c, s) => (s.post ? c : c + 1), 0);
  const lines = report.sort(byCodeUnits);
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

