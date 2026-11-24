/*
 * Banner Capture - page helpers.
 * Injected into a website tab to find banner elements, list the original
 * image files inside them, and build CSS selectors for the picker.
 * Exposes window.__BCP (isolated content-script world, never the page's).
 */
(() => {
  if (window.__BCP && window.__BCP.v === 2) return;

  // ---------------------------------------------------------------- constants
  const SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset', 'data-original-set', 'data-src-set'];
  const LAZY_SRC_ATTRS = [
    'data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-url', 'data-echo',
    'data-hi-res', 'data-full', 'data-full-src', 'data-large', 'data-image', 'data-img',
    'data-desktop', 'data-desktop-src', 'data-src-desktop', 'data-zoom-image'
  ];
  const BG_ATTRS = [
    'data-bg', 'data-background', 'data-background-image', 'data-bg-src', 'data-bgset',
    'data-image-src', 'data-bg-desktop', 'data-background-desktop'
  ];
  // Carousel libraries duplicate slides to make infinite loops; skip the copies.
  const CLONE_SEL = [
    '.slick-cloned', '.swiper-slide-duplicate', '.glide__slide--clone', '.splide__slide--clone',
    '.owl-item.cloned', '.flickity-slider > .is-clone', '.tns-slide-cloned', '[data-cloned="true"]',
    '.cloned'
  ].join(',');
  const SUPPORTED_TYPES = /^image\/(avif|webp|jpeg|jpg|png|gif|apng|bmp)$/i;
  const PLACEHOLDER_RE = /(?:^|\/)(?:blank|spacer|placeholder|transparent|pixel|loader|loading|lazy|empty|grey|gray|1x1|trans)[^/]*\.(?:gif|png|svg)(?:[?#]|$)/i;
  const SVG_RE = /\.svg(?:[?#]|$)/i;

  const clean = (s, max = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

  // ---------------------------------------------------------------- URLs
  function abs(u) {
    if (!u) return '';
    u = String(u).trim().replace(/^url\((['"]?)(.*)\1\)$/i, '$2');
    if (!u || u.startsWith('#')) return '';
    try {
      const x = new URL(u, document.baseURI);
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
      return x.href;
    } catch (e) {
      return '';
    }
  }

  function isPlaceholder(u) {
    if (!u) return true;
    if (/^(data|blob|about):/i.test(u)) return true;
    return PLACEHOLDER_RE.test(u);
  }

  // Spec-style srcset parser (copes with commas inside URLs, e.g. Cloudinary).
  function parseSrcset(s) {
    const out = [];
    s = String(s || '');
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = '';
      if (/,+$/.test(url)) {
        url = url.replace(/,+$/, '');
      } else {
        const d0 = i;
        let depth = 0;
        while (i < s.length) {
          const ch = s[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          else if (ch === ',' && depth <= 0) break;
          i++;
        }
        desc = s.slice(d0, i).trim();
        i++;
      }
      if (!url) continue;
      const w = /(\d+(?:\.\d+)?)w\b/.exec(desc);
      const x = /(\d+(?:\.\d+)?)x\b/.exec(desc);
      out.push({ url, w: w ? parseFloat(w[1]) : 0, x: x ? parseFloat(x[1]) : (w ? 0 : 1) });
    }
    return out;
  }

  function largest(cands) {
    const list = cands.filter((c) => c.url && !isPlaceholder(abs(c.url)));
    if (!list.length) return '';
    list.sort((a, b) => (b.w - a.w) || (b.x - a.x));
    return list[0].url;
  }

  function bgUrls(value) {
    if (!value || value === 'none') return [];
    const urls = [];
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(value))) urls.push(m[2]);
    // image-set(a 1x, b 2x): keep the highest density only
    if (/image-set\(/i.test(value) && urls.length > 1) return urls.slice(-1);
    return urls;
  }

  function safeMatchMedia(media) {
    try { return window.matchMedia(media).matches; } catch (e) { return true; }
  }

  // Best original-image URL for an <img>.
  function fromImg(img) {
    const pic = img.parentElement && img.parentElement.localName === 'picture' ? img.parentElement : null;
    if (pic) {
      // Same rule as the browser: first <source> whose media + type match wins.
      for (const src of pic.querySelectorAll(':scope > source')) {
        const type = src.getAttribute('type');
        if (type && !SUPPORTED_TYPES.test(type.trim())) continue;
        const media = src.getAttribute('media');
        if (media && !safeMatchMedia(media)) continue;
        const set = [];
        for (const a of SRCSET_ATTRS) set.push(...parseSrcset(src.getAttribute(a)));
        const lazy = src.getAttribute('data-src');
        if (lazy) set.push({ url: lazy, w: 0, x: 1 });
        const best = largest(set);
        if (best) return best;
      }
    }
    const set = [];
    for (const a of SRCSET_ATTRS) set.push(...parseSrcset(img.getAttribute(a)));
    const best = largest(set);
    if (best) return best;
    for (const a of LAZY_SRC_ATTRS) {
      const v = img.getAttribute(a);
      if (v && !isPlaceholder(abs(v))) return v;
    }
    if (img.currentSrc && !isPlaceholder(img.currentSrc)) return img.currentSrc;
    const src = img.getAttribute('src');
    if (src && !isPlaceholder(abs(src))) return src;
    return '';
  }

  // Small icons (arrows, logos) are skipped early. Only judge by the loaded
  // size when the loaded file is the one we would save: a lazy-loaded banner
  // often shows a 1x1 placeholder until it scrolls into view.
  function tinyImg(img, chosenUrl) {
    const current = abs(img.currentSrc || img.getAttribute('src'));
    if (current !== chosenUrl) return false;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (img.complete && nw && nh && nw < 80 && nh < 80) return true;
    const aw = parseInt(img.getAttribute('width'), 10), ah = parseInt(img.getAttribute('height'), 10);
    return aw > 0 && ah > 0 && aw < 40 && ah < 40;
  }

  // ---------------------------------------------------------------- metadata
  function findSlide(el, root) {
    const sel = '[aria-roledescription="slide"], .swiper-slide, .slick-slide, .splide__slide, .glide__slide, .owl-item, '
      + '[class*="slide" i]:not([class*="slider" i]):not([class*="slides" i]):not([class*="slideshow" i]), li, [role="group"]';
    let s = null;
    try { s = el.closest(sel); } catch (e) { s = null; }
    if (s && s !== root && root.contains(s)) return s;
    const a = el.closest('a');
    if (a && root.contains(a)) return a;
    return el.parentElement || el;
  }

  function isVisibleNow(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight * 2) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); } catch (e) { /* older Chrome */ }
    }
    return true;
  }

  function meta(el, root) {
    const a = el.closest('a[href]');
    const attr = (n, k) => (n && n.getAttribute ? (n.getAttribute(k) || '') : '');
    const alt = attr(el, 'alt') || attr(el, 'title') || attr(el, 'aria-label') || attr(a, 'aria-label') || attr(a, 'title');
    const slide = findSlide(el, root);
    let text = '';
    try { text = clean(slide.innerText || slide.textContent); } catch (e) { text = ''; }
    return {
      link: a ? a.href : '',
      alt: clean(alt, 200),
      text,
      visible: isVisibleNow(el)
    };
  }

  // ---------------------------------------------------------------- collect
  // List the original images inside an element (img, picture, srcset, lazy
  // attributes, CSS backgrounds, video posters), in page order.
  function collect(root, opts) {
    const o = opts || {};
    const limit = o.limit || 80;
    const out = [];
    const seen = new Set();
    if (!root || !root.querySelectorAll) return out;

    const push = (raw, el, kind) => {
      const url = abs(raw);
      if (!url || isPlaceholder(url) || SVG_RE.test(url) || seen.has(url)) return;
      seen.add(url);
      out.push(o.quick ? { url } : Object.assign({ url, kind }, meta(el, root)));
    };

    const all = [root, ...root.querySelectorAll('*')];
    for (let i = 0; i < all.length && i < 6000 && out.length < limit; i++) {
      const el = all[i];
      if (el instanceof SVGElement) continue;
      const tag = el.localName;
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'source' || tag === 'template' || tag === 'iframe') continue;
      const clone = el.closest(CLONE_SEL);
      if (clone && clone !== root && root.contains(clone)) continue;

      if (tag === 'img') {
        const u = fromImg(el);
        if (u && !tinyImg(el, abs(u))) push(u, el, 'img');
        continue;
      }
      if (tag === 'video') {
        const p = el.getAttribute('poster');
        if (p) push(p, el, 'video-poster');
      }
      for (const a of BG_ATTRS) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const urls = v.includes('url(') ? bgUrls(v) : [largest(parseSrcset(v)) || v.split(/\s/)[0]];
        for (const u of urls) push(u, el, 'background');
      }
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { cs = null; }
      if (cs) for (const u of bgUrls(cs.backgroundImage)) push(u, el, 'background');
      if (!o.quick) {
        for (const pseudo of ['::before', '::after']) {
          try {
            const ps = getComputedStyle(el, pseudo);
            if (ps && ps.content !== 'none') for (const u of bgUrls(ps.backgroundImage)) push(u, el, 'background');
          } catch (e) { /* ignore */ }
        }
      }
    }
    return out.slice(0, limit);
  }

  // ---------------------------------------------------------------- capture
  function findRoots(rule) {
    for (const sel of rule.selectors || []) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      if (els.length) return { sel, els: Array.from(els).slice(0, 10) };
    }
    return null;
  }

  async function extract(rules, opts) {
    const o = opts || {};
    const waitMs = o.waitMs == null ? 8000 : o.waitMs;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ready = (rule) => {
      const f = findRoots(rule);
      return !!f && f.els.some((el) => collect(el, { limit: 1, quick: true }).length > 0);
    };
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (rules.every(ready)) break;
      await sleep(500);
    }
    // Let carousels finish setting up, then nudge lazy loaders.
    await sleep(o.settleMs == null ? 1000 : o.settleMs);
    try {
      const y = window.scrollY;
      window.scrollBy(0, Math.min(900, window.innerHeight || 900));
      await sleep(400);
      window.scrollTo(0, y);
      await sleep(300);
    } catch (e) { /* ignore */ }

    return rules.map((rule) => {
      const f = findRoots(rule);
      if (!f) return { ruleId: rule.id, found: false, images: [] };
      const seen = new Set();
      const images = [];
      for (const el of f.els) {
        for (const im of collect(el, { limit: 80 })) {
          if (seen.has(im.url)) continue;
          seen.add(im.url);
          images.push(im);
        }
      }
      return { ruleId: rule.id, found: true, selector: f.sel, matches: f.els.length, images: images.slice(0, 80) };
    });
  }

  // ---------------------------------------------------------------- selectors
  const STATE_RE = /(^|[-_])(active|current|selected|hover|hovered|focus|focused|visible|invisible|hidden|show|shown|open|opened|closed|loaded|loading|lazyloaded|lazyload|lazyloading|initialized|init|ready|animating|animated|animate|transition|transitioning|enter|entering|leave|leaving|prev|next|duplicate|cloned|clone|disabled|enabled|playing|paused|fade|fadein|fadeout|in|out|sticky|scrolled|mounted)([-_]|$)/i;
  const GOOD_WORD_RE = /(banner|hero|slider|slideshow|carousel|swiper|slick|splide|glide|promo|highlight|push|teaser|billboard|keyvisual|visual|cover|showcase|main|header|top|home|campaign|offer|operation)/i;
  const BAD_ID_RE = /^(ember|react|vue|ng|ext-|gen|ui-id|radix|headlessui|mui|swiper-wrapper-|splide\d|glide-|tns\d|slick-slide\d)/i;
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'data-component', 'data-module', 'data-block', 'data-section', 'data-name', 'data-zone', 'data-slot', 'data-container', 'data-widget', 'data-placement'];

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const quote = (v) => '"' + String(v).replace(/["\\]/g, '\\$&') + '"';

  function looksRandom(s) {
    if (!s) return true;
    if (s.length > 48) return true;
    if (/\d{4,}/.test(s)) return true;
    if (/^(css|sc|jsx|emotion|styled|svelte|astro|tw)-[a-z0-9]{4,}/i.test(s)) return true;
    if (/[a-z][A-Z][a-z]?[A-Z]/.test(s) && !/[-_]/.test(s) && s.length <= 10) return true; // e.g. bdVaJa
    if (/^[a-z0-9]{6,}$/i.test(s) && /\d/.test(s) && /[a-z]/i.test(s)) return true;      // e.g. x7f3k2
    return false;
  }

  function stableId(el) {
    const id = el.id;
    if (!id || id.includes(':') || BAD_ID_RE.test(id) || /\d{3,}/.test(id) || looksRandom(id)) return '';
    return id;
  }

  // Class tokens worth using in a selector, best first. CSS-module classes like
  // "Hero_root__a1B2c" become a prefix match on their stable part.
  function classTokens(el) {
    const tokens = [];
    for (const c of Array.from(el.classList || [])) {
      if (STATE_RE.test(c)) continue;
      const mod = /^([A-Za-z][\w-]*?__?[A-Za-z][\w-]*?__)[A-Za-z0-9_-]{4,8}$/.exec(c) || /^([A-Za-z][\w-]*?_[A-Za-z][\w-]*?__)[A-Za-z0-9_-]{4,8}$/.exec(c);
      if (mod) { tokens.push({ sel: '[class*=' + quote(mod[1]) + ']', score: 3 + (GOOD_WORD_RE.test(c) ? 4 : 0) }); continue; }
      if (looksRandom(c)) continue;
      let score = 2;
      if (GOOD_WORD_RE.test(c)) score += 5;
      if (/[:[\]/.%]/.test(c)) score -= 3;          // utility classes (Tailwind etc.)
      if (c.length <= 3) score -= 1;
      if (/\d/.test(c)) score -= 1;
      tokens.push({ sel: '.' + esc(c), score });
    }
    tokens.sort((a, b) => b.score - a.score);
    return tokens.map((t) => t.sel);
  }

  function attrToken(el) {
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 60 && !/\d{4,}/.test(v)) return el.localName + '[' + a + '=' + quote(v) + ']';
    }
    // Accessible labels such as "Carousel des opérations commerciales" are
    // usually stable, unlike slide counters ("Diapositive 2 / 6").
    const label = el.getAttribute('aria-label');
    if (label && el.localName !== 'img' && label.length >= 4 && label.length <= 90
        && /[a-zA-ZÀ-ſ]{3}/.test(label) && !/\d+\s*(\/|of|sur|de)\s*\d+/i.test(label) && !/^slide\s*\d+$/i.test(label)) {
      return el.localName + '[aria-label=' + quote(label) + ']';
    }
    const rd = el.getAttribute('aria-roledescription');
    if (rd && /carousel|slider|slideshow|diaporama|carrousel/i.test(rd)) return el.localName + '[aria-roledescription=' + quote(rd) + ']';
    return '';
  }

  function unique(sel, el) {
    try {
      const l = document.querySelectorAll(sel);
      return l.length === 1 && l[0] === el;
    } catch (e) {
      return false;
    }
  }

  function anchorToken(el) {
    const id = stableId(el);
    if (id) return '#' + esc(id);
    const at = attrToken(el);
    if (at) return at;
    const cls = classTokens(el);
    return cls.length ? el.localName + cls[0] : '';
  }

  function byOwn(el) {
    const id = stableId(el);
    if (id && unique('#' + esc(id), el)) return '#' + esc(id);
    const at = attrToken(el);
    if (at && unique(at, el)) return at;
    return '';
  }

  function byClasses(el) {
    const tag = el.localName;
    const toks = classTokens(el).slice(0, 6);
    for (const t of toks) {
      if (unique(t, el)) return t;
      if (unique(tag + t, el)) return tag + t;
    }
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        const s = tag + toks[i] + toks[j];
        if (unique(s, el)) return s;
      }
    }
    const own = [...toks.slice(0, 3).map((t) => tag + t), tag];
    let anc = el.parentElement;
    for (let depth = 0; anc && anc !== document.documentElement && depth < 6; depth++, anc = anc.parentElement) {
      const at = anchorToken(anc);
      if (!at) continue;
      for (const p of own) {
        const s = at + ' ' + p;
        if (unique(s, el)) return s;
        const s2 = at + ' > ' + p;
        if (anc === el.parentElement && unique(s2, el)) return s2;
      }
    }
    return '';
  }

  function byPath(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      const id = stableId(n);
      if (id && n !== el) { parts.unshift('#' + esc(id)); break; }
      if (n === document.body) { parts.unshift('body'); break; }
      let seg = n.localName;
      const p = n.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((c) => c.localName === n.localName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(seg);
      n = p;
    }
    const s = parts.join(' > ');
    return unique(s, el) ? s : '';
  }

  // Up to 3 selectors built different ways; the first one that still matches
  // the page is used at capture time, so a small redesign rarely breaks a rule.
  function buildSelectors(el) {
    const out = [];
    for (const fn of [byOwn, byClasses, byPath]) {
      let s = '';
      try { s = fn(el); } catch (e) { s = ''; }
      if (s && !out.includes(s)) out.push(s);
    }
    return out.slice(0, 3);
  }

  // When the user clicks one slide, find the carousel around it so every slide
  // is captured. Uses carousel-library names first, then a layout heuristic:
  // an ancestor about as tall as the clicked part that holds several images.
  const CAROUSEL_RE = /(carousel|carrousel|slider|slideshow|swiper|slick|splide|glide|owl-|flickity|keen-slider|embla|tns-|diaporama)/i;
  const SINGLE_SLIDE_RE = /(^|\s)(swiper-slide|slick-slide|splide__slide|glide__slide|owl-item|carousel-item|carousel-cell|slide|item)(\s|$)/i;

  function looksCarousel(el) {
    const rd = el.getAttribute('aria-roledescription') || '';
    if (/carousel|carrousel|slider|diaporama/i.test(rd)) return true;
    const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
    if (!CAROUSEL_RE.test(cls)) return false;
    return !(SINGLE_SLIDE_RE.test(cls) && !/(wrapper|track|list|container|inner)/i.test(cls));
  }

  function findCarousel(el) {
    if (!el || !el.parentElement) return null;
    const own = collect(el, { limit: 2, quick: true }).length;
    let n = el.parentElement;
    for (let depth = 0; n && n !== document.body && n !== document.documentElement && depth < 10; depth++, n = n.parentElement) {
      if (looksCarousel(n) && collect(n, { limit: 3, quick: true }).length >= 2) return settle(n, el);
    }
    if (own > 1) return null;
    const base = el.getBoundingClientRect().height;
    if (base < 60) return null;
    n = el.parentElement;
    for (let depth = 0; n && n !== document.body && n !== document.documentElement && depth < 6; depth++, n = n.parentElement) {
      const h = n.getBoundingClientRect().height;
      if (h > base * 1.6 + 40) break;
      if (collect(n, { limit: 3, quick: true }).length >= 2) return settle(n, el);
    }
    return null;
  }

  // Carousel tracks are often shifted sideways with a transform, so their box
  // is mostly off-screen. Step out to the visible frame around them, as long
  // as it is the same height band (not a whole page section).
  function settle(found, clicked) {
    const r0 = clicked.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    const covers = (node) => {
      const r = node.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    let n = found;
    for (let i = 0; i < 4; i++) {
      const p = n.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      const sameBand = p.getBoundingClientRect().height <= Math.max(n.getBoundingClientRect().height, r0.height) * 1.5 + 40;
      if (!sameBand) break;
      if (!covers(n) || looksCarousel(p)) { n = p; continue; }
      break;
    }
    return n;
  }

  function describe(el) {
    if (!el || !el.localName) return '';
    let s = el.localName;
    if (el.id) s += '#' + el.id;
    const cls = Array.from(el.classList || []).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  window.__BCP = { v: 2, extract, collect, buildSelectors, describe, findCarousel, parseSrcset };
})();
