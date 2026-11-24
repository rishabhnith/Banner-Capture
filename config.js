// Banner Capture - shared settings, storage and formatting helpers.
// Used by the background service worker, the popup and the settings page.

export const DEFAULT_SETTINGS = Object.freeze({
  rootFolder: 'Banners',
  duplicateMode: 'day',      // 'day' = skip if already saved today, 'ever' = only new banners, 'never' = always save
  minWidth: 300,             // ignore images narrower than this (icons, arrows, logos)
  parallelTabs: 2,
  pageWaitSec: 8,
  csvSeparator: ',',
  saveCsvLog: true,
  notify: true,
  hideDownloadBubble: true,
  schedule: Object.freeze({ enabled: false, time: '09:00' })
});

// Sites added on first install. Their banners are picked once with the picker.
export const PRESET_SITES = [
  { name: 'Boulanger', url: 'https://www.boulanger.com/', rules: [] },
  { name: 'Fnac', url: 'https://www.fnac.com/', rules: [] },
  { name: 'Darty', url: 'https://www.darty.com/', rules: [] }
];

export const HISTORY_LIMIT = 20000;
export const SEEN_LIMIT_PER_SITE = 3000;

export const LOG_COLUMNS = [
  ['date', 'Date'],
  ['time', 'Time'],
  ['site', 'Site'],
  ['banner', 'Banner'],
  ['slide', 'Slide'],
  ['status', 'Status'],
  ['note', 'Note'],
  ['width', 'Width'],
  ['height', 'Height'],
  ['size_kb', 'Size (KB)'],
  ['first_seen', 'First seen'],
  ['visible_on_load', 'Visible on load'],
  ['alt_text', 'Alt text'],
  ['slide_text', 'Slide text'],
  ['link', 'Banner link'],
  ['image_url', 'Image URL'],
  ['file', 'Saved file'],
  ['page_url', 'Page URL']
];

// ------------------------------------------------------------------ small utils
export function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const pad = (n) => String(n).padStart(2, '0');

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Make a string safe as a single folder or file name on Windows, macOS and Linux.
export function sanitizeSegment(s, max = 60) {
  let out = String(s == null ? '' : s)
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F~]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+|[.\s]+$/g, '');
  if (out.length > max) out = out.slice(0, max).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
  return out;
}

// ------------------------------------------------------------------ URLs
export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a website address.');
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+\.[^:/]+:\d+/.test(s)) {
      throw new Error('Only web pages (http or https) can be added.');
    }
    s = 'https://' + s;
  }
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    throw new Error('That doesn\'t look like a website address.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only web pages (http or https) can be added.');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That doesn\'t look like a website address.');
  u.hash = '';
  return u.href;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch (e) { return ''; }
}

// Key used to tell whether two addresses are the same page.
export function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./i, '') + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase();
  } catch (e) {
    return String(url || '').toLowerCase();
  }
}

export function siteNameFromUrl(url) {
  const host = hostOf(url);
  if (!host) return 'Website';
  const parts = host.split('.').filter((p) => p && p !== 'm' && p !== 'www');
  let name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (['co', 'com', 'gov', 'ac', 'org', 'net'].includes(name) && parts.length >= 3) name = parts[parts.length - 3];
  name = (name || host).replace(/[-_]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Find the saved site a page belongs to: same address first, then same domain.
export function findSiteForUrl(cfg, url) {
  const key = urlKey(url);
  const exact = cfg.sites.find((s) => urlKey(s.url) === key);
  if (exact) return exact;
  const host = hostOf(url);
  if (!host) return null;
  let path = '/';
  try { path = new URL(url).pathname; } catch (e) { /* ignore */ }
  const sameHost = cfg.sites
    .filter((s) => hostOf(s.url) === host)
    .map((s) => ({ s, p: (() => { try { return new URL(s.url).pathname; } catch (e) { return '/'; } })() }))
    .filter((x) => path.startsWith(x.p.replace(/\/+$/, '') || '/'))
    .sort((a, b) => b.p.length - a.p.length);
  return sameHost.length ? sameHost[0].s : null;
}

export function uniqueSiteName(cfg, name, exceptId) {
  const base = String(name || 'Website').trim().slice(0, 60) || 'Website';
  const taken = new Set(cfg.sites.filter((s) => s.id !== exceptId).map((s) => sanitizeSegment(s.name).toLowerCase()));
  if (!taken.has(sanitizeSegment(base).toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(sanitizeSegment(n).toLowerCase())) return n;
  }
  return `${base} ${uid().slice(0, 4)}`;
}

// ------------------------------------------------------------------ config
function normalizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  let selectors = Array.isArray(r.selectors) ? r.selectors : (r.selector ? [r.selector] : []);
  selectors = selectors.map((s) => String(s || '').trim()).filter((s) => s && s.length <= 2000);
  selectors = [...new Set(selectors)].slice(0, 6);
  if (!selectors.length) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : uid(),
    name: String(r.name || '').trim().slice(0, 60) || 'Banner',
    selectors,
    selected: r.selected !== false,
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now()
  };
}

export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const inS = cfg.settings && typeof cfg.settings === 'object' ? cfg.settings : {};
  const s = { ...DEFAULT_SETTINGS, ...inS };
  const sch = { ...DEFAULT_SETTINGS.schedule, ...(inS.schedule && typeof inS.schedule === 'object' ? inS.schedule : {}) };

  const settings = {
    rootFolder: sanitizeSegment(s.rootFolder, 40) || 'Banners',
    duplicateMode: ['day', 'ever', 'never'].includes(s.duplicateMode) ? s.duplicateMode : 'day',
    minWidth: clampInt(s.minWidth, 0, 5000, DEFAULT_SETTINGS.minWidth),
    parallelTabs: clampInt(s.parallelTabs, 1, 5, DEFAULT_SETTINGS.parallelTabs),
    pageWaitSec: clampInt(s.pageWaitSec, 2, 60, DEFAULT_SETTINGS.pageWaitSec),
    csvSeparator: s.csvSeparator === ';' ? ';' : ',',
    saveCsvLog: s.saveCsvLog !== false,
    notify: s.notify !== false,
    hideDownloadBubble: s.hideDownloadBubble !== false,
    schedule: {
      enabled: sch.enabled === true,
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(sch.time)) ? String(sch.time) : DEFAULT_SETTINGS.schedule.time
    }
  };

  const out = { version: 1, sites: [], settings };
  const ids = new Set();
  const keys = new Set();
  for (const site of Array.isArray(cfg.sites) ? cfg.sites : []) {
    if (!site || typeof site !== 'object') continue;
    let url;
    try { url = normalizeUrl(site.url); } catch (e) { continue; }
    if (keys.has(urlKey(url))) continue;
    keys.add(urlKey(url));
    let id = typeof site.id === 'string' && site.id ? site.id.slice(0, 40) : uid();
    if (ids.has(id)) id = uid();
    ids.add(id);
    const ruleIds = new Set();
    const rules = [];
    for (const r of Array.isArray(site.rules) ? site.rules : []) {
      const nr = normalizeRule(r);
      if (!nr) continue;
      if (ruleIds.has(nr.id)) nr.id = uid();
      ruleIds.add(nr.id);
      rules.push(nr);
    }
    const entry = { id, name: '', url, rules };
    entry.name = uniqueSiteName(out, String(site.name || '').trim() || siteNameFromUrl(url), id);
    out.sites.push(entry);
  }
  return out;
}

export async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return normalizeConfig(config);
}

export async function saveConfig(cfg) {
  const clean = normalizeConfig(cfg);
  await chrome.storage.local.set({ config: clean });
  return clean;
}

// Read, change and save the config in one step. The mutator may return a value.
export async function updateConfig(mutator) {
  const cfg = await getConfig();
  const result = await mutator(cfg);
  await saveConfig(cfg);
  return result;
}

// ------------------------------------------------------------------ CSV
export function toCsv(rows, sep = ',') {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    // Stop spreadsheet apps from treating text as a formula.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (s.includes(sep) || /["\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const head = LOG_COLUMNS.map(([, label]) => escape(label)).join(sep);
  const body = rows.map((r) => LOG_COLUMNS.map(([key]) => escape(r[key])).join(sep));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ schedule
export function scheduledAt(time, day = new Date()) {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  const d = new Date(day);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

// When the next scheduled run will happen, given the date of the last one.
export function nextRunTime(schedule, lastScheduledRunDate, now = new Date()) {
  if (!schedule || !schedule.enabled) return null;
  const today = scheduledAt(schedule.time, now);
  if (now < today) return today;
  if (lastScheduledRunDate !== localDate(now)) return now; // due now (missed or right on time)
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return scheduledAt(schedule.time, tomorrow);
}

export function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (localDate(d) === localDate(now)) return `today at ${time}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (localDate(d) === localDate(y)) return `yesterday at ${time}`;
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  if (localDate(d) === localDate(t)) return `tomorrow at ${time}`;
  return `${localDate(d)} at ${time}`;
}
