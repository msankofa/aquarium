// test-page-syntax.mjs — the pages' inline module scripts parse.
//
// A page is one <script type="module"> that nothing in Node ever loads, so a duplicate `const`
// or a stray brace ships as a blank page with one console error (base-game.html at f199597 had
// two `const stands` in one function). Each module script is extracted and handed to
// `node --check`, which parses without resolving the importmap's bare specifiers or running it.
//
// It also flags top-level temporal-dead-zone reads: a `const` declared BELOW a top-level call to a
// function whose body reads it. `node --check` cannot see this -- the file parses perfectly and then
// dies on load with "Cannot access 'X' before initialization", the same blank-page-plus-one-console-
// error failure this file exists to prevent. aquarium.html shipped exactly that at 4698fa6.
//
// And it flags getElementById() on an id that is nowhere in the page's markup -- a control wired in
// JS whose row was never added dies with "Cannot set properties of null", again after a clean parse.
//
// node test-page-syntax.mjs [page.html ...]

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['base-game.html', 'bot-viewer-v3.html', 'environment-viewer.html', 'aquarium.html', 'plant-viewer.html'];
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * Top-level `const`/`let` read by a function that is CALLED before the declaration line.
 *
 * Deliberately conservative: only column-0 declarations, column-0 `function` declarations and
 * column-0 bare calls, because anything indented sits in a scope whose execution order this cannot
 * know. That is enough for the real pattern -- a helper defined near its subject and invoked
 * immediately at the top of the file.
 *
 * Known false positive: a function whose body declares a LOCAL sharing a name with a later
 * top-level const. If that is what you are looking at, rename the local rather than delete the check.
 */
/**
 * Whole-word occurrence of `name` in `body`.
 *
 * Written by hand rather than with a constructed RegExp: the natural form there is
 * new RegExp('\b' + name + '\b'), and a single-backslash slip makes it the BACKSPACE escape
 * instead of a word boundary -- a regex that can never match, so the check only ever reports
 * green. A guard that cannot fail is worse than no guard, and this one shipped that way once.
 */
function mentionsWord(body, name) {
  const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  let i = body.indexOf(name);
  while (i !== -1) {
    if (!isWordChar(body[i - 1]) && !isWordChar(body[i + name.length])) return true;
    i = body.indexOf(name, i + 1);
  }
  return false;
}

/**
 * Does this function declare `name` itself, as a local or a parameter?
 *
 * Closes the shadowing false positive: a local `radius` sharing a name with a later top-level
 * const is not a dead-zone read, and flagging it fails pages that are perfectly correct.
 */
/**
 * Body lines with comments removed, joined.
 *
 * A name mentioned only in a COMMENT is not a read. environment-viewer.html tripped this: its
 * updateDrawDistance() mentions `radius` once, in prose explaining chunk maths. Cutting at `//`
 * can also truncate a line at a `//` inside a string literal, which can only ever cause a missed
 * detection, never a false alarm -- the safe direction for a check that gates other people's work.
 */
function stripComments(bodyLines) {
  return bodyLines
    .map((l) => { const c = l.indexOf('//'); return c === -1 ? l : l.slice(0, c); })
    .filter((l) => !/^\s*[*]/.test(l))
    .join(String.fromCharCode(10));
}

function declaresLocally(body, signature, name) {
  const tail = '(?![A-Za-z0-9_$])';
  const head = '(?:^|[^A-Za-z0-9_$])';
  // Only the BINDING declares anything. `const [x, y, z] = lampPosition(LAMP, TANK, WATER_LEVEL)`
  // declares x, y and z -- matching the whole statement counted WATER_LEVEL as a local too, and a
  // real dead-zone read inside applyLamp() passed this guard and killed aquarium.html on load. So the
  // binding is cut at the first `=`, ` of ` or ` in ` and only that part is searched.
  const nameRe = new RegExp(head + name + tail);
  const kwRe = /(?:^|[^A-Za-z0-9_$])(?:const|let|var)(?![A-Za-z0-9_$])/;
  for (const line of body.split(String.fromCharCode(10))) {
    const kw = line.search(kwRe);
    if (kw === -1) continue;
    let binding = line.slice(kw);
    for (const stop of ['=', ' of ', ' in ']) {
      const at = binding.indexOf(stop);
      if (at !== -1) binding = binding.slice(0, at);
    }
    if (nameRe.test(binding)) return true;
  }
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close < open) return false;
  return new RegExp(head + name + tail).test(signature.slice(open + 1, close));
}

function tdzHazards(src) {
  const lines = src.split('\n');
  const decl = new Map();
  lines.forEach((l, i) => {
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m && !decl.has(m[1])) decl.set(m[1], i + 1);
  });
  const fns = [];
  let cur = null;
  lines.forEach((l, i) => {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) { cur = { name: m[1], start: i + 1, end: null }; fns.push(cur); }
    else if (cur && /^\}/.test(l) && cur.end === null) { cur.end = i + 1; cur = null; }
  });
  const out = [];
  lines.forEach((l, i) => {
    const m = /^([A-Za-z_$][\w$]*)\(/.exec(l);
    if (!m) return;
    const fn = fns.find(f => f.name === m[1]);
    if (!fn || fn.end === null) return;
    const body = stripComments(lines.slice(fn.start, fn.end));
    const signature = lines[fn.start - 1];
    for (const [name, dline] of decl) {
      // Skip names the function declares or receives ITSELF -- a local `radius` shadowing a later
      // top-level `const radius` is not a dead-zone read, and treating it as one fails pages that
      // are perfectly correct. This is the documented false positive, closed.
      if (declaresLocally(body, signature, name)) continue;
      if (dline > i + 1 && mentionsWord(body, name)) {
        out.push(`${m[1]}() at line ${i + 1} reads ${name}, declared at ${dline}`);
      }
    }
  });
  return out;
}

/**
 * Literal getElementById('x') where no `id="x"` appears anywhere in the page.
 *
 * Only literal single- or double-quoted arguments; a computed id (`id + 'Val'`) is invisible here
 * and always will be, so this is a floor rather than a guarantee. It still catches the common case:
 * a control wired in script whose markup row was never added, or was added to the wrong page.
 */
/**
 * Range sliders whose `value` attribute sits outside their own min/max.
 *
 * A default the slider cannot express is a real defect and a quiet one: the control snaps to the
 * nearest rail on load, so the page opens showing a number it is not using, and every later read
 * of it is wrong. Only values written into the markup are visible here; one set from script is not.
 *
 * Attributes are read by splitting rather than by regex, because the natural pattern here needs
 * backslash escapes and this file has already shipped one guard that could never fire because a
 * single-backslash slip turned a word boundary into a backspace.
 */
function railedRangeDefaults(src, html) {
  const out = [];
  for (const tag of html.split('<input').slice(1)) {
    const head = tag.slice(0, tag.indexOf('>'));
    if (!head.includes('type="range"')) continue;
    const attr = (name) => {
      const at = head.indexOf(name + '="');
      if (at === -1) return null;
      const from = at + name.length + 2;
      const raw = head.slice(from, head.indexOf('"', from));
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const id = head.includes('id="') ? head.slice(head.indexOf('id="') + 4, head.indexOf('"', head.indexOf('id="') + 4)) : '(unnamed)';
    const v = attr('value'), lo = attr('min'), hi = attr('max');
    if (v === null || lo === null || hi === null) continue;
    if (v < lo || v > hi) out.push(id + ' value ' + v + ' outside ' + lo + '..' + hi);
  }
  return out;
}

function missingElementIds(src, html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
  const missing = new Set();
  for (const m of src.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!ids.has(m[1])) missing.add(m[1]);
  }
  return [...missing];
}

/**
 * A slider that rebuilds the scene on every `input` event drags the whole tank behind the nub.
 * Rebuilds belong on `change`, which a range input fires when the nub is released.
 *
 * The handler is found by BRACE MATCHING from the `{` that opens it. The first version took "the
 * text up to the next `on<event> =`", capped at 1200 characters, and was wrong both ways it could
 * be: a short `oninput` followed by `onSlide(..., queueScapeRebuild)` calls -- which contain no
 * `on<event> =` -- read those correct calls as its own body and failed a page that was fine.
 * A handler with no braces (`oninput = e => f(e);`) ends at the end of its statement.
 */
function handlerBody(src, at) {
  const arrow = src.indexOf('=>', at);
  const semi = src.indexOf(';', at);
  const open = src.indexOf('{', at);
  // An expression-bodied arrow: no brace before the statement ends.
  if (open === -1 || (semi !== -1 && semi < open && (arrow === -1 || arrow < semi))) {
    return src.slice(at, semi === -1 ? src.length : semi);
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

function rebuildsWhileDragging(src, expensive) {
  const out = [];
  const starts = [...src.matchAll(/oninput\s*=/g)].map(m => m.index);
  for (const at of starts) {
    const region = handlerBody(src, at);
    for (const fn of expensive) {
      if (mentionsWord(region, fn)) out.push(`${fn} runs from an oninput handler`);
    }
  }
  return [...new Set(out)];
}

// The guard's own canaries. It has shipped blind twice -- once when a word boundary became a
// backspace, once when a local destructure's initializer counted as a declaration -- and both times
// it reported clean on a page that died on load. A guard is only as good as the bad input it has
// been seen to reject, so it is shown one of each kind every run.
{
  const NL = String.fromCharCode(10);
  const readsLaterInInitializer = [
    'function applyIt() {',
    '  const [x, y] = place(WATER_LEVEL);',
    '}',
    'applyIt();',
    'const WATER_LEVEL = 1;',
  ].join(NL);
  check('tdz guard: a later const read in a local initializer is caught',
    tdzHazards(readsLaterInInitializer).length === 1, JSON.stringify(tdzHazards(readsLaterInInitializer)));

  const shadowedLocally = [
    'function applyIt() {',
    '  const radius = 2;',
    '  return radius;',
    '}',
    'applyIt();',
    'const radius = 1;',
  ].join(NL);
  check('tdz guard: a local that merely shares a later name is not flagged',
    tdzHazards(shadowedLocally).length === 0, JSON.stringify(tdzHazards(shadowedLocally)));

  const loopOverLater = [
    'function applyIt() {',
    '  for (const item of LATER_LIST) use(item);',
    '}',
    'applyIt();',
    'const LATER_LIST = [];',
  ].join(NL);
  check('tdz guard: a loop over a later const is caught',
    tdzHazards(loopOverLater).length === 1, JSON.stringify(tdzHazards(loopOverLater)));

  // The drag-rebuild guard's canaries. Its first version failed a correct page: a short `oninput`
  // followed by onSlide(..., queueScapeRebuild) calls read those calls as its own body.
  const R = ['queueScapeRebuild'];
  const rebuildsOnDrag = [
    "document.getElementById('a').oninput = (e) => {",
    '  settings.a = Number(e.target.value);',
    '  queueScapeRebuild();',
    '};',
  ].join(NL);
  check('drag guard: a rebuild inside an oninput handler is caught',
    rebuildsWhileDragging(rebuildsOnDrag, R).length === 1, JSON.stringify(rebuildsWhileDragging(rebuildsOnDrag, R)));

  const expressionBody = "el.oninput = () => queueScapeRebuild();";
  check('drag guard: a braceless oninput that rebuilds is caught',
    rebuildsWhileDragging(expressionBody, R).length === 1, JSON.stringify(rebuildsWhileDragging(expressionBody, R)));

  const cheapThenCommitOnRelease = [
    "document.getElementById('bubbles').oninput = (e) => {",
    '  settings.bubbles = Number(e.target.value);',
    '  buildBubbles();',
    '};',
    "onSlide('duckweed', (e) => {",
    '  settings.duckweed = Number(e.target.value);',
    '}, queueScapeRebuild);',
  ].join(NL);
  check('drag guard: a cheap oninput followed by a commit-on-release slider is not flagged',
    rebuildsWhileDragging(cheapThenCommitOnRelease, R).length === 0,
    JSON.stringify(rebuildsWhileDragging(cheapThenCommitOnRelease, R)));

  const thenOnclick = [
    "el.oninput = (e) => { settings.a = 1; };",
    "reroll.onclick = () => { queueScapeRebuild(); };",
  ].join(NL);
  check('drag guard: a button that rebuilds, after an oninput, is not flagged',
    rebuildsWhileDragging(thenOnclick, R).length === 0, JSON.stringify(rebuildsWhileDragging(thenOnclick, R)));
}

const dir = mkdtempSync(join(tmpdir(), 'page-syntax-'));
for (const page of PAGES) {
  const html = readFileSync(page, 'utf8');
  const scripts = [...html.matchAll(/<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim());
  check(`${page} has a module script`, scripts.length > 0);
  scripts.forEach((src, i) => {
    const file = join(dir, `${page.replace(/[^a-z0-9]/gi, '_')}-${i}.mjs`);
    writeFileSync(file, src);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    const err = (r.stderr || '').split('\n').filter(l => /SyntaxError|^\s+at |:\d+$/.test(l) || /^\S+:\d+/.test(l)).slice(0, 3).join(' | ');
    check(`${page} module script ${i + 1} parses`, r.status === 0, err || r.stderr?.trim().slice(0, 200));

    const tdz = tdzHazards(src);
    check(`${page} module script ${i + 1} has no top-level use-before-declare`, tdz.length === 0, tdz.slice(0, 3).join(' | '));

    const missing = missingElementIds(src, html);
    check(`${page} module script ${i + 1} only reaches ids that exist`, missing.length === 0, missing.slice(0, 5).join(', '));

    const railed = railedRangeDefaults(src, html);
    check(`${page} module script ${i + 1} has no range slider whose value cannot be reached`, railed.length === 0, railed.slice(0, 5).join(', '));

    const dragging = rebuildsWhileDragging(src, ['queueScapeRebuild']);
    check(`${page} module script ${i + 1} rebuilds on release, not on every drag event`, dragging.length === 0, dragging.slice(0, 5).join(', '));
  });
}
rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
