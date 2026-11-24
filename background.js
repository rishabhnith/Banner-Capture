// Banner Capture - background service worker.
// Opens each site in a background tab, finds the chosen banner elements,
// downloads the original image files and writes a CSV log. Also runs the
// optional daily schedule.

import {
  getConfig, saveConfig, updateConfig, normalizeConfig, PRESET_SITES, uid,
  localDate, localTime, sanitizeSegment, toCsv, normalizeUrl, siteNameFromUrl,
  findSiteForUrl, uniqueSiteName, hostOf, nextRunTime, scheduledAt,
  HISTORY_LIMIT, SEEN_LIMIT_PER_SITE
} from './lib/config.js';

const ALARM_CHECK = 'bcp-schedule-check';
const ALARM_EXACT = 'bcp-schedule-exact';
const ALARM_STARTUP = 'bcp-startup-check';
const DATA_URL_MAX_BYTES = 1400000; // larger files are downloaded straight from their URL
const PAGE_LOAD_TIMEOUT = 30000;
const IMAGE_FETCH_TIMEOUT = 30000;

let currentRun = null;
let cancelRequested = false;

// --------------------------------------------------------------- start-up
// A fresh service worker never has a run in progress, so any "running" state
// left in session storage is from a run that was interrupted.
(async () => {
  try {
    const { runState } = await chrome.storage.session.get('runState');
    if (runState && runState.running) {
      await chrome.storage.session.set({
        runState: { ...runState, running: false, interrupted: true, message: 'The last capture was interrupted (Chrome closed or the extension restarted).' }
      });
    }
  } catch (e) { /* ignore */ }
  setDownloadUi(true);
})();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { config } = await chrome.storage.local.get('config');
  if (!config) {
    await saveConfig(normalizeConfig({ sites: PRESET_SITES.map((s) => ({ ...s, id: uid(), rules: [] })) }));
  }
  await ensureAlarms();
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  // Give Chrome a minute to get online before a catch-up run.
  chrome.alarms.create(ALARM_STARTUP, { delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if ([ALARM_CHECK, ALARM_EXACT, ALARM_STARTUP].includes(alarm.name)) checkSchedule();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  const before = JSON.stringify(changes.config.oldValue?.settings?.schedule || null);
  const after = JSON.stringify(changes.config.newValue?.settings?.schedule || null);
  if (before !== after) ensureAlarms();
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('bcp-')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#last-run') });
    chrome.notifications.clear(id);
  }
});

// --------------------------------------------------------------- schedule
async function ensureAlarms() {
  const cfg = await getConfig();
  const sch = cfg.settings.schedule;
  await chrome.alarms.clear(ALARM_EXACT);
  if (!sch.enabled) {
    await chrome.alarms.clear(ALARM_CHECK);
    return;
  }
  // Safety net every 15 minutes, plus an exact alarm at the chosen time.
  if (!(await chrome.alarms.get(ALARM_CHECK))) {
    chrome.alarms.create(ALARM_CHECK, { delayInMinutes: 1, periodInMinutes: 15 });
  }
  const { lastScheduledRunDate } = await chrome.storage.local.get('lastScheduledRunDate');
  const next = nextRunTime(sch, lastScheduledRunDate);
  if (next) chrome.alarms.create(ALARM_EXACT, { when: Math.max(next.getTime(), Date.now() + 30000) });
}

async function checkSchedule() {
  const cfg = await getConfig();
  const sch = cfg.settings.schedule;
  if (!sch.enabled) return;
  const now = new Date();
  const today = localDate(now);
  const { lastScheduledRunDate } = await chrome.storage.local.get('lastScheduledRunDate');
  // Only today's run is caught up: yesterday's banners can't be captured any more.
  if (now >= scheduledAt(sch.time, now) && lastScheduledRunDate !== today && !currentRun) {
    await chrome.storage.local.set({ lastScheduledRunDate: today });
    startRun({ scope: 'selected', trigger: 'schedule' });
  }
  await ensureAlarms();
}

// --------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('BCP_')) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const fromPage = !!sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  // Website tabs (the picker) may only save a picked banner.
  if (fromPage && msg.type !== 'BCP_PICKER_SAVE') return false;
  handleMessage(msg, sender)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: friendlyError(e) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'BCP_RUN':
      if (currentRun) return { ok: false, error: 'A capture is already running.' };
      startRun({ scope: msg.scope || 'selected', siteIds: msg.siteIds, ruleIds: msg.ruleIds, trigger: 'manual' });
      return { ok: true };
    case 'BCP_STOP':
      if (currentRun) cancelRequested = true;
      return { ok: true };
    case 'BCP_TEST':
      return await testSite(msg.siteId, msg.ruleId);
    case 'BCP_PICK':
      return await startPicker(msg);
    case 'BCP_PICKER_SAVE':
      return await savePickedRule(msg, sender);
    default:
      return { ok: false, error: 'Unknown request.' };
  }
}

// --------------------------------------------------------------- picker
async function startPicker({ siteId, tabId, ruleId }) {
  const cfg = await getConfig();
  let site = siteId ? cfg.sites.find((s) => s.id === siteId) : null;
  if (siteId && !site) throw new Error('That site no longer exists.');
  const rule = site && ruleId ? site.rules.find((r) => r.id === ruleId) : null;
  if (!tabId) {
    const tab = await chrome.tabs.create({ url: site.url, active: true });
    tabId = tab.id;
    await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT);
  } else if (!site) {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(tab.url || '')) throw new Error('Open a website first, then pick a banner on it.');
    site = findSiteForUrl(cfg, tab.url);
  }
  let pageHost = '';
  try { pageHost = hostOf((await chrome.tabs.get(tabId)).url); } catch (e) { /* ignore */ }
  const ctx = {
    siteId: site ? site.id : null,
    siteName: site ? site.name : (pageHost ? siteNameFromUrl('https://' + pageHost) : 'this site'),
    existingCount: site ? site.rules.length : 0,
    minWidth: cfg.settings.minWidth,
    ruleId: rule ? rule.id : null,
    ruleName: rule ? rule.name : ''
  };
  await chrome.scripting.executeScript({ target: { tabId }, func: (c) => { window.__BCP_PICKER_CTX = c; }, args: [ctx] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/extract-lib.js', 'content/picker.js'] });
  try { await chrome.tabs.update(tabId, { active: true }); } catch (e) { /* ignore */ }
  return { ok: true };
}

async function savePickedRule(msg, sender) {
  const pageUrl = (sender.tab && sender.tab.url) || msg.pageUrl;
  const rawSelectors = Array.isArray(msg.rule?.selectors) ? msg.rule.selectors : [];
  const selectors = rawSelectors.map((s) => String(s || '').trim()).filter((s) => s && s.length <= 2000).slice(0, 6);
  if (!selectors.length) throw new Error('Could not describe this element. Try selecting a bigger area.');
  const name = String(msg.rule?.name || '').trim().slice(0, 60) || 'Banner';
  let out = null;
  await updateConfig((cfg) => {
    let site = msg.siteId ? cfg.sites.find((s) => s.id === msg.siteId) : null;
    if (!site) site = findSiteForUrl(cfg, pageUrl);
    if (!site) {
      const u = new URL(normalizeUrl(pageUrl));
      const url = u.origin + u.pathname;
      site = { id: uid(), name: uniqueSiteName(cfg, siteNameFromUrl(url)), url, rules: [] };
      cfg.sites.push(site);
    }
    // Re-pick: give an existing banner a new selection, keeping its name and history.
    const target = msg.ruleId ? site.rules.find((r) => r.id === msg.ruleId) : null;
    if (target) {
      target.selectors = selectors;
      target.selected = true;
      if (msg.rule?.name && String(msg.rule.name).trim()) target.name = name;
      out = { ok: true, siteId: site.id, siteName: site.name, ruleId: target.id, name: target.name, mode: 'replaced' };
      return;
    }
    const existing = site.rules.find((r) => r.selectors[0] === selectors[0]);
    if (existing) {
      existing.selected = true;
      out = { ok: true, siteId: site.id, siteName: site.name, ruleId: existing.id, name: existing.name, mode: 'already' };
      return;
    }
    const rule = { id: uid(), name, selectors, selected: true, createdAt: Date.now() };
    site.rules.push(rule);
    out = { ok: true, siteId: site.id, siteName: site.name, ruleId: rule.id, name: rule.name, mode: 'new' };
  });
  return out;
}

// --------------------------------------------------------------- runs
function startRun(opts) {
  cancelRequested = false;
  currentRun = runCapture(opts)
    .catch(async (e) => {
      await setRunState({ running: false, finishedAt: Date.now(), message: 'Capture failed: ' + friendlyError(e) });
    })
    .finally(() => { currentRun = null; cancelRequested = false; });
  return currentRun;
}

function buildJobs(cfg, scope, siteIds, ruleIds) {
  const jobs = [];
  for (const site of cfg.sites) {
    let rules = site.rules;
    if (scope === 'selected') rules = rules.filter((r) => r.selected);
    else if (scope === 'site') rules = (siteIds || []).includes(site.id) ? rules : [];
    else if (scope === 'rules') rules = rules.filter((r) => (ruleIds || []).includes(r.id));
    if (rules.length) jobs.push({ site, rules });
  }
  return jobs;
}

async function runCapture({ scope = 'selected', siteIds, ruleIds, trigger = 'manual' }) {
  const cfg = await getConfig();
  const S = cfg.settings;
  const jobs = buildJobs(cfg, scope, siteIds, ruleIds);
  const started = new Date();
  const state = {
    running: true, trigger, startedAt: started.getTime(), totalSites: jobs.length, doneSites: 0,
    active: [], saved: 0, skipped: 0, problems: 0, message: ''
  };
  await setRunState(state);

  if (!jobs.length) {
    const summary = {
      trigger, startedAt: started.getTime(), finishedAt: Date.now(), totalSites: 0, sitesOk: 0,
      saved: 0, skipped: 0, problems: 0, sites: [], logFile: null, lastDownloadId: null,
      message: 'Nothing to capture: no banners are selected.'
    };
    await chrome.storage.local.set({ lastRun: summary });
    await setRunState({ running: false, finishedAt: Date.now(), ...summary });
    if (trigger === 'schedule' && S.notify) notify('Banner capture skipped', summary.message);
    return summary;
  }

  const ctx = {
    S, date: localDate(started), time: localTime(started), dryRun: false,
    seen: await loadSeen(), rows: [], lastDownloadId: null
  };
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  if (S.hideDownloadBubble) await setDownloadUi(false);
  const results = new Array(jobs.length);
  let win = null;
  try {
    win = await getCaptureWindow();
    ctx.windowId = win.windowId;
    await pool(jobs, S.parallelTabs, async (job, index) => {
      if (cancelRequested) {
        results[index] = siteResult(job.site, { cancelled: true, error: 'Stopped before this site was captured.' });
        return;
      }
      state.active.push(job.site.name);
      await setRunState(state);
      const res = await captureSite(job, ctx);
      results[index] = res;
      state.active = state.active.filter((n) => n !== job.site.name);
      state.doneSites += 1;
      state.saved += res.saved;
      state.skipped += res.skipped;
      state.problems += res.problems;
      await setRunState(state);
    });
  } finally {
    clearInterval(keepAlive);
    if (win) await win.cleanup();
    if (S.hideDownloadBubble) await setDownloadUi(true);
  }

  await saveSeen(ctx.seen);
  const order = new Map(jobs.map((j, i) => [j.site.id, i]));
  ctx.rows.sort((a, b) => (order.get(a._siteId) - order.get(b._siteId)) || (a._ruleIndex - b._ruleIndex) || (a.slide - b.slide));
  const rows = ctx.rows.map(({ _siteId, _ruleIndex, ...r }) => r);

  let logFile = null;
  if (S.saveCsvLog && rows.length) {
    try { logFile = await saveCsvLog(rows, S, ctx.date, ctx.time); } catch (e) { logFile = null; }
  }
  await appendHistory(rows);

  const sites = results.filter(Boolean);
  const summary = {
    trigger,
    startedAt: started.getTime(),
    finishedAt: Date.now(),
    totalSites: jobs.length,
    sitesOk: sites.filter((s) => s.ok && !s.problems).length,
    saved: sites.reduce((n, s) => n + s.saved, 0),
    skipped: sites.reduce((n, s) => n + s.skipped, 0),
    problems: sites.reduce((n, s) => n + s.problems, 0),
    cancelled: cancelRequested,
    sites,
    logFile,
    lastDownloadId: ctx.lastDownloadId,
    message: ''
  };
  await chrome.storage.local.set({ lastRun: summary });
  await setRunState({ running: false, finishedAt: summary.finishedAt, ...summary });

  if (S.notify) {
    const parts = [`${summary.saved} new image${summary.saved === 1 ? '' : 's'} saved from ${summary.totalSites} site${summary.totalSites === 1 ? '' : 's'}`];
    if (summary.skipped) parts.push(`${summary.skipped} already saved`);
    if (summary.problems) parts.push(`${summary.problems} problem${summary.problems === 1 ? '' : 's'}`);
    notify(summary.cancelled ? 'Banner capture stopped' : 'Banner capture finished', parts.join(' · '));
  }
  return summary;
}

async function testSite(siteId, ruleId) {
  const cfg = await getConfig();
  const site = cfg.sites.find((s) => s.id === siteId);
  if (!site) throw new Error('That site no longer exists.');
  const rules = ruleId ? site.rules.filter((r) => r.id === ruleId) : site.rules;
  if (!rules.length) throw new Error('This site has no banners yet. Click "Pick banner" first.');
  const now = new Date();
  const ctx = {
    S: cfg.settings, date: localDate(now), time: localTime(now), dryRun: true,
    seen: await loadSeen(), rows: [], lastDownloadId: null
  };
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  let win = null;
  try {
    win = await getCaptureWindow();
    ctx.windowId = win.windowId;
    const result = await captureSite({ site, rules }, ctx);
    const rows = ctx.rows
      .sort((a, b) => (a._ruleIndex - b._ruleIndex) || (a.slide - b.slide))
      .map(({ _siteId, _ruleIndex, ...r }) => ({ ...r, ruleIndex: _ruleIndex }));
    return { ok: true, result, rows };
  } finally {
    clearInterval(keepAlive);
    if (win) await win.cleanup();
  }
}

function siteResult(site, extra) {
  return {
    siteId: site.id, siteName: site.name, url: site.url, ok: true, error: '',
    found: 0, saved: 0, skipped: 0, problems: 0, rules: [], ...(extra || {})
  };
}

async function captureSite(job, ctx) {
  const { site, rules } = job;
  const res = siteResult(site);
  const base = { date: ctx.date, time: ctx.time, site: site.name, page_url: site.url, _siteId: site.id };
  let tabId = null;
  let extraction = null;
  try {
    const tab = await chrome.tabs.create({ url: site.url, active: false, windowId: ctx.windowId });
    tabId = tab.id;
    try { await chrome.tabs.update(tabId, { muted: true }); } catch (e) { /* ignore */ }
    const load = await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT);
    if (load === 'closed') throw new Error('The tab was closed before the page finished loading.');
    extraction = await extractInTab(tabId, rules, ctx.S);
  } catch (e) {
    res.ok = false;
    res.error = friendlyError(e);
    res.problems += 1;
    ctx.rows.push({ ...base, banner: '', slide: 0, status: 'error', note: res.error, _ruleIndex: -1 });
    return res;
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }

  const runSeen = new Map(); // image hash -> "Banner #slide" within this run
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const ex = extraction.find((x) => x.ruleId === rule.id);
    const rr = { ruleId: rule.id, ruleName: rule.name, found: false, images: 0, saved: 0, skipped: 0, problems: 0, message: '' };
    res.rules.push(rr);
    const rowBase = { ...base, banner: rule.name, _ruleIndex: ri };
    if (!ex || !ex.found) {
      rr.message = 'Banner not found on the page. The site may have changed its layout: pick this banner again.';
      rr.problems = 1;
      res.problems += 1;
      ctx.rows.push({ ...rowBase, slide: 0, status: 'not found', note: rr.message });
      continue;
    }
    rr.found = true;
    rr.images = ex.images.length;
    res.found += ex.images.length;
    if (!ex.images.length) {
      rr.message = 'The banner was found but contained no images.';
      rr.problems = 1;
      res.problems += 1;
      ctx.rows.push({ ...rowBase, slide: 0, status: 'no images', note: rr.message });
      continue;
    }
    let slide = 0;
    for (const img of ex.images) {
      if (cancelRequested && !ctx.dryRun) break;
      slide += 1;
      const row = await processImage(img, { ...rowBase, slide }, { site, rule, ctx, runSeen });
      ctx.rows.push(row);
      if (row.status === 'saved') { rr.saved++; res.saved++; }
      else if (row.status === 'error') { rr.problems++; res.problems++; }
      else { rr.skipped++; res.skipped++; }
    }
  }
  return res;
}

async function extractInTab(tabId, rules, S) {
  const payload = rules.map((r) => ({ id: r.id, selectors: r.selectors }));
  const opts = { waitMs: S.pageWaitSec * 1000 };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/extract-lib.js'] });
      const [first] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (r, o) => window.__BCP.extract(r, o),
        args: [payload, opts]
      });
      if (first && Array.isArray(first.result)) return first.result;
      throw new Error('The page did not answer.');
    } catch (e) {
      lastErr = e;
      // The page may have redirected (consent page, A/B test). Wait and retry once.
      await waitForTabComplete(tabId, 15000);
    }
  }
  throw lastErr || new Error('Could not read the page.');
}

// --------------------------------------------------------------- images
async function processImage(img, row, { site, rule, ctx, runSeen }) {
  const { S, date, dryRun } = ctx;
  Object.assign(row, {
    status: '', note: '', width: '', height: '', size_kb: '', first_seen: '',
    visible_on_load: img.visible ? 'yes' : 'no', alt_text: img.alt || '', slide_text: img.text || '',
    link: img.link || '', image_url: img.url, file: ''
  });

  let bytes = null;
  let mime = '';
  let fetchError = '';
  try {
    const r = await fetchWithTimeout(img.url, IMAGE_FETCH_TIMEOUT);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
    mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  } catch (e) {
    fetchError = friendlyError(e);
  }

  if (!bytes) {
    // Could not read the file ourselves: let Chrome download it directly.
    if (dryRun) {
      row.status = 'would save';
      row.note = `Could not check this image in advance (${fetchError}); it will be downloaded directly.`;
      return row;
    }
    const ext = extFromUrl(img.url) || 'jpg';
    const filename = buildFilename(S, site, rule, date, row.slide, 'nohash', ext);
    try {
      const id = await chrome.downloads.download({ url: img.url, filename, conflictAction: 'uniquify', saveAs: false });
      const done = await waitForDownload(id);
      if (done.state === 'interrupted') throw new Error(done.error || 'download interrupted');
      ctx.lastDownloadId = id;
      row.status = 'saved';
      row.note = 'Saved directly (could not be checked for duplicates).';
      row.file = done.filename || filename;
    } catch (e) {
      row.status = 'error';
      row.note = `Could not download the image (${fetchError}; ${friendlyError(e)}).`;
    }
    return row;
  }

  const kind = sniffImage(bytes) || kindFromMime(mime) || extFromUrl(img.url);
  if (!kind) {
    row.status = 'error';
    row.note = /html|json|text/.test(mime) ? 'The address returned a web page, not an image.' : 'The file is not a recognised image.';
    return row;
  }
  if (kind === 'svg') {
    row.status = 'skipped';
    row.note = 'Vector icon (SVG), not a banner image.';
    return row;
  }
  row.size_kb = Math.round(bytes.length / 102.4) / 10;
  const dims = await measure(bytes, MIME_BY_KIND[kind] || mime);
  if (dims) {
    row.width = dims.width;
    row.height = dims.height;
  }
  if (dims && dims.width < S.minWidth) {
    row.status = 'skipped';
    row.note = `Too small (${dims.width}px wide; minimum is ${S.minWidth}px).`;
    return row;
  }
  if (!dims && bytes.length < 2048) {
    row.status = 'skipped';
    row.note = 'Tiny file (probably an icon or tracking pixel).';
    return row;
  }

  const hash = await sha1(bytes);
  const siteSeen = ctx.seen[site.id] || (ctx.seen[site.id] = {});
  const prior = siteSeen[hash];
  row.first_seen = prior ? prior.f : date;

  if (runSeen.has(hash)) {
    row.status = 'skipped';
    row.note = `Same image as ${runSeen.get(hash)}.`;
    return row;
  }
  runSeen.set(hash, `${rule.name} #${row.slide}`);

  if (prior && prior.s && S.duplicateMode === 'day' && prior.s === date) {
    row.status = 'skipped';
    row.note = 'Already saved today.';
    row.file = prior.p || '';
    if (!dryRun) prior.v = date;
    return row;
  }
  if (prior && prior.s && S.duplicateMode === 'ever') {
    row.status = 'skipped';
    row.note = `Already saved on ${prior.s} (first seen ${prior.f}).`;
    row.file = prior.p || '';
    if (!dryRun) prior.v = date;
    return row;
  }

  const filename = buildFilename(S, site, rule, date, row.slide, hash, kind);
  if (dryRun) {
    row.status = 'would save';
    row.file = filename;
    return row;
  }

  try {
    let id;
    if (bytes.length <= DATA_URL_MAX_BYTES) {
      const url = `data:${MIME_BY_KIND[kind] || 'application/octet-stream'};base64,${toBase64(bytes)}`;
      id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    } else {
      id = await chrome.downloads.download({ url: img.url, filename, conflictAction: 'uniquify', saveAs: false });
    }
    const done = await waitForDownload(id);
    if (done.state === 'interrupted') throw new Error(done.error || 'download interrupted');
    ctx.lastDownloadId = id;
    row.status = 'saved';
    row.file = done.filename || filename;
    siteSeen[hash] = { f: prior ? prior.f : date, s: date, v: date, p: row.file };
  } catch (e) {
    row.status = 'error';
    row.note = 'Download failed: ' + friendlyError(e);
  }
  return row;
}

const MIME_BY_KIND = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml'
};

function sniffImage(b) {
  if (b.length < 12) return '';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/avi[fs]/.test(brand)) return 'avif';
  }
  if (b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 512))).trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return '';
}

function kindFromMime(mime) {
  const m = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/apng': 'png',
    'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
  };
  return m[mime] || '';
}

function extFromUrl(url) {
  try {
    const m = /\.(jpe?g|png|webp|avif|gif|bmp|svg)$/i.exec(new URL(url).pathname);
    if (!m) return '';
    const e = m[1].toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
  } catch (e) {
    return '';
  }
}

async function measure(bytes, mime) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const d = { width: bmp.width, height: bmp.height };
    bmp.close();
    if (d.width && d.height) return d;
  } catch (e) { /* fall back to reading the file header */ }
  return headerDims(bytes);
}

function headerDims(b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) };
    if (b[0] === 0x47 && b[1] === 0x49) return { width: u16le(6), height: u16le(8) };
    if (b[0] === 0xFF && b[1] === 0xD8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
          return { width: u16(i + 7), height: u16(i + 5) };
        }
        i += 2 + u16(i + 2);
      }
    }
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (chunk === 'VP8 ') return { width: u16le(26) & 0x3FFF, height: u16le(28) & 0x3FFF };
      if (chunk === 'VP8L') {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
      }
    }
  } catch (e) { /* unknown layout */ }
  return null;
}

async function sha1(bytes) {
  const d = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      signal: ac.signal,
      credentials: 'include',
      cache: 'no-cache',
      redirect: 'follow',
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
    });
  } finally {
    clearTimeout(t);
  }
}

function buildFilename(S, site, rule, date, slide, hash, ext) {
  const root = sanitizeSegment(S.rootFolder, 40) || 'Banners';
  const siteDir = sanitizeSegment(site.name) || 'Website';
  const ruleName = (sanitizeSegment(rule.name, 40) || 'Banner').replace(/\s+/g, '-');
  const short = hash === 'nohash' ? Date.now().toString(36).slice(-6) : hash.slice(0, 6);
  return `${root}/${siteDir}/${date}/${ruleName}_${String(slide).padStart(2, '0')}_${short}.${ext}`;
}

// --------------------------------------------------------------- downloads
function waitForDownload(id, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = async (state, error) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      let filename = '';
      try {
        const [item] = await chrome.downloads.search({ id });
        if (item) filename = item.filename || '';
      } catch (e) { /* ignore */ }
      resolve({ state, error, filename });
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish('complete');
      else if (delta.state.current === 'interrupted') finish('interrupted', delta.error ? delta.error.current : 'interrupted');
    };
    chrome.downloads.onChanged.addListener(onChanged);
    const timer = setTimeout(() => finish('pending'), timeoutMs);
    chrome.downloads.search({ id }).then(([item]) => {
      if (!item) return;
      if (item.state === 'complete') finish('complete');
      else if (item.state === 'interrupted') finish('interrupted', item.error || 'interrupted');
    }).catch(() => {});
  });
}

async function setDownloadUi(enabled) {
  try {
    if (chrome.downloads && typeof chrome.downloads.setUiOptions === 'function') {
      await chrome.downloads.setUiOptions({ enabled });
    }
  } catch (e) { /* not supported in this browser */ }
}

async function saveCsvLog(rows, S, date, time) {
  const csv = toCsv(rows, S.csvSeparator);
  const root = sanitizeSegment(S.rootFolder, 40) || 'Banners';
  const filename = `${root}/_logs/capture_${date}_${time.replace(/:/g, '-')}.csv`;
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  const done = await waitForDownload(id, 30000);
  return done.filename || filename;
}

// --------------------------------------------------------------- tabs
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (why) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve(why);
    };
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && /^https?:/i.test((tab && tab.url) || '')) finish('complete');
    };
    const onRemoved = (id) => { if (id === tabId) finish('closed'); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && /^https?:/i.test(tab.url || '')) finish('complete');
    }).catch(() => finish('closed'));
  });
}

// Use an existing normal window; if Chrome has none open (scheduled run),
// open a minimised one and close it afterwards.
async function getCaptureWindow() {
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const usable = wins.filter((w) => !w.incognito);
    const w = usable.find((x) => x.focused) || usable[0];
    if (w) return { windowId: w.id, cleanup: async () => {} };
  } catch (e) { /* fall through */ }
  const w = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
  return {
    windowId: w.id,
    cleanup: async () => { try { await chrome.windows.remove(w.id); } catch (e) { /* already closed */ } }
  };
}

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// --------------------------------------------------------------- storage
async function setRunState(state) {
  try { await chrome.storage.session.set({ runState: { ...state, active: [...(state.active || [])] } }); } catch (e) { /* ignore */ }
}

async function loadSeen() {
  const { seen } = await chrome.storage.local.get('seen');
  return seen && typeof seen === 'object' ? seen : {};
}

async function saveSeen(seen) {
  for (const siteId of Object.keys(seen)) {
    const entries = Object.entries(seen[siteId] || {});
    if (entries.length > SEEN_LIMIT_PER_SITE) {
      entries.sort((a, b) => String(b[1].v || b[1].s || '').localeCompare(String(a[1].v || a[1].s || '')));
      seen[siteId] = Object.fromEntries(entries.slice(0, SEEN_LIMIT_PER_SITE));
    }
  }
  await chrome.storage.local.set({ seen });
}

async function appendHistory(rows) {
  if (!rows.length) return;
  const { history } = await chrome.storage.local.get('history');
  let all = Array.isArray(history) ? history.concat(rows) : rows.slice();
  if (all.length > HISTORY_LIMIT) all = all.slice(all.length - HISTORY_LIMIT);
  await chrome.storage.local.set({ history: all });
}

// --------------------------------------------------------------- misc
function notify(title, message) {
  try {
    chrome.notifications.create('bcp-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 0
    });
  } catch (e) { /* notifications disabled */ }
}

function friendlyError(e) {
  const m = String((e && e.message) || e || 'Unknown error');
  if (/Cannot access contents of|cannot be scripted|chrome:\/\/|extensions gallery|Cannot access a chrome/i.test(m)) {
    return 'Chrome does not allow extensions to read this page.';
  }
  if (/showing error page|ERR_|net::/i.test(m)) return 'The page failed to load (check the address or the internet connection).';
  if (/No tab with id|tab was closed/i.test(m)) return 'The tab was closed.';
  if (/Frame with ID|was removed|navigated/i.test(m)) return 'The page kept changing while it was being read.';
  if (/aborted|AbortError/i.test(m)) return 'Timed out';
  if (/Failed to fetch/i.test(m)) return 'network error';
  return m;
}
