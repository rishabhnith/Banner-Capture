/*
 * Banner Capture - point-and-click banner picker.
 * Hover over the page to highlight elements, click the banner, adjust the
 * selection with Bigger/Smaller, preview the images found, name it and save.
 * Runs in the extension's isolated world; its UI lives in a closed shadow root.
 */
(() => {
  const BCP = window.__BCP;
  if (!BCP) return;
  if (window.__BCP_PICKER) {
    window.__BCP_PICKER.restart(window.__BCP_PICKER_CTX);
    return;
  }

  const ctx = Object.assign(
    { siteId: null, siteName: location.hostname.replace(/^www\./, ''), existingCount: 0, minWidth: 300 },
    window.__BCP_PICKER_CTX || {}
  );

  // ------------------------------------------------------------------ UI shell
  const host = document.createElement('div');
  host.setAttribute('data-banner-capture-picker', '');
  host.style.cssText = [
    'all:initial', 'position:fixed', 'inset:0', 'width:100vw', 'height:100vh', 'margin:0', 'padding:0',
    'border:0', 'background:transparent', 'overflow:visible', 'pointer-events:none',
    'z-index:2147483647', 'display:block', 'color-scheme:light'
  ].join(';');
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .hl, .sel { position: fixed; display: none; pointer-events: none; border-radius: 4px; }
  .hl { border: 2px dashed #ff5a36; background: rgba(255, 90, 54, .10); }
  .sel { border: 3px solid #2f5bea; background: rgba(47, 91, 234, .12); box-shadow: 0 0 0 9999px rgba(15, 23, 42, .28); }
  .tag {
    position: absolute; left: -2px; top: -24px; max-width: 520px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; background: #ff5a36; color: #fff; font: 600 11px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 4px 7px; border-radius: 4px;
  }
  .tag.inside { top: 2px; left: 2px; }
  .sel .tag { background: #2f5bea; }
  .panel {
    position: fixed; width: 360px; max-height: calc(100vh - 32px); overflow: auto; pointer-events: auto;
    background: #fff; color: #172033; border-radius: 14px; border: 1px solid #e3e7ef;
    box-shadow: 0 18px 50px rgba(15, 23, 42, .28), 0 2px 8px rgba(15, 23, 42, .12);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
  }
  .pos-br { right: 16px; bottom: 16px; } .pos-bl { left: 16px; bottom: 16px; }
  .pos-tl { left: 16px; top: 16px; }    .pos-tr { right: 16px; top: 16px; }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 10px 14px; border-bottom: 1px solid #eef1f6; }
  .logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #2f5bea, #6a3df0); display: grid; place-items: center; flex: none; }
  .logo i { width: 12px; height: 8px; border: 2px solid #fff; border-radius: 2px; display: block; }
  .title { font-weight: 700; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title small { font-weight: 500; color: #5d6b82; }
  .icon { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: #5d6b82; font-size: 15px; }
  .icon:hover { background: #f1f4f9; color: #172033; }
  .body { padding: 12px 14px 14px; }
  p { margin: 0 0 8px; }
  .muted { color: #5d6b82; }
  .small { font-size: 12px; }
  .code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f4f6fa; border: 1px solid #e3e7ef; border-radius: 6px; padding: 6px 8px; word-break: break-all; margin-bottom: 8px; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .btn {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 12px; border-radius: 8px; font-weight: 600; font-size: 12.5px; border: 1px solid #d5dbe6; background: #fff; color: #172033;
  }
  .btn:hover { background: #f4f6fa; }
  .btn:focus-visible, .icon:focus-visible { outline: 2px solid #2f5bea; outline-offset: 2px; }
  .btn.primary { background: #2f5bea; border-color: #2f5bea; color: #fff; }
  .btn.primary:hover { background: #2549c8; }
  .btn[disabled] { opacity: .45; cursor: default; pointer-events: none; }
  .grow { flex: 1; }
  label.lbl { display: block; font-weight: 600; font-size: 12px; margin: 12px 0 4px; }
  input.name {
    all: unset; box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid #d5dbe6; border-radius: 8px; font-size: 13px; background: #fff; color: #172033;
  }
  input.name:focus { border-color: #2f5bea; box-shadow: 0 0 0 3px rgba(47, 91, 234, .18); }
  .count { font-weight: 700; }
  .thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }
  .thumb { position: relative; height: 52px; border-radius: 6px; overflow: hidden; background: #eef1f6; border: 1px solid #e3e7ef; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb.small img { opacity: .35; }
  .thumb.small::after { content: 'small'; position: absolute; inset: auto 3px 3px auto; font-size: 10px; background: rgba(0,0,0,.6); color: #fff; padding: 1px 4px; border-radius: 4px; }
  .more { display: grid; place-items: center; height: 52px; border-radius: 6px; background: #f4f6fa; color: #5d6b82; font-weight: 600; font-size: 12px; }
  .hint { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: #fff6e5; color: #7a4b00; font-size: 12px; }
  .info { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: #e9eeff; color: #22315e; font-size: 12px; }
  .err { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: #fde8e6; color: #8f2219; font-size: 12px; }
  .ok { display: flex; gap: 8px; align-items: flex-start; }
  .ok .tick { color: #1a8f5a; font-size: 18px; line-height: 1; font-weight: 700; }
  .keys { margin-top: 10px; color: #8190a5; font-size: 11px; }
  kbd { font: 11px ui-monospace, monospace; background: #f1f4f9; border: 1px solid #dfe4ec; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: #3b475c; }
</style>
<div class="hl"><span class="tag"></span></div>
<div class="sel"><span class="tag"></span></div>
<div class="panel pos-br" role="dialog" aria-label="Banner Capture picker">
  <div class="head">
    <span class="logo"><i></i></span>
    <span class="title"></span>
    <button class="icon move" title="Move this panel">⇆</button>
    <button class="icon close" title="Close picker (Esc)">✕</button>
  </div>
  <div class="body"></div>
</div>`;

  const $ = (s) => root.querySelector(s);
  const hl = $('.hl'), hlTag = $('.hl .tag'), selBox = $('.sel'), selTag = $('.sel .tag');
  const panel = $('.panel'), body = $('.body'), titleEl = $('.title');
  const CORNERS = ['pos-br', 'pos-bl', 'pos-tl', 'pos-tr'];
  let corner = 0;

  let state = 'hover';           // hover | selected | paused | saved
  let hovered = null;
  let selected = null;
  let downStack = [];
  let lastX = 0, lastY = 0, raf = 0;
  let busy = false;
  let errorText = '';
  let lastSavedName = '';
  let nameDraft = '';
  let autoNote = '';

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }

  const defaultName = () => (ctx.ruleId && ctx.ruleName ? ctx.ruleName : (ctx.existingCount === 0 ? 'Main banner' : `Banner ${ctx.existingCount + 1}`));
  let savedMode = 'new';
  const intercepting = () => state === 'hover' || state === 'selected';

  // ------------------------------------------------------------------ geometry
  function place(box, tagEl, el, label) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = Math.max(r.width, 2) + 'px';
    box.style.height = Math.max(r.height, 2) + 'px';
    tagEl.textContent = `${label ? label + '  ' : ''}${BCP.describe(el)}  ·  ${Math.round(r.width)}×${Math.round(r.height)}`;
    tagEl.classList.toggle('inside', r.top < 26);
  }

  function elementAt(x, y) {
    const list = document.elementsFromPoint(x, y);
    for (const n of list) {
      if (n === host || n === document.documentElement || n === document.body) continue;
      return n;
    }
    return null;
  }

  function drawHover() {
    if (!intercepting() || !hovered || hovered === selected) { hl.style.display = 'none'; return; }
    place(hl, hlTag, hovered, 'Click to select');
  }

  function drawSelection() {
    if (selected && (state === 'selected' || state === 'saved')) place(selBox, selTag, selected, state === 'saved' ? 'Saved' : 'Selected');
    else selBox.style.display = 'none';
  }

  function redraw() { drawHover(); drawSelection(); }

  // ------------------------------------------------------------------ events
  const isOurs = (e) => (typeof e.composedPath === 'function' ? e.composedPath().includes(host) : false);

  function onMove(e) {
    if (!intercepting()) return;
    if (isOurs(e)) { hovered = null; hl.style.display = 'none'; return; }
    lastX = e.clientX;
    lastY = e.clientY;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        hovered = elementAt(lastX, lastY);
        drawHover();
      });
    }
  }

  function block(e) {
    if (!intercepting() || isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!intercepting() || isOurs(e)) return;
    block(e);
    const el = elementAt(e.clientX, e.clientY) || hovered;
    if (el) select(el);
  }

  function onKey(e) {
    const target = typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target;
    const inOurInput = isOurs(e) && target && target.localName === 'input';
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (state === 'selected') { selected = null; downStack = []; state = 'hover'; errorText = ''; autoNote = ''; render(); redraw(); }
      else close();
      return;
    }
    if (state !== 'selected') return;
    if (e.key === 'Enter' && (inOurInput || !isOurs(e))) { e.preventDefault(); e.stopPropagation(); save(); return; }
    if (inOurInput) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); bigger(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); smaller(); }
  }

  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchend', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'submit'];
  const onScroll = () => redraw();

  function listen(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('mousemove', onMove, true);
    window[m]('click', onClick, true);
    for (const t of BLOCKED) window[m](t, block, true);
    window[m]('keydown', onKey, true);
    window[m]('scroll', onScroll, true);
    window[m]('resize', onScroll, true);
  }

  // Keystrokes typed in the picker must not reach the website's shortcuts.
  for (const t of ['keydown', 'keyup', 'keypress', 'input']) {
    panel.addEventListener(t, (e) => { if (e.key !== 'Escape' && e.key !== 'Enter') e.stopPropagation(); });
  }

  // ------------------------------------------------------------------ actions
  function select(el) {
    if (nameInputValue()) nameDraft = nameInputValue();
    selected = el;
    downStack = [];
    autoNote = '';
    // Clicking one slide selects the whole carousel; "Smaller" walks back down.
    let carousel = null;
    try { carousel = BCP.findCarousel ? BCP.findCarousel(el) : null; } catch (e) { carousel = null; }
    if (carousel && carousel !== el && carousel.contains(el)) {
      for (let n = el; n && n !== carousel; n = n.parentElement) downStack.push(n);
      selected = carousel;
      autoNote = 'Expanded to the whole carousel so every slide is captured. Press “Smaller” (↓) if you only want the part you clicked.';
    }
    state = 'selected';
    errorText = '';
    render();
    redraw();
  }

  function bigger() {
    if (!selected) return;
    const p = selected.parentElement;
    if (!p || p === document.body || p === document.documentElement) return;
    nameDraft = nameInputValue() || nameDraft;
    downStack.push(selected);
    selected = p;
    errorText = '';
    autoNote = '';
    render();
    redraw();
  }

  function smaller() {
    if (!selected) return;
    let c = downStack.pop();
    if (!c) {
      c = Array.from(selected.children).find((ch) => {
        const r = ch.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (!c) return;
    nameDraft = nameInputValue() || nameDraft;
    selected = c;
    errorText = '';
    autoNote = '';
    render();
    redraw();
  }

  function nameInputValue() {
    const i = root.querySelector('input.name');
    return i ? i.value.trim() : '';
  }

  async function save() {
    if (busy || !selected) return;
    const name = nameInputValue() || nameDraft || defaultName();
    let selectors = [];
    try { selectors = BCP.buildSelectors(selected); } catch (e) { selectors = []; }
    if (!selectors.length) {
      errorText = 'Could not describe this element reliably. Press "Bigger" to select its container and try again.';
      render();
      return;
    }
    busy = true;
    render();
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new Error('reloaded');
      const res = await chrome.runtime.sendMessage({
        type: 'BCP_PICKER_SAVE', siteId: ctx.siteId, ruleId: ctx.ruleId, pageUrl: location.href, rule: { name, selectors }
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not save the banner.');
      ctx.siteId = res.siteId;
      ctx.siteName = res.siteName;
      savedMode = res.mode || 'new';
      if (savedMode === 'new') ctx.existingCount += 1;
      ctx.ruleId = null;
      ctx.ruleName = '';
      lastSavedName = res.name || name;
      nameDraft = '';
      state = 'saved';
      errorText = '';
    } catch (e) {
      const m = String((e && e.message) || e);
      errorText = /reloaded|context invalidated|Receiving end/i.test(m)
        ? 'The extension was updated or reloaded. Refresh this page and open the picker again.'
        : m;
    } finally {
      busy = false;
      render();
      redraw();
    }
  }

  function close() {
    listen(false);
    if (raf) cancelAnimationFrame(raf);
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch (e) { /* ignore */ }
    host.remove();
    delete window.__BCP_PICKER;
  }

  // ------------------------------------------------------------------ panel
  function render() {
    titleEl.replaceChildren(ctx.ruleId ? `Re-pick “${ctx.ruleName}” ` : 'Pick a banner ', h('small', { text: `· ${ctx.siteName}` }));
    const parts = [];

    if (state === 'hover') {
      parts.push(
        h('p', {}, h('b', { text: 'Hover over the banner, then click it.' })),
        h('p', { class: 'muted', text: 'Tip: select the whole carousel, not a single slide, so every slide gets captured. You can enlarge the selection after clicking.' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => { state = 'paused'; render(); redraw(); } }, 'Pause to use the page'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', onclick: close }, 'Cancel')),
        h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Pause lets you close a cookie pop-up or menu that covers the banner.')
      );
    }

    if (state === 'paused') {
      parts.push(
        h('p', {}, h('b', { text: 'Paused. The page works normally now.' })),
        h('p', { class: 'muted', text: 'Close anything covering the banner, then resume picking.' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => { state = selected ? 'selected' : 'hover'; render(); redraw(); } }, 'Resume picking'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', onclick: close }, 'Cancel'))
      );
    }

    if (state === 'selected' && selected) {
      const r = selected.getBoundingClientRect();
      let images = [];
      try { images = BCP.collect(selected, { limit: 60 }); } catch (e) { images = []; }
      let parentCount = 0;
      const p = selected.parentElement;
      if (images.length <= 1 && p && p !== document.body) {
        try { parentCount = BCP.collect(p, { limit: 6, quick: true }).length; } catch (e) { parentCount = 0; }
      }
      const countEl = h('span', { class: 'count', text: String(images.length) });
      const largeEl = h('span', { class: 'muted' });
      const thumbs = h('div', { class: 'thumbs' });
      let small = 0, measured = 0;
      const updateCount = () => {
        largeEl.textContent = measured < images.length ? '' : (small ? ` · ${images.length - small} large enough to save` : '');
      };
      images.forEach((im, i) => {
        const probe = new Image();
        const cell = i < 11 || images.length === 12 ? h('div', { class: 'thumb', title: im.url }) : null;
        probe.onload = () => {
          measured++;
          if (probe.naturalWidth && probe.naturalWidth < ctx.minWidth) {
            small++;
            if (cell) cell.classList.add('small');
          }
          updateCount();
        };
        probe.onerror = () => { measured++; updateCount(); };
        probe.referrerPolicy = 'no-referrer-when-downgrade';
        probe.src = im.url;
        if (cell) { cell.append(h('img', { src: im.url, alt: '' })); thumbs.append(cell); }
      });
      if (images.length > 12) thumbs.append(h('div', { class: 'more', text: `+${images.length - 11}` }));

      parts.push(
        h('div', { class: 'code', text: `${BCP.describe(selected)}  ·  ${Math.round(r.width)}×${Math.round(r.height)}` }),
        h('p', {}, countEl, ` image${images.length === 1 ? '' : 's'} found`, largeEl)
      );
      if (images.length) parts.push(thumbs);
      if (autoNote) parts.push(h('div', { class: 'info', text: autoNote }));
      if (!images.length) {
        parts.push(h('div', { class: 'hint', text: 'No images inside this element. Press "Bigger" (↑) to select a larger area.' }));
      } else if (images.length === 1 && parentCount > 1) {
        parts.push(h('div', { class: 'hint', text: 'Only one image here. If this is a carousel, press "Bigger" (↑) until every slide is included.' }));
      }
      const nameInput = h('input', { class: 'name', type: 'text', maxlength: '60', placeholder: defaultName() });
      nameInput.value = nameDraft || defaultName();
      parts.push(
        h('div', { class: 'row' },
          h('button', { class: 'btn', title: 'Select the surrounding element (↑)', onclick: bigger }, '▲ Bigger'),
          h('button', { class: 'btn', title: 'Go back to a smaller element (↓)', onclick: smaller }, '▼ Smaller'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', title: 'Use the page normally for a moment', onclick: () => { nameDraft = nameInputValue(); state = 'paused'; render(); redraw(); } }, 'Pause')),
        h('label', { class: 'lbl', text: 'Name this banner' }),
        nameInput,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: busy || !images.length, onclick: save }, busy ? 'Saving…' : 'Save banner'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', onclick: close }, 'Cancel'))
      );
      if (errorText) parts.push(h('div', { class: 'err', text: errorText }));
      parts.push(h('div', { class: 'keys' }, h('kbd', { text: '↑' }), ' bigger  ', h('kbd', { text: '↓' }), ' smaller  ', h('kbd', { text: 'Enter' }), ' save  ', h('kbd', { text: 'Esc' }), ' back'));
    }

    if (state === 'saved') {
      parts.push(
        h('div', { class: 'ok' }, h('span', { class: 'tick', text: '✓' }),
          h('div', {},
            savedMode === 'replaced'
              ? h('p', {}, 'Updated ', h('b', { text: `“${lastSavedName}”` }), ` for ${ctx.siteName}. It will be found with this new selection.`)
              : savedMode === 'already'
                ? h('p', {}, 'This banner is already saved as ', h('b', { text: `“${lastSavedName}”` }), ` for ${ctx.siteName}.`)
                : h('p', {}, 'Saved ', h('b', { text: `“${lastSavedName}”` }), ` for ${ctx.siteName}.`),
            h('p', { class: 'muted', text: 'It is ticked for capture. You can rename, test or remove it any time in the extension settings.' }))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => { selected = null; downStack = []; state = 'hover'; render(); redraw(); } }, 'Pick another banner'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn primary', onclick: close }, 'Done'))
      );
    }

    body.replaceChildren(...parts);
  }

  $('.close').addEventListener('click', close);
  $('.move').addEventListener('click', () => {
    panel.classList.remove(CORNERS[corner]);
    corner = (corner + 1) % CORNERS.length;
    panel.classList.add(CORNERS[corner]);
  });

  // ------------------------------------------------------------------ start
  function mount() {
    document.documentElement.appendChild(host);
    // The top layer keeps the picker above the site's own pop-ups.
    try {
      host.setAttribute('popover', 'manual');
      host.showPopover();
    } catch (e) { /* older browser: z-index is enough */ }
  }

  function restart(newCtx) {
    if (newCtx) Object.assign(ctx, newCtx);
    if (!host.isConnected) mount();
    selected = null;
    downStack = [];
    state = 'hover';
    errorText = '';
    autoNote = '';
    render();
    redraw();
  }

  mount();
  listen(true);
  render();
  window.__BCP_PICKER = { restart, close };
})();
