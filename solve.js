// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree makefun-site's build
// returns for a case's input { site, templates, files }, byte for byte. The semantics are makefun-site's own
// (its README and code are the reference); this module re-implements them with the hot paths written for speed:
// memoized slugs/dates, char-code scanners instead of per-line/per-char regexes, run-based inline rendering and
// array-accumulated template output. All state lives inside one run() call: nothing is cached across cases.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- text

/** `s` with & < > " ' escaped (and returned as itself when it holds none). */
function escapeHtml(s) {
  let out = null;
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out = out === null ? s.slice(0, i) : out + s.slice(seg, i);
      out += rep;
      seg = i + 1;
    }
  }
  return out === null ? s : out + s.slice(seg);
}

const SLUG_MAX = 64;

/** The slug of `text`, makefun-site's rule: NFKD, marks dropped, A-Z lowered, non-[a-z0-9] runs one "-". */
function slugifyCompute(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    // NFKD is the identity on ASCII, and ASCII holds no combining marks: lowercase, then keep the [a-z0-9]
    // runs, joined by single "-".
    const lowered = text.toLowerCase();
    const n = lowered.length;
    let i = 0;
    while (i < n) {
      while (i < n) {
        const c = lowered.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) break;
        i++;
      }
      if (i >= n) break;
      let j = i + 1;
      while (j < n) {
        const c = lowered.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) break;
        j++;
      }
      if (out.length > 0) out += '-';
      out += lowered.slice(i, j);
      if (out.length > SLUG_MAX) break;
      i = j;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) {
        out += '-';
        gap = false;
      }
      out += keep;
      if (out.length > SLUG_MAX) break;
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateCompute(date) {
  const p1 = date.indexOf('-');
  const p2 = date.indexOf('-', p1 + 1);
  return `${Number(date.slice(p2 + 1))} ${MONTHS[Number(date.slice(p1 + 1, p2)) - 1]} ${date.slice(0, p1)}`;
}

/** Whether a code unit is JavaScript whitespace (the \s set). */
function isWsCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace (the count of /\S+/g matches). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWsCode(c))) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** A line of spaces and tabs only (or empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `s` with spaces and tabs at either end dropped. */
function trimSpacesTabs(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    if (raw.indexOf('\\', 1) === -1 && raw.indexOf('"', 1) === len - 1) return { value: raw.slice(1, len - 1) };
    let out = '';
    let seg = 1;
    for (let i = 1; i < len - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === len - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(seg, i) + n;
        i++;
        seg = i + 1;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
    }
    return { value: out + raw.slice(seg, len - 1) };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a real YYYY-MM-DD day from 1970-01-01 to 2099-12-31. */
function dateOk(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** Whether `raw` is a template name (a-z, 0-9 and -). */
function layoutOk(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug value: a-z and 0-9, single - between, at most 64 characters. */
function slugOk(raw) {
  const len = raw.length;
  if (len === 0 || len > 64) return false;
  let needAlnum = true;
  for (let i = 0; i < len; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      needAlnum = false;
      continue;
    }
    if (c === 45 && !needAlnum) {
      needAlnum = true;
      continue;
    }
    return false;
  }
  return !needAlnum;
}

/** One key's value, or why it is refused (the full report message). */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateOk(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      const len = raw.length;
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(len - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, len - 1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return layoutOk(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return slugOk(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // The line spans after the opening line, up to and including the closing "---".
  const spans = [];
  let close = -1;
  let pos = firstNl + 1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    spans.push([pos, end]);
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      close = spans.length - 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let li = 0; li < close; li++) {
    const line = text.slice(spans[li][0], spans[li][1]);
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    let raw = null;
    if (k > 0 && line.charCodeAt(k) === 58) {
      if (k === line.length - 1) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    }
    if (raw === null) return { error: `line ${li + 2} is not "key: value"` };
    const key = line.slice(0, k);
    raw = trimSpacesTabs(raw);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = spans[close][1] + 1;
  return { data, body: bodyStart >= text.length ? '' : text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const isLangChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** A fence-opening line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  const n = line.length;
  let i = 3;
  while (i < n && isLangChar(line.charCodeAt(i))) i++;
  const langEnd = i;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return i === n ? line.slice(3, langEnd) : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimSpacesTabs(line.slice(n));
  return text === '' ? null : { depth: n, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (!((c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) || (c0 === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item line's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item line's { num, text } after "N. ", or null. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: parseInt(line.slice(0, d), 10), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWsCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  if (c === 32 || c === 9 || line.length === 0) return isBlankLine(line);
  return false;
}

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (ch) => {
  const c = ch.charCodeAt(0);
  return c < 128 && ESCAPABLE[c] === 1;
};

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace (the /\s/ test). */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

const ESC_REP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Every char that can start an inline construct or needs HTML escaping. */
const INL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline; `linkFn(target)` is a link's href. The regex finds the next interesting char (plain runs
 * between constructs are appended verbatim: the scan intercepts every char HTML escaping would change), and only
 * code-span contents and hrefs go through escapeHtml. The shared regex's lastIndex is reset before every exec,
 * so the recursive calls for strong/emphasis/link text cannot disturb an outer scan.
 */
function inline(s, linkFn) {
  const n = s.length;
  let out = '';
  let seg = 0;
  let resume = 0;
  for (;;) {
    INL_RE.lastIndex = resume;
    const m = INL_RE.exec(s);
    if (m === null) break;
    const i = m.index;
    const ch = m[0];
    if (ch === '&' || ch === '<' || ch === '>' || ch === '"' || ch === "'") {
      out += s.slice(seg, i) + ESC_REP[ch];
      seg = i + 1;
      resume = i + 1;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < n && isEscapable(s[i + 1])) {
        out += s.slice(seg, i);
        const e = s[i + 1];
        out += e === '>' ? '&gt;' : e;
        seg = i + 2;
        resume = i + 2;
      } else resume = i + 1;
      continue;
    }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += s.slice(seg, i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        seg = j + 1;
        resume = j + 1;
      } else resume = i + 1;
      continue;
    }
    if (ch === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += s.slice(seg, i);
          out += `<strong>${inline(s.slice(i + 2, j), linkFn)}</strong>`;
          seg = j + 2;
          resume = j + 2;
        } else resume = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += s.slice(seg, i);
        out += `<em>${inline(s.slice(i + 1, j), linkFn)}</em>`;
        seg = j + 1;
        resume = j + 1;
      } else resume = i + 1;
      continue;
    }
    // ch === '['
    const k = findUnescaped(s, ']', i + 1);
    let linked = false;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) {
      const e = s.indexOf(')', k + 2);
      if (e !== -1) {
        const target = s.slice(k + 2, e);
        if (target !== '' && !hasWhitespace(target)) {
          out += s.slice(seg, i);
          out += `<a href="${escapeHtml(linkFn(target))}">${inline(s.slice(i + 1, k), linkFn)}</a>`;
          seg = e + 1;
          resume = e + 1;
          linked = true;
        }
      }
    }
    if (!linked) resume = i + 1;
  }
  return out + s.slice(seg);
}

/**
 * `src` rendered: its HTML (a "\n" after each block), its table of contents (every level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, linkFn, slugifyC) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    // Block kinds are told apart by their first character (blank, then fence, heading, break, quote, list).
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || line.length === 0) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        let inner = '';
        i++;
        while (i < n && !fenceClose(lines[i])) inner += `${escapeHtml(lines[i++])}\n`;
        i++;
        blocks.push(lang === '' ? `<pre><code>${inner}</code></pre>` : `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugifyC(h.text), ids);
        const html = inline(h.text, linkFn);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimSpacesTabs(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), linkFn)}</p>\n</blockquote>`);
      continue;
    } else if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      if ((c0 === 45 || c0 === 42) && isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const b0 = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
      const o0 = b0 === null ? orderedOf(line) : null;
      if (b0 !== null || o0 !== null) {
        const isOrdered = o0 !== null;
        const items = [];
        while (i < n) {
          const l = lines[i];
          const m = isOrdered ? orderedOf(l) : bulletOf(l);
          if (m !== null) {
            items.push(trimSpacesTabs(isOrdered ? m.text : m));
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1] += `\n${trimSpacesTabs(l)}`;
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && o0.num !== 1 ? `<ol start="${o0.num}">` : `<${tag}>`;
        let inner = '';
        for (const item of items) inner += `<li>${inline(item, linkFn)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>`);
        continue;
      }
    }
    const body = [trimSpacesTabs(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimSpacesTabs(lines[i++]));
    const html = inline(body.join('\n'), linkFn);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

// Node kinds: 0 text, 1 var (escaped), 2 raw, 3 for, 4 if, 5 include.

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a..b] is spaces and tabs only. */
function allSpaceTab(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const L = src.length;
  while (i < L) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === L - 1) {
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
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? L : nl;
    const standalone = allSpaceTab(src, lineStart, open) && allSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 6, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? L : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: -1, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 0) body.push({ k: 0, text: tok.text });
    else if (tok.t === 1 || tok.t === 2) body.push({ k: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { k: 3, kindName: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { k: 4, kindName: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 4 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 3 : 4)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === -1 ? parent.body : parent.k === 3 ? parent.body : parent.els ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kindName} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  if (path.length === 1) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[1])) return undefined;
  v = v[path[1]];
  for (let k = 2; k < path.length; k++) {
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
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
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

/** `nodes` rendered in `scope` ({ vars, parent }), accumulated into `sink.s` (a rope: no per-render joins). */
function renderNodes(nodes, scope, templates, depth, sink) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.k) {
      case 0:
        sink.s += nd.text;
        break;
      case 1:
        sink.s += escapeHtml(textOf(lookupPath(scope, nd.path)));
        break;
      case 2:
        sink.s += textOf(lookupPath(scope, nd.path));
        break;
      case 4: {
        const branch = truthy(lookupPath(scope, nd.path)) !== nd.not ? nd.then : nd.els;
        if (branch !== null) renderNodes(branch, scope, templates, depth, sink);
        break;
      }
      case 3: {
        const xs = lookupPath(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One scope per for, its bindings updated per item: rendering is synchronous and nothing retains a
        // scope past the call, so reuse is invisible to templates (a nested render gets its own scope).
        const loop = { index: 0, first: false, last: false, length: len };
        const vars = { [nd.name]: undefined, loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[nd.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(nd.body, child, templates, depth, sink);
        }
        break;
      }
      case 5: {
        const t = templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, sink);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- links

const isSchemeTail = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // Fast path: no "", "." or ".." segment (no "//", no leading/trailing "." segment, no ".." anywhere, no trailing "/").
  if (rel.charCodeAt(0) !== 46 && !rel.includes('..') && !rel.includes('//') && !rel.includes('/.') && !rel.endsWith('/')) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
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

/** A link target's href, resolving it against the pages and static files (broken ones reported, kept as written). */
function resolveLink(target, dir, sourcePath, base, bySource, staticPaths, broken) {
  const c0 = target.charCodeAt(0);
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let i = 1;
    while (i < target.length && isSchemeTail(target.charCodeAt(i))) i++;
    if (target.charCodeAt(i) === 58) return target;
  }
  if (c0 === 47 || c0 === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const s = bySource.get(path);
    if (s !== undefined) return `${s.url}${frag}`;
    if (staticPaths.has(path)) return `${base}/${path}${frag}`;
  }
  broken.add(`broken-link ${sourcePath} -> ${target}`);
  return target;
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

/** A page's link record as templates read it. */
function linkOf(s, longDateC) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateC(s.data.date) };
}

/** A post's or page's card, as lists show it. */
function cardOf(s, longDateC) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateC(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it: its (cached) card, plus the page-only fields. */
function pageOf(s, longDateC) {
  const page = { ...s.card };
  page.slug = s.slug;
  page.content = s.html;
  page.toc = s.toc;
  page.newer = linkOf(s.newer ?? null, longDateC);
  page.older = linkOf(s.older ?? null, longDateC);
  page.is_post = s.post;
  return page;
}

/** makefun-site 1.0.0's answer for one case's input: its output tree, path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const rawBase = input.site.base_url;
  let base = rawBase;
  if (base.endsWith('/')) {
    let e = base.length;
    while (e > 0 && base.charCodeAt(e - 1) === 47) e--;
    base = base.slice(0, e);
  }
  const slugCache = new Map();
  const slugifyC = (t) => {
    let v = slugCache.get(t);
    if (v === undefined) {
      v = slugifyCompute(t);
      slugCache.set(t, v);
    }
    return v;
  };
  const dateCache = new Map();
  const longDateC = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) {
      v = longDateCompute(d);
      dateCache.set(d, v);
    }
    return v;
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
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

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugifyC(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const linkFn = (target) => {
      let v = linkCache.get(target);
      if (v === undefined) {
        v = resolveLink(target, dir, s.path, base, bySource, staticPaths, broken);
        linkCache.set(target, v);
      }
      return v;
    };
    const md = renderMarkdown(s.body, linkFn, slugifyC);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTagsOf = (s) => {
    const list = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (const name of list) {
      const slug = slugifyC(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const t of ownTagsOf(p)) {
      let tag = bySlug.get(t.slug);
      if (tag === undefined) {
        tag = { name: t.name, slug: t.slug, url: `${base}/tags/${t.slug}/`, posts: [] };
        bySlug.set(t.slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagsOf(s).map((t) => bySlug.get(t.slug) ?? { name: t.name, slug: t.slug, url: '', posts: [] });
  }
  const tagsArr = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  for (const s of kept) s.card = cardOf(s, longDateC);
  const siteObj = { title: input.site.title, base_url: base };
  const allTags = tagsArr.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, k1, v1, k2, v2) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const vars = { site: siteObj, tags: allTags, recent };
    if (k1 !== undefined) vars[k1] = v1;
    if (k2 !== undefined) vars[k2] = v2;
    const sink = { s: '' };
    renderNodes(nodes, { vars, parent: null }, templates, 0, sink);
    return sink.s;
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, 'page', pageOf(s, longDateC));
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render(
      'index',
      'posts',
      posts.slice((k - 1) * per, k * per).map((p) => p.card),
      'pager',
      {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    );
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagsArr) {
    const html = render('tag', 'tag', {
      name: t.name,
      slug: t.slug,
      url: t.url,
      count: t.posts.length,
      posts: t.posts.map((p) => p.card),
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageTotal = 0;
  for (const s of kept) if (!s.post) pageTotal++;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagsArr.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
