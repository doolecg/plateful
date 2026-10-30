import { UNITS, UNIT_GROUPS, parseQuantity, toGrams, unitOption } from './units.js';

const $ = (s, el = document) => el.querySelector(s);
const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const MEAL_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks & drinks' };
const nf = new Intl.NumberFormat('en-GB');
const n = (x) => nf.format(Math.round(x));
const g = (x) => `${Math.round(x)}g`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const parseDate = (d) => new Date(`${d}T12:00:00`);
const fmtDay = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => parseDate(d).toLocaleDateString('en-GB', opts);
const addDays = (d, k) => { const x = parseDate(d); x.setDate(x.getDate() + k); return x.toLocaleDateString('en-CA'); };
const r1 = (x) => Math.round(x * 10) / 10;
const MACROS = ['kcal', 'protein', 'carbs', 'fat', 'fibre', 'sugars', 'sat_fat', 'salt'];
// The nutrients in the drop-down, in UK label order. Fibre and the rest are blank on items logged before Plateful tracked them.
const NUTRIENTS = [['protein', 'Protein'], ['carbs', 'Carbohydrate'], ['sugars', 'of which sugars', 'sub'], ['fat', 'Fat'], ['sat_fat', 'of which saturates', 'sub'], ['fibre', 'Fibre'], ['salt', 'Salt']];
const gv = (x) => (x == null ? '–' : `${x < 10 && x % 1 ? r1(x) : Math.round(x)} g`);

/* ---------- Amount picker ----------
   An amount is a number, a unit and roughly how many grams that is. Changing the number or the
   grams rescales kcal and macros in the same form; changing the unit converts the number so the
   food stays the same. All local, no tokens. */

// Items logged before units existed only have text like "1 bowl", so read what we can from it
function asAmount(i) {
  if (UNITS[i.unit] && i.amount > 0) return i;
  return { ...(parseQuantity(i.quantity) || { amount: 1, unit: 'portion' }), grams: i.grams, untouched: true };
}

function amountHtml(i, cls = 'full') {
  const a = asAmount(i);
  const grams = a.grams > 0 ? a.grams : toGrams(a.amount, a.unit, a);
  const weight = UNITS[a.unit].kind === 'weight';
  return `<div class="amt ${cls}" data-unit="${a.unit}" data-g="${grams}" data-density="${a.density ?? ''}" data-each="${a.each_g ?? ''}"${a.untouched ? ' data-untouched' : ''}>
    <label class="f">Amount<input data-a="amount" type="number" inputmode="decimal" step="any" min="0" value="${a.amount}" required></label>
    <label class="f">Unit<select data-a="unit">${UNIT_GROUPS.map(([label, keys]) => `<optgroup label="${label}">${keys.map((k) => `<option value="${k}"${k === a.unit ? ' selected' : ''}>${esc(unitOption(k))}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <label class="f">≈ grams<input data-a="grams" type="number" inputmode="decimal" step="any" min="0" value="${r1(grams)}"${weight ? ' readonly tabindex="-1"' : ''}></label>
    ${a.untouched && i.quantity ? `<span class="amt-was small">Logged as “${esc(i.quantity)}”</span>` : ''}
  </div>`;
}

// What the item weighed when its macros were last set, so rescaling never compounds rounding
function amtBase(amt) {
  if (!amt._base) {
    const scope = amt.closest('.pi-row, form');
    const val = (k) => { const v = $(`[data-m="${k}"]`, scope)?.value; return v === '' || v == null ? null : Number(v) || 0; };
    amt._base = { g: Number(amt.dataset.g), ...Object.fromEntries(MACROS.map((k) => [k, val(k)])) };
  }
  return amt._base;
}

function rescale(amt, grams) {
  const base = amtBase(amt);
  amt.dataset.g = grams;
  delete amt.dataset.untouched;
  const scope = amt.closest('.pi-row, form');
  if (!(base.g > 0) || !(grams >= 0)) return;
  const k = grams / base.g;
  for (const m of MACROS) {
    const input = $(`[data-m="${m}"]`, scope);
    if (input && base[m] != null) input.value = m === 'kcal' ? Math.round(base[m] * k) : r1(base[m] * k);
  }
  scope.dispatchEvent(new CustomEvent('rescaled', { bubbles: true }));
}

function onAmountInput(el) {
  const amt = el.closest('.amt');
  const [amountIn, unitIn, gramsIn] = ['amount', 'unit', 'grams'].map((k) => $(`[data-a="${k}"]`, amt));
  const unit = unitIn.value, u = UNITS[unit];
  const known = { density: Number(amt.dataset.density) || undefined, each_g: Number(amt.dataset.each) || undefined };
  if (el === unitIn) {
    gramsIn.readOnly = u.kind === 'weight';
    gramsIn.tabIndex = u.kind === 'weight' ? -1 : 0;
    delete amt.dataset.untouched;
    if (!amtBase(amt).kcal) {
      // A blank new item is just being labelled, so keep the number and work out the grams
      amt._base = null;
      Object.assign(amt.dataset, { unit, each: '', density: '' });
      const grams = toGrams(Number(amountIn.value), unit);
      gramsIn.value = r1(grams);
      amt.dataset.g = grams;
      return;
    }
    // Same food, different measure: keep the grams and work out the new number
    const g = Number(amt.dataset.g);
    if (u.kind === 'count' && unit !== amt.dataset.unit) { known.each_g = u.g; amt.dataset.each = ''; }
    const per = toGrams(1, unit, known);
    amountIn.value = g > 0 ? (u.kind === 'weight' && u.g === 1 ? Math.round(g) : Math.round((g / per) * 100) / 100) : '';
    amt.dataset.unit = unit;
    return;
  }
  const amount = Number(amountIn.value);
  if (el === gramsIn) {
    // Telling us the weight of a spoonful or a slice: remember it for this item and rescale
    const grams = Number(gramsIn.value);
    if (amount > 0 && grams > 0) {
      if (u.kind === 'volume') amt.dataset.density = grams / (amount * u.ml);
      if (u.kind === 'count') amt.dataset.each = grams / amount;
    }
    return rescale(amt, grams);
  }
  const grams = toGrams(amount, unit, known);
  gramsIn.value = r1(grams);
  rescale(amt, grams);
}

document.addEventListener('input', (e) => {
  if (e.target.closest('.amt')) onAmountInput(e.target);
  // Typing a macro by hand makes that the new starting point for rescaling
  else if (e.target.dataset.m) {
    const amt = $('.amt', e.target.closest('.pi-row, form'));
    if (amt) amt._base = null;
  }
});

// The amount fields as the API wants them; nothing when an old free-text amount was left alone
function readAmount(amt) {
  if (amt.hasAttribute('data-untouched')) return {};
  const amount = Number($('[data-a="amount"]', amt).value);
  const unit = $('[data-a="unit"]', amt).value;
  const grams = Number($('[data-a="grams"]', amt).value);
  const kind = UNITS[unit].kind;
  return {
    amount, unit, grams,
    density: kind === 'volume' ? Number(amt.dataset.density) || (amount > 0 ? grams / (amount * UNITS[unit].ml) : null) : null,
    each_g: kind === 'count' ? Number(amt.dataset.each) || (amount > 0 ? grams / amount : null) : null,
  };
}

/* ---------- Colours ---------- */

const SCHEMES = [['larder', 'Plateful', ['#f3ede2', '#bd3f19', '#4d6b2f']], ['sage', 'Sage', ['#eef1ea', '#ab4e27', '#3f6f3a']],
  ['slate', 'Slate', ['#eef1f5', '#bf3f2c', '#2b62b8']], ['plum', 'Plum', ['#f3eef2', '#b03a5b', '#6a4fb0']],
  ['harbour', 'Harbour', ['#edf1f2', '#b8432a', '#23695f']], ['rose', 'Rose', ['#f6eeee', '#b3364f', '#4a6b36']],
  ['graphite', 'Graphite', ['#ececeb', '#b23c0b', '#3f6e3a']], ['saffron', 'Saffron', ['#f6f0dc', '#b9461e', '#556b1f']],
  ['lavender', 'Lavender', ['#f0eff6', '#b23a48', '#5b4fb0']]];

// Remembered on this device too, so the PIN screen and first paint are already in your colours
function applyColours({ scheme = 'larder', mode = 'auto' } = {}) {
  const root = document.documentElement;
  if (scheme === 'larder') delete root.dataset.scheme; else root.dataset.scheme = scheme;
  if (mode === 'auto') delete root.dataset.mode; else root.dataset.mode = mode;
  const bg = getComputedStyle(root).getPropertyValue('--paper').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
  try { localStorage.setItem('larder-colours', JSON.stringify({ scheme, mode })); } catch { /* private mode */ }
}
try { applyColours(JSON.parse(localStorage.getItem('larder-colours') || '{}')); } catch { /* nothing saved */ }

let state = null;
let date = new URLSearchParams(location.search).get('d');
let pendingImages = [];
let pendingMessage = null;
let people = [];
// Entry ids picked with a long press; while any are picked, taps select instead of edit
const selected = new Set();
let presets = { presets: [], suggestions: [] };
// The last thing added, so it can be undone from the bar above the message box
let lastAdd = null;
let view = ['stats', 'foods'].includes(new URLSearchParams(location.search).get('view')) ? new URLSearchParams(location.search).get('view') : 'diary';

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (data.signedOut || data.locked) { showGate(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), kind === 'error' ? 6000 : 3000);
}

async function load() {
  qp.recentFor = null;
  try {
    state = await api(`/api/summary${date ? `?date=${date}` : ''}`);
    applyColours(state.settings);
    date = state.date;
    [presets, people] = await Promise.all([
      api(`/api/presets?date=${date}&hour=${new Date().getHours()}`),
      api('/api/people'),
    ]);
    document.body.classList.remove('signed-out');
    $('#gate').hidden = true;
    if (view !== 'diary') setView(view); else { renderViewTabs(); render(); }
  } catch (err) {
    if (!document.body.classList.contains('signed-out')) toast(`Couldn’t load your diary: ${err.message}`, 'error');
  } finally {
    $('#app').setAttribute('aria-busy', 'false');
  }
}

function go(d) {
  date = d;
  lastAdd = null;
  selected.clear();
  const url = d === state.today ? location.pathname : `?d=${d}`;
  history.replaceState(null, '', url);
  load();
}

/* ---------- Rendering ---------- */

function render() {
  const { today } = state;
  const isToday = date === today;
  $('#dayLabel').innerHTML = isToday
    ? `<b>Today</b><span>${fmtDay(date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>`
    : `<b>${fmtDay(date, { weekday: 'long' })}</b><span>${fmtDay(date, { day: 'numeric', month: 'long' })}</span>`;
  $('#dayTitle').textContent = isToday ? `Today, ${fmtDay(date, { day: 'numeric', month: 'long' })}` : fmtDay(date, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#nextDay').disabled = date >= today;
  $('#who').innerHTML = `<span class="avatar">${esc(state.profile.name[0].toUpperCase())}</span><span class="who-name">${esc(state.profile.name)}</span>`;
  renderWeekStrip();
  renderHero();
  renderMeals();
  renderThread();
  renderWeek();
  renderWeight();
  renderQuickPanel();
  renderLastAdd();
  renderSelection();
}

// Mon to Sun with a ring for each day: how much of that day's target went
function renderWeekStrip() {
  const C = 2 * Math.PI * 11;
  $('#weekStrip').innerHTML = state.week.days.map((d) => {
    const f = d.target ? Math.min(d.kcal / d.target, 1) : 0;
    return `<button class="wday${d.date === date ? ' sel' : ''}${d.date === state.today ? ' today' : ''}" data-day="${d.date}" ${d.future ? 'disabled' : ''}
        aria-label="${fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${d.kcal ? `${n(d.kcal)} of ${n(d.target)} kcal` : 'nothing logged'}"${d.date === date ? ' aria-current="date"' : ''}>
      <span class="wd-name">${fmtDay(d.date, { weekday: 'narrow' })}</span>
      <svg viewBox="0 0 28 28" width="30" height="30" aria-hidden="true">
        <circle class="ring-bg" cx="14" cy="14" r="11"/>
        ${d.kcal ? `<circle class="ring${d.kcal > d.target ? ' over' : ''}" cx="14" cy="14" r="11" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 14 14)"/>` : ''}
        <text x="14" y="18" text-anchor="middle">${parseDate(d.date).getDate()}</text>
      </svg>
    </button>`;
  }).join('');
}

// Value against goal, the way a food label reads: protein is a goal to reach, carbs and fat are limits
function macroBars(totals, st) {
  return [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([k, label]) => {
    const goal = goalFor(k, st);
    const v = totals[k] || 0;
    const over = k !== 'protein' && v > goal;
    return `<div class="mbar mb-${k}${over ? ' over' : ''}">
      <div class="mbar-top"><span>${label}</span><span class="num"><b>${Math.round(v)}</b>/${goal} g</span></div>
      <div class="mtrack"><span style="width:${Math.min(100, (v / goal) * 100)}%"></span></div>
    </div>`;
  }).join('');
}

function renderHero() {
  const { totals, target, flex } = state.day;
  const left = target - totals.kcal;
  const over = left < 0;
  const hero = $('#hero');
  hero.className = `hero${over ? ' over' : ''}`;
  hero.innerHTML = `
    <div class="hero-top">
      <div class="big num" aria-label="${n(Math.abs(left))} kcal ${over ? 'over' : 'left'}">${n(Math.abs(left))}<small>kcal ${over ? 'over' : 'left'}</small></div>
      <div class="hero-of num">${n(totals.kcal)} of ${n(target)}${flex ? '<span class="flex-tag">Flex day</span>' : ''}</div>
    </div>
    <div class="bar"><span style="width:${Math.min(100, (totals.kcal / target) * 100)}%"></span></div>
    <div class="mbars">${macroBars(totals, state.settings)}</div>`;
}

const PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Every meal is always there with its own Add button, like a paper diary with the headings printed
function renderMeals() {
  const el = $('#meals');
  const { entries } = state.day;
  const hint = !entries.length && !pendingMessage
    ? `<p class="day-hint">Nothing logged ${date === state.today ? 'yet' : 'this day'}. Tap <b>Add</b> on a meal, or tell Plateful what you ate in the box below.</p>` : '';
  el.innerHTML = hint + MEALS.map((meal) => {
    const rows = entries.filter((e) => e.meal === meal);
    const kcal = rows.reduce((s, e) => s + e.kcal, 0);
    return `<section class="meal${rows.length ? '' : ' empty-meal'}" data-meal="${meal}">
      <div class="meal-head">
        <h2>${MEAL_NAMES[meal]}${rows.length ? ` <span class="num">${n(kcal)} kcal</span>` : ''}</h2>
        ${rows.length > 1 ? `<button class="link-btn save-meal" data-savepreset="${meal}">Save as a meal</button>` : ''}
        <button class="add-btn" data-addto="${meal}" aria-label="Add to ${MEAL_NAMES[meal]}">${PLUS}Add</button>
      </div>
      ${rows.length ? `<ul class="items">${rows.map(itemHtml).join('')}</ul>` : ''}
    </section>`;
  }).join('');
}

const SOURCE_TAGS = { label: ['from label', 'label'], saved: ['saved food', 'label'], db: ['food list', 'label'], manual: ['added by hand'], preset: ['preset'], copied: ['copied'], 'est.': ['estimate'] };

// Open Food Facts lists own-brand lines as "Brooklea, Aldi", so show the shop when there is one
const SHOP_WORDS = /tesco|sainsbury|asda|aldi|lidl|m&s|marks|co-?op|morrisons|waitrose|iceland|ocado/i;
const shopOf = (brand) => { const all = String(brand || '').split(',').map((b) => b.trim()).filter(Boolean); return all.find((b) => SHOP_WORDS.test(b)) || all[0] || ''; };

function photosFor(e) {
  return state.day.messages.filter((m) => m.id === e.message_id || m.id === e.label_message_id).flatMap((m) => m.images);
}

function amountText(e) {
  const grams = e.grams > 0 && UNITS[e.unit]?.kind !== 'weight' ? `, ${n(e.grams)} g` : '';
  // "3 × 200 g" rather than "3, 600 g" for things counted whole
  if (e.unit === 'each' && e.amount > 0 && e.grams > 0) {
    return Number.isInteger(e.amount) && e.amount > 1 ? `${e.amount} × ${n(e.grams / e.amount)} g` : `${e.amount === 0.5 ? 'half' : r1(e.amount)}, ${n(e.grams)} g`;
  }
  return `${esc(e.quantity || 'no amount')}${grams}`;
}

function itemHtml(e) {
  const shop = shopOf(e.product_brand);
  const brand = shop && !e.name.toLowerCase().includes(shop.toLowerCase()) ? `${esc(shop)}, ` : '';
  return `<li class="item${selected.has(e.id) ? ' selected' : ''}${e.needs_label ? ' needs' : ''}">
    <button class="item-row" data-edit="${e.id}" ${selected.size ? `aria-pressed="${selected.has(e.id)}"` : 'aria-haspopup="dialog"'}>
      <span class="item-name">${esc(e.name)}</span><span class="item-kcal num">${n(e.kcal)}</span>
      <span class="item-meta num">${brand}${amountText(e)}</span>
    </button>
    ${e.needs_label && !selected.size ? `<label class="label-chip" title="It’s an estimate until Plateful has the label"><input type="file" accept="image/*" capture="environment" data-labelfor="${e.id}" hidden>Add label photo</label>` : ''}
  </li>`;
}

const macroInput = (i, attr, k, label) => `<label class="f">${label}<input ${attr}="${k}" data-m="${k}" type="number" inputmode="decimal" step="any" min="0"
  value="${i[k] ?? (['kcal', 'fibre', 'sugars', 'sat_fat', 'salt'].includes(k) ? '' : 0)}"${k === 'kcal' ? ' required' : ''}></label>`;
const macroInputs = (i, attr = 'name') => [['kcal', 'kcal'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['fat', 'Fat g']].map(([k, l]) => macroInput(i, attr, k, l)).join('')
  + `<details class="more-n full"><summary>Fibre, sugars, saturates, salt</summary><div class="grid">${[['fibre', 'Fibre g'], ['sugars', 'Sugars g'], ['sat_fat', 'Saturates g'], ['salt', 'Salt g']]
    .map(([k, l]) => macroInput(i, attr, k, l)).join('')}</div></details>`;

const TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SHORT_MEALS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };
const ALL_NUTRIENTS = [['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbohydrate', 'g'], ['sugars', 'of which sugars', 'g', 'sub'],
  ['fat', 'Fat', 'g'], ['sat_fat', 'of which saturates', 'g', 'sub'], ['fibre', 'Fibre', 'g'], ['salt', 'Salt', 'g']];

// Dialogs open as a sheet from the bottom on a phone and a panel in the middle on a computer
function openSheet(html, cls = '') {
  const d = $('#dialog');
  if (d.open) d.close();
  d.className = `sheet ${cls}`;
  d.innerHTML = html;
  d.showModal();
  return d;
}

function sourceLine(e) {
  if (e.needs_label) return ['need', 'An estimate. Add the label photo for the real figures.'];
  const per = e.grams > 0 ? `, ${n((e.kcal / e.grams) * 100)} kcal per 100 g` : '';
  if (e.source === 'label') return ['label', `From its label${per}`];
  if (e.source === 'db') return ['label', `From the food list${per}`];
  if (e.source === 'saved') return ['label', `One of your saved foods${per}`];
  if (e.source === 'manual') return ['', 'Numbers you typed in'];
  if (e.source === 'preset') return ['', 'From a saved meal'];
  if (e.source === 'copied') return ['', 'Copied from another day'];
  return ['', `An estimate using typical UK values${per}`];
}

// Tap a food: how much, which meal, what's in it, and the things you can do with it
function itemSheet(e) {
  const photos = photosFor(e);
  const shop = shopOf(e.product_brand);
  const [cls, line] = sourceLine(e);
  const d = openSheet(`<form class="edit sheet-form" data-entry="${e.id}">
    <header class="sheet-head">
      ${photos.length ? `<button type="button" class="thumb sheet-thumb" data-photos="${esc(JSON.stringify(photos))}" data-photoat="0" aria-label="Open the photo"><img src="${esc(photos[0])}" alt=""></button>` : ''}
      <div class="sheet-title">
        ${shop && !e.name.toLowerCase().includes(shop.toLowerCase()) ? `<div class="sheet-brand">${esc(shop)}</div>` : ''}
        <h2>${esc(e.name)}</h2>
        <div class="src-line ${cls}">${line}</div>
      </div>
      <button class="icon-btn" type="button" data-closesheet aria-label="Close">${CLOSE}</button>
    </header>
    <div class="sheet-body">
      ${e.needs_label ? `<div class="need-label"><p>Plateful hasn’t got this one’s label yet, so the numbers are the AI’s estimate. A photo of the nutrition label fixes it now and every time after.</p>
        <label class="btn primary"><input type="file" accept="image/*" capture="environment" data-labelfor="${e.id}" data-paste hidden>Add label photo</label></div>` : ''}
      <div class="grid">${amountHtml(e)}</div>
      <fieldset class="meal-pick"><legend>Meal</legend>
        ${MEALS.map((m) => `<label><input type="radio" name="meal" value="${m}"${m === e.meal ? ' checked' : ''}><span>${SHORT_MEALS[m]}</span></label>`).join('')}
      </fieldset>
      <div class="nut-card">
        <div class="nut-top"><span><b class="num" data-show="kcal"></b> kcal</span><span class="small num" data-show="share"></span></div>
        <div class="split" data-show="split"></div>
        <table class="nutr num"><tbody data-show="rows"></tbody></table>
      </div>
      <details class="more-n"><summary>Change the name or numbers</summary>
        <div class="grid">
          <label class="f full">Name<input name="name" value="${esc(e.name)}" required maxlength="120"></label>
          ${ALL_NUTRIENTS.map(([k, label, unit]) => `<label class="f wide">${label}${unit === 'g' ? ' g' : ''}<input name="${k}" data-m="${k}" type="number" inputmode="decimal" step="any" min="0" value="${e[k] ?? ''}"${k === 'kcal' ? ' required' : ''}></label>`).join('')}
        </div>
      </details>
      <div class="sheet-links">
        <button type="button" class="link-btn" data-info="${e.id}">Where these numbers came from</button>
        ${e.needs_label ? '' : `<label class="link-btn"><input type="file" accept="image/*" data-labelfor="${e.id}" data-paste hidden>Use a label photo</label>`}
      </div>
    </div>
    <footer class="sheet-foot">
      <button class="btn danger square" type="button" data-delete="${e.id}" aria-label="Delete ${esc(e.name)}" title="Delete">${TRASH}</button>
      <button class="btn" type="button" data-savefood="${e.id}">Save as food</button>
      <button class="btn primary grow" type="submit">Done</button>
    </footer>
  </form>`);
  const form = $('form', d);
  const show = () => {
    const v = Object.fromEntries(ALL_NUTRIENTS.map(([k]) => { const x = $(`[data-m="${k}"]`, form).value; return [k, x === '' ? null : Number(x)]; }));
    $('[data-show="kcal"]', form).textContent = n(v.kcal || 0);
    $('[data-show="share"]', form).textContent = state.day.target ? `${Math.round(((v.kcal || 0) / state.day.target) * 100)}% of your day` : '';
    const parts = [['protein', 4], ['carbs', 4], ['fat', 9]].map(([k, m]) => [k, (v[k] || 0) * m]);
    $('[data-show="split"]', form).innerHTML = parts.some(([, x]) => x) ? parts.map(([k, x]) => `<span class="m-${k}" style="flex-grow:${x}"></span>`).join('') : '';
    $('[data-show="rows"]', form).innerHTML = ALL_NUTRIENTS.slice(1).map(([k, label, , sub]) => `<tr${sub ? ' class="sub"' : ''}><th scope="row">${label}</th><td>${gv(v[k])}</td></tr>`).join('');
  };
  form.addEventListener('input', show);
  form.addEventListener('rescaled', show);
  show();
}

// The chat: what you sent, oldest first like any messaging app, with Plateful's reply under each.
// Long pastes (a whole supermarket product page) are cut to a few lines until you ask for more.
const openMsgs = new Set();

function renderThread(keepScroll = false) {
  const msgs = state.day.messages.filter((m) => !m.cleared);
  if (pendingMessage) msgs.push(pendingMessage);
  const el = $('#thread');
  const clearable = msgs.some((m) => !m.pending && !m.error);
  $('#clearThreadSlot').innerHTML = clearable ? '<button class="link-btn" data-clearthread title="Hides these messages. Your logged food, its photos and notes stay.">Clear</button>' : '';
  if (!msgs.length) {
    el.innerHTML = `<p class="chat-empty small">Tell Plateful what you ate, in your own words, or send a photo of the plate or the label. It replies here and adds the food to your diary.</p>`;
    return;
  }
  el.innerHTML = msgs.map((m) => {
    const time = m.pending ? 'just now' : new Date(`${m.created_at.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const items = m.pending ? [] : state.day.entries.filter((e) => e.message_id === m.id);
    const long = (m.text || '').length > 280 || (m.text || '').split('\n').length > 6;
    const open = openMsgs.has(m.id);
    return `<div class="msg${m.pending ? ' pending' : ''}">
      <div class="bubble">
        ${m.images.length ? `<div class="thumbs">${m.images.map((src, i) => (m.pending ? `<img src="${esc(src)}" alt="Photo you sent">`
          : `<button type="button" class="thumb" data-photos="${esc(JSON.stringify(m.images))}" data-photoat="${i}" aria-label="Open photo ${i + 1} of ${m.images.length}"><img src="${esc(src)}" alt="" loading="lazy"></button>`)).join('')}</div>` : ''}
        ${m.text ? `<div class="said${long && !open ? ' clamped' : ''}">${esc(m.text)}</div>` : ''}
        ${long ? `<button class="link-btn more" data-msgopen="${m.id}">${open ? 'Show less' : 'Show all'}</button>` : ''}
        <div class="time">${time}</div>
      </div>
      ${m.pending ? '<div class="reply">Reading it</div>'
        : m.error ? `<div class="err"><span>${esc(m.error)}</span><button class="btn" data-retry="${m.id}">Retry</button><button class="link-btn" data-dismiss="${m.id}">Dismiss</button></div>`
        : `<div class="reply">${m.note ? esc(m.note) : ''}${m.relabel_entry_id ? '' : items.length ? `<span class="added num">${addedText(items)}</span>`
          : `<span class="added">Nothing from this is in the diary now. <button class="link-btn" data-retry="${m.id}">Log it again</button></span>`}</div>`}
    </div>`;
  }).join('');
  const scroller = $('#chatScroll');
  if (!keepScroll) scroller.scrollTop = scroller.scrollHeight;
}

// "Added 2 to Breakfast, 345 kcal" (or "Added 3, 560 kcal" when they went to different meals)
function addedText(items) {
  const meals = [...new Set(items.map((e) => e.meal))];
  return `Added ${items.length}${meals.length === 1 ? ` to ${MEAL_NAMES[meals[0]]}` : ''}, ${n(items.reduce((t, e) => t + e.kcal, 0))} kcal`;
}

function renderWeek() {
  const { week, today } = state;
  // Only days with something logged count towards the balance, so a fresh install isn't "under" for empty days
  const logged = week.days.filter((d) => d.kcal > 0 && !d.future);
  const balance = logged.reduce((s, d) => s + (d.target - d.kcal), 0);
  const { budget, used } = week;
  const remainingDays = week.days.filter((d) => d.date > today).length;
  $('#week').innerHTML = `
    <h2>This week</h2>
    <p class="lede num">${logged.length
      ? `<b class="${balance >= 0 ? 'good' : 'bad'}">${n(Math.abs(balance))} kcal ${balance >= 0 ? 'under' : 'over'}</b> over ${logged.length} day${logged.length > 1 ? 's' : ''}.`
      : 'Nothing logged this week yet.'}
      ${week.flexFree ? `Your ${n(state.settings.flex_kcal)} day is still free.` : `Flex day: ${fmtDay(week.flexDate, { weekday: 'long' })}.`}
      ${remainingDays ? `${remainingDays} day${remainingDays > 1 ? 's' : ''} to go.` : ''}</p>
    <div class="bar soft"><span style="width:${Math.min(100, (used / budget) * 100)}%"></span></div>
    <div class="small num">${n(used)} of ${n(budget)} kcal for the week</div>`;
}

const stones = (kg) => { const lb = kg / 0.45359237; return `${Math.floor(lb / 14)}st ${Math.round(lb % 14)}lb`; };

function renderWeight() {
  const { stats, rows } = state.weight;
  const goal = state.settings.goal_kg;
  $('#weight').innerHTML = `<div class="weight-row">
      <div><h2>Weight</h2>
        ${stats ? `<div class="num"><b>${stats.latest.kg.toFixed(1)} kg</b>${stats.lost > 0 ? `, down ${stats.lost.toFixed(1)} kg` : ''}</div>
          ${stats.toGo != null ? `<div class="small num">${stats.toGo.toFixed(1)} kg to go</div>` : ''}` : '<div class="small">No weigh-ins yet.</div>'}</div>
      <button class="btn" data-weighin>Weigh in</button>
    </div>
    ${stats?.progress != null ? `<div class="progress" aria-label="${Math.round(stats.progress * 100)}% of the way to goal"><span style="width:${stats.progress * 100}%"></span></div>` : ''}
    ${stats ? weightChart(rows, goal, stats) : ''}
    ${stats?.projectedDate ? `<p class="small num" style="margin:var(--s2) 0 0">At this pace, ${goal} kg around ${parseDate(stats.projectedDate).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}.</p>` : ''}`;
}

function weighIn() {
  const latest = state.weight.stats?.latest.kg;
  openDialog(`<h2>Weigh in</h2><form>
    <div class="grid">
      <label class="f wide">Weight (kg)<input name="kg" type="number" step="0.1" min="30" max="400" inputmode="decimal" placeholder="${latest ?? ''}" required autofocus></label>
      <label class="f wide">Date<input name="date" type="date" value="${date}" max="${state.today}" required></label>
    </div>
    <p class="small" style="margin:0">Or type “w 128.2” or “20st 3lb” in the message box.</p>
    <div class="actions"><button class="btn primary" type="submit">Log weight</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async (v) => {
    await api('/api/weights', { method: 'POST', body: { date: v.date, kg: Number(v.kg) } });
    toast(`Logged ${v.kg} kg`);
    await load();
    if (view === 'stats') await loadStats();
  });
}

// The whole story, for the Stats page
function weightPanel(weight, st) {
  const { rows, stats: ws } = weight;
  const goal = st.goal_kg;
  if (!ws) return `<section class="panel p-weight"><div class="weight-row"><div><h2>Weight</h2><p class="lede" style="margin:0">No weigh-ins yet.</p></div><button class="btn" data-weighin>Weigh in</button></div></section>`;
  return `<section class="panel p-weight">
    <div class="weight-row"><h2>Weight</h2><button class="btn" data-weighin>Weigh in</button></div>
    <p class="lede num">${ws.latest.kg.toFixed(1)} kg (${stones(ws.latest.kg)}) on ${fmtDay(ws.latest.date, { day: 'numeric', month: 'short' })}.
      ${goal == null ? 'Set a goal weight in Settings to see a projection.' : ''}
      ${ws.projectedDate ? `At this pace you reach <b>${goal} kg</b> around <b>${parseDate(ws.projectedDate).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</b>.` : ''}</p>
    <div class="wstats num">
      <div><b>${ws.lost.toFixed(1)}</b><span>kg lost</span></div>
      <div><b>${ws.toGo != null ? ws.toGo.toFixed(1) : '–'}</b><span>kg to go</span></div>
      <div><b>${ws.ratePerWeek != null ? ws.ratePerWeek.toFixed(1) : '–'}</b><span>kg a week</span></div>
    </div>
    ${ws.progress != null ? `<div class="progress"><span style="width:${ws.progress * 100}%"></span></div>
    <div class="small">${Math.round(ws.progress * 100)}% of the way from ${ws.start.kg} kg to ${goal} kg</div>` : ''}
    <div class="wchart-box"></div>
    <details class="wlist"><summary>All weigh-ins (${rows.length})</summary><ul>
      ${rows.slice().reverse().map((r) => `<li class="num"><span>${fmtDay(r.date, { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>${r.kg.toFixed(1)} kg <button class="link-btn" data-delweight="${r.id}" aria-label="Delete weigh-in">Remove</button></span></li>`).join('')}
    </ul></details>
  </section>`;
}

function weightChart(rows, goal, stats, W = 360, H = 170) {
  const L = 34, R = 10, T = 12, B = 22;
  const t = (d) => parseDate(d).getTime();
  const end = stats.projectedDate && rows.length >= 2 ? stats.projectedDate : rows[rows.length - 1].date;
  const x0 = t(rows[0].date), x1 = Math.max(t(end), x0 + 86400000 * 7);
  const ys = rows.map((r) => r.kg).concat(goal ?? []);
  const y0 = Math.floor(Math.min(...ys) - 2), y1 = Math.ceil(Math.max(...ys) + 2);
  const X = (d) => L + ((t(d) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (kg) => T + ((y1 - kg) / (y1 - y0)) * (H - T - B);
  const path = rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.date).toFixed(1)},${Y(r.kg).toFixed(1)}`).join('');
  const last = rows[rows.length - 1];
  const proj = stats.projectedDate ? `<path class="proj" d="M${X(last.date)},${Y(last.kg)}L${X(stats.projectedDate)},${Y(goal)}"/>` : '';
  const ticks = [y1, Math.round((y0 + y1) / 2), y0].map((v) => `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  return `<svg class="wchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time${goal != null ? `, with goal line at ${goal} kg` : ''}">
    ${goal != null ? `<line class="goal" x1="${L}" x2="${W - R}" y1="${Y(goal)}" y2="${Y(goal)}"/>
    <text class="goal-t" x="${W - R}" y="${Y(goal) - 5}" text-anchor="end">goal ${goal}</text>` : ''}
    ${ticks}
    ${proj}
    <path class="line" d="${path}"/>
    ${rows.map((r) => `<circle class="dot" cx="${X(r.date)}" cy="${Y(r.kg)}" r="3.5"><title>${fmtDay(r.date)}: ${r.kg} kg</title></circle>`).join('')}
    <text x="${L}" y="${H - 4}">${fmtDay(rows[0].date, { month: 'short', year: '2-digit' })}</text>
    <text x="${W - R}" y="${H - 4}" text-anchor="end">${parseDate(end).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</text>
  </svg>`;
}

function foodMeta(f) {
  return `${n(f.kcal)} kcal per ${f.per === 1 ? '' : `${f.per} `}${esc(f.unit)} · P ${g(f.protein)} C ${g(f.carbs)} F ${g(f.fat)}`;
}

// Your own quick-add chips, managed on the Foods tab
function renderFoods() {
  const el = $('#quickFoods');
  if (!el || !state) return;
  const { foods } = state;
  el.innerHTML = `<h2>Your quick-add foods</h2>
    <p class="lede">Just for you. They come first under Saved foods when you tap Add on a meal. Save more from any logged item with “Save as food”.</p>
    ${foods.length ? `<ul class="foodlist">${foods.map((f) => `<li><div><div>${esc(f.name)}</div><div class="meta num">${foodMeta(f)}</div></div>
      <button class="link-btn" data-delfood="${f.id}" aria-label="Remove ${esc(f.name)}">Remove</button></li>`).join('')}</ul>`
      : '<p class="small">None yet.</p>'}`;
}

/* ---------- Dialogs ---------- */

function openDialog(html, onSubmit) {
  const d = $('#dialog');
  if (d.open) d.close();
  d.className = '';
  d.innerHTML = html;
  d.showModal();
  const form = $('form', d);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (ev.submitter?.value === 'cancel') return d.close();
    const btn = $('button.primary', form);
    btn.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      d.close();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function guessMeal() {
  const h = new Date().getHours();
  return h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h >= 17 && h < 22 ? 'dinner' : 'snacks';
}

function quickAdd(food, meal = guessMeal()) {
  // Saved foods store their unit as text ("100 g", "1 slice"); unknown words count as "each"
  const q = parseQuantity(`${food.per} ${food.unit}`) || { amount: food.per, unit: 'each' };
  openDialog(`<h2>${esc(food.name)}</h2><form>
    <p class="small num" style="margin:0">${foodMeta(food)}</p>
    <div class="grid">
      ${amountHtml(q)}
      <label class="f full">Meal${mealSelect(meal)}</label>
      ${MACROS.map((k) => `<input type="hidden" data-m="${k}" value="${food[k]}">`).join('')}
    </div>
    <p class="qa-total num"><b>${n(food.kcal)}</b> kcal · P ${g(food.protein)} · C ${g(food.carbs)} · F ${g(food.fat)}</p>
    <div class="actions"><button class="btn primary" type="submit">Add</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ meal }, form) => {
    const m = Object.fromEntries(MACROS.map((k) => [k, Number($(`[data-m="${k}"]`, form).value)]));
    const amt = $('.amt', form);
    delete amt.dataset.untouched;
    const r = await api('/api/entries', { method: 'POST', body: { date, meal, name: food.name, ...m, ...readAmount(amt), source: 'saved', origin: `Your saved food “${food.name}”` } });
    lastAdd = { ids: [r.id], text: `Added ${food.name} to ${MEAL_NAMES[meal]}` };
    await load();
  });
  const form = $('#dialog form');
  form.addEventListener('rescaled', () => {
    const v = Object.fromEntries(MACROS.map((k) => [k, Number($(`[data-m="${k}"]`, form).value)]));
    $('.qa-total', form).innerHTML = `<b>${n(v.kcal)}</b> kcal · P ${g(v.protein)} · C ${g(v.carbs)} · F ${g(v.fat)}`;
  });
}

function saveAsFood(e) {
  // Weights and liquids are saved per 100 g or ml, counted things per one of them
  const a = asAmount(e);
  const grams = a.grams > 0 ? a.grams : toGrams(a.amount, a.unit, a);
  const kind = UNITS[a.unit].kind;
  const per = kind === 'weight' ? { amount: 100, unit: 'g' } : kind === 'volume' ? { amount: 100, unit: 'ml' } : { amount: 1, unit: a.unit };
  const perG = toGrams(per.amount, per.unit, a);
  const k = grams > 0 ? perG / grams : 1;
  const scaled = Object.fromEntries(MACROS.map((m) => [m, m === 'kcal' ? Math.round(e[m] * k) : r1(e[m] * k)]));
  openDialog(`<h2>Save as a quick-add food</h2><form>
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(e.name)}" required></label>
      <span class="f full small" style="margin:0">Values per</span>
      ${amountHtml({ ...per, grams: perG, density: a.density, each_g: a.each_g })}
      ${macroInputs(scaled)}
    </div>
    <div class="actions"><button class="btn primary" type="submit">Save food</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async (v, form) => {
    const { amount, unit } = readAmount($('.amt', form));
    await api('/api/foods', { method: 'POST', body: { name: v.name, per: amount, unit: UNITS[unit].label || 'each', kcal: Number(v.kcal), protein: Number(v.protein), carbs: Number(v.carbs), fat: Number(v.fat) } });
    toast(`Saved ${v.name}`);
    await load();
  });
}

// Text for whichever AI the server is set up with (PLATEFUL_AI in .env)
const aiStatus = (ai) => (ai.problem ? `${ai.label} isn’t set up yet, so only saved foods and presets work: ${ai.problem} See SETUP.md.`
  : `Food is read by ${ai.label}.${ai.photos ? '' : ' It can’t see photos as set up, so describe food in words.'}`);

function openSettings() {
  const s = state.settings;
  const ai = state.server.ai;
  const days = [['auto', 'Whichever day I go over'], ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  openDialog(`<h2>Settings for ${esc(state.profile.name)}</h2><form>
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(state.profile.name)}" required maxlength="40"></label>
      <label class="f wide">Daily kcal<input name="daily_kcal" type="number" min="800" max="6000" value="${s.daily_kcal}" required></label>
      <label class="f wide">Flex day kcal<input name="flex_kcal" type="number" min="800" max="6000" value="${s.flex_kcal}" required></label>
      <label class="f full">Flex day<select name="flex_day">${days.map(([v, l]) => `<option value="${v}"${v === s.flex_day ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f full">Goal weight (kg)<input name="goal_kg" type="number" step="0.1" min="30" max="300" value="${s.goal_kg ?? ''}" placeholder="optional"></label>
      <fieldset class="f full day-goals"><legend>Daily goals, in grams</legend>
        <p class="small">Leave one empty to use the reference intake printed on UK food labels. Protein and fibre are amounts to reach; the rest are limits.</p>
        <div class="grid">${['protein', 'fibre', 'carbs', 'sugars', 'fat', 'sat_fat', 'salt'].map((k) => NUTRIENTS.find((x) => x[0] === k)).map(([k, l, sub]) => `<label class="f wide${sub ? ' sub' : ''}">${l}<input name="${k}_g" type="number" inputmode="decimal" step="any" min="0" max="${k === 'salt' ? 30 : 600}" value="${s[`${k}_g`] ?? ''}" placeholder="${RI[k]}"></label>`).join('')}</div>
      </fieldset>
      <fieldset class="f full schemes"><legend>Colours</legend>
        ${SCHEMES.map(([v, l, sw]) => `<label class="scheme"><input type="radio" name="scheme" value="${v}"${v === s.scheme ? ' checked' : ''}>
          <span class="sw">${sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${l}</label>`).join('')}
      </fieldset>
      <label class="f full">Light or dark<select name="mode">${[['auto', 'Match this device'], ['light', 'Always light'], ['dark', 'Always dark']]
        .map(([v, l]) => `<option value="${v}"${v === s.mode ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f full">Which model reads your food<select name="model_mode">${(ai.text === ai.photo ? [
        ['auto', `${modelName(ai.text)} for everything`],
      ] : [
        ['auto', `${modelName(ai.text)} for typing, ${modelName(ai.photo)} for photos (cheapest)`],
        ['sonnet', `${modelName(ai.photo)} for everything (most accurate)`],
        ['haiku', `${modelName(ai.text)} for everything`],
      ]).map(([v, l]) => `<option value="${v}"${v === s.model_mode ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f wide">Current PIN<input name="current" type="password" inputmode="numeric" autocomplete="current-password" pattern="\\d{4,8}" placeholder="to change PIN"></label>
      <label class="f wide">New PIN<input name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="\\d{4,8}" placeholder="4 to 8 digits"></label>
    </div>
    <p class="small" style="margin:0">16 st is 101.6 kg. The week runs Monday to Sunday. Leave the PIN boxes empty to keep your PIN.</p>
    <p class="small" style="margin:0">${esc(aiStatus(ai))}
      <button class="link-btn" type="button" data-explain>Where the numbers come from</button></p>
    <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ current, pin, ...v }) => {
    if (pin) await api('/api/pin', { method: 'PUT', body: { current, pin } });
    await api('/api/settings', { method: 'PUT', body: v });
    toast(pin ? 'Settings and PIN saved' : 'Settings saved');
    await load();
    if (view === 'stats') await loadStats();
  });
  // Try colours as you pick them; closing without saving puts yours back
  const form = $('#dialog form');
  form.addEventListener('change', (e) => {
    if (['scheme', 'mode'].includes(e.target.name)) applyColours({ scheme: form.elements.scheme.value, mode: form.elements.mode.value });
  });
  $('#dialog').addEventListener('close', () => applyColours(state.settings), { once: true });
}

/* ---------- Adding to a meal ----------
   Each meal's Add button opens one sheet: search what Plateful already knows (things you've had
   lately, the household food list, saved meals), take a photo, make a new food, or hand the
   words to the AI. Picking something you've had before adds it straight away, with Undo. */

const SEARCH = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const CAMERA = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const LABEL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 8h8M8 12h8M8 16h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const adding = { meal: 'snacks', tab: 'recent', q: '', recent: [], products: [], online: false, rows: [], seq: 0 };
const terms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text, ts) => { const t = text.toLowerCase(); return ts.every((w) => t.includes(w)); };

function addSheet(meal) {
  Object.assign(adding, { meal, tab: 'recent', q: '', online: false, products: [] });
  const left = state.day.target - state.day.totals.kcal;
  const d = openSheet(`<div class="sheet-form add-sheet">
    <header class="sheet-head">
      <div class="sheet-title"><h2>Add to ${MEAL_NAMES[meal]}</h2>
        <div class="small num">${date === state.today ? 'Today' : fmtDay(date, { weekday: 'long', day: 'numeric', month: 'short' })}, ${n(Math.abs(left))} kcal ${left < 0 ? 'over' : 'left'}</div></div>
      <button class="icon-btn" type="button" data-closesheet aria-label="Close">${CLOSE}</button>
    </header>
    <div class="sheet-body">
      <form class="add-search" role="search">
        <label class="sr-only" for="addQ">Search your foods, or describe what you ate</label>
        <div class="search-box">${SEARCH}<input id="addQ" type="search" autocomplete="off" enterkeyhint="go" placeholder="Search, or just say what you had"></div>
        <p class="small hint">Search your foods, or just say it: “2 slices of toast with butter”.</p>
      </form>
      <div class="photo-btns">
        <label class="btn"><input type="file" accept="image/*" capture="environment" data-addphoto="food" data-paste hidden>${CAMERA}Photo of food</label>
        <label class="btn"><input type="file" accept="image/*" capture="environment" data-addphoto="label" hidden>${LABEL}Photo of label</label>
      </div>
      <p class="small hint photo-alt"><label class="link-btn"><input type="file" accept="image/*" data-addphoto="food" hidden>Use a picture you already have</label><span class="hide-touch"> or paste one with Ctrl+V</span></p>
      <div class="seg-tabs" role="tablist" aria-label="Where to look">
        ${[['recent', 'Recent'], ['foods', 'Saved foods'], ['meals', 'Meals']].map(([k, l]) => `<button type="button" role="tab" data-addtab="${k}">${l}</button>`).join('')}
      </div>
      <div class="add-list" id="addList" aria-live="polite"></div>
    </div>
    <footer class="sheet-foot" id="addFoot"></footer>
  </div>`, 'add');
  const input = $('#addQ', d);
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { adding.q = input.value.trim(); adding.online = false; refreshAdd(); }, 200); });
  $('.add-search', d).addEventListener('submit', (e) => { e.preventDefault(); if (adding.q) askPlateful(); });
  if (!matchMedia('(pointer: coarse)').matches) input.focus();
  refreshAdd();
}

async function refreshAdd() {
  const seq = ++adding.seq;
  renderAddList(true);
  try {
    const [recent, found] = await Promise.all([
      adding.recent.length && adding.recent.date === date ? adding.recent : api('/api/recent').then((r) => Object.assign(r.entries, { date })),
      (adding.q || adding.tab === 'foods') ? api(`/api/fooddb?q=${encodeURIComponent(adding.q)}${adding.online ? '&online=1' : ''}`) : { products: [] },
    ]);
    if (seq !== adding.seq) return;
    adding.recent = recent;
    adding.products = found.products;
    renderAddList();
  } catch (err) {
    if (seq === adding.seq) $('#addList').innerHTML = `<p class="small">${esc(err.message)}</p>`;
  }
}

function addRow(kind, i, name, detail, kcal, action = 'Add') {
  return `<li><button type="button" class="add-row" data-addpick="${kind}:${i}">
    <span class="ar-text"><span class="ar-name">${esc(name)}</span><span class="ar-detail num">${detail}</span></span>
    <span class="ar-kcal num">${kcal == null ? '' : n(kcal)}</span>
    <span class="ar-plus" aria-hidden="true">${PLUS}</span><span class="sr-only">${action}</span>
  </button></li>`;
}

function renderAddList(loading = false) {
  const d = $('#dialog');
  if (!d.open || !$('.add-sheet', d)) return;
  const { tab, q } = adding;
  const ts = terms(q);
  d.querySelectorAll('[data-addtab]').forEach((b) => b.setAttribute('aria-selected', String(!q && b.dataset.addtab === tab)));
  $('.seg-tabs', d).classList.toggle('dim', !!q);
  const recent = adding.recent.filter((e) => !ts.length || matches(e.name, ts));
  const quick = state.foods.filter((f) => !ts.length || matches(f.name, ts));
  const mealsList = presets.presets.filter((p) => !ts.length || matches(p.name, ts));
  const sugg = ts.length ? [] : presets.suggestions;
  const rows = [];
  const section = (title, html) => (html ? `<h3 class="add-h">${title}</h3><ul class="add-ul">${html}</ul>` : '');
  const R = (e) => { rows.push(['recent', e]); return addRow('r', rows.length - 1, e.name, `${amountText(e)}${e.times > 1 ? `, had ${e.times} times` : ''}`, e.kcal); };
  const P = (p) => { rows.push(['product', p]); return addRow('r', rows.length - 1, productName(p), `${p.serving_g ? `${n((p.kcal * p.serving_g) / 100)} kcal a serving of ${r1(p.serving_g)} g` : `${n(p.kcal)} kcal per 100 g`}`, null, 'Choose amount'); };
  const Q = (f) => { rows.push(['quick', f]); return addRow('r', rows.length - 1, f.name, `${f.per === 1 ? '1' : f.per} ${esc(f.unit)}, your saved food`, f.kcal); };
  const M = (p) => { rows.push(['preset', p]); return addRow('r', rows.length - 1, p.name, `Saved meal: ${p.items.map((i) => esc(i.name)).slice(0, 3).join(', ')}${p.items.length > 3 ? '…' : ''}`, p.kcal); };
  const S = (s) => { rows.push(['suggest', s]); return addRow('r', rows.length - 1, s.name, s.kind === 'habit' ? `You’ve had this ${s.count} times lately` : 'Saved meal, usually now', s.kcal); };
  let html;
  if (q) {
    html = section('You’ve had', recent.slice(0, 8).map(R).join(''))
      + section('Saved foods', quick.map(Q).join('') + adding.products.slice(0, 12).map(P).join(''))
      + section('Meals', mealsList.map(M).join(''));
    if (!html && !loading) html = `<p class="add-empty">Nothing saved matches “${esc(q)}”. Take a photo of it or its label above, ask Plateful below, or make it a new food.</p>
      <button type="button" class="btn wide-btn" data-newfood>${PLUS}New food</button>`;
    html += adding.online ? '' : `<button type="button" class="btn wide-btn" data-addonline>${SEARCH}Search Open Food Facts for “${esc(q)}”</button>`;
  } else if (tab === 'recent') {
    html = section('Usually now', sugg.map(S).join('')) + section('Recent', recent.slice(0, 40).map(R).join(''))
      || (loading ? '' : '<p class="add-empty">Nothing logged in the last two months yet. Search, take a photo, or just say what you had.</p>');
  } else if (tab === 'foods') {
    html = section('Your saved foods', quick.map(Q).join('')) + section('Food list', adding.products.map(P).join(''))
      || (loading ? '' : '<p class="add-empty">No foods yet. Photograph a label or make a new food below.</p>');
  } else {
    html = section('Saved meals', mealsList.map(M).join(''))
      + (people.length ? `<div class="copy-btns">${people.map((x) => `<button type="button" class="btn" data-addcopy="${x.id}">Copy from ${esc(x.name)}</button>`).join('')}</div>` : '')
      || '';
    if (!mealsList.length && !loading) html = '<p class="add-empty">No saved meals yet. When a meal has two or more things in it, “Save as a meal” sits next to its name.</p>' + html;
  }
  adding.rows = rows;
  $('#addList').innerHTML = loading && !html ? '<div class="skeleton" style="height:120px"></div>' : html;
  $('#addFoot').innerHTML = q
    ? `<button type="button" class="btn primary grow" data-askadd>Ask Plateful to work out “${esc(q.length > 40 ? `${q.slice(0, 40)}…` : q)}”</button>`
    : `<button type="button" class="btn grow" data-newfood>${PLUS}New food</button>`;
}

async function pickAdd([kind, x], meal) {
  if (kind === 'product') return addProduct(x, meal);
  if (kind === 'quick') return quickAdd(x, meal);
  if ($('#dialog').open) $('#dialog').close();
  if (kind === 'recent') {
    const r = await api('/api/entries/copy', { method: 'POST', body: { ids: [x.id], date, meal } });
    lastAdd = { ids: r.ids, text: `Added ${x.name} to ${MEAL_NAMES[meal]}` };
  } else if (kind === 'preset') {
    const r = await api(`/api/presets/${x.id}/add`, { method: 'POST', body: { date, meal } });
    lastAdd = { ids: r.ids, text: `Added ${x.name} to ${MEAL_NAMES[meal]}` };
  } else if (kind === 'suggest') {
    const r = x.kind === 'preset' ? await api(`/api/presets/${x.id}/add`, { method: 'POST', body: { date, meal } })
      : await api('/api/entries/copy', { method: 'POST', body: { ids: x.ids, date, meal } });
    lastAdd = { ids: r.ids, text: `Added ${x.name} to ${MEAL_NAMES[meal]}` };
  }
  await load();
}

function askPlateful() {
  const text = `${adding.q} for ${adding.meal === 'snacks' ? 'a snack' : adding.meal}`;
  $('#dialog').close();
  sendMessage(text, []);
}

async function addPhoto(kind, file) {
  const meal = adding.meal;
  const image = await shrink(file);
  $('#dialog').close();
  if (kind === 'food') return sendMessage(`${adding.q ? `${adding.q} ` : ''}for ${meal === 'snacks' ? 'a snack' : meal}`, [image]);
  toast('Reading the label…');
  try {
    const r = await api('/api/fooddb/from-label', { method: 'POST', body: { images: [image] } });
    $('#toast').hidden = true;
    customFood({ product: r.product, meal });
  } catch (err) { toast(err.message, 'error'); }
}

/* ---------- Quick add, beside the diary on a computer ----------
   The same things as the Add sheet's lists, one tap each, into whichever meal is picked
   at the top (the one for this time of day to start with). */

const qp = { tab: 'recent', meal: null, rows: [], products: null, recentFor: null };

async function renderQuickPanel() {
  const el = $('#quickPanel');
  if (!el || !state || matchMedia('(max-width: 899px)').matches) return;
  qp.meal = qp.meal || guessMeal();
  if (qp.recentFor !== date) {
    qp.recentFor = date;
    const [r, f] = await Promise.all([api('/api/recent'), api('/api/fooddb?q=')]).catch(() => [{ entries: [] }, { products: [] }]);
    adding.recent = Object.assign(r.entries, { date });
    qp.products = f.products;
  }
  const rows = [];
  const row = (kind, x, name, detail, kcal) => { rows.push([kind, x]); return `<li><button type="button" class="add-row" data-qpick="${rows.length - 1}" title="Add to ${MEAL_NAMES[qp.meal]}">
      <span class="ar-text"><span class="ar-name">${esc(name)}</span><span class="ar-detail num">${detail}</span></span>
      <span class="ar-kcal num">${kcal == null ? '' : n(kcal)}</span><span class="ar-plus" aria-hidden="true">${PLUS}</span></button></li>`; };
  let list = '';
  if (qp.tab === 'recent') list = adding.recent.slice(0, 15).map((e) => row('recent', e, e.name, `${amountText(e)}${e.times > 1 ? `, ${e.times} times` : ''}`, e.kcal)).join('');
  else if (qp.tab === 'meals') list = presets.presets.map((p) => row('preset', p, p.name, `${p.items.length} item${p.items.length > 1 ? 's' : ''}`, p.kcal)).join('');
  else list = state.foods.map((f) => row('quick', f, f.name, `${f.per === 1 ? '1' : f.per} ${esc(f.unit)}`, f.kcal)).join('')
    + (qp.products || []).slice(0, 15).map((p) => row('product', p, productName(p), p.serving_g ? `${r1(p.serving_g)} g serving` : 'per 100 g', p.serving_g ? (p.kcal * p.serving_g) / 100 : p.kcal)).join('');
  qp.rows = rows;
  const empty = { recent: 'Nothing logged in the last two months yet.', meals: 'No saved meals yet. “Save as a meal” sits by any meal with two or more things in it.', foods: 'No saved foods yet.' }[qp.tab];
  el.innerHTML = `<div class="panel-head"><h2>Quick add</h2>
      <label class="qp-meal"><span class="sr-only">Add to</span>${mealSelect(qp.meal)}</label></div>
    <div class="seg-tabs" role="tablist" aria-label="Quick add from">
      ${[['recent', 'Recent'], ['meals', 'My meals'], ['foods', 'Saved foods']].map(([k, l]) => `<button type="button" role="tab" data-qptab="${k}" aria-selected="${qp.tab === k}">${l}</button>`).join('')}
    </div>
    ${list ? `<ul class="add-ul qp-list">${list}</ul>` : `<p class="add-empty">${empty}</p>`}`;
  $('select', el).addEventListener('change', (e) => { qp.meal = e.target.value; renderQuickPanel(); });
}

/* ---------- A new food, typed in or read off a label ---------- */

function customFood({ product = null, meal = null } = {}) {
  const p = product || {};
  const d = openSheet(`<form class="sheet-form custom-food">
    <header class="sheet-head">
      <div class="sheet-title"><h2>${product ? 'Check the label' : 'New food'}</h2>
        <div class="small">${product ? 'Read off your photo. Fix anything that’s wrong, then save.' : 'Saved foods are shared with everyone in the house.'}</div></div>
      <button class="icon-btn" type="button" data-closesheet aria-label="Close">${CLOSE}</button>
    </header>
    <div class="sheet-body">
      ${product ? '' : `<div class="cf-photo"><div class="photo-btns">
        <label class="btn dashed"><input type="file" accept="image/*" capture="environment" data-cflabel hidden>${CAMERA}Photograph the label</label>
        <label class="btn dashed"><input type="file" accept="image/*" data-cflabel data-paste hidden>${LABEL}Use a label picture</label>
      </div><p class="small hint">Plateful fills everything in from it<span class="hide-touch">. You can paste a picture with Ctrl+V too</span>.</p></div>`}
      <div class="grid">
        <label class="f full">Name<input name="name" value="${esc(p.name || '')}" required maxlength="120" placeholder="Overnight oats with berries"></label>
        <label class="f wide"><span>Brand or shop <span class="opt">optional</span></span><input name="brand" value="${esc(p.brand || '')}" maxlength="80" placeholder="Home made"></label>
        <label class="f wide">One serving, g<input name="serving_g" type="number" inputmode="decimal" step="any" min="0" value="${p.serving_g ?? ''}" placeholder="240"></label>
        <label class="f wide"><span>Whole pack, g <span class="opt">optional</span></span><input name="pack_g" type="number" inputmode="decimal" step="any" min="0" value="${p.pack_g ?? ''}"></label>
        <label class="f wide"><span>Barcode <span class="opt">optional</span></span><input name="barcode" inputmode="numeric" pattern="\\d{8,14}" value="${esc(p.barcode || '')}"></label>
      </div>
      <div class="cf-head"><h3>Nutrition</h3>
        <div class="seg-tabs small-seg" role="radiogroup" aria-label="The numbers are">
          <label><input type="radio" name="per" value="100" checked><span>Per 100 g</span></label>
          <label><input type="radio" name="per" value="serving"><span>Per serving</span></label>
        </div>
      </div>
      <div class="cf-nut">
        ${ALL_NUTRIENTS.map(([k, label, unit, sub]) => `<label class="cf-row${sub ? ' sub' : ''}"><span>${label}</span>
          <input name="${k}" type="number" inputmode="decimal" step="any" min="0" value="${p[k] ?? ''}"${k === 'kcal' ? ' required' : ''}><span class="unit">${unit}</span></label>`).join('')}
      </div>
      <p class="small" style="margin:0">Only calories are needed. Per serving needs the serving size above.</p>
    </div>
    <footer class="sheet-foot">
      ${meal ? `<button class="btn" type="submit" value="save">Just save it</button><button class="btn primary grow" type="submit" value="add">Save and add to ${MEAL_NAMES[meal]}</button>`
        : '<button class="btn primary grow" type="submit" value="save">Save food</button>'}
    </footer>
  </form>`, 'tall');
  const form = $('form', d);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const serving = Number(v.serving_g) || null;
    if (v.per === 'serving' && !serving) return toast('Put in how many grams one serving is, or switch to per 100 g.', 'error');
    const k = v.per === 'serving' ? 100 / serving : 1;
    const nums = Object.fromEntries(ALL_NUTRIENTS.map(([key]) => [key, v[key] === '' ? null : r1(Number(v[key]) * k)]));
    const body = { name: v.name, brand: v.brand, barcode: v.barcode, serving_g: serving, pack_g: Number(v.pack_g) || null, ...nums };
    const btns = form.querySelectorAll('.sheet-foot .btn');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = product ? await api(`/api/fooddb/${product.id}`, { method: 'PUT', body }) : await api('/api/fooddb', { method: 'POST', body });
      const saved = r.product;
      adding.recent = [];
      if (e.submitter?.value === 'add') {
        const grams = saved.serving_g || 100;
        const amount = saved.serving_g ? { amount: 1, unit: 'portion', grams, each_g: grams } : { amount: 100, unit: 'g', grams: 100 };
        const values = Object.fromEntries(MACROS.map((m) => [m, saved[m] == null ? null : m === 'kcal' ? Math.round((saved[m] * grams) / 100) : r1((saved[m] * grams) / 100)]));
        const added = await api('/api/entries', { method: 'POST', body: { date, meal, name: productName(saved), ...values, ...amount, source: 'db', product_id: saved.id, origin: `Food list: ${saved.name}` } });
        lastAdd = { ids: [added.id], text: `Added ${saved.name} to ${MEAL_NAMES[meal]}` };
      } else toast(`Saved ${saved.name}`);
      d.close();
      await load();
      if (view === 'foods') loadFoods();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  });
  form.querySelectorAll('[data-cflabel]').forEach((input) => input.addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    const btn = e.target.closest('label');
    const was = btn.lastChild.textContent;
    btn.classList.add('busy');
    btn.lastChild.textContent = 'Reading the label…';
    try {
      const r = await api('/api/fooddb/from-label', { method: 'POST', body: { images: [await shrink(e.target.files[0])] } });
      customFood({ product: r.product, meal });
    } catch (err) {
      toast(err.message, 'error');
      btn.classList.remove('busy');
      btn.lastChild.textContent = was;
    }
  }));
}

/* ---------- What just happened, with Undo ---------- */

function renderLastAdd() {
  const el = $('#lastAdd');
  const pending = pendingMessage && !pendingMessage.error;
  const last = state && !pendingMessage && state.day.messages.filter((m) => !m.cleared).at(-1);
  const failed = last?.error && !lastAdd;
  if (!lastAdd && !pending && !failed) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `lastadd${failed ? ' error' : pending ? ' pending' : ''}`;
  el.innerHTML = pending ? '<span class="la-text">Reading it<span class="dots"></span></span>'
    : failed ? `<span class="la-text">${esc(last.error)}</span><button type="button" class="link-btn" data-retry="${last.id}">Retry</button>`
    : `<span class="la-text"><b>${esc(lastAdd.text)}</b>${lastAdd.note ? ` ${esc(lastAdd.note)}` : ''}</span>
      ${lastAdd.ids?.length ? '<button type="button" class="link-btn" data-undo>Undo</button>' : ''}
      <button type="button" class="link-btn la-chat" data-openchat>Chat</button>
      <button type="button" class="icon-btn la-x" data-dismissadd aria-label="Hide this">${CLOSE}</button>`;
}

async function undoLast() {
  const { ids, text } = lastAdd;
  lastAdd = null;
  await Promise.all(ids.map((id) => api(`/api/entries/${id}`, { method: 'DELETE' })));
  toast(`Undone: ${text.replace(/^Added /, '').replace(/^Copied /, '')}`);
  await load();
}

function openChat(open) {
  document.body.classList.toggle('chat-open', open);
  if (open) { const sc = $('#chatScroll'); sc.scrollTop = sc.scrollHeight; }
}

/* ---------- Food list ---------- */

const per100 = (p) => `${n(p.kcal)} kcal per 100 g${p.protein != null ? ` · P ${r1(p.protein)} C ${r1(p.carbs ?? 0)} F ${r1(p.fat ?? 0)}` : ''}`;
const PRODUCT_SOURCES = { off: 'Open Food Facts', label: 'read off your label', manual: 'typed in', import: 'imported' };
const productName = (p) => (p.brand && !p.name.toLowerCase().includes(shopOf(p.brand).toLowerCase()) ? `${shopOf(p.brand)} ${p.name}` : p.name);

function addProduct(p, meal = guessMeal()) {
  const grams = p.serving_g || 100;
  const scaled = (g) => Object.fromEntries(MACROS.map((k) => [k, p[k] == null ? null : k === 'kcal' ? Math.round((p[k] * g) / 100) : r1((p[k] * g) / 100)]));
  openDialog(`<h2>${esc(p.name)}</h2><form>
    <p class="small num" style="margin:0">${p.brand ? `${esc(p.brand)} · ` : ''}${per100(p)} · ${PRODUCT_SOURCES[p.source] || p.source}</p>
    <div class="grid">
      ${amountHtml(p.serving_g ? { amount: 1, unit: 'portion', grams, each_g: p.serving_g } : { amount: grams, unit: 'g', grams })}
      <label class="f full">Meal${mealSelect(meal)}</label>
      ${MACROS.map((k) => `<input type="hidden" data-m="${k}" value="${scaled(grams)[k] ?? ''}">`).join('')}
    </div>
    <p class="qa-total num"></p>
    <div class="actions"><button class="btn primary" type="submit">Add</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ meal }, form) => {
    const m = Object.fromEntries(MACROS.map((k) => [k, $(`[data-m="${k}"]`, form).value]));
    const amt = $('.amt', form);
    delete amt.dataset.untouched;
    const r = await api('/api/entries', { method: 'POST', body: { date, meal, name: productName(p), ...m, ...readAmount(amt), source: 'db', product_id: p.id, origin: `Food list: ${p.name}` } });
    lastAdd = { ids: [r.id], text: `Added ${p.name} to ${MEAL_NAMES[meal]}` };
    await load();
  });
  const form = $('#dialog form');
  const total = () => {
    const v = Object.fromEntries(MACROS.map((k) => [k, Number($(`[data-m="${k}"]`, form).value)]));
    $('.qa-total', form).innerHTML = `<b>${n(v.kcal)}</b> kcal · P ${g(v.protein)} · C ${g(v.carbs)} · F ${g(v.fat)}`;
  };
  form.addEventListener('rescaled', total);
  total();
}

/* ---------- Foods: the household food list, to search, fix, prune, import and export ---------- */

const SOURCE_NAMES = { off: 'Open Food Facts', label: 'From a label', manual: 'Typed in', import: 'Imported' };
const foodsState = { products: [], total: 0, q: '', source: '' };
const PRODUCT_FIELDS = [['kcal', 'kcal'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['sugars', 'of which sugars g'], ['fat', 'Fat g'], ['sat_fat', 'of which saturates g'], ['fibre', 'Fibre g'], ['salt', 'Salt g']];
const IMPORT_EXAMPLE = `{
  "foods": [
    {
      "name": "Protein granola with dark chocolate",
      "brand": "Lidl",
      "barcode": "4056489123456",
      "kcal": 441,
      "fat": 13.7,
      "sat_fat": 2.8,
      "carbs": 60.4,
      "sugars": 17.5,
      "fibre": 6.4,
      "protein": 15.8,
      "salt": 0.03,
      "serving_g": 50,
      "pack_g": 650
    }
  ]
}`;

async function loadFoods() {
  const el = $('#foodsView');
  if (!el.innerHTML) renderFoodsShell();
  try {
    const r = await api(`/api/fooddb/all?q=${encodeURIComponent(foodsState.q)}&source=${foodsState.source}`);
    Object.assign(foodsState, { products: r.products, total: r.total });
    renderFoodsList();
  } catch (err) {
    if (!document.body.classList.contains('signed-out')) toast(err.message, 'error');
  }
}

function renderFoodsShell() {
  $('#foodsView').innerHTML = `
    <div class="stats-head">
      <div><div class="eyebrow">Shared by everyone in the house</div><h1>Foods</h1>
        <div class="small num" id="foodsCount"></div></div>
      <div class="foods-actions">
        <label class="btn primary"><input type="file" accept="image/*" capture="environment" data-foodlabel hidden>Photograph a label</label>
        <label class="btn"><input type="file" accept="image/*" multiple id="labelFile" data-foodlabel hidden>Add from label pictures</label>
        <button class="btn" data-fadd>Add by hand</button>
        <label class="btn"><input type="file" accept="application/json,.json" id="importFile" hidden>Import JSON</label>
        <button class="btn" data-fexport>Export JSON</button>
      </div>
    </div>
    <div class="foods-bar">
      <input type="search" id="foodsQ" placeholder="Search by name, shop or barcode" aria-label="Search foods" autocomplete="off">
      <div class="seg" id="foodsSrc"></div>
    </div>
    <div id="foodsList"></div>
    <section class="panel" id="quickFoods"></section>
    <details class="import-help panel"><summary>What an import file looks like</summary>
      <p class="small">A JSON file with a list of foods, either on its own or under <code>"foods"</code>. Every value is per 100 g, like the big column on a UK label. Only <code>name</code> and <code>kcal</code> are needed; leave out anything you don’t know. A product that’s already here (same barcode, or same name and brand) is updated rather than added twice, and you see what will happen before anything changes. A file exported from here imports straight back.</p>
      <pre class="code">${esc(IMPORT_EXAMPLE)}</pre>
    </details>`;
  let t;
  $('#foodsQ').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { foodsState.q = e.target.value.trim(); loadFoods(); }, 200); });
  $('#foodsView').querySelectorAll('[data-foodlabel]').forEach((input) => input.addEventListener('change', async (e) => {
    const files = [...e.target.files].slice(0, 3);
    e.target.value = '';
    if (!files.length) return;
    const btn = e.target.closest('label');
    const was = btn.lastChild.textContent;
    btn.classList.add('busy');
    btn.lastChild.textContent = 'Reading the label…';
    try {
      const images = await Promise.all(files.map(shrink));
      const r = await api('/api/fooddb/from-label', { method: 'POST', body: { images } });
      toast(`Saved ${r.product.name}. Check the numbers.`);
      await loadFoods();
      editProduct(r.product);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.classList.remove('busy');
      btn.lastChild.textContent = was;
    }
  }));
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importFoods(e.target.files[0]); e.target.value = ''; });
}

function renderFoodsList() {
  renderFoods();
  const { products, total, source } = foodsState;
  $('#foodsCount').textContent = `${n(total)} product${total === 1 ? '' : 's'}${products.length !== total ? `, ${n(products.length)} shown` : ''}`;
  $('#foodsSrc').innerHTML = [['', 'All'], ...Object.entries(SOURCE_NAMES)]
    .map(([v, l]) => `<button class="seg-btn" data-fsrc="${v}" aria-pressed="${source === v}">${l}</button>`).join('');
  $('#foodsList').innerHTML = products.length
    ? `<table class="foods-table num"><thead><tr><th>Product</th><th>kcal</th><th>Protein</th><th class="hide-s">Carbs</th><th class="hide-s">Fat</th><th class="hide-s">Serving</th><th class="hide-s">From</th></tr></thead><tbody>
      ${products.map((p) => `<tr data-editproduct="${p.id}" tabindex="0">
        <th scope="row">${p.photo ? '<span class="has-photo" title="Has a label photo">▣</span>' : ''}<span class="fp-name">${esc(p.name)}</span><span class="fp-brand">${esc(p.brand || '')}${p.barcode ? ` · ${esc(p.barcode)}` : ''}</span></th>
        <td>${n(p.kcal)}</td><td>${p.protein ?? '–'}</td><td class="hide-s">${p.carbs ?? '–'}</td><td class="hide-s">${p.fat ?? '–'}</td>
        <td class="hide-s">${p.serving_g ? `${r1(p.serving_g)} g` : '–'}</td>
        <td class="hide-s"><span class="src">${SOURCE_NAMES[p.source] || p.source}</span>${p.added_by_name ? `<span class="small"> · ${esc(p.added_by_name)}</span>` : ''}</td>
      </tr>`).join('')}</tbody></table>
      <p class="small">Values per 100 g. Tap a product to edit it, add its label photo or delete it.</p>`
    : `<div class="empty"><strong>${foodsState.q || source ? 'Nothing matches that.' : 'No foods yet.'}</strong><p>Foods arrive here when the AI reads a label you photograph or Plateful finds one on Open Food Facts. You can also add one by hand or import a JSON file.</p></div>`;
}

function editProduct(p) {
  const v = p || { name: '', brand: '', barcode: '' };
  openDialog(`<h2>${p ? 'Edit product' : 'Add a product'}</h2><form class="product-edit">
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(v.name)}" required maxlength="120"></label>
      <label class="f wide">Shop or brand<input name="brand" value="${esc(v.brand)}" maxlength="80"></label>
      <label class="f wide">Barcode<input name="barcode" value="${esc(v.barcode ?? '')}" inputmode="numeric" pattern="\\d{8,14}" placeholder="optional"></label>
      <span class="f full small" style="margin:0">Per 100 g</span>
      ${PRODUCT_FIELDS.map(([k, l]) => `<label class="f">${l}<input name="${k}" type="number" step="any" min="0" max="${k === 'kcal' ? 900 : 100}" value="${v[k] ?? ''}"${k === 'kcal' ? ' required' : ''}></label>`).join('')}
      <label class="f wide">One serving g<input name="serving_g" type="number" step="any" min="0" value="${v.serving_g ?? ''}" placeholder="optional"></label>
      <label class="f wide">Whole pack g<input name="pack_g" type="number" step="any" min="0" value="${v.pack_g ?? ''}" placeholder="optional"></label>
    </div>
    ${p ? `<div class="product-photo">
      ${p.photo ? `<button type="button" class="thumb" data-photos="${esc(JSON.stringify([p.photo]))}" data-photoat="0" aria-label="Open label photo"><img src="${esc(p.photo)}" alt=""></button>` : '<span class="small">No label photo yet.</span>'}
      <label class="btn"><input type="file" accept="image/*" id="productPhoto" hidden>${p.photo ? 'Change photo' : 'Add label photo'}</label>
    </div>
    <p class="small" style="margin:0">${SOURCE_NAMES[p.source] || p.source}${p.added_by_name ? `, added by ${esc(p.added_by_name)}` : ''}. Used in ${p.uses} diary item${p.uses === 1 ? '' : 's'}; changing it here doesn’t change those.</p>` : ''}
    <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" value="cancel" formnovalidate>Cancel</button>
      ${p ? '<span class="spacer"></span><button class="btn danger" type="button" data-pdelete>Delete</button>' : ''}</div>
  </form>`, async (vals) => {
    if (p) await api(`/api/fooddb/${p.id}`, { method: 'PUT', body: vals });
    else await api('/api/fooddb', { method: 'POST', body: vals });
    toast(`Saved ${vals.name}`);
    await loadFoods();
  });
  const form = $('#dialog form');
  form.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-pdelete]') || !confirm(`Delete “${p.name}” from the food list? Diary items keep their numbers.`)) return;
    try {
      await api(`/api/fooddb/${p.id}`, { method: 'DELETE' });
      $('#dialog').close();
      toast('Deleted');
      await loadFoods();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#productPhoto', form)?.addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    try {
      const r = await api(`/api/fooddb/${p.id}/photo`, { method: 'POST', body: { image: await shrink(e.target.files[0]) } });
      p.photo = r.photo;
      toast('Photo saved');
      await loadFoods();
      editProduct(foodsState.products.find((x) => x.id === p.id) || p);
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function importFoods(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    return toast(`That isn’t valid JSON: ${err.message}`, 'error');
  }
  const body = Array.isArray(data) ? { foods: data } : data;
  let preview;
  try {
    preview = await api('/api/fooddb/import', { method: 'POST', body: { ...body, preview: true } });
  } catch (err) { return toast(err.message, 'error'); }
  const { summary, rows } = preview;
  const STATUS = { new: 'New', update: 'Updates', same: 'Already here', duplicate: 'Twice in file', error: 'Problem' };
  const shown = rows.filter((r) => r.status !== 'same').slice(0, 200);
  openDialog(`<h2>Import ${esc(file.name)}</h2><form>
    <div class="import-sum num">${Object.entries(STATUS).map(([k, l]) => `<div class="is-${k}"><b>${n(summary[k])}</b><span>${l}</span></div>`).join('')}</div>
    ${shown.length ? `<div class="import-rows"><table class="foods-table num"><thead><tr><th>#</th><th>Product</th><th>kcal</th><th>What happens</th></tr></thead><tbody>
      ${shown.map((r) => `<tr class="is-${r.status}"><td>${r.line}</td><th scope="row"><span class="fp-name">${esc(r.name || '(no name)')}</span>${r.brand ? `<span class="fp-brand">${esc(r.brand)}</span>` : ''}</th><td>${r.kcal != null ? n(r.kcal) : ''}</td>
        <td>${r.status === 'error' ? `Skipped: ${esc(r.error)}` : r.status === 'duplicate' ? `Skipped, same as line ${r.of}` : STATUS[r.status]}</td></tr>`).join('')}
    </tbody></table>${rows.filter((r) => r.status !== 'same').length > 200 ? '<p class="small">Showing the first 200.</p>' : ''}</div>` : ''}
    ${summary.update ? `<label class="check"><input type="checkbox" name="update" checked> Update the ${n(summary.update)} already in the list with this file’s values (blank fields leave theirs alone)</label>` : ''}
    <div class="actions"><button class="btn primary" type="submit" ${summary.new || summary.update ? '' : 'disabled'}>Import ${n(summary.new + summary.update)} product${summary.new + summary.update === 1 ? '' : 's'}</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async (v) => {
    const r = await api('/api/fooddb/import', { method: 'POST', body: { ...body, update: !!v.update || !summary.update } });
    toast(`Added ${n(r.summary.new)}, updated ${n(r.summary.update)}`);
    await loadFoods();
  });
}

/* ---------- Dashboard ---------- */

// UK adult reference intakes from food labels, used where you haven't set a goal of your own (fibre is the UK's 30 g advice)
const RI = { protein: 50, carbs: 260, sugars: 90, fat: 70, sat_fat: 20, fibre: 30, salt: 6 };
let stats = null;
let statsDate = null;
let statsPick = 'week';

function setView(v) {
  view = v;
  openChat(false);
  document.body.classList.toggle('view-stats', v !== 'diary');
  $('#app').hidden = v !== 'diary';
  $('#stats').hidden = v !== 'stats';
  $('#foodsView').hidden = v !== 'foods';
  const params = new URLSearchParams(location.search);
  if (v !== 'diary') params.set('view', v); else params.delete('view');
  history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
  renderViewTabs();
  if (v === 'stats') { statsDate = statsDate || state?.today; loadStats(); }
  else if (v === 'foods') loadFoods();
  else if (state) render();
}

const VIEWS = [['diary', 'Diary', 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6'],
  ['stats', 'Stats', 'M4 20V10M10 20V4M16 20v-7M22 20H2'], ['foods', 'Foods', 'M4 7h16M4 12h16M4 17h10']];

function renderViewTabs() {
  $('#viewTabs').innerHTML = VIEWS.map(([v, l]) => `<button class="vtab" data-view="${v}" aria-current="${view === v ? 'page' : 'false'}">${l}</button>`).join('');
  $('#tabBar').innerHTML = VIEWS.map(([v, l, icon]) => `<button class="tab" data-view="${v}" aria-current="${view === v ? 'page' : 'false'}">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${icon}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${l}</button>`).join('');
}

async function loadStats() {
  try {
    stats = await api(`/api/stats${statsDate ? `?date=${statsDate}` : ''}`);
    statsDate = stats.date;
    renderStats();
  } catch (err) {
    if (!document.body.classList.contains('signed-out')) toast(`Couldn’t load your stats: ${err.message}`, 'error');
  }
}

const goalFor = (k, s) => (k === 'kcal' ? s.daily_kcal : s[`${k}_g`] || RI[k]);
const ownGoal = (k, s) => k === 'kcal' || !!s[`${k}_g`];

function renderStats() {
  const { weeks, settings: st, today } = stats;
  const wk = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  const four = weeks.slice(-4).filter((w) => w.loggedDays);
  const fourAvg = four.length ? Math.round(four.reduce((s, w) => s + w.avg.kcal * w.loggedDays, 0) / four.reduce((s, w) => s + w.loggedDays, 0)) : null;
  const isThis = wk.days.some((d) => d.date === today);
  const end = wk.days[6].date;
  const label = isThis ? 'This week' : `Week of ${fmtDay(wk.start, { day: 'numeric', month: 'short' })}`;
  const day = wk.days.find((d) => d.date === (statsPick === 'week' ? null : statsPick));
  const values = day ? day.totals : wk.avg;
  const vs = (a) => (a == null ? '<span class="vs">–</span>' : `<span class="vs ${a > st.daily_kcal ? 'bad' : 'good'}">${a > st.daily_kcal ? `${n(a - st.daily_kcal)} over` : `${n(st.daily_kcal - a)} under`}</span>`);
  const history = weeks.filter((w) => w.loggedDays).length;
  const hasWeek = wk.loggedDays > 0;
  const loggedThisWeek = wk.days.filter((d) => d.logged).length;
  const range = `${fmtDay(wk.start, { day: 'numeric', month: 'short' })} to ${fmtDay(end, { day: 'numeric', month: 'short' })}`;

  $('#stats').innerHTML = `
    <header class="stats-head">
      <div><div class="eyebrow">${esc(stats.profile.name)}’s stats</div><h1>${label}</h1></div>
      <nav class="week-nav" aria-label="Week">
        <button class="icon-btn" data-sweek="-1" aria-label="Previous week">‹</button>
        <span class="num">${range}</span>
        <button class="icon-btn" data-sweek="1" aria-label="Next week" ${isThis ? 'disabled' : ''}>›</button>
      </nav>
    </header>

    <div class="sgrid">
      ${statsHero(wk, st, today, isThis)}
      <section class="panel s-card s-avg">
        <div class="eyebrow">Average a day</div>
        <div class="s-big num">${wk.loggedDays ? n(wk.avg.kcal) : '–'}<small>kcal</small></div>
        <ul class="s-rows num">
          <li><span>${isThis ? 'This week' : 'That week'}</span>${vs(wk.loggedDays ? wk.avg.kcal : null)}</li>
          <li><span>Week before, ${prev.avg.kcal != null ? n(prev.avg.kcal) : '–'}</span>${vs(prev.avg.kcal)}</li>
          <li><span>Four weeks, ${fourAvg != null ? n(fourAvg) : '–'}</span>${vs(fourAvg)}</li>
        </ul>
      </section>
      <section class="panel s-card s-streak">
        <div class="eyebrow">Logging</div>
        <div class="s-big num">${stats.streak}<small>day${stats.streak === 1 ? '' : 's'} in a row</small></div>
        <div class="s-dots" aria-label="${loggedThisWeek} of 7 days logged">${wk.days.map((d) => `<span class="${d.logged ? 'on' : ''}${d.future ? ' future' : ''}" title="${fmtDay(d.date, { weekday: 'long' })}">${fmtDay(d.date, { weekday: 'narrow' })}</span>`).join('')}</div>
        <div class="small num">${loggedThisWeek} of 7 days logged ${isThis ? 'this' : 'that'} week</div>
      </section>

      ${hasWeek ? `
      <section class="panel p-days">
        <div class="panel-head"><div><h2>Calories by day</h2><p class="lede">Tap a day to see its nutrients.</p></div></div>
        ${dayBars(wk, st)}
      </section>
      <section class="panel p-nutr" id="nutrients">
        <div class="panel-head"><h2>Nutrients</h2>
          <select id="nutPick" aria-label="Which day">${[['week', 'Week average'], ...wk.days.filter((d) => d.logged).map((d) => [d.date, fmtDay(d.date)])]
            .map(([v, l]) => `<option value="${v}"${v === statsPick ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        ${nutrientBars(values, st, day)}
        <h3 class="sub-h">Macros</h3>
        ${macroSplit(values)}
      </section>
      ${weightPanel(stats.weight, st)}
      <section class="panel p-foods">
        <h2>Biggest foods</h2>
        <p class="lede">Most calories ${isThis ? 'this' : 'that'} week.</p>
        <ul class="mini">${stats.topFoods.map((f) => `<li><span>${esc(f.name)}${f.times > 1 ? ` <span class="q">×${f.times}</span>` : ''}</span><span class="num">${n(f.kcal)}</span></li>`).join('')}</ul>
      </section>
      <section class="panel p-meals">
        <h2>Meals</h2>
        <p class="lede">Where ${isThis ? 'this' : 'that'} week’s calories came from.</p>
        ${mealSplit(stats.meals)}
      </section>
      ${goalsPanel(stats.weight, st)}
      <section class="panel p-weeks">
        <h2>Weekly averages</h2>
        <p class="lede">Average kcal on the days you logged.</p>
        ${history >= 2 ? weekAverages(weeks.slice(weeks.findIndex((w) => w.loggedDays)), st) : '<p class="small">Shows up once there’s more than one week logged.</p>'}
      </section>`
      : `<section class="panel p-empty"><h2>Nothing logged ${isThis ? 'this week yet' : 'that week'}</h2><p class="lede">${isThis ? 'Log something in the diary and it shows up here straight away.' : 'Try another week with the arrows above.'}</p></section>`}
    </div>`;
  $('#nutPick')?.addEventListener('change', (e) => { statsPick = e.target.value; renderStats(); });
  fitWeightChart();
}

// Drawn at the card's real width so the axis text stays 11px instead of scaling up with the viewBox
function fitWeightChart() {
  const box = $('#stats .wchart-box');
  const w = stats?.weight;
  const W = Math.round(box?.clientWidth || 0);
  if (!W || !w?.stats) return;
  box.innerHTML = weightChart(w.rows, stats.settings.goal_kg, w.stats, W, Math.round(Math.min(220, Math.max(160, W * 0.3))));
}
addEventListener('resize', fitWeightChart);

// The one number that matters: what's left today, with the week's budget beside it
function statsHero(wk, st, today, isThis) {
  const left = wk.budget - wk.used;
  const weekCard = `<section class="panel s-card s-week">
      <div class="eyebrow">${isThis ? 'This week' : 'That week'}</div>
      <div class="s-big num">${n(Math.abs(left))}<small>kcal ${left >= 0 ? 'left' : 'over'}</small></div>
      <div class="bar soft"><span style="width:${Math.min(100, (wk.used / wk.budget) * 100)}%"></span></div>
      <div class="small num">${n(wk.used)} of ${n(wk.budget)} for the week</div>
    </section>`;
  const d = isThis && wk.days.find((x) => x.date === today);
  if (!d) return weekCard;
  const rem = d.target - d.totals.kcal;
  return `<section class="panel s-card s-today${rem < 0 ? ' over' : ''}">
      <div class="eyebrow">${rem < 0 ? 'Over today by' : 'Left today'}${d.flex ? '<span class="flex-tag">Flex day</span>' : ''}</div>
      <div class="s-big num">${n(Math.abs(rem))}<small>kcal</small></div>
      <div class="equation num"><span><b>${n(d.target)}</b>Goal</span><i>−</i><span><b>${n(d.totals.kcal)}</b>Food</span><i>=</i><span class="${rem < 0 ? 'bad' : ''}"><b>${n(rem)}</b>Remaining</span></div>
    </section>
    ${weekCard}`;
}

function dayBars(wk, st) {
  const max = Math.max(...wk.days.map((d) => Math.max(d.totals.kcal, d.target))) * 1.08;
  return `<div class="weekbars big">${wk.days.map((d) => `<button class="wbar${d.date === statsPick ? ' sel' : ''}${d.flex ? ' flex' : ''}${d.logged ? '' : ' nolog'}" data-pickday="${d.date}" ${d.future || !d.logged ? 'disabled' : ''}
      title="${fmtDay(d.date, { weekday: 'long' })}: ${n(d.totals.kcal)} of ${n(d.target)} kcal · P ${g(d.totals.protein)} C ${g(d.totals.carbs)} F ${g(d.totals.fat)}">
      <div class="track"><div class="fill${d.totals.kcal > d.target ? ' over' : ''}" style="height:${(d.totals.kcal / max) * 100}%"></div><div class="target" style="bottom:${(d.target / max) * 100}%"></div></div>
      <div class="lbl num">${fmtDay(d.date, { weekday: 'narrow' })}<br>${d.logged ? n(d.totals.kcal) : '–'}</div>
    </button>`).join('')}</div>
    <div class="legend"><span><i></i>${n(st.daily_kcal)} target</span><span><i class="flex"></i>${n(st.flex_kcal)} flex day</span></div>`;
}

// The same numbers as bars, value against goal; reaching protein or fibre is good, passing a limit shows in red
function nutrientBars(v, st, day) {
  const rows = [['kcal', 'Calories', '', ' kcal'], ...NUTRIENTS.map(([k, l, sub]) => [k, l, sub, ' g'])];
  return `<div class="nbars">${rows.map(([k, label, sub, unit]) => {
    const goal = k === 'kcal' && day ? day.target : goalFor(k, st);
    const val = v[k];
    const reach = k === 'fibre' || k === 'protein';
    const mark = val == null ? '' : reach ? (val >= goal ? 'hit' : '') : val > goal ? 'over' : '';
    const f = (x) => (x == null ? '–' : k === 'kcal' ? n(x) : `${r1(x)}`);
    return `<div class="nbar${sub ? ' sub' : ''} ${mark}">
      <div class="mbar-top"><span>${label}${mark === 'hit' ? ' <span class="hit">✓</span>' : ''}</span><span class="num"><b>${f(val)}</b>/${f(goal)}${unit}${ownGoal(k, st) ? '' : '<sup>RI</sup>'}</span></div>
      <div class="mtrack"><span style="width:${val == null ? 0 : Math.min(100, (val / goal) * 100)}%"></span></div>
    </div>`;
  }).join('')}</div>
  <p class="small" style="margin:var(--s3) 0 0"><sup>RI</sup> UK reference intake from food labels. Set your own with Change goals.</p>`;
}

function macroSplit(v) {
  const parts = [['protein', 'Protein', 4], ['carbs', 'Carbs', 4], ['fat', 'Fat', 9]].map(([k, l, m]) => ({ k, l, kcal: (v[k] || 0) * m, g: v[k] || 0 }));
  const total = parts.reduce((s, p) => s + p.kcal, 0);
  if (!total) return '<p class="small">Nothing logged.</p>';
  return `<div class="split" role="img" aria-label="${parts.map((p) => `${p.l} ${Math.round((p.kcal / total) * 100)}%`).join(', ')}">
      ${parts.map((p) => `<span class="m-${p.k}" style="flex-grow:${p.kcal}" title="${p.l}: ${g(p.g)}, ${Math.round((p.kcal / total) * 100)}% of calories"></span>`).join('')}</div>
    <ul class="split-key num">${parts.map((p) => `<li><i class="m-${p.k}"></i>${p.l}<b>${Math.round((p.kcal / total) * 100)}%</b><span>${g(p.g)}</span></li>`).join('')}</ul>`;
}

function weekAverages(weeks, st) {
  const max = Math.max(st.daily_kcal, ...weeks.map((w) => w.avg.kcal || 0)) * 1.08;
  return `<div class="hbars">${weeks.map((w) => `<div class="hbar" title="Week of ${fmtDay(w.start, { day: 'numeric', month: 'short' })}: ${w.loggedDays ? `${n(w.avg.kcal)} kcal a day over ${w.loggedDays} days` : 'nothing logged'}">
      <span class="small num">${fmtDay(w.start, { day: 'numeric', month: 'short' })}</span>
      <div class="htrack"><div class="hfill${w.avg.kcal > st.daily_kcal ? ' over' : ''}" style="width:${((w.avg.kcal || 0) / max) * 100}%"></div><div class="htarget" style="left:${(st.daily_kcal / max) * 100}%"></div></div>
      <b class="num">${w.loggedDays ? n(w.avg.kcal) : '–'}</b>
    </div>`).join('')}</div>
    <details class="wlist"><summary>As a table</summary><table class="nutr wide num"><thead><tr><th>Week of</th><th>kcal</th><th>Protein</th><th>Fibre</th><th>Days</th></tr></thead><tbody>
      ${weeks.slice().reverse().map((w) => `<tr><th scope="row">${fmtDay(w.start, { day: 'numeric', month: 'short' })}</th><td>${w.loggedDays ? n(w.avg.kcal) : '–'}</td><td>${w.loggedDays ? g(w.avg.protein) : '–'}</td><td>${w.loggedDays ? g(w.avg.fibre) : '–'}</td><td>${w.loggedDays}</td></tr>`).join('')}
    </tbody></table></details>`;
}

function mealSplit(meals) {
  const total = Object.values(meals).reduce((s, x) => s + x, 0);
  if (!total) return '<p class="small">Nothing logged.</p>';
  return `<div class="hbars">${MEALS.map((m) => `<div class="hbar"><span class="small">${MEAL_NAMES[m]}</span>
    <div class="htrack"><div class="hfill" style="width:${(meals[m] / total) * 100}%"></div></div><b class="num">${Math.round((meals[m] / total) * 100)}%</b></div>`).join('')}</div>`;
}

function goalsPanel(weight, st) {
  const ws = weight.stats;
  return `<section class="panel p-goals">
    <h2>Goals</h2>
    <ul class="mini">
      <li><span>Daily calories</span><span class="num">${n(st.daily_kcal)} kcal, one ${n(st.flex_kcal)} day a week</span></li>
      ${NUTRIENTS.filter(([k]) => st[`${k}_g`]).map(([k, l]) => `<li><span>${l}</span><span class="num">${r1(st[`${k}_g`])} g a day</span></li>`).join('')
        || '<li><span>Nutrients</span><span class="num">label reference intakes</span></li>'}
      <li><span>Weight</span><span class="num">${st.goal_kg ? `${st.goal_kg} kg${ws?.toGo != null ? `, ${ws.toGo.toFixed(1)} kg to go` : ''}` : 'not set'}</span></li>
      ${ws?.ratePerWeek != null ? `<li><span>Losing</span><span class="num">${ws.ratePerWeek.toFixed(1)} kg a week${ws.projectedDate ? `, goal around ${parseDate(ws.projectedDate).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}` : ''}</span></li>` : ''}
    </ul>
    <div class="actions" style="margin-top:var(--s3)"><button class="btn" data-opensettings>Change goals</button></div>
  </section>`;
}

/* ---------- Where the numbers came from ---------- */

const modelName = (m) => (m ? m.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, f, a, b) => `Claude ${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`) : 'The AI');

function originText(e) {
  const msg = e.message_id && state.day.messages.find((m) => m.id === e.message_id);
  const who = modelName(msg?.model);
  const from = msg?.images?.length ? `your photo${msg.images.length > 1 ? 's' : ''}` : 'what you typed';
  if (e.source === 'label') return !msg ? 'Taken from a nutrition label.'
    : msg.images.length ? `${who} read the nutrition label in ${from} and scaled it to the amount you had.`
    : `${who} used the label figures for it, scaled to the amount you had.`;
  if (e.source === 'saved') return msg ? `${who} matched it to one of your saved foods and scaled that to the amount you had.` : `${esc(e.origin || 'One of your saved foods')}, scaled to the amount by Plateful.`;
  if (e.source === 'db' && e.origin?.startsWith('Matched by Plateful')) return `${esc(e.origin)}. Its per 100 g figures were scaled to the amount you typed, on your server, costing no tokens.`;
  if (e.source === 'db') return `${e.product_name ? `“${esc(`${e.product_brand ? `${e.product_brand} ` : ''}${e.product_name}`)}” from` : 'A product in'} the household food list (Open Food Facts or a label someone photographed), per 100 g scaled by Plateful to the grams you had.`;
  if (e.source === 'est.' && !msg) return 'An estimate using typical UK values.';
  if (e.source === 'est.') return `${who} estimated it from ${from}, using typical UK values (supermarket own-brand and McCance and Widdowson style figures). A good guess rather than a measurement.`;
  if (e.source === 'manual') return 'You typed these numbers in yourself.';
  if (e.source === 'preset') return `Added from your preset meal ${e.origin ? `“${esc(e.origin.replace(/^Preset: /, ''))}”` : ''}, with the numbers saved in it.`;
  if (e.source === 'copied') return `${esc(e.origin || 'Copied from another log')}.`;
  return 'Not recorded.';
}

function conversionText(e) {
  const u = UNITS[e.unit];
  if (!u || !(e.amount > 0)) return e.quantity ? `Logged as “${esc(e.quantity)}” before Plateful knew about units, so there’s no weight on record.` : 'No amount recorded.';
  const grams = e.grams ?? toGrams(e.amount, e.unit, e);
  if (u.kind === 'weight') return e.unit === 'g' ? `${n(grams)} g.` : `${esc(e.quantity)} is ${r1(grams)} g (1 ${u.label} = ${u.g} g).`;
  if (u.kind === 'volume') {
    const ml = e.amount * u.ml;
    const d = e.density || grams / ml;
    return `${esc(e.quantity)} is ${n(ml)} ml${u.ml !== 1 ? ` (1 ${u.label} = ${r1(u.ml)} ml)` : ''}, which weighs about ${n(grams)} g`
      + (Math.abs(d - 1) < 0.005 ? ', taking it to weigh the same as water.' : ` at ${d.toFixed(2)} g per ml.`);
  }
  if (grams == null) return `${esc(e.quantity)}, with no weight on record.`;
  return `${esc(e.quantity)}, about ${n(grams)} g in all (${r1(grams / e.amount)} g each${e.message_id && !e.edited_at ? ', the AI’s estimate' : ''}).`;
}

function infoDialog(e) {
  const msg = e.message_id && state.day.messages.find((m) => m.id === e.message_id);
  const grams = e.grams ?? (UNITS[e.unit] && e.amount > 0 && UNITS[e.unit].kind !== 'count' ? toGrams(e.amount, e.unit, e) : null);
  const per100 = grams > 0 ? (x) => r1((x / grams) * 100) : null;
  const sent = msg && `${msg.images.length ? `${msg.images.length} photo${msg.images.length > 1 ? 's' : ''}` : ''}${msg.images.length && msg.text ? ' and ' : ''}${msg.text ? `“${esc(msg.text.length > 140 ? `${msg.text.slice(0, 140)}…` : msg.text)}”` : ''}`;
  openDialog(`<h2>${esc(e.name)}</h2><form class="info">
    <dl class="info-list">
      <dt>Numbers from</dt><dd>${originText(e)}</dd>
      ${sent ? `<dt>You sent</dt><dd>${sent}</dd>` : ''}
      ${e.edited_at ? `<dt>Changed</dt><dd>You edited the amount or numbers by hand on ${new Date(e.edited_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</dd>` : ''}
      <dt>Amount</dt><dd class="num">${conversionText(e)}</dd>
      ${per100 ? `<dt>Per 100 g</dt><dd class="num">${n(per100(e.kcal))} kcal · P ${per100(e.protein)} g · C ${per100(e.carbs)} g · F ${per100(e.fat)} g</dd>` : ''}
      <dt>Worked out by</dt><dd>Plateful itself: totals, targets, the week and every unit conversion are sums on your server, so they cost no tokens.</dd>
    </dl>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><span class="spacer"></span><button class="link-btn" type="button" data-explain>How Plateful works out numbers</button></div>
  </form>`, async () => {});
}

function explainDialog() {
  const spoon = (k) => `${UNITS[k].label} ${r1(UNITS[k].ml)} ml`;
  openDialog(`<h2>Where the numbers come from</h2><form class="info">
    <div class="explain">
      <h3>An AI reads what you send</h3>
      <p>Only messages you send cost tokens. ${(() => {
        const ai = state.server.ai;
        const mode = state.settings.model_mode;
        if (ai.problem) return `${esc(ai.label)} isn’t set up yet, so nothing reads your messages`;
        if (mode === 'sonnet' || ai.text === ai.photo) return `${esc(modelName(ai.photo))} (through ${esc(ai.label)}) reads everything you send`;
        if (mode === 'haiku') return `${esc(modelName(ai.text))} (through ${esc(ai.label)}) reads everything you send`;
        return `${esc(modelName(ai.text))} reads what you type and ${esc(modelName(ai.photo))} reads anything with a photo, through ${esc(ai.label)}`;
      })()} (change it in Settings). In order of preference it uses a nutrition label it can see, then one of your saved foods, then typical UK values for a realistic portion. Each item is tagged: <span class="src label">from label</span>, <span class="src label">saved food</span>, <span class="src label">food list</span> or <span class="src">estimate</span>.</p>
      <h3>The food list</h3>
      <p>When the AI names a branded product, Plateful looks it up: first in the foods your household already has, then by barcode or name on Open Food Facts, a free crowd-sourced database with a lot of UK supermarket own-brand products. A match swaps the estimate for the product’s real per 100 g figures. Supermarkets don’t publish their own data, so some products won’t be there; those are marked <span class="src need">needs label</span>, and one photo of the label puts them on the list for good.</p>
      <h3>Plateful does the rest</h3>
      <p>Everything else is worked out on your server with no tokens: daily and weekly totals, the flex day, macros, the weight trend and goal date, suggestions, presets, copying, and all unit conversions. Presets and copies carry the numbers they were saved with, and the (i) on each item shows where they first came from.</p>
      <h3>Units</h3>
      <p>Weights are exact (1 oz = 28.35 g, 1 lb = 453.6 g). Spoons and cups are UK metric: ${['tsp', 'dsp', 'tbsp', 'cup'].map(spoon).join(', ')}; a US cup is 236.6 ml. A UK pint is 568 ml and a UK fl oz 28.4 ml; the US ones are marked. Volumes are turned into grams using how heavy that food is per ml (the AI’s figure, or water if there isn’t one), and slices, handfuls and the like using a weight for one of them. You can correct the grams on any item and everything rescales.</p>
      <h3>How far to trust it</h3>
      <p>A label is as good as the label. An estimate from a photo of a plate can be out a fair way, mostly on portion size. Weighing it and typing the grams beats both.</p>
    </div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button></div>
  </form>`, async () => {});
}

/* ---------- Presets and copying ---------- */

const itemsList = (items) => `<ul class="mini">${items.map((i) => `<li><span>${esc(i.name)}${i.quantity ? ` <span class="q">${esc(i.quantity)}</span>` : ''}</span><span class="num">${n(i.kcal)}</span></li>`).join('')}</ul>`;
const mealSelect = (selected, extra = '') => `<select name="meal">${extra}${MEALS.map((m) => `<option value="${m}"${m === selected ? ' selected' : ''}>${MEAL_NAMES[m]}</option>`).join('')}</select>`;

function addSuggestion(s, meal = s.meal) {
  openDialog(`<h2>${esc(s.name)}</h2><form>
    <p class="small" style="margin:0">${s.kind === 'habit' ? `You’ve had this for ${MEAL_NAMES[s.meal].toLowerCase()} ${s.count} times in the last month.` : 'Preset meal.'}</p>
    ${itemsList(s.items)}
    <div class="grid"><label class="f full">Add to${mealSelect(meal)}</label></div>
    <div class="actions"><button class="btn primary" type="submit">Add ${n(s.kcal)} kcal</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ meal }) => {
    const r = s.kind === 'preset' ? await api(`/api/presets/${s.id}/add`, { method: 'POST', body: { date, meal } })
      : await api('/api/entries/copy', { method: 'POST', body: { ids: s.ids, date, meal } });
    lastAdd = { ids: r.ids, text: `Added ${s.name} to ${MEAL_NAMES[meal]}` };
    await load();
  });
}

function savePreset(meal, rows = state.day.entries.filter((e) => e.meal === meal), title = `Save ${MEAL_NAMES[meal].toLowerCase()} as a preset`) {
  const guess = rows.length > 2 ? `${rows[0].name} and more` : rows.map((e) => e.name).join(' & ');
  openDialog(`<h2>${title}</h2><form>
    ${itemsList(rows)}
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(guess.slice(0, 60))}" maxlength="60" required></label>
      <label class="f full">Usually eaten at${mealSelect(meal)}</label>
    </div>
    <label class="check"><input type="checkbox" name="shared" ${people.length ? '' : 'disabled'}> Share with ${people.length ? people.map((p) => esc(p.name)).join(' and ') : 'everyone'}</label>
    <div class="actions"><button class="btn primary" type="submit">Save preset</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async (v) => {
    await api('/api/presets', { method: 'POST', body: { name: v.name, meal: v.meal, shared: !!v.shared, entry_ids: rows.map((e) => e.id) } });
    selected.clear();
    toast(`Saved ${v.name}`);
    await load();
  });
}

function presetsDialog() {
  const list = presets.presets;
  openDialog(`<h2>Preset meals</h2><form>
    ${list.length ? `<ul class="presetlist">${list.map((p) => `<li>
        <div><div>${esc(p.name)}${p.shared ? ' <span class="tag">shared</span>' : ''}</div>
          <div class="meta num">${MEAL_NAMES[p.meal]} · ${n(p.kcal)} kcal · ${p.items.length} item${p.items.length > 1 ? 's' : ''}</div></div>
        <div class="row-actions"><button class="btn" type="button" data-usepreset="${p.id}">Add</button><button class="link-btn" type="button" data-editpreset="${p.id}">Edit</button></div>
      </li>`).join('')}</ul>`
      : '<p class="small" style="margin:0">No presets yet. Log a meal you have often, then tap “Save as preset” next to it.</p>'}
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button></div>
  </form>`, async () => {});
}

const presetItemRow = (i = {}) => `<div class="pi-row">
  <label class="f pi-name">Item<input data-k="name" value="${esc(i.name ?? '')}" required></label>
  <input type="hidden" data-k="quantity" value="${esc(i.quantity ?? '')}">
  ${amountHtml(i.name ? i : { amount: 1, unit: 'portion' })}
  ${macroInputs(i, 'data-k')}
  <button class="icon-btn pi-del" type="button" data-pidel aria-label="Remove item">✕</button>
</div>`;

function editPreset(p) {
  const mineToUnshare = !p.shared || p.created_by === state.profile.id;
  openDialog(`<h2>Edit preset</h2><form class="preset-edit">
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(p.name)}" maxlength="60" required></label>
      <label class="f full">Usually eaten at${mealSelect(p.meal)}</label>
    </div>
    <label class="check"><input type="checkbox" name="shared" ${p.shared ? 'checked' : ''} ${(people.length && mineToUnshare) ? '' : 'disabled'}>
      Share with ${people.length ? people.map((x) => esc(x.name)).join(' and ') : 'everyone'}${p.shared && !mineToUnshare ? ` (shared by ${esc(p.created_by_name || 'someone else')})` : ''}</label>
    <div class="pi-list">${p.items.map(presetItemRow).join('')}</div>
    <div class="actions"><button class="btn" type="button" data-piadd>+ Add item</button><span class="spacer"></span><span class="pi-total num"></span></div>
    <div class="actions">
      <button class="btn primary" type="submit">Save</button><button class="btn" value="cancel" formnovalidate>Cancel</button>
      <span class="spacer"></span><button class="btn danger" type="button" data-pidelete>Delete preset</button>
    </div>
  </form>`, async (v, form) => {
    const items = [...form.querySelectorAll('.pi-row')].map((row) => ({
      ...Object.fromEntries([...row.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value])), ...readAmount($('.amt', row)),
    }));
    // A disabled checkbox isn't submitted, so keep a preset shared when this person can't unshare it
    const shared = form.elements.shared.disabled ? p.shared : form.elements.shared.checked;
    await api(`/api/presets/${p.id}`, { method: 'PUT', body: { name: v.name, meal: v.meal, shared, items } });
    toast(`Saved ${v.name}`);
    await load();
  });
  const form = $('#dialog form');
  const total = () => {
    const kcal = [...form.querySelectorAll('[data-k="kcal"]')].reduce((s, i) => s + (Number(i.value) || 0), 0);
    $('.pi-total', form).textContent = `${n(kcal)} kcal`;
  };
  form.addEventListener('input', total);
  form.addEventListener('rescaled', total);
  form.addEventListener('click', async (e) => {
    if (e.target.closest('[data-pidel]')) { e.target.closest('.pi-row').remove(); total(); }
    else if (e.target.closest('[data-piadd]')) { $('.pi-list', form).insertAdjacentHTML('beforeend', presetItemRow()); $('.pi-row:last-child input', form).focus(); }
    else if (e.target.closest('[data-pidelete]') && confirm(`Delete “${p.name}”${p.shared ? ' for everyone' : ''}?`)) {
      try {
        await api(`/api/presets/${p.id}`, { method: 'DELETE' });
        $('#dialog').close();
        toast('Preset deleted');
        await load();
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  total();
}

async function copyDialog(personId, meal = null) {
  const person = people.find((p) => p.id === personId);
  let from = date;
  openDialog(`<h2>Copy from ${esc(person.name)}</h2><form>
    <div class="copy-nav"><button class="icon-btn" type="button" data-cd="-1" aria-label="Previous day">‹</button><span class="cd-label"></span><button class="icon-btn" type="button" data-cd="1" aria-label="Next day">›</button></div>
    <div class="copy-list"><div class="skeleton" style="height:80px"></div></div>
    <div class="grid"><label class="f full">Put it in my${mealSelect(meal, `<option value=""${meal ? '' : ' selected'}>Same meals as theirs</option>`)}</label></div>
    <div class="actions"><button class="btn primary" type="submit" disabled>Copy</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async (v, form) => {
    const ids = [...form.querySelectorAll('input[name="id"]:checked')].map((c) => Number(c.value));
    if (!ids.length) throw new Error('Tick something to copy.');
    const r = await api('/api/entries/copy', { method: 'POST', body: { ids, date, meal: v.meal || null } });
    lastAdd = { ids: r.ids, text: `Copied ${r.added} item${r.added > 1 ? 's' : ''} from ${person.name}` };
    await load();
  });
  const dlg = $('#dialog');
  const btn = $('button.primary', dlg);
  const count = () => {
    const k = dlg.querySelectorAll('input[name="id"]:checked').length;
    btn.disabled = !k;
    btn.textContent = k ? `Copy ${k} item${k > 1 ? 's' : ''} to ${date === state.today ? 'today' : fmtDay(date)}` : 'Copy';
  };
  const show = async () => {
    $('.cd-label', dlg).textContent = from === state.today ? 'Today' : fmtDay(from, { weekday: 'long', day: 'numeric', month: 'short' });
    $('[data-cd="1"]', dlg).disabled = from >= state.today;
    const { entries } = await api(`/api/people/${personId}/day?date=${from}`);
    $('.copy-list', dlg).innerHTML = entries.length
      ? `<label class="check all"><input type="checkbox" data-all> Whole day · <span class="num">${n(entries.reduce((s, e) => s + e.kcal, 0))} kcal</span></label>`
        + MEALS.filter((m) => entries.some((e) => e.meal === m)).map((m) => `<fieldset>
          <legend><label class="check"><input type="checkbox" data-mealall="${m}"> ${MEAL_NAMES[m]}</label></legend>
          ${entries.filter((e) => e.meal === m).map((e) => `<label class="check item-check"><input type="checkbox" name="id" value="${e.id}" data-meal="${m}">
            <span>${esc(e.name)}${e.quantity ? ` <span class="q">${esc(e.quantity)}</span>` : ''}</span><span class="num">${n(e.kcal)}</span></label>`).join('')}
        </fieldset>`).join('')
      : `<p class="small">${esc(person.name)} hasn’t logged anything that day.</p>`;
    count();
  };
  // Listeners go on the form, which is replaced with the next dialog, so they don't pile up
  const form = $('form', dlg);
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cd]');
    if (b) { from = addDays(from, Number(b.dataset.cd)); show(); }
  });
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.all !== undefined) dlg.querySelectorAll('input[name="id"], [data-mealall]').forEach((c) => { c.checked = t.checked; });
    else if (t.dataset.mealall) dlg.querySelectorAll(`input[data-meal="${t.dataset.mealall}"]`).forEach((c) => { c.checked = t.checked; });
    count();
  });
  show().catch((err) => toast(err.message, 'error'));
}

/* ---------- Photo viewer ----------
   Full screen. Swipe or arrow keys between photos; pinch, scroll wheel or double-tap to zoom;
   drag to look around a zoomed photo; tap, ✕ or Esc to close. */

const viewer = { photos: [], at: 0, scale: 1, x: 0, y: 0, pointers: new Map(), start: null, lastTap: 0, tapTimer: null };

function openViewer(photos, at) {
  Object.assign(viewer, { photos, at });
  const el = $('#viewer');
  el.hidden = false;
  document.body.classList.add('viewing');
  showPhoto();
  $('.v-close', el).focus();
}

function closeViewer() {
  $('#viewer').hidden = true;
  document.body.classList.remove('viewing');
  viewer.pointers.clear();
}

function showPhoto() {
  const el = $('#viewer');
  Object.assign(viewer, { scale: 1, x: 0, y: 0 });
  $('.v-img', el).src = viewer.photos[viewer.at];
  $('.v-count', el).textContent = viewer.photos.length > 1 ? `${viewer.at + 1} of ${viewer.photos.length}` : '';
  $('.v-prev', el).hidden = viewer.at === 0;
  $('.v-next', el).hidden = viewer.at >= viewer.photos.length - 1;
  applyZoom();
}

function step(k) {
  const at = viewer.at + k;
  if (at < 0 || at >= viewer.photos.length) return applyZoom();
  viewer.at = at;
  showPhoto();
}

function applyZoom(animate = true) {
  const img = $('#viewer .v-img');
  // Keep a zoomed photo from being dragged off the screen
  const maxX = ((viewer.scale - 1) * img.clientWidth) / 2;
  const maxY = ((viewer.scale - 1) * img.clientHeight) / 2;
  viewer.x = Math.max(-maxX, Math.min(maxX, viewer.x));
  viewer.y = Math.max(-maxY, Math.min(maxY, viewer.y));
  img.style.transition = animate ? 'transform .2s ease' : 'none';
  img.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`;
}

function zoomTo(scale, cx = innerWidth / 2, cy = innerHeight / 2, animate = true) {
  const next = Math.max(1, Math.min(5, scale));
  // Zoom around the point under the finger or cursor
  const k = next / viewer.scale;
  viewer.x = (viewer.x - (cx - innerWidth / 2)) * k + (cx - innerWidth / 2);
  viewer.y = (viewer.y - (cy - innerHeight / 2)) * k + (cy - innerHeight / 2);
  viewer.scale = next;
  if (next === 1) Object.assign(viewer, { x: 0, y: 0 });
  applyZoom(animate);
}

{
  const stage = $('#viewer .v-stage');
  const dist = () => { const [a, b] = [...viewer.pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...viewer.pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    viewer.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewer.start = viewer.pointers.size === 2
      ? { pinch: dist(), scale: viewer.scale, moved: true }
      : { x: e.clientX, y: e.clientY, vx: viewer.x, vy: viewer.y, moved: false, t: Date.now() };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!viewer.pointers.has(e.pointerId) || !viewer.start) return;
    viewer.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = viewer.start;
    if (viewer.pointers.size === 2 && s.pinch) {
      const m = mid();
      zoomTo((s.scale * dist()) / s.pinch, m.x, m.y, false);
      return;
    }
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.hypot(dx, dy) > 8) s.moved = true;
    const img = $('#viewer .v-img');
    if (viewer.scale > 1) { viewer.x = s.vx + dx; viewer.y = s.vy + dy; applyZoom(false); }
    else { img.style.transition = 'none'; img.style.transform = `translateX(${dx}px)`; }
  });
  const end = (e) => {
    if (!viewer.pointers.has(e.pointerId)) return;
    viewer.pointers.delete(e.pointerId);
    const s = viewer.start;
    if (!s || viewer.pointers.size) { if (viewer.pointers.size === 1) { const [p] = [...viewer.pointers.values()]; viewer.start = { x: p.x, y: p.y, vx: viewer.x, vy: viewer.y, moved: true }; } return; }
    viewer.start = null;
    if (s.pinch) return;
    const dx = e.clientX - s.x;
    if (viewer.scale === 1 && s.moved) return Math.abs(dx) > 60 ? step(dx < 0 ? 1 : -1) : applyZoom();
    if (s.moved) return;
    // A double tap zooms in or out; a single tap closes (after a short wait to tell the two apart)
    const now = Date.now();
    if (now - viewer.lastTap < 300) {
      clearTimeout(viewer.tapTimer);
      viewer.lastTap = 0;
      zoomTo(viewer.scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
    } else {
      viewer.lastTap = now;
      viewer.tapTimer = setTimeout(() => { if (viewer.scale === 1) closeViewer(); }, 300);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(viewer.scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY, false); }, { passive: false });
  $('#viewer .v-close').addEventListener('click', closeViewer);
  $('#viewer .v-prev').addEventListener('click', () => step(-1));
  $('#viewer .v-next').addEventListener('click', () => step(1));
  document.addEventListener('keydown', (e) => {
    if ($('#viewer').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === '+' || e.key === '=') zoomTo(viewer.scale * 1.5);
    else if (e.key === '-') zoomTo(viewer.scale / 1.5);
  });
}

/* ---------- Multi-select ---------- */

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderSelection();
}

function clearSelection() {
  selected.clear();
  renderSelection();
}

function renderSelection() {
  const rows = state ? state.day.entries.filter((e) => selected.has(e.id)) : [];
  if (selected.size !== rows.length) { selected.clear(); rows.length = 0; } // the day changed underneath
  document.body.classList.toggle('selecting', rows.length > 0);
  $('#selectbar').hidden = !rows.length;
  $('#selCount').textContent = `${rows.length} picked · ${n(rows.reduce((s, e) => s + e.kcal, 0))} kcal`;
  renderMeals();
}

function saveSelection() {
  const rows = state.day.entries.filter((e) => selected.has(e.id));
  const counts = MEALS.map((m) => rows.filter((e) => e.meal === m).length);
  const meal = MEALS[counts.indexOf(Math.max(...counts))];
  savePreset(meal, rows, `Save ${rows.length} item${rows.length > 1 ? 's' : ''} as a meal`);
}

// Press and hold an item, then either let go to pick it (multi-select) or move to drag it to another
// meal. Dragging a picked item takes every picked item with it. Right-click also picks.
// The click that follows a hold is swallowed.
let pressTimer = null;
let pressedAt = null;
let swallowClick = false;
const drag = { armed: null, active: false, ids: [], ghost: null, over: null };

document.addEventListener('pointerdown', (e) => {
  swallowClick = false; // a long press re-renders the list, so its own click may never arrive to clear this
  const row = e.target.closest('.item-row');
  if (!row || e.button !== 0) return;
  pressedAt = { x: e.clientX, y: e.clientY };
  pressTimer = setTimeout(() => {
    pressTimer = null;
    swallowClick = true;
    navigator.vibrate?.(15);
    drag.armed = row;
    row.closest('.item').classList.add('lifted');
  }, 400);
});

function startDrag(row, e) {
  const id = Number(row.dataset.edit);
  drag.active = true;
  drag.ids = selected.has(id) ? [...selected] : [id];
  const entries = state.day.entries.filter((x) => drag.ids.includes(x.id));
  drag.ghost = document.createElement('div');
  drag.ghost.className = 'drag-ghost';
  drag.ghost.innerHTML = entries.length > 1
    ? `<b>${entries.length} items</b><span class="num">${n(entries.reduce((s, x) => s + x.kcal, 0))}</span>`
    : `<b>${esc(entries[0].name)}</b><span class="num">${n(entries[0].kcal)}</span>`;
  document.body.append(drag.ghost);
  // Every meal is a target, even ones with nothing in them yet
  const from = new Set(entries.map((x) => x.meal));
  $('#droptray').innerHTML = MEALS.map((m) => `<div class="drop" data-drop="${m}"${from.size === 1 && from.has(m) ? ' data-same' : ''}>${MEAL_NAMES[m]}</div>`).join('');
  $('#droptray').hidden = false;
  document.body.classList.add('dragging');
  moveDrag(e);
}

function moveDrag(e) {
  drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY - 20}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const target = under?.closest('[data-drop]')?.dataset.drop || under?.closest('section.meal')?.dataset.meal || null;
  if (target === drag.over) return;
  drag.over = target;
  document.querySelectorAll('.drop-on').forEach((el) => el.classList.remove('drop-on'));
  if (target) document.querySelectorAll(`[data-drop="${target}"], section.meal[data-meal="${target}"]`).forEach((el) => el.classList.add('drop-on'));
}

async function endDrag() {
  const { ids, over } = drag;
  drag.ghost?.remove();
  Object.assign(drag, { active: false, ghost: null, over: null, ids: [] });
  $('#droptray').hidden = true;
  document.body.classList.remove('dragging');
  const moving = state.day.entries.filter((x) => ids.includes(x.id) && x.meal !== over);
  if (!over || !moving.length) return renderMeals();
  try {
    await Promise.all(moving.map((x) => api(`/api/entries/${x.id}`, { method: 'PATCH', body: { meal: over } })));
    selected.clear();
    toast(`Moved ${moving.length > 1 ? `${moving.length} items` : moving[0].name} to ${MEAL_NAMES[over].toLowerCase()}`);
  } catch (err) {
    toast(err.message, 'error');
  }
  await load();
}

const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
document.addEventListener('pointerup', (e) => {
  cancelPress();
  if (drag.active) return endDrag();
  if (drag.armed) {
    // Held and let go without moving: pick it, as before
    const row = drag.armed;
    drag.armed = null;
    row.closest('.item')?.classList.remove('lifted');
    if (e.target.closest('.item-row') === row || row.contains(e.target)) toggleSelect(Number(row.dataset.edit));
    else renderMeals();
  }
});
document.addEventListener('pointercancel', () => {
  cancelPress();
  if (drag.active) { drag.over = null; endDrag(); }
  if (drag.armed) { drag.armed.closest('.item')?.classList.remove('lifted'); drag.armed = null; }
});
document.addEventListener('pointermove', (e) => {
  if (pressTimer && pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 10) cancelPress();
  if (drag.armed && !drag.active && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 8) {
    const row = drag.armed;
    drag.armed = null;
    row.closest('.item')?.classList.remove('lifted');
    startDrag(row, e);
  } else if (drag.active) moveDrag(e);
});
// Once an item is held, a finger moving should drag it rather than scroll the page
document.addEventListener('touchmove', (e) => { if (drag.armed || drag.active) e.preventDefault(); }, { passive: false });
document.addEventListener('click', (e) => {
  if (swallowClick && e.target.closest('.item-row')) { e.stopImmediatePropagation(); e.preventDefault(); }
  swallowClick = false;
}, true);
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.item-row');
  if (!row) return;
  e.preventDefault();
  if (!swallowClick) toggleSelect(Number(row.dataset.edit));
});
$('#selCancel').addEventListener('click', clearSelection);
$('#selSave').addEventListener('click', saveSelection);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected.size && !$('#dialog').open && $('#viewer').hidden) clearSelection(); });

/* ---------- Profiles ---------- */

let gateProfiles = [];

async function showGate() {
  document.body.classList.add('signed-out');
  $('#dialog').open && $('#dialog').close();
  const gate = $('#gate');
  gate.hidden = false;
  const res = await fetch('/api/profiles');
  if (res.status === 401) return houseForm();
  gateProfiles = await res.json();
  gate.innerHTML = '<div class="gate-inner"></div>';
  if (!gateProfiles.length) return newPersonForm(true);
  gate.innerHTML = `<div class="gate-inner">
    <div class="brand big-brand">Plateful</div>
    <h1>Who’s logging?</h1>
    <div class="people">${gateProfiles.map((p) => `<button class="person" data-person="${p.id}"><span class="avatar lg">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}</button>`).join('')}
      <button class="person add" data-addperson><span class="avatar lg">+</span>Add someone</button></div>
  </div>`;
}

function pinForm(p) {
  $('#gate .gate-inner').innerHTML = `<div class="brand big-brand">Plateful</div>
    <span class="avatar lg">${esc(p.name[0].toUpperCase())}</span>
    <h1>${p.hasPin ? `Hi ${esc(p.name)}` : `Set a PIN, ${esc(p.name)}`}</h1>
    <form class="pin-form" id="pinForm" data-id="${p.id}">
      <label class="f">${p.hasPin ? 'PIN' : 'Choose a PIN (4 to 8 digits)'}
        <input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" autocomplete="${p.hasPin ? 'current-password' : 'new-password'}" required autofocus></label>
      <div class="actions"><button class="btn primary" type="submit">${p.hasPin ? 'Open diary' : 'Save PIN and open'}</button><button class="btn" type="button" data-back>Back</button></div>
    </form>`;
  $('#pinForm input').focus();
}

// Only shown when the server has PLATEFUL_PASSWORD set, before anything else
function houseForm() {
  $('#gate').innerHTML = `<div class="gate-inner"><div class="brand big-brand">Plateful</div>
    <h1>Household password</h1>
    <form class="pin-form" id="houseForm">
      <label class="f">Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <p class="small" style="margin:0">Whoever set up this Plateful has the password. Each device only needs it once.</p>
      <div class="actions"><button class="btn primary" type="submit">Unlock</button></div>
    </form></div>`;
  $('#houseForm input').focus();
}

function newPersonForm(first = false) {
  $('#gate .gate-inner').innerHTML = `<div class="brand big-brand">Plateful</div>
    <h1>${first ? 'Welcome. Who’s first?' : 'Add someone'}</h1>
    ${first ? '<p class="small gate-lede">Plateful keeps a food diary for each person in the house. Set yourself up here; anyone else can add themselves from the start screen later.</p>' : ''}
    <form class="pin-form wide" id="newPerson">
      <div class="grid">
        <label class="f full">Name<input name="name" required maxlength="40" autofocus></label>
        <label class="f wide">PIN (4 to 8 digits)<input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" autocomplete="new-password" required></label>
        <label class="f wide">Daily kcal<input name="daily_kcal" type="number" min="800" max="6000" value="2000" required></label>
        <label class="f wide">Weight now kg<input name="start_kg" type="number" step="0.1" min="30" max="400" placeholder="optional"></label>
        <label class="f wide">Goal weight kg<input name="goal_kg" type="number" step="0.1" min="30" max="300" placeholder="optional"></label>
        <label class="f full">One bigger day a week, kcal<input name="flex_kcal" type="number" min="800" max="6000" value="2300" required></label>
      </div>
      <p class="small" style="margin:0">Targets, weigh-ins and saved foods are separate for each person. All of it can be changed later in Settings. 16 st is 101.6 kg.</p>
      <div class="actions"><button class="btn primary" type="submit">Create and open</button>${first ? '' : '<button class="btn" type="button" data-back>Back</button>'}</div>
    </form>`;
  $('#newPerson input').focus();
}

async function signedIn() {
  date = null;
  lastAdd = null;
  history.replaceState(null, '', location.pathname);
  await load();
}

function switchPerson() {
  openDialog(`<h2>Switch person?</h2><form>
    <p class="small" style="margin:0">This signs ${esc(state.profile.name)} out on this device. You’ll need the PIN to get back in.</p>
    <div class="actions"><button class="btn primary" type="submit">Switch</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async () => {
    await fetch('/api/session', { method: 'DELETE' });
    state = null;
    showGate();
  });
}

/* ---------- Composer ---------- */

// Phone photos are 4–12 MB; vision models read up to ~1568 px on the long edge anyway, so shrink first
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (pendingImages.length >= 5) { toast('Five pictures per message is plenty.'); break; }
    try {
      pendingImages.push(await shrink(f));
    } catch {
      toast(`Couldn’t read ${f.name || 'that image'}.`, 'error');
    }
  }
  renderPreviews();
}

function renderPreviews() {
  $('#previews').innerHTML = pendingImages.map((src, i) => `<div class="preview"><img src="${src}" alt="Picture to send"><button type="button" data-unpick="${i}" aria-label="Remove picture">✕</button></div>`).join('');
  updateSend();
}

function updateSend() {
  const empty = !$('#text').value.trim() && !pendingImages.length;
  $('#send').disabled = !!pendingMessage || empty;
  $('#clearText').hidden = empty;
}

function clearComposer() {
  $('#text').value = '';
  pendingImages = [];
  autosize();
  renderPreviews();
  $('#text').focus();
}

function autosize() {
  const t = $('#text');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

async function send(ev) {
  ev.preventDefault();
  const text = $('#text').value.trim();
  if (pendingMessage || (!text && !pendingImages.length)) return;
  const images = pendingImages;
  pendingImages = [];
  $('#text').value = '';
  autosize();
  renderPreviews();
  await sendMessage(text, images);
}

// What you typed (or the Add sheet's words and photos) goes to the AI; the bar above the box says what came of it
async function sendMessage(text, images) {
  if (pendingMessage) return toast('Still reading the last one.');
  pendingMessage = { pending: true, text, images, created_at: '' };
  lastAdd = null;
  $('#send').classList.add('busy');
  updateSend();
  renderMeals();
  renderThread();
  renderLastAdd();
  let r = null;
  try {
    r = await api('/api/log', { method: 'POST', body: { text, images, date } });
    if (r.weight) toast(`Logged ${r.weight} kg`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pendingMessage = null;
    $('#send').classList.remove('busy');
    updateSend();
    await load();
  }
  if (r?.message_id && state) {
    const items = state.day.entries.filter((e) => e.message_id === r.message_id);
    const msg = state.day.messages.find((m) => m.id === r.message_id);
    lastAdd = items.length ? { ids: items.map((e) => e.id), text: addedText(items), note: msg?.note && msg.note.length < 140 ? msg.note : '' }
      : { ids: [], text: 'Nothing added.', note: msg?.note || '' };
    renderLastAdd();
  }
}

/* ---------- Events ---------- */

$('#composer').addEventListener('submit', send);
$('#clearText').addEventListener('click', clearComposer);
$('#text').addEventListener('input', () => { autosize(); updateSend(); });
$('#text').addEventListener('keydown', (e) => {
  // Enter sends on desktop; on touch keyboards Enter stays a newline
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
// A label photo for an item that's already in the diary
document.addEventListener('change', async (e) => {
  const id = e.target.dataset?.labelfor;
  if (!id || !e.target.files?.length) return;
  const file = e.target.files[0];
  const btn = e.target.closest('label');
  btn.classList.add('busy');
  btn.lastChild.textContent = 'Reading the label…';
  if ($('#dialog').open) { $('#dialog').close(); toast('Reading the label…'); }
  try {
    const r = await api(`/api/entries/${id}/label`, { method: 'POST', body: { images: [await shrink(file)] } });
    if (r.updated) toast('Updated from the label');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    await load();
  }
});
document.addEventListener('change', (e) => {
  const kind = e.target.dataset?.addphoto;
  if (kind && e.target.files?.[0]) addPhoto(kind, e.target.files[0]).catch((err) => toast(err.message, 'error'));
});
$('#cameraInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
// A pasted image goes to the photo box that's open (the webcam, a sheet's label or food photo,
// the Foods page), and to the message box otherwise
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const target = camFor || $('#dialog[open] [data-paste]') || (view === 'foods' && !$('#dialog').open && $('#labelFile'));
  if (!target) return addFiles(files);
  $('dialog.cam')?.close();
  giveFile(target, files[0]);
});

/* ---------- The webcam, on a computer ----------
   A camera button there would only open a file picker, so it opens the webcam instead. The
   shot goes back through the button's own file input, so each button keeps its own handler. */

let camFor = null;

function giveFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('click', (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.hasAttribute('capture') || input.dataset.picking) return;
  if (matchMedia('(pointer: coarse)').matches || !navigator.mediaDevices?.getUserMedia) return;
  e.preventDefault();
  openCam(input);
}, true);

async function openCam(input) {
  const d = document.createElement('dialog');
  d.className = 'cam';
  d.innerHTML = `<h2>Take a photo</h2>
    <div class="cam-box"><video autoplay playsinline muted></video><p class="cam-msg">Starting the camera…</p></div>
    <div class="actions">
      <button type="button" class="btn primary" data-snap disabled>${CAMERA}Take photo</button>
      <button type="button" class="btn" data-pickfile>Choose a file</button>
      <button type="button" class="btn" data-camclose>Cancel</button>
    </div>
    <p class="small">Or paste a picture with Ctrl+V.</p>`;
  document.body.append(d);
  camFor = input;
  d.showModal();
  let stream = null;
  d.addEventListener('close', () => { stream?.getTracks().forEach((t) => t.stop()); if (camFor === input) camFor = null; d.remove(); });
  const video = $('video', d);
  const msg = $('.cam-msg', d);
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-camclose]')) d.close();
    if (e.target.closest('[data-pickfile]')) {
      d.close();
      input.dataset.picking = '1';
      input.click();
      delete input.dataset.picking;
    }
    if (e.target.closest('[data-snap]')) {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob((blob) => { d.close(); giveFile(input, new File([blob], 'photo.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.9);
    }
  });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (!d.open) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    await video.play();
    msg.hidden = true;
    $('[data-snap]', d).disabled = false;
  } catch (err) {
    msg.textContent = err.name === 'NotAllowedError' ? 'The browser wasn’t allowed to use the camera. Allow it from the address bar, or choose a file.'
      : err.name === 'NotFoundError' ? 'No camera found. Choose a file or paste a picture instead.' : `Couldn’t start the camera: ${err.message}`;
  }
}
const composer = $('#composer');
document.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drag'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) composer.classList.remove('drag'); });
document.addEventListener('drop', (e) => { e.preventDefault(); composer.classList.remove('drag'); addFiles(e.dataTransfer.files); });

$('#prevDay').addEventListener('click', () => go(addDays(date, -1)));
$('#nextDay').addEventListener('click', () => go(addDays(date, 1)));
$('#dayLabel').addEventListener('click', () => go(state.today));
$('#openSettings').addEventListener('click', openSettings);
$('#who').addEventListener('click', switchPerson);

$('#gate').addEventListener('click', (e) => {
  const t = e.target.closest('[data-person],[data-addperson],[data-back]');
  if (!t) return;
  if (t.dataset.person) pinForm(gateProfiles.find((p) => p.id === Number(t.dataset.person)));
  else if (t.dataset.addperson !== undefined) newPersonForm();
  else showGate();
});

$('#gate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('button.primary', form);
  btn.disabled = true;
  try {
    const v = Object.fromEntries(new FormData(form));
    if (form.id === 'houseForm') { await api('/api/unlock', { method: 'POST', body: v }); return showGate(); }
    if (form.id === 'pinForm') await api('/api/session', { method: 'POST', body: { profile_id: Number(form.dataset.id), pin: v.pin } });
    else await api('/api/profiles', { method: 'POST', body: v });
    await signedIn();
  } catch (err) {
    toast(err.message, 'error');
    const pin = $('input[name="pin"], input[name="password"]', form);
    if (pin) { pin.value = ''; pin.focus(); }
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-qpick],[data-qptab],[data-addto],[data-addtab],[data-addpick],[data-addonline],[data-askadd],[data-newfood],[data-addcopy],[data-closesheet],[data-undo],[data-dismissadd],[data-openchat],[data-closechat],[data-weighin],[data-savepreset],[data-presets],[data-clearthread],[data-editproduct],[data-fexport],[data-fadd],[data-fsrc],[data-view],[data-sweek],[data-usepreset],[data-editpreset],[data-copyfrom],[data-edit],[data-delete],[data-savefood],[data-retry],[data-dismiss],[data-day],[data-delfood],[data-delweight],[data-unpick],[data-info],[data-explain],[data-pickday],[data-photos],[data-msgopen],[data-opensettings]');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.addto) addSheet(d.addto);
    else if (d.addtab) { adding.tab = d.addtab; refreshAdd(); }
    else if (d.addpick) await pickAdd(adding.rows[Number(d.addpick.split(':')[1])], adding.meal);
    else if (d.qpick) await pickAdd(qp.rows[Number(d.qpick)], qp.meal);
    else if (d.qptab) { qp.tab = d.qptab; renderQuickPanel(); }
    else if (d.addonline !== undefined) { adding.online = true; refreshAdd(); }
    else if (d.askadd !== undefined) askPlateful();
    else if (d.newfood !== undefined) customFood({ meal: adding.meal });
    else if (d.addcopy) copyDialog(Number(d.addcopy), adding.meal);
    else if (d.closesheet !== undefined) $('#dialog').close();
    else if (d.undo !== undefined) await undoLast();
    else if (d.dismissadd !== undefined) { lastAdd = null; renderLastAdd(); }
    else if (d.openchat !== undefined) openChat(true);
    else if (d.closechat !== undefined) openChat(false);
    else if (d.weighin !== undefined) weighIn();
    else if (d.savepreset) savePreset(d.savepreset);
    else if (d.presets !== undefined) presetsDialog();
    else if (d.clearthread !== undefined) {
      const r = await api('/api/messages/clear', { method: 'POST', body: { date } });
      toast(r.cleared ? 'Cleared. Your logged food is untouched.' : 'Nothing to clear');
      await load();
    }
    else if (d.editproduct) editProduct(foodsState.products.find((p) => p.id === Number(d.editproduct)));
    else if (d.fadd !== undefined) customFood();
    else if (d.fexport !== undefined) location.href = '/api/fooddb/export';
    else if (d.fsrc !== undefined) { foodsState.source = d.fsrc; loadFoods(); }
    else if (d.view) setView(d.view);
    else if (d.sweek) { statsDate = addDays(statsDate, 7 * Number(d.sweek)); statsPick = 'week'; loadStats(); }
    else if (d.usepreset) {
      $('#dialog').close();
      const p = presets.presets.find((x) => x.id === Number(d.usepreset));
      addSuggestion({ kind: 'preset', id: p.id, name: p.name, meal: p.meal, items: p.items, kcal: p.kcal });
    }
    else if (d.editpreset) editPreset(presets.presets.find((x) => x.id === Number(d.editpreset)));
    else if (d.copyfrom) copyDialog(Number(d.copyfrom));
    else if (d.edit && selected.size) toggleSelect(Number(d.edit));
    else if (d.edit) itemSheet(state.day.entries.find((x) => x.id === Number(d.edit)));
    else if (d.delete) {
      const entry = state.day.entries.find((x) => x.id === Number(d.delete));
      await api(`/api/entries/${d.delete}`, { method: 'DELETE' });
      $('#dialog').close();
      toast(`Deleted ${entry?.name || 'it'}`);
      await load();
    }
    else if (d.savefood) saveAsFood(state.day.entries.find((x) => x.id === Number(d.savefood)));
    else if (d.retry) {
      t.disabled = true;
      t.textContent = 'Retrying…';
      await api(`/api/messages/${d.retry}/retry`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
      await load();
    }
    else if (d.dismiss) { await api(`/api/messages/${d.dismiss}`, { method: 'DELETE' }); await load(); }
    else if (d.day) go(d.day);
    else if (d.delfood) { if (confirm('Remove this quick-add food?')) { await api(`/api/foods/${d.delfood}`, { method: 'DELETE' }); await load(); renderFoods(); } }
    else if (d.delweight) { if (confirm('Remove this weigh-in?')) { await api(`/api/weights/${d.delweight}`, { method: 'DELETE' }); await load(); } }
    else if (d.unpick) { pendingImages.splice(Number(d.unpick), 1); renderPreviews(); }
    else if (d.info) infoDialog(state.day.entries.find((x) => x.id === Number(d.info)));
    else if (d.explain !== undefined) { $('#dialog').close(); explainDialog(); }
    else if (d.msgopen) { const id = Number(d.msgopen); if (openMsgs.has(id)) openMsgs.delete(id); else openMsgs.add(id); renderThread(true); }
    else if (d.photos) openViewer(JSON.parse(d.photos), Number(d.photoat));
    else if (d.pickday) { statsPick = statsPick === d.pickday ? 'week' : d.pickday; renderStats(); }
    else if (d.opensettings !== undefined) openSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.matches('form.edit')) {
    e.preventDefault();
    const entry = state.day.entries.find((x) => x.id === Number(form.dataset.entry));
    const v = { ...Object.fromEntries(new FormData(form)), ...readAmount($('.amt', form)) };
    // Only send what changed, so saving an untouched item doesn't mark it as edited by hand
    const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => String(x ?? '') !== String(entry[k] ?? '')));
    // The amount fields only make sense together (the server rebuilds the "2 slices" text from them)
    if (['amount', 'unit', 'grams'].some((k) => k in changed)) Object.assign(changed, readAmount($('.amt', form)));
    try {
      await api(`/api/entries/${form.dataset.entry}`, { method: 'PATCH', body: changed });
      $('#dialog').close();
      if (Object.keys(changed).length) toast(changed.meal && Object.keys(changed).length === 1 ? `Moved to ${MEAL_NAMES[changed.meal]}` : 'Saved');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }
});

// Pick up a new day if the tab was left open overnight
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state || document.body.classList.contains('signed-out')) return;
  if (date === state.today) date = null;
  load();
});

updateSend();
load();
