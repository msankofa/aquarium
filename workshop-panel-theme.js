// The environment viewer's control-panel look, re-scoped for standalone viewers.
//
// environment-viewer.html gets this look indirectly: environment-ui.js docks its #ctrl inside
// #workshop-ui and overrides the panel's own dark CSS from there. A standalone harness has no dock,
// so installPanelTheme() applies the equivalent rules straight to its panel root -- and reads the
// same `pcw:uiTheme` colours the environment viewer's Theme tab writes, so a theme picked there
// carries across to the harnesses instead of each tool inventing its own palette.
//
// Note environment-ui.js still carries its own copy of these rules (installStyle, ~line 595). This
// module is the extractable half; folding the dock onto it is a separate job.

export const THEME_STORAGE_KEY = 'pcw:uiTheme';

// Same values as environment-ui.js buildThemePanel's `defaults.settings`.
export const SETTINGS_THEME_DEFAULTS = Object.freeze({
  surface: '#ffffff', border: '#d8d8d8', text: '#151515', accent: '#e66b1a', opacity: 100,
});

const HEX = /^#[0-9a-f]{6}$/i;

export function hexToRgba(hex, opacity) {
  const value = HEX.test(hex) ? hex.slice(1) : '000000';
  const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(100, Number(opacity) || 0)) / 100})`;
}

// Read the settings-panel colours the environment viewer persisted. Anything missing or malformed
// falls back per-key, so a partially written theme still yields a usable palette.
export function readSettingsTheme(storage) {
  const theme = { ...SETTINGS_THEME_DEFAULTS };
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return theme;
  let saved = null;
  try { saved = JSON.parse(store.getItem(THEME_STORAGE_KEY) || 'null'); } catch { return theme; }
  const settings = saved && typeof saved === 'object' ? saved.settings : null;
  if (!settings || typeof settings !== 'object') return theme;
  for (const key of ['surface', 'border', 'text', 'accent']) {
    if (HEX.test(settings[key])) theme[key] = settings[key];
  }
  if (Number.isFinite(settings.opacity)) theme.opacity = Math.max(0, Math.min(100, settings.opacity));
  return theme;
}

// The `--theme-settings-*` custom properties, in the same names environment-ui.js writes onto
// :root -- so the two tools stay interchangeable rather than merely similar.
export function themeCssVars(theme = SETTINGS_THEME_DEFAULTS) {
  return {
    '--theme-settings-surface': theme.surface,
    '--theme-settings-border': theme.border,
    '--theme-settings-text': theme.text,
    '--theme-settings-accent': theme.accent,
    '--theme-settings-surface-rgba': hexToRgba(theme.surface, theme.opacity),
  };
}

/**
 * The scoped stylesheet. `root` is a CSS selector for the panel element (e.g. '#ctrl').
 * Pure string builder so the rules can be asserted in Node without a DOM.
 */
export function panelCss(root) {
  const R = root;
  return `
${R}{
  --wui-surface: var(--theme-settings-surface, ${SETTINGS_THEME_DEFAULTS.surface});
  --wui-line: var(--theme-settings-border, ${SETTINGS_THEME_DEFAULTS.border});
  --wui-text: var(--theme-settings-text, ${SETTINGS_THEME_DEFAULTS.text});
  --wui-accent: var(--theme-settings-accent, ${SETTINGS_THEME_DEFAULTS.accent});
  --wui-muted: #6f6f6f;
  --wui-hover: #fff7f1;
  --wui-hover-text: #af4b0b;
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(340px, calc(100vw - 24px));
  display: flex; flex-direction: column; box-sizing: border-box;
  border: 1px solid var(--wui-line); border-right: 0;
  background: var(--theme-settings-surface-rgba, var(--wui-surface));
  color: var(--wui-text);
  font: 12px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
  user-select: none; z-index: 20; overflow: hidden;
  contain: layout paint style;
  box-shadow: -10px 0 28px rgba(0,0,0,.10);
}
${R} .panel-head{
  display: flex; align-items: center; justify-content: space-between;
  flex: 0 0 auto; min-height: 55px; padding: 0 15px;
  border-bottom: 1px solid var(--wui-line);
  font-size: 14px; font-weight: 750;
}
${R} .panel-head .hint{ color: var(--wui-muted); font-size: 11px; font-weight: 500; }
${R} .head-left{ display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; }
${R} .head-btns{ display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
${R} .head-btns button{
  width: auto; min-height: 24px; margin: 0; padding: 2px 8px;
  color: var(--wui-muted); font-size: 12px; line-height: 1.1;
}
/* Panel collapse shrinks the dock to its header bar, freeing the whole viewport. */
${R}.collapsed{ bottom: auto; width: auto; border-bottom: 1px solid var(--wui-line); border-bottom-left-radius: 8px; }
${R}.collapsed .panel-body{ display: none; }
${R}.collapsed .sec-toggle{ display: none; }
${R} .panel-body{
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 10px; box-sizing: border-box;
  scrollbar-color: #c4c4c4 transparent;
}
/* A single open Base Game section can contain dozens of controls. Let the browser skip individual
   rows below the scrollport instead of treating that entire long section as one visible unit. */
${R} .control, ${R} .row, ${R} .note, ${R} .state-status, ${R} .capture-status{
  content-visibility: auto; contain-intrinsic-size: auto 36px;
}
${R} .sec{
  margin-bottom: 7px; overflow: hidden;
  border: 1px solid var(--wui-line); border-radius: 7px;
  background: var(--wui-surface);
  box-shadow: 0 1px 2px rgba(0,0,0,.025);
  transition: transform .18s ease, box-shadow .18s ease;
}
${R} .sec:not(.collapsed):hover{ transform: translateY(-1px); box-shadow: 0 5px 14px rgba(230,107,26,.09); }
${R} .sec-head{
  display: flex; align-items: center; justify-content: space-between;
  box-sizing: border-box; min-height: 38px; padding: 9px 10px;
  background: #fbfbfb; border-bottom: 1px solid #ededed;
  color: var(--wui-text); font-weight: 650; cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
${R} .sec-head:hover{ color: var(--wui-hover-text); background: var(--wui-hover); }
${R} .sec-head .caret{ color: var(--wui-accent); font-size: 10px; transition: transform .2s cubic-bezier(.2,.8,.2,1); }
${R} .sec.collapsed .caret{ transform: rotate(-90deg); }
/* Hidden controls must leave the layout tree. Base Game has hundreds of them; max-height:0 merely
   clipped their paint while the browser continued laying out every slider behind the live canvas. */
${R} .sec-body{
  overflow: hidden; padding: 8px 10px 10px;
  content-visibility: auto; contain-intrinsic-size: auto 320px;
}
${R} .sec.collapsed .sec-head{ border-bottom: 0; }
${R} .sec.collapsed .sec-body{ display: none; }
/* Nested sections read as subheads rather than as more cards. */
${R} .sec .sec{ margin: 5px 0; border-radius: 5px; box-shadow: none; }
${R} .sec .sec-head{ min-height: 30px; padding: 6px 9px; font-size: 12px; font-weight: 600; background: transparent; }
${R} .sec .sec:not(.collapsed):hover{ transform: none; box-shadow: none; }
/* .ttl is the pre-existing flat heading; it survives as a subhead inside a section. */
${R} .ttl{
  margin: 0 0 7px; padding: 8px 10px;
  border: 1px solid var(--wui-line); border-radius: 6px;
  background: #fbfbfb; color: var(--wui-text); font-weight: 650;
}
${R} .row{
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; margin: 5px 0; color: var(--wui-muted);
}
${R} .row span:first-child{ color: var(--wui-text); }
${R} .row span.v{ color: var(--wui-accent); font-variant-numeric: tabular-nums; }
${R} button{
  width: 100%; min-height: 28px; margin: 4px 0; padding: 4px 7px;
  border: 1px solid #cfcfcf; border-radius: 5px;
  background: var(--wui-surface); color: var(--wui-text);
  font: inherit; cursor: pointer;
  transition: transform .15s ease, border-color .15s ease, background-color .15s ease, box-shadow .15s ease;
}
${R} button:hover:not(:disabled){
  border-color: var(--wui-accent); background: var(--wui-hover); color: var(--wui-hover-text);
  transform: translateY(-1px); box-shadow: 0 3px 9px rgba(230,107,26,.16);
}
${R} button:disabled{ cursor: default; opacity: .45; }
${R} button.primary{ color: #a94305; background: #fff2e9; border-color: #ef9b65; }
${R} input[type=range]{ width: 100%; height: 18px; margin: 0; accent-color: var(--wui-accent); cursor: pointer; }
${R} input[type=checkbox]{ accent-color: var(--wui-accent); cursor: pointer; }
${R} select, ${R} input[type=number], ${R} input[type=text], ${R} textarea{
  box-sizing: border-box; min-height: 26px; padding: 3px 6px;
  border: 1px solid #cfcfcf; border-radius: 5px;
  background: var(--wui-surface); color: var(--wui-text); font: inherit;
}
${R} select:focus, ${R} input:focus, ${R} textarea:focus{
  outline: 2px solid rgba(230,107,26,.28); outline-offset: 1px; border-color: var(--wui-accent);
}
`;
}

/**
 * Write the theme vars onto :root and inject the scoped stylesheet. Idempotent per root selector.
 * Returns the resolved theme.
 */
export function installPanelTheme(root = '#ctrl', { storage, styleId } = {}) {
  const theme = readSettingsTheme(storage);
  const docRoot = document.documentElement;
  for (const [name, value] of Object.entries(themeCssVars(theme))) docRoot.style.setProperty(name, value);
  const id = styleId || `workshop-panel-theme${root.replace(/[^a-z0-9]+/gi, '-')}`;
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = panelCss(root);
  return theme;
}

/**
 * The environment viewer's collapsible-section idiom: a `.sec` card whose head toggles `collapsed`.
 * Returns the body element that subsequent controls should be appended to.
 */
export function createSection(host, title, { collapsed = true } = {}) {
  const sec = document.createElement('div');
  sec.className = collapsed ? 'sec collapsed' : 'sec';
  const head = document.createElement('div');
  head.className = 'sec-head';
  const label = document.createElement('span');
  label.textContent = title;
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▾';
  head.append(label, caret);
  const body = document.createElement('div');
  body.className = 'sec-body';
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  sec.append(head, body);
  host.appendChild(sec);
  return body;
}

// ─── section state ──────────────────────────────────────────────────────────
// Sections are addressed by their heading text, not by index: a slot saved before a section was
// added or reordered still restores the sections it does know about.

const sectionTitle = (sec) => sec.querySelector('.sec-head span')?.textContent || '';

export function setAllSectionsCollapsed(host, collapsed) {
  for (const sec of host.querySelectorAll('.sec')) sec.classList.toggle('collapsed', !!collapsed);
}

export function readSectionStates(host) {
  const out = {};
  for (const sec of host.querySelectorAll('.sec')) {
    const title = sectionTitle(sec);
    if (title) out[title] = sec.classList.contains('collapsed');
  }
  return out;
}

export function applySectionStates(host, states) {
  if (!states || typeof states !== 'object') return;
  for (const sec of host.querySelectorAll('.sec')) {
    const value = states[sectionTitle(sec)];
    if (typeof value === 'boolean') sec.classList.toggle('collapsed', value);
  }
}
