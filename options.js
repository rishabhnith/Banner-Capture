import {
  getConfig, saveConfig, updateConfig, normalizeConfig, normalizeUrl, urlKey, uid, siteNameFromUrl,
  uniqueSiteName, localDate, toCsv, nextRunTime, formatWhen, sanitizeSegment
} from '../lib/config.js';

const $ = (id) => document.getElementById(id);
let cfg = null;
let runState = null;
let lastRun = null;
let lastScheduledRunDate = null;
const testResults = new Map(); // siteId -> { loading, error, data, ruleId }
const editing = new Set();      // rule ids whose selectors are being edited
let pendingSitesRender = false;
let importData = null;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v === 'boolean') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

let toastTimer = 0;
function toast(text, isError) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('err', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2500);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ header
function renderHeader() {
  const selected = cfg.sites.reduce((n, s) => n + s.rules.filter((r) => r.selected).length, 0);
  const running = !!(runState && runState.running);
  $('run-selected').disabled = running || selected === 0;
  $('run-selected').textContent = running ? 'Capturing…' : `Capture selected (${selected})`;
  $('stop-run').hidden = !running;
  const pill = $('run-pill');
  if (running) {
    pill.replaceChildren(h('span', { class: 'spinner', style: 'width:11px;height:11px;vertical-align:-1px' }),
      ` Capturing ${runState.doneSites} of ${plural(runState.totalSites, 'site')}…` + (runState.active && runState.active.length ? ` (${runState.active.join(', ')})` : ''));
  } else {
    pill.textContent = `${plural(cfg.sites.length, 'website')} · ${plural(selected, 'banner')} selected`;
  }
}

// ------------------------------------------------------------------ sites
function sitesHaveFocus() {
  const a = document.activeElement;
  return !!a && $('sites').contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'));
}

function renderSites() {
  if (sitesHaveFocus()) { pendingSitesRender = true; return; }
  pendingSitesRender = false;
  const box = $('sites');
  if (!cfg.sites.length) {
    box.replaceChildren(h('div', { class: 'empty-sites', text: 'No websites yet. Add one above.' }));
    return;
  }
  box.replaceChildren(...cfg.sites.map(siteCard));
}

function siteCard(site) {
  const total = site.rules.length;
  const sel = site.rules.filter((r) => r.selected).length;
  const all = h('input', { type: 'checkbox', disabled: !total, title: 'Tick or untick all banners of this website' });
  all.checked = total > 0 && sel === total;
  all.indeterminate = sel > 0 && sel < total;
  all.addEventListener('change', () => updateConfig((c) => {
    const s = c.sites.find((x) => x.id === site.id);
    if (s) for (const r of s.rules) r.selected = all.checked;
  }));

  const nameInput = h('input', { type: 'text', class: 'name-input', value: site.name, maxlength: '60', 'aria-label': 'Website name (also the folder name)', title: 'Click to rename (this is also the folder name)' });
  nameInput.addEventListener('change', () => renameSite(site.id, nameInput.value));
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  const test = testResults.get(site.id);
  const head = h('div', { class: 'site-head' },
    all,
    h('div', { class: 'site-title' }, nameInput, h('a', { class: 'site-url', href: site.url, target: '_blank', rel: 'noopener', text: site.url })),
    h('div', { class: 'site-actions' },
      h('button', { class: 'btn sm primary', onclick: () => pick(site.id) }, total ? 'Pick another banner' : 'Pick banner'),
      h('button', { class: 'btn sm', disabled: !total || (test && test.loading), onclick: () => runTest(site.id, null), title: 'Check what would be captured, without saving anything' }, 'Test'),
      h('button', { class: 'btn sm', disabled: !total || (runState && runState.running), onclick: () => captureSite(site.id), title: 'Capture every banner of this website now' }, 'Capture now'),
      h('button', { class: 'btn sm ghost danger', onclick: () => removeSite(site), title: 'Remove this website' }, 'Remove')));

  const card = h('div', { class: 'site' }, head);
  if (!total) {
    card.append(h('div', { class: 'no-rules' }, 'No banner picked yet. Click “Pick banner”, then click the banner on the page.'));
  } else {
    card.append(h('div', { class: 'rules' }, site.rules.map((r) => ruleRow(site, r))));
  }
  if (test) card.append(testPanel(site, test));
  return card;
}

function ruleRow(site, rule) {
  const cb = h('input', { type: 'checkbox', title: 'Include in “Capture selected” and the daily run' });
  cb.checked = rule.selected;
  cb.addEventListener('change', () => updateRule(site.id, rule.id, (r) => { r.selected = cb.checked; }));
  const name = h('input', { type: 'text', class: 'name-input', value: rule.name, maxlength: '60', 'aria-label': 'Banner name' });
  name.addEventListener('change', () => {
    const v = name.value.trim() || 'Banner';
    updateRule(site.id, rule.id, (r) => { r.name = v; });
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  const test = testResults.get(site.id);
  const row = h('div', { class: 'rule' },
    cb,
    name,
    h('code', { title: rule.selectors.join('\n'), text: rule.selectors[0] }),
    h('div', { class: 'rule-actions' },
      h('button', { class: 'btn sm ghost', disabled: !!(test && test.loading), onclick: () => runTest(site.id, rule.id) }, 'Test'),
      h('button', { class: 'btn sm ghost', onclick: () => { editing.has(rule.id) ? editing.delete(rule.id) : editing.add(rule.id); renderSites(); } }, editing.has(rule.id) ? 'Close' : 'Edit'),
      h('button', { class: 'btn sm ghost danger', onclick: () => removeRule(site, rule) }, 'Delete')));
  if (editing.has(rule.id)) {
    const ta = h('textarea', { rows: String(Math.max(3, rule.selectors.length + 1)), spellcheck: 'false' });
    ta.value = rule.selectors.join('\n');
    row.append(h('div', { class: 'rule-edit' },
      h('p', { class: 'small muted', text: 'CSS selectors, one per line. The first one that matches the page is used. Picking the banner again is usually easier than editing these.' }),
      ta,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm primary', onclick: () => saveSelectors(site.id, rule.id, ta.value) }, 'Save selectors'),
        h('button', { class: 'btn sm', onclick: () => { editing.delete(rule.id); renderSites(); } }, 'Cancel'))));
  }
  return row;
}

const STATUS_CHIP = {
  'would save': ['ok', 'Will be saved'],
  saved: ['ok', 'Saved'],
  skipped: ['', 'Skipped'],
  error: ['err', 'Error'],
  'not found': ['warn', 'Not found'],
  'no images': ['warn', 'No images']
};

function testPanel(site, test) {
  const close = h('button', { class: 'btn sm ghost', onclick: () => { testResults.delete(site.id); renderSites(); } }, 'Close');
  if (test.loading) {
    return h('div', { class: 'test' }, h('div', { class: 'test-head' },
      h('span', { class: 'spinner' }), h('b', { text: 'Testing…' }),
      h('span', { class: 'muted small grow', text: 'Opening the page in a background tab and looking for the banner. This takes 10 to 30 seconds. Nothing is saved.' })));
  }
  if (test.error) {
    return h('div', { class: 'test' }, h('div', { class: 'test-head' }, h('span', { class: 'chip err', text: 'Test failed' }), h('span', { class: 'grow', text: test.error }), close));
  }
  const { result, rows } = test.data;
  const would = rows.filter((r) => r.status === 'would save').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const problems = rows.filter((r) => ['error', 'not found', 'no images'].includes(r.status)).length;
  const wrap = h('div', { class: 'test' }, h('div', { class: 'test-head' },
    h('b', { text: 'Test result' }),
    h('span', { class: 'chip ok', text: `${would} would be saved` }),
    skipped ? h('span', { class: 'chip', text: `${skipped} skipped` }) : null,
    problems ? h('span', { class: 'chip err', text: plural(problems, 'problem') }) : null,
    h('span', { class: 'grow' }), close));
  if (!result.ok) {
    wrap.append(h('div', { class: 'notice err', text: result.error || 'The page could not be read.' }));
    return wrap;
  }
  result.rules.forEach((rr, index) => {
    const group = h('div', { class: 'test-group' }, h('h4', { text: rr.ruleName }));
    if (!rr.found || !rr.images) {
      group.append(h('div', { class: 'notice warn' }, rr.message || 'Nothing found.', ' ',
        h('button', { class: 'btn sm', onclick: () => pick(site.id, rr.ruleId) }, 'Pick it again')));
    } else {
      const thumbs = h('div', { class: 'thumbs' });
      for (const row of rows.filter((x) => x.ruleIndex === index && x.image_url)) {
        const [cls, label] = STATUS_CHIP[row.status] || ['', row.status];
        const a = h('a', { class: 'img', href: row.image_url, target: '_blank', rel: 'noopener', title: row.image_url });
        a.style.backgroundImage = `url("${row.image_url.replace(/["\\\n]/g, encodeURIComponent)}")`;
        thumbs.append(h('div', { class: 'thumb' + (row.status === 'skipped' || row.status === 'error' ? ' dim' : '') },
          a,
          h('div', { class: 'meta' },
            h('span', { class: 'chip ' + cls, text: label }),
            h('span', { text: `#${row.slide}${row.width ? ` · ${row.width}×${row.height}` : ''}${row.visible_on_load === 'yes' ? ' · shown first' : ''}` }),
            row.note ? h('span', { class: 'note', title: row.note, text: row.note }) : null)));
      }
      group.append(thumbs);
    }
    wrap.append(group);
  });
  return wrap;
}

// ------------------------------------------------------------------ site actions
async function renameSite(siteId, value) {
  const v = value.trim();
  if (!v) { renderSites(); return; }
  await updateConfig((c) => {
    const s = c.sites.find((x) => x.id === siteId);
    if (s) s.name = uniqueSiteName(c, v, siteId);
  });
  toast('Renamed. New captures go to a folder with this name.');
}

async function updateRule(siteId, ruleId, fn) {
  await updateConfig((c) => {
    const s = c.sites.find((x) => x.id === siteId);
    const r = s && s.rules.find((x) => x.id === ruleId);
    if (r) fn(r);
  });
}

async function saveSelectors(siteId, ruleId, text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { toast('Enter at least one selector.', true); return; }
  for (const l of lines) {
    try { document.createDocumentFragment().querySelector(l); } catch (e) { toast(`Not a valid CSS selector: ${l}`, true); return; }
  }
  editing.delete(ruleId);
  await updateRule(siteId, ruleId, (r) => { r.selectors = lines.slice(0, 6); });
  toast('Selectors saved.');
}

async function removeSite(site) {
  const n = site.rules.length;
  if (!confirm(`Remove ${site.name}${n ? ` and its ${plural(n, 'banner')}` : ''}?\n\nFiles already saved are not deleted.`)) return;
  testResults.delete(site.id);
  await updateConfig((c) => { c.sites = c.sites.filter((s) => s.id !== site.id); });
  toast(`${site.name} removed.`);
}

async function removeRule(site, rule) {
  if (!confirm(`Delete the banner “${rule.name}” from ${site.name}?`)) return;
  editing.delete(rule.id);
  await updateConfig((c) => {
    const s = c.sites.find((x) => x.id === site.id);
    if (s) s.rules = s.rules.filter((r) => r.id !== rule.id);
  });
}

async function pick(siteId, ruleId) {
  const res = await send({ type: 'BCP_PICK', siteId, ruleId });
  if (!res || !res.ok) toast((res && res.error) || 'Could not open the picker.', true);
}

async function runTest(siteId, ruleId) {
  testResults.set(siteId, { loading: true, ruleId });
  renderSites();
  const res = await send({ type: 'BCP_TEST', siteId, ruleId });
  testResults.set(siteId, res && res.ok ? { data: res, ruleId } : { error: (res && res.error) || 'The test failed.', ruleId });
  renderSites();
}

async function captureSite(siteId) {
  const res = await send({ type: 'BCP_RUN', scope: 'site', siteIds: [siteId] });
  if (!res || !res.ok) toast((res && res.error) || 'Could not start the capture.', true);
  else toast('Capture started.');
}

$('add-site').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-msg');
  let url;
  try {
    url = normalizeUrl($('add-url').value);
  } catch (err) {
    msg.replaceChildren(h('div', { class: 'notice err', text: err.message }));
    return;
  }
  const name = $('add-name').value.trim();
  let outcome = null;
  await updateConfig((c) => {
    const dup = c.sites.find((s) => urlKey(s.url) === urlKey(url));
    if (dup) { outcome = { dup }; return; }
    const site = { id: uid(), name: uniqueSiteName(c, name || siteNameFromUrl(url)), url, rules: [] };
    c.sites.push(site);
    outcome = { site };
  });
  if (outcome.dup) {
    msg.replaceChildren(h('div', { class: 'notice warn', text: `That address is already in the list as “${outcome.dup.name}”.` }));
    return;
  }
  $('add-url').value = '';
  $('add-name').value = '';
  msg.replaceChildren(h('div', { class: 'notice ok row wrap' },
    h('span', { class: 'grow', text: `${outcome.site.name} added. Now pick its banner.` }),
    h('button', { class: 'btn sm primary', onclick: () => { msg.replaceChildren(); pick(outcome.site.id); } }, 'Pick banner now')));
});

$('sites').addEventListener('focusout', () => {
  setTimeout(() => { if (pendingSitesRender && !sitesHaveFocus()) renderSites(); }, 0);
});

// ------------------------------------------------------------------ schedule & saving
function renderSettings() {
  const S = cfg.settings;
  $('sch-enabled').checked = S.schedule.enabled;
  if (document.activeElement !== $('sch-time')) $('sch-time').value = S.schedule.time;
  $('sch-time').disabled = !S.schedule.enabled;
  const next = nextRunTime(S.schedule, lastScheduledRunDate);
  const nextEl = $('sch-next');
  if (!S.schedule.enabled) nextEl.textContent = 'The daily run is off.';
  else if (next && next.getTime() <= Date.now() + 1000) nextEl.replaceChildren(h('b', { text: 'Due now.' }), ' It will start within a few minutes.');
  else nextEl.replaceChildren('Next run: ', h('b', { text: formatWhen(next) }), '.');

  if (document.activeElement !== $('set-root')) $('set-root').value = S.rootFolder;
  const firstSite = cfg.sites[0] ? sanitizeSegment(cfg.sites[0].name) : 'Boulanger';
  $('path-example').replaceChildren('Example: ', h('code', { text: `Downloads/${S.rootFolder}/${firstSite}/${localDate()}/Main-banner_01_3fa9c2.jpg` }));
  for (const r of document.querySelectorAll('input[name="dup"]')) r.checked = r.value === S.duplicateMode;
  if (document.activeElement !== $('set-minw')) $('set-minw').value = S.minWidth;
  $('set-sep').value = S.csvSeparator;
  $('set-csv').checked = S.saveCsvLog;
  $('set-notify').checked = S.notify;
  $('set-bubble').checked = S.hideDownloadBubble;
  if (document.activeElement !== $('set-parallel')) $('set-parallel').value = S.parallelTabs;
  if (document.activeElement !== $('set-wait')) $('set-wait').value = S.pageWaitSec;
}

function setSetting(fn) {
  return updateConfig((c) => fn(c.settings)).then(() => toast('Saved.'));
}

$('sch-enabled').addEventListener('change', (e) => setSetting((s) => { s.schedule.enabled = e.target.checked; }));
$('sch-time').addEventListener('change', (e) => { if (e.target.value) setSetting((s) => { s.schedule.time = e.target.value.slice(0, 5); }); });
$('set-root').addEventListener('change', (e) => setSetting((s) => { s.rootFolder = e.target.value; }));
for (const r of document.querySelectorAll('input[name="dup"]')) {
  r.addEventListener('change', () => { if (r.checked) setSetting((s) => { s.duplicateMode = r.value; }); });
}
$('set-minw').addEventListener('change', (e) => setSetting((s) => { s.minWidth = e.target.value; }));
$('set-sep').addEventListener('change', (e) => setSetting((s) => { s.csvSeparator = e.target.value; }));
$('set-csv').addEventListener('change', (e) => setSetting((s) => { s.saveCsvLog = e.target.checked; }));
$('set-notify').addEventListener('change', (e) => setSetting((s) => { s.notify = e.target.checked; }));
$('set-bubble').addEventListener('change', (e) => setSetting((s) => { s.hideDownloadBubble = e.target.checked; }));
$('set-parallel').addEventListener('change', (e) => setSetting((s) => { s.parallelTabs = e.target.value; }));
$('set-wait').addEventListener('change', (e) => setSetting((s) => { s.pageWaitSec = e.target.value; }));

// ------------------------------------------------------------------ last run
function renderLastRun() {
  const when = $('last-run-when');
  const body = $('last-run-body');
  if (!lastRun) {
    when.textContent = 'No capture yet.';
    body.replaceChildren();
    $('show-files').disabled = true;
    return;
  }
  $('show-files').disabled = false;
  when.replaceChildren(
    `Finished ${formatWhen(lastRun.finishedAt)}${lastRun.trigger === 'schedule' ? ' (daily run)' : ''}${lastRun.cancelled ? ' (stopped)' : ''} · `,
    h('span', { class: 'chip ok', text: `${lastRun.saved} saved` }), ' ',
    lastRun.skipped ? h('span', { class: 'chip', text: `${lastRun.skipped} skipped` }) : '', ' ',
    lastRun.problems ? h('span', { class: 'chip err', text: plural(lastRun.problems, 'problem') }) : '');
  if (lastRun.message) {
    body.replaceChildren(h('div', { class: 'notice warn', text: lastRun.message }));
    return;
  }
  const rows = (lastRun.sites || []).map((s) => {
    const notes = [];
    if (s.error) notes.push(h('div', { class: 'sub', text: s.error }));
    for (const r of s.rules || []) {
      if (!r.message) continue;
      const stillThere = cfg.sites.some((x) => x.id === s.siteId && x.rules.some((y) => y.id === r.ruleId));
      notes.push(h('div', { class: 'sub' }, `${r.ruleName}: ${r.message} `,
        !r.found && stillThere ? h('button', { class: 'btn sm', onclick: () => pick(s.siteId, r.ruleId) }, 'Re-pick') : null));
    }
    let chip;
    if (s.cancelled) chip = h('span', { class: 'chip', text: 'Stopped' });
    else if (!s.ok) chip = h('span', { class: 'chip err', text: 'Failed' });
    else if (s.problems && !s.saved && !s.skipped) chip = h('span', { class: 'chip err', text: 'Re-pick banner' });
    else if (s.problems) chip = h('span', { class: 'chip warn', text: 'Partly' });
    else chip = h('span', { class: 'chip ok', text: 'OK' });
    return h('tr', {},
      h('td', {}, h('b', { text: s.siteName }), notes),
      h('td', {}, chip),
      h('td', { class: 'num', text: String(s.saved) }),
      h('td', { class: 'num', text: String(s.skipped) }),
      h('td', { class: 'num', text: String(s.problems) }));
  });
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Website' }), h('th', { text: 'Result' }), h('th', { class: 'num', text: 'Saved' }), h('th', { class: 'num', text: 'Skipped' }), h('th', { class: 'num', text: 'Problems' }))),
    h('tbody', {}, rows));
  const parts = [table];
  if (lastRun.logFile) parts.push(h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Log: ', h('code', { text: lastRun.logFile })));
  body.replaceChildren(...parts);
}

async function renderHistoryCount() {
  const { history } = await chrome.storage.local.get('history');
  const n = Array.isArray(history) ? history.length : 0;
  $('history-count').textContent = n ? `${n} rows in the history.` : 'History is empty.';
  $('export-history').disabled = !n;
}

$('show-files').addEventListener('click', async () => {
  try {
    if (lastRun && lastRun.lastDownloadId) {
      const [item] = await chrome.downloads.search({ id: lastRun.lastDownloadId });
      if (item && item.exists !== false) { chrome.downloads.show(lastRun.lastDownloadId); return; }
    }
  } catch (e) { /* fall through */ }
  chrome.downloads.showDefaultFolder();
});

async function downloadText(text, type, filename, saveAs) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

$('export-history').addEventListener('click', async () => {
  const { history } = await chrome.storage.local.get('history');
  if (!Array.isArray(history) || !history.length) return;
  const root = sanitizeSegment(cfg.settings.rootFolder, 40) || 'Banners';
  await downloadText(toCsv(history, cfg.settings.csvSeparator), 'text/csv', `${root}/_logs/history_${localDate()}.csv`, false);
  toast('History saved to your Downloads folder.');
});

$('clear-history').addEventListener('click', async () => {
  if (!confirm('Clear the capture history and the memory of which images were already saved?\n\nThe next run will save every banner again. Saved files are not deleted.')) return;
  await chrome.storage.local.remove(['history', 'seen', 'lastRun']);
  toast('History cleared.');
});

// ------------------------------------------------------------------ export / import
$('export-config').addEventListener('click', async () => {
  const data = { app: 'banner-capture', formatVersion: 1, exportedAt: new Date().toISOString(), sites: cfg.sites, settings: cfg.settings };
  await downloadText(JSON.stringify(data, null, 2), 'application/json', `banner-capture-settings_${localDate()}.json`, true);
});

$('import-config').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const box = $('import-box');
  box.classList.remove('hidden');
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('This file is too large to be a settings file.');
    const raw = JSON.parse(await file.text());
    if (!raw || !Array.isArray(raw.sites)) throw new Error('This is not a Banner Capture settings file.');
    importData = normalizeConfig(raw);
    const banners = importData.sites.reduce((n, s) => n + s.rules.length, 0);
    box.replaceChildren(h('div', { class: 'notice info' },
      h('span', { class: 'grow' }, `“${file.name}” contains ${plural(importData.sites.length, 'website')} and ${plural(banners, 'banner')}.`),
      h('button', { class: 'btn sm primary', onclick: () => doImport('merge') }, 'Add to my list'),
      h('button', { class: 'btn sm', onclick: () => doImport('replace') }, 'Replace my list and settings'),
      h('button', { class: 'btn sm ghost', onclick: () => { importData = null; box.classList.add('hidden'); } }, 'Cancel')));
  } catch (err) {
    importData = null;
    box.replaceChildren(h('div', { class: 'notice err', text: err instanceof SyntaxError ? 'This file could not be read (it is not valid JSON).' : err.message }));
  }
});

async function doImport(mode) {
  if (!importData) return;
  const data = importData;
  importData = null;
  if (mode === 'replace') {
    if (!confirm('Replace all your websites, banners and settings with the ones in this file?')) return;
    await saveConfig(data);
    toast('Settings imported.');
  } else {
    let sites = 0, rules = 0;
    await updateConfig((c) => {
      for (const s of data.sites) {
        const ex = c.sites.find((x) => urlKey(x.url) === urlKey(s.url));
        if (ex) {
          for (const r of s.rules) {
            if (!ex.rules.some((er) => er.selectors[0] === r.selectors[0])) { ex.rules.push({ ...r, id: uid() }); rules++; }
          }
        } else {
          c.sites.push({ ...s, id: uid(), name: uniqueSiteName(c, s.name), rules: s.rules.map((r) => ({ ...r, id: uid() })) });
          sites++;
          rules += s.rules.length;
        }
      }
    });
    toast(`Added ${plural(sites, 'website')} and ${plural(rules, 'banner')}.`);
  }
  $('import-box').classList.add('hidden');
}

// ------------------------------------------------------------------ header actions
$('run-selected').addEventListener('click', async () => {
  const res = await send({ type: 'BCP_RUN', scope: 'selected' });
  if (!res || !res.ok) toast((res && res.error) || 'Could not start the capture.', true);
});
$('stop-run').addEventListener('click', () => send({ type: 'BCP_STOP' }));
$('welcome-close').addEventListener('click', async () => {
  $('welcome').classList.add('hidden');
  await chrome.storage.local.set({ welcomeDismissed: true });
});
$('open-download-settings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/downloads' }));

// ------------------------------------------------------------------ init
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) {
    cfg = normalizeConfig(changes.config.newValue);
    renderHeader(); renderSites(); renderSettings();
  }
  if (area === 'local' && changes.lastRun) { lastRun = changes.lastRun.newValue || null; renderLastRun(); }
  if (area === 'local' && changes.history) renderHistoryCount();
  if (area === 'local' && changes.lastScheduledRunDate) { lastScheduledRunDate = changes.lastScheduledRunDate.newValue || null; renderSettings(); }
  if (area === 'session' && changes.runState) {
    runState = changes.runState.newValue || null;
    renderHeader();
    if (!sitesHaveFocus()) renderSites();
  }
});

(async () => {
  const [c, session, local] = await Promise.all([
    getConfig(),
    chrome.storage.session.get('runState'),
    chrome.storage.local.get(['lastRun', 'lastScheduledRunDate', 'welcomeDismissed'])
  ]);
  cfg = c;
  runState = session.runState || null;
  lastRun = local.lastRun || null;
  lastScheduledRunDate = local.lastScheduledRunDate || null;
  const params = new URLSearchParams(location.search);
  const noBanners = !cfg.sites.some((s) => s.rules.length);
  if (params.get('welcome') === '1' || (noBanners && !local.welcomeDismissed)) $('welcome').classList.remove('hidden');
  $('version').textContent = `Banner Capture ${chrome.runtime.getManifest().version}`;
  renderHeader();
  renderSites();
  renderSettings();
  renderLastRun();
  renderHistoryCount();
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  // Keep "Next run" fresh while the page stays open.
  setInterval(renderSettings, 60000);
})();
