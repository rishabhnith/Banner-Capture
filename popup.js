import { getConfig, updateConfig, normalizeConfig, findSiteForUrl, hostOf, nextRunTime, formatWhen } from '../lib/config.js';

const $ = (id) => document.getElementById(id);
let cfg = null;
let runState = null;
let lastRun = null;
let lastScheduledRunDate = null;
let tab = null;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v === 'boolean') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ------------------------------------------------------------------ render
function renderSites() {
  const box = $('sites');
  if (!cfg.sites.length) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('p', { text: 'No websites yet.' }),
      h('p', { class: 'small', text: 'Add a site in Settings, or open a website and pick its banner below.' }),
      h('button', { class: 'btn', onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings')));
    return;
  }
  box.replaceChildren(...cfg.sites.map((site) => {
    const total = site.rules.length;
    const sel = site.rules.filter((r) => r.selected).length;
    const siteBox = h('input', { type: 'checkbox', disabled: total === 0, 'aria-label': `Select all banners of ${site.name}` });
    siteBox.checked = total > 0 && sel === total;
    siteBox.indeterminate = sel > 0 && sel < total;
    siteBox.addEventListener('change', () => setSelected(site.id, null, siteBox.checked));
    const head = h('div', { class: 'site-head' },
      h('label', {}, siteBox, h('span', { class: 'site-name', text: site.name })),
      h('span', { class: 'site-count', text: total ? `${sel}/${total}` : '' }));
    const card = h('div', { class: 'site' }, head);
    if (!total) {
      card.append(h('div', { class: 'empty-rules' },
        h('span', { class: 'grow', text: 'No banner picked yet.' }),
        h('button', { class: 'btn sm', onclick: () => pick({ siteId: site.id }) }, 'Pick banner')));
    } else {
      card.append(h('div', { class: 'rules' }, site.rules.map((rule) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = rule.selected;
        cb.addEventListener('change', () => setSelected(site.id, rule.id, cb.checked));
        return h('label', { class: 'rule', title: rule.selectors[0] }, cb, h('span', { text: rule.name }));
      })));
    }
    return card;
  }));
}

function renderButtons() {
  const selected = cfg.sites.reduce((n, s) => n + s.rules.filter((r) => r.selected).length, 0);
  const total = cfg.sites.reduce((n, s) => n + s.rules.length, 0);
  const running = !!(runState && runState.running);
  const capSel = $('capture-selected');
  capSel.textContent = running ? 'Capturing…' : `Capture selected (${selected})`;
  capSel.disabled = running || selected === 0;
  $('capture-all').disabled = running || total === 0;
  $('select-all').disabled = total === 0;
  $('select-none').disabled = total === 0;
}

function renderStatus() {
  const box = $('status');
  const parts = [];
  if (runState && runState.running) {
    const pct = runState.totalSites ? Math.round((runState.doneSites / runState.totalSites) * 100) : 0;
    parts.push(
      h('div', { class: 'line' }, h('span', { class: 'spinner' }),
        h('b', { text: `Capturing ${runState.doneSites} of ${runState.totalSites} site${runState.totalSites === 1 ? '' : 's'}` }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: async () => { await send({ type: 'BCP_STOP' }); } }, 'Stop')),
      h('div', { class: 'progress' + (pct ? '' : ' indeterminate') }, h('i', { style: pct ? `width:${pct}%` : '' })),
      h('div', { class: 'muted' },
        runState.active && runState.active.length ? `Now: ${runState.active.join(', ')} · ` : '',
        `${runState.saved} saved so far`)
    );
  } else if (runState && runState.interrupted && (!lastRun || lastRun.finishedAt < runState.startedAt)) {
    parts.push(h('div', { class: 'notice warn', text: runState.message || 'The last capture was interrupted.' }));
  } else if (lastRun) {
    const chips = [h('span', { class: 'chip ok', text: `${lastRun.saved} saved` })];
    if (lastRun.skipped) chips.push(h('span', { class: 'chip', text: `${lastRun.skipped} already saved / skipped` }));
    if (lastRun.problems) chips.push(h('span', { class: 'chip err', text: `${lastRun.problems} problem${lastRun.problems === 1 ? '' : 's'}` }));
    parts.push(
      h('div', { class: 'line muted' },
        `Last run ${formatWhen(lastRun.finishedAt)}${lastRun.trigger === 'schedule' ? ' (scheduled)' : ''}${lastRun.cancelled ? ' (stopped)' : ''}`),
      lastRun.message ? h('div', { class: 'muted', text: lastRun.message }) : h('div', { class: 'line', style: 'margin-top:4px' }, chips),
      h('div', { class: 'links' },
        h('button', { class: 'btn sm', disabled: !lastRun.saved && !lastRun.logFile, onclick: showFiles }, 'Show files'),
        h('button', { class: 'btn sm', onclick: () => openSettings('last-run') }, 'Details'))
    );
  }
  box.replaceChildren(...parts);
}

function renderSchedule() {
  const sch = cfg.settings.schedule;
  const line = $('schedule-line');
  const link = h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('schedule'); } }, sch.enabled ? 'change' : 'turn on');
  if (sch.enabled) {
    const next = nextRunTime(sch, lastScheduledRunDate);
    line.replaceChildren(`Daily run at ${sch.time}`, next ? ` · next ${formatWhen(next)} · ` : ' · ', link);
  } else {
    line.replaceChildren('Daily run is off · ', link);
  }
}

function renderPage() {
  const box = $('page-box');
  if (!tab || !/^https?:/i.test(tab.url || '')) { box.replaceChildren(); return; }
  const site = findSiteForUrl(cfg, tab.url);
  const where = h('span', { class: 'where' }, 'This page: ', h('b', { text: site ? site.name : hostOf(tab.url) }));
  const btn = h('button', { class: 'btn sm', onclick: () => pick({ tabId: tab.id }) },
    site ? (site.rules.length ? 'Pick another banner here' : 'Pick a banner here') : 'Add site & pick banner');
  box.replaceChildren(where, btn);
}

function renderAll() {
  renderSites();
  renderButtons();
  renderStatus();
  renderSchedule();
  renderPage();
}

// ------------------------------------------------------------------ actions
async function setSelected(siteId, ruleId, value) {
  await updateConfig((c) => {
    const site = c.sites.find((s) => s.id === siteId);
    if (!site) return;
    for (const r of site.rules) if (!ruleId || r.id === ruleId) r.selected = value;
  });
}

async function setAll(value) {
  await updateConfig((c) => { for (const s of c.sites) for (const r of s.rules) r.selected = value; });
}

async function capture(scope) {
  const res = await send({ type: 'BCP_RUN', scope });
  if (!res || !res.ok) $('status').replaceChildren(h('div', { class: 'notice err', text: (res && res.error) || 'Could not start the capture.' }));
}

async function pick(opts) {
  const res = await send({ type: 'BCP_PICK', ...opts });
  if (res && res.ok) { window.close(); return; }
  $('status').replaceChildren(h('div', { class: 'notice err', text: (res && res.error) || 'Could not open the picker on this page.' }));
}

async function showFiles() {
  try {
    if (lastRun && lastRun.lastDownloadId) {
      const [item] = await chrome.downloads.search({ id: lastRun.lastDownloadId });
      if (item && item.exists !== false) { chrome.downloads.show(lastRun.lastDownloadId); return; }
    }
  } catch (e) { /* fall through */ }
  chrome.downloads.showDefaultFolder();
}

function openSettings(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html' + (hash ? '#' + hash : '')) });
  window.close();
}

// ------------------------------------------------------------------ init
$('open-settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('select-all').addEventListener('click', () => setAll(true));
$('select-none').addEventListener('click', () => setAll(false));
$('capture-selected').addEventListener('click', () => capture('selected'));
$('capture-all').addEventListener('click', () => capture('all'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) { cfg = normalizeConfig(changes.config.newValue); renderSites(); renderButtons(); renderSchedule(); renderPage(); }
  if (area === 'local' && changes.lastRun) { lastRun = changes.lastRun.newValue || null; renderStatus(); }
  if (area === 'local' && changes.lastScheduledRunDate) { lastScheduledRunDate = changes.lastScheduledRunDate.newValue || null; renderSchedule(); }
  if (area === 'session' && changes.runState) { runState = changes.runState.newValue || null; renderButtons(); renderStatus(); }
});

(async () => {
  const [c, session, local, tabs] = await Promise.all([
    getConfig(),
    chrome.storage.session.get('runState'),
    chrome.storage.local.get(['lastRun', 'lastScheduledRunDate']),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);
  cfg = c;
  runState = session.runState || null;
  lastRun = local.lastRun || null;
  lastScheduledRunDate = local.lastScheduledRunDate || null;
  tab = tabs && tabs[0];
  renderAll();
})();
