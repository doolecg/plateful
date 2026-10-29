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
const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

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
    amt._base = { g: Number(amt.dataset.g), ...Object.fromEntries(MACROS.map((k) => [k, Number($(`[data-m="${k}"]`, scope)?.value) || 0])) };
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
    if (input) input.value = m === 'kcal' ? Math.round(base[m] * k) : r1(base[m] * k);
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

let state = null;
let date = new URLSearchParams(location.search).get('d');
let editing = null;
let pendingImages = [];
let pendingMessage = null;
let people = [];
// Entry ids picked with a long press; while any are picked, taps select instead of edit
const selected = new Set();
let presets = { presets: [], suggestions: [] };

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
  try {
    state = await api(`/api/summary${date ? `?date=${date}` : ''}`);
    date = state.date;
    [presets, people] = await Promise.all([
      api(`/api/presets?date=${date}&hour=${new Date().getHours()}`),
      api('/api/people'),
    ]);
    document.body.classList.remove('signed-out');
    $('#gate').hidden = true;
    render();
  } catch (err) {
    if (!document.body.classList.contains('signed-out')) toast(`Couldn’t load your diary: ${err.message}`, 'error');
  } finally {
    $('#app').setAttribute('aria-busy', 'false');
  }
}

function go(d) {
  date = d;
  editing = null;
  selected.clear();
  const url = d === state.today ? location.pathname : `?d=${d}`;
  history.replaceState(null, '', url);
  load();
}

/* ---------- Rendering ---------- */

function render() {
  const { today } = state;
  $('#dayLabel').textContent = date === today ? `Today, ${fmtDay(date, { day: 'numeric', month: 'short' })}` : fmtDay(date, { weekday: 'long', day: 'numeric', month: 'short' });
  $('#nextDay').disabled = date >= today;
  $('#who').innerHTML = `<span class="avatar">${esc(state.profile.name[0].toUpperCase())}</span><span class="who-name">${esc(state.profile.name)}</span>`;
  renderHero();
  renderMeals();
  renderThread();
  renderWeek();
  renderWeight();
  renderFoods();
  renderQuick();
  renderTools();
  renderSelection();
}

function renderHero() {
  const { totals, target, flex } = state.day;
  const left = target - totals.kcal;
  const over = left < 0;
  const isToday = date === state.today;
  const macroKcal = totals.fat * 9 + totals.carbs * 4 + totals.protein * 4 || 1;
  const pct = (k, m) => Math.round((k * m / macroKcal) * 100);
  const hero = $('#hero');
  hero.className = `hero${over ? ' over' : ''}`;
  hero.innerHTML = `
    <div class="eyebrow">${over ? 'Over by' : isToday ? 'Left today' : 'Left that day'}${flex ? '<span class="flex-tag">Flex day</span>' : ''}</div>
    <div class="big num">${n(Math.abs(left))}<small>kcal</small></div>
    <div class="sub num">${n(totals.kcal)} eaten of ${n(target)}</div>
    <div class="bar"><span style="width:${Math.min(100, (totals.kcal / target) * 100)}%"></span></div>
    <div class="macros num">
      <span>Protein <b>${g(totals.protein)}</b> · ${pct(totals.protein, 4)}%</span>
      <span>Carbs <b>${g(totals.carbs)}</b> · ${pct(totals.carbs, 4)}%</span>
      <span>Fat <b>${g(totals.fat)}</b> · ${pct(totals.fat, 9)}%</span>
    </div>`;
}

function renderMeals() {
  const el = $('#meals');
  const { entries } = state.day;
  if (!entries.length && !pendingMessage) {
    el.innerHTML = `<div class="empty"><strong>Nothing logged ${date === state.today ? 'yet' : 'this day'}.</strong>
      <p>Type what you ate, paste a photo of a label, or snap your plate with the camera button below. Saved foods add instantly from the chips, and “w 128.2” logs a weigh-in.</p></div>`;
    return;
  }
  el.innerHTML = MEALS.map((meal) => {
    const rows = entries.filter((e) => e.meal === meal);
    if (!rows.length) return '';
    const kcal = rows.reduce((s, e) => s + e.kcal, 0);
    return `<section class="meal"><h2>${MEAL_NAMES[meal]} <span class="num">${n(kcal)} kcal</span></h2>
      <ul class="items">${rows.map(itemHtml).join('')}</ul>
      <div class="meal-foot"><button class="link-btn" data-savepreset="${meal}">Save ${MEAL_NAMES[meal].toLowerCase()} as a preset</button></div></section>`;
  }).join('');
}

function itemHtml(e) {
  if (editing === e.id) return `<li class="item">${editFormHtml(e)}</li>`;
  const src = e.source === 'label' ? '<span class="src label">from label</span>'
    : e.source === 'saved' ? '<span class="src label">saved food</span>'
    : e.source === 'manual' ? '<span class="src">added by hand</span>'
    : e.source === 'preset' ? '<span class="src">preset</span>'
    : e.source === 'copied' ? '<span class="src">copied</span>'
    : '<span class="src">estimate</span>';
  return `<li class="item${selected.has(e.id) ? ' selected' : ''}"><button class="item-row" data-edit="${e.id}"${selected.size ? ` aria-pressed="${selected.has(e.id)}"` : ''}>
    <span class="item-name">${esc(e.name)}</span><span class="item-kcal num">${n(e.kcal)}</span>
    <span class="item-meta num">${e.quantity ? `<span>${esc(e.quantity)}</span>` : ''}<span>P ${g(e.protein)} · C ${g(e.carbs)} · F ${g(e.fat)}</span>${src}${e.edited_at ? '<span class="src">edited</span>' : ''}</span>
  </button><button class="info-btn" data-info="${e.id}" aria-label="Where the numbers for ${esc(e.name)} came from" title="Where these numbers came from">i</button></li>`;
}

const macroInputs = (i, attr = 'name') => [['kcal', 'kcal'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['fat', 'Fat g']]
  .map(([k, label]) => `<label class="f">${label}<input ${attr}="${k}" data-m="${k}" type="number" inputmode="decimal" step="any" min="0" value="${i[k] ?? (k === 'kcal' ? '' : 0)}"${k === 'kcal' ? ' required' : ''}></label>`).join('');

function editFormHtml(e) {
  return `<form class="edit" data-entry="${e.id}">
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(e.name)}" required></label>
      ${amountHtml(e)}
      <label class="f full">Meal<select name="meal">${MEALS.map((m) => `<option value="${m}"${m === e.meal ? ' selected' : ''}>${MEAL_NAMES[m]}</option>`).join('')}</select></label>
      ${macroInputs(e)}
    </div>
    <div class="actions">
      <button class="btn primary" type="submit">Save</button>
      <button class="btn" type="button" data-cancel>Cancel</button>
      <span class="spacer"></span>
      <button class="btn" type="button" data-savefood="${e.id}" title="Add to your quick-add chips">Save as food</button>
      <button class="btn danger" type="button" data-delete="${e.id}">Delete</button>
    </div>
  </form>`;
}

function renderThread() {
  const msgs = [...state.day.messages];
  if (pendingMessage) msgs.push(pendingMessage);
  const el = $('#thread');
  if (!msgs.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h3>What you sent</h3>${msgs.slice().reverse().map((m) => {
    const time = m.pending ? 'just now' : new Date(`${m.created_at.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `<div class="msg${m.pending ? ' pending' : ''}">
      ${m.images.length ? `<div class="thumbs">${m.images.map((src) => `<img src="${esc(src)}" alt="Photo you sent" loading="lazy">`).join('')}</div>` : ''}
      ${m.text ? `<div class="said">${esc(m.text)}</div>` : ''}
      ${m.pending ? '<div class="reply">Reading it</div>'
        : m.error ? `<div class="err"><span>${esc(m.error)}</span><button class="btn" data-retry="${m.id}">Retry</button><button class="link-btn" data-dismiss="${m.id}">Dismiss</button></div>`
        : m.note ? `<div class="reply">${esc(m.note)}</div>` : ''}
      <div class="time">${time}</div>
    </div>`;
  }).join('')}`;
}

function renderWeek() {
  const { week, today } = state;
  const max = Math.max(...week.days.map((d) => Math.max(d.kcal, d.target))) * 1.08;
  // Only days with something logged count towards the balance, so a fresh install isn't "under" for empty days
  const logged = week.days.filter((d) => d.kcal > 0 && !d.future);
  const balance = logged.reduce((s, d) => s + (d.target - d.kcal), 0);
  const remainingDays = week.days.filter((d) => d.date > today).length;
  $('#week').innerHTML = `
    <h2>This week</h2>
    <p class="lede num">${logged.length
      ? balance >= 0 ? `<b class="good">${n(balance)} kcal under</b> across ${logged.length} logged day${logged.length > 1 ? 's' : ''}.`
        : `<b class="bad">${n(-balance)} kcal over</b> across ${logged.length} logged day${logged.length > 1 ? 's' : ''}.`
      : 'Nothing logged this week yet.'}
      ${week.flexFree ? `Your ${n(state.settings.flex_kcal)} day is still unused.` : `Flex day: ${fmtDay(week.flexDate, { weekday: 'long' })}.`}
      ${remainingDays ? `${remainingDays} day${remainingDays > 1 ? 's' : ''} to go.` : ''}</p>
    <div class="weekbars">${week.days.map((d) => {
      const nolog = d.kcal === 0;
      return `<button class="wbar${d.date === date ? ' sel' : ''}${d.flex ? ' flex' : ''}${nolog ? ' nolog' : ''}" data-day="${d.date}" ${d.future ? 'disabled' : ''}
          aria-label="${fmtDay(d.date, { weekday: 'long' })}: ${n(d.kcal)} of ${n(d.target)} kcal">
        <div class="track">
          <div class="fill${d.kcal > d.target ? ' over' : ''}" style="height:${(d.kcal / max) * 100}%"></div>
          <div class="target" style="bottom:${(d.target / max) * 100}%"></div>
        </div>
        <div class="lbl num">${fmtDay(d.date, { weekday: 'narrow' })}<br>${nolog ? '–' : n(d.kcal)}</div>
      </button>`;
    }).join('')}</div>
    <div class="legend"><span><i></i>${n(state.settings.daily_kcal)} target</span><span><i class="flex"></i>${n(state.settings.flex_kcal)} flex day</span></div>`;
}

function renderWeight() {
  const { rows, stats } = state.weight;
  const goal = state.settings.goal_kg;
  const el = $('#weight');
  const form = `<form class="inline-form" id="weightForm">
      <label class="f">Weigh-in (kg)<input name="kg" type="number" step="0.1" min="30" max="400" inputmode="decimal" placeholder="${stats ? stats.latest.kg : '80.0'}" required></label>
      <label class="f">Date<input name="date" type="date" value="${date}" max="${state.today}" required></label>
      <button class="btn primary" type="submit">Log</button>
    </form>
    <p class="small" style="margin:6px 0 0">Or type “w 128.2” or “20st 3lb” in the message box.</p>`;
  if (!stats) { el.innerHTML = `<h2>Weight</h2><p class="lede">No weigh-ins yet.</p>${form}`; return; }
  const stones = (kg) => { const lb = kg / 0.45359237; return `${Math.floor(lb / 14)}st ${Math.round(lb % 14)}lb`; };
  el.innerHTML = `
    <h2>Weight</h2>
    <p class="lede num">${stats.latest.kg.toFixed(1)} kg (${stones(stats.latest.kg)}) on ${fmtDay(stats.latest.date, { day: 'numeric', month: 'short' })}.
      ${goal == null ? 'Set a goal weight in Settings to see a projection.' : ''}
      ${stats.projectedDate ? `At this pace you reach <b>${goal} kg</b> around <b>${parseDate(stats.projectedDate).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</b>.` : ''}</p>
    <div class="wstats num">
      <div><b>${stats.lost.toFixed(1)}</b><span>kg lost</span></div>
      <div><b>${stats.toGo != null ? stats.toGo.toFixed(1) : '–'}</b><span>kg to go</span></div>
      <div><b>${stats.ratePerWeek != null ? stats.ratePerWeek.toFixed(1) : '–'}</b><span>kg a week</span></div>
    </div>
    ${stats.progress != null ? `<div class="progress" aria-label="${Math.round(stats.progress * 100)}% of the way to goal"><span style="width:${stats.progress * 100}%"></span></div>
    <div class="small">${Math.round(stats.progress * 100)}% of the way from ${stats.start.kg} kg to ${goal} kg</div>` : ''}
    ${weightChart(rows, goal, stats)}
    ${form}
    <details class="wlist"><summary>All weigh-ins (${rows.length})</summary><ul>
      ${rows.slice().reverse().map((r) => `<li class="num"><span>${fmtDay(r.date, { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>${r.kg.toFixed(1)} kg <button class="link-btn" data-delweight="${r.id}" aria-label="Delete weigh-in">Remove</button></span></li>`).join('')}
    </ul></details>`;
}

function weightChart(rows, goal, stats) {
  const W = 360, H = 170, L = 34, R = 10, T = 12, B = 22;
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

function renderFoods() {
  const { foods } = state;
  $('#foods').innerHTML = `<h2>Saved foods</h2>
    <p class="lede">Tap one in the bar above the message box to add it without asking Claude. Save more from any logged item.</p>
    ${foods.length ? `<ul class="foodlist">${foods.map((f) => `<li><div><div>${esc(f.name)}</div><div class="meta num">${foodMeta(f)}</div></div>
      <button class="link-btn" data-delfood="${f.id}" aria-label="Remove ${esc(f.name)}">Remove</button></li>`).join('')}</ul>`
      : '<p class="small">None yet.</p>'}`;
}

function renderQuick() {
  const sugg = presets.suggestions.map((s, i) => `<button type="button" class="chip suggest" data-suggest="${i}"
      title="${s.kind === 'habit' ? `You’ve had this ${s.count} times lately` : 'Preset meal'}">${esc(s.name)} <span class="num">${n(s.kcal)}</span></button>`).join('');
  $('#quick').innerHTML = sugg + state.foods.map((f) => `<button type="button" class="chip" data-quick="${f.id}">${esc(f.name)}</button>`).join('');
}

function renderTools() {
  $('#tools').innerHTML = people.map((p) => `<button class="btn" data-copyfrom="${p.id}">Copy from ${esc(p.name)}</button>`).join('')
    + `<button class="btn" data-presets>Preset meals${presets.presets.length ? ` <span class="count num">${presets.presets.length}</span>` : ''}</button>`;
}

/* ---------- Dialogs ---------- */

function openDialog(html, onSubmit) {
  const d = $('#dialog');
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

function quickAdd(food) {
  // Saved foods store their unit as text ("100 g", "1 slice"); unknown words count as "each"
  const q = parseQuantity(`${food.per} ${food.unit}`) || { amount: food.per, unit: 'each' };
  openDialog(`<h2>${esc(food.name)}</h2><form>
    <p class="small num" style="margin:0">${foodMeta(food)}</p>
    <div class="grid">
      ${amountHtml(q)}
      <label class="f full">Meal<select name="meal">${MEALS.map((m) => `<option value="${m}"${m === guessMeal() ? ' selected' : ''}>${MEAL_NAMES[m]}</option>`).join('')}</select></label>
      ${MACROS.map((k) => `<input type="hidden" data-m="${k}" value="${food[k]}">`).join('')}
    </div>
    <p class="qa-total num"><b>${n(food.kcal)}</b> kcal · P ${g(food.protein)} · C ${g(food.carbs)} · F ${g(food.fat)}</p>
    <div class="actions"><button class="btn primary" type="submit">Add</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ meal }, form) => {
    const m = Object.fromEntries(MACROS.map((k) => [k, Number($(`[data-m="${k}"]`, form).value)]));
    const amt = $('.amt', form);
    delete amt.dataset.untouched;
    await api('/api/entries', { method: 'POST', body: { date, meal, name: food.name, ...m, ...readAmount(amt), source: 'saved', origin: `Your saved food “${food.name}”` } });
    toast(`Added ${food.name}`);
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

function openSettings() {
  const s = state.settings;
  const days = [['auto', 'Whichever day I go over'], ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  openDialog(`<h2>Settings for ${esc(state.profile.name)}</h2><form>
    <div class="grid">
      <label class="f full">Name<input name="name" value="${esc(state.profile.name)}" required maxlength="40"></label>
      <label class="f wide">Daily kcal<input name="daily_kcal" type="number" min="800" max="6000" value="${s.daily_kcal}" required></label>
      <label class="f wide">Flex day kcal<input name="flex_kcal" type="number" min="800" max="6000" value="${s.flex_kcal}" required></label>
      <label class="f full">Flex day<select name="flex_day">${days.map(([v, l]) => `<option value="${v}"${v === s.flex_day ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f full">Goal weight (kg)<input name="goal_kg" type="number" step="0.1" min="30" max="300" value="${s.goal_kg ?? ''}" placeholder="optional"></label>
      <label class="f full">Who reads your food<select name="model_mode">${[
        ['auto', 'Haiku for typing, Sonnet for photos (cheapest)'],
        ['sonnet', 'Sonnet for everything (most accurate)'],
        ['haiku', 'Haiku for everything'],
      ].map(([v, l]) => `<option value="${v}"${v === s.model_mode ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f wide">Current PIN<input name="current" type="password" inputmode="numeric" autocomplete="current-password" pattern="\\d{4,8}" placeholder="to change PIN"></label>
      <label class="f wide">New PIN<input name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="\\d{4,8}" placeholder="4 to 8 digits"></label>
    </div>
    <p class="small" style="margin:0">16 st is 101.6 kg. The week runs Monday to Sunday. Leave the PIN boxes empty to keep your PIN.</p>
    <p class="small" style="margin:0">${state.server.claude === 'subscription' ? 'Food is read using a Claude subscription.' : state.server.claude === 'api_key' ? 'Food is read using a Claude API key, billed per message.' : 'Larder isn’t signed in to Claude yet, so only saved foods and presets work. See SETUP.md.'}
      <button class="link-btn" type="button" data-explain>Where the numbers come from</button></p>
    <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ current, pin, ...v }) => {
    if (pin) await api('/api/pin', { method: 'PUT', body: { current, pin } });
    await api('/api/settings', { method: 'PUT', body: v });
    toast(pin ? 'Settings and PIN saved' : 'Settings saved');
    await load();
  });
}

/* ---------- Where the numbers came from ---------- */

const modelName = (m) => (m ? m.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, f, a, b) => `Claude ${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`) : 'Claude');

function originText(e) {
  const msg = e.message_id && state.day.messages.find((m) => m.id === e.message_id);
  const who = modelName(msg?.model);
  const from = msg?.images?.length ? `your photo${msg.images.length > 1 ? 's' : ''}` : 'what you typed';
  if (e.source === 'label') return !msg ? 'Taken from a nutrition label.'
    : msg.images.length ? `${who} read the nutrition label in ${from} and scaled it to the amount you had.`
    : `${who} used the label figures for it, scaled to the amount you had.`;
  if (e.source === 'saved') return msg ? `${who} matched it to one of your saved foods and scaled that to the amount you had.` : `${esc(e.origin || 'One of your saved foods')}, scaled to the amount by Larder.`;
  if (e.source === 'est.' && !msg) return 'An estimate using typical UK values.';
  if (e.source === 'est.') return `${who} estimated it from ${from}, using typical UK values (supermarket own-brand and McCance and Widdowson style figures). A good guess rather than a measurement.`;
  if (e.source === 'manual') return 'You typed these numbers in yourself.';
  if (e.source === 'preset') return `Added from your preset meal ${e.origin ? `“${esc(e.origin.replace(/^Preset: /, ''))}”` : ''}, with the numbers saved in it.`;
  if (e.source === 'copied') return `${esc(e.origin || 'Copied from another log')}.`;
  return 'Not recorded.';
}

function conversionText(e) {
  const u = UNITS[e.unit];
  if (!u || !(e.amount > 0)) return e.quantity ? `Logged as “${esc(e.quantity)}” before Larder knew about units, so there’s no weight on record.` : 'No amount recorded.';
  const grams = e.grams ?? toGrams(e.amount, e.unit, e);
  if (u.kind === 'weight') return e.unit === 'g' ? `${n(grams)} g.` : `${esc(e.quantity)} is ${r1(grams)} g (1 ${u.label} = ${u.g} g).`;
  if (u.kind === 'volume') {
    const ml = e.amount * u.ml;
    const d = e.density || grams / ml;
    return `${esc(e.quantity)} is ${n(ml)} ml${u.ml !== 1 ? ` (1 ${u.label} = ${r1(u.ml)} ml)` : ''}, which weighs about ${n(grams)} g`
      + (Math.abs(d - 1) < 0.005 ? ', taking it to weigh the same as water.' : ` at ${d.toFixed(2)} g per ml.`);
  }
  if (grams == null) return `${esc(e.quantity)}, with no weight on record.`;
  return `${esc(e.quantity)}, about ${n(grams)} g in all (${r1(grams / e.amount)} g each${e.message_id && !e.edited_at ? ', Claude’s estimate' : ''}).`;
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
      <dt>Worked out by</dt><dd>Larder itself: totals, targets, the week and every unit conversion are sums on your server, so they cost no tokens.</dd>
    </dl>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><span class="spacer"></span><button class="link-btn" type="button" data-explain>How Larder works out numbers</button></div>
  </form>`, async () => {});
}

function explainDialog() {
  const spoon = (k) => `${UNITS[k].label} ${r1(UNITS[k].ml)} ml`;
  openDialog(`<h2>Where the numbers come from</h2><form class="info">
    <div class="explain">
      <h3>Claude reads what you send</h3>
      <p>Only messages you send cost tokens. ${state.settings.model_mode === 'sonnet' ? 'Claude Sonnet 5.5 reads everything you send' : state.settings.model_mode === 'haiku' ? 'Claude Haiku 5.5 reads everything you send' : 'Claude Haiku 5.5 reads what you type and Claude Sonnet 5.5 reads anything with a photo'} (change it in Settings). In order of preference it uses a nutrition label it can see, then one of your saved foods, then typical UK values for a realistic portion. Each item is tagged: <span class="src label">from label</span>, <span class="src label">saved food</span> or <span class="src">estimate</span>.</p>
      <h3>Larder does the rest</h3>
      <p>Everything else is worked out on your server with no tokens: daily and weekly totals, the flex day, macros, the weight trend and goal date, suggestions, presets, copying, and all unit conversions. Presets and copies carry the numbers they were saved with, and the (i) on each item shows where they first came from.</p>
      <h3>Units</h3>
      <p>Weights are exact (1 oz = 28.35 g, 1 lb = 453.6 g). Spoons and cups are UK metric: ${['tsp', 'dsp', 'tbsp', 'cup'].map(spoon).join(', ')}; a US cup is 236.6 ml. A UK pint is 568 ml and a UK fl oz 28.4 ml; the US ones are marked. Volumes are turned into grams using how heavy that food is per ml (Claude’s figure, or water if there isn’t one), and slices, handfuls and the like using a weight for one of them. You can correct the grams on any item and everything rescales.</p>
      <h3>How far to trust it</h3>
      <p>A label is as good as the label. An estimate from a photo of a plate can be out a fair way, mostly on portion size. Weighing it and typing the grams beats both.</p>
    </div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button></div>
  </form>`, async () => {});
}

/* ---------- Presets and copying ---------- */

const itemsList = (items) => `<ul class="mini">${items.map((i) => `<li><span>${esc(i.name)}${i.quantity ? ` <span class="q">${esc(i.quantity)}</span>` : ''}</span><span class="num">${n(i.kcal)}</span></li>`).join('')}</ul>`;
const mealSelect = (selected, extra = '') => `<select name="meal">${extra}${MEALS.map((m) => `<option value="${m}"${m === selected ? ' selected' : ''}>${MEAL_NAMES[m]}</option>`).join('')}</select>`;

function addSuggestion(s) {
  openDialog(`<h2>${esc(s.name)}</h2><form>
    <p class="small" style="margin:0">${s.kind === 'habit' ? `You’ve had this for ${MEAL_NAMES[s.meal].toLowerCase()} ${s.count} times in the last month.` : 'Preset meal.'}</p>
    ${itemsList(s.items)}
    <div class="grid"><label class="f full">Add to${mealSelect(s.meal)}</label></div>
    <div class="actions"><button class="btn primary" type="submit">Add ${n(s.kcal)} kcal</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async ({ meal }) => {
    if (s.kind === 'preset') await api(`/api/presets/${s.id}/add`, { method: 'POST', body: { date, meal } });
    else await api('/api/entries/copy', { method: 'POST', body: { ids: s.ids, date, meal } });
    toast(`Added ${s.name}`);
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

async function copyDialog(personId) {
  const person = people.find((p) => p.id === personId);
  let from = date;
  openDialog(`<h2>Copy from ${esc(person.name)}</h2><form>
    <div class="copy-nav"><button class="icon-btn" type="button" data-cd="-1" aria-label="Previous day">‹</button><span class="cd-label"></span><button class="icon-btn" type="button" data-cd="1" aria-label="Next day">›</button></div>
    <div class="copy-list"><div class="skeleton" style="height:80px"></div></div>
    <div class="grid"><label class="f full">Put it in my${mealSelect(null, '<option value="" selected>Same meals as theirs</option>')}</label></div>
    <div class="actions"><button class="btn primary" type="submit" disabled>Copy</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
  </form>`, async (v, form) => {
    const ids = [...form.querySelectorAll('input[name="id"]:checked')].map((c) => Number(c.value));
    if (!ids.length) throw new Error('Tick something to copy.');
    const r = await api('/api/entries/copy', { method: 'POST', body: { ids, date, meal: v.meal || null } });
    toast(`Copied ${r.added} item${r.added > 1 ? 's' : ''} from ${person.name}`);
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

/* ---------- Multi-select ---------- */

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  editing = null;
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

// Long press (or right-click) on an item starts picking. The click that follows a long press is swallowed.
let pressTimer = null;
let pressedAt = null;
let swallowClick = false;
document.addEventListener('pointerdown', (e) => {
  swallowClick = false; // a long press re-renders the list, so its own click may never arrive to clear this
  const row = e.target.closest('.item-row');
  if (!row || e.button !== 0) return;
  pressedAt = { x: e.clientX, y: e.clientY };
  pressTimer = setTimeout(() => {
    pressTimer = null;
    swallowClick = true;
    navigator.vibrate?.(15);
    toggleSelect(Number(row.dataset.edit));
  }, 450);
});
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
document.addEventListener('pointerup', cancelPress);
document.addEventListener('pointercancel', cancelPress);
document.addEventListener('pointermove', (e) => {
  if (pressTimer && pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 10) cancelPress();
});
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected.size && !$('#dialog').open) clearSelection(); });

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
    <div class="brand big-brand">Larder</div>
    <h1>Who’s logging?</h1>
    <div class="people">${gateProfiles.map((p) => `<button class="person" data-person="${p.id}"><span class="avatar lg">${esc(p.name[0].toUpperCase())}</span>${esc(p.name)}</button>`).join('')}
      <button class="person add" data-addperson><span class="avatar lg">+</span>Add someone</button></div>
  </div>`;
}

function pinForm(p) {
  $('#gate .gate-inner').innerHTML = `<div class="brand big-brand">Larder</div>
    <span class="avatar lg">${esc(p.name[0].toUpperCase())}</span>
    <h1>${p.hasPin ? `Hi ${esc(p.name)}` : `Set a PIN, ${esc(p.name)}`}</h1>
    <form class="pin-form" id="pinForm" data-id="${p.id}">
      <label class="f">${p.hasPin ? 'PIN' : 'Choose a PIN (4 to 8 digits)'}
        <input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" autocomplete="${p.hasPin ? 'current-password' : 'new-password'}" required autofocus></label>
      <div class="actions"><button class="btn primary" type="submit">${p.hasPin ? 'Open diary' : 'Save PIN and open'}</button><button class="btn" type="button" data-back>Back</button></div>
    </form>`;
  $('#pinForm input').focus();
}

// Only shown when the server has LARDER_PASSWORD set, before anything else
function houseForm() {
  $('#gate').innerHTML = `<div class="gate-inner"><div class="brand big-brand">Larder</div>
    <h1>Household password</h1>
    <form class="pin-form" id="houseForm">
      <label class="f">Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <p class="small" style="margin:0">Whoever set up this Larder has the password. Each device only needs it once.</p>
      <div class="actions"><button class="btn primary" type="submit">Unlock</button></div>
    </form></div>`;
  $('#houseForm input').focus();
}

function newPersonForm(first = false) {
  $('#gate .gate-inner').innerHTML = `<div class="brand big-brand">Larder</div>
    <h1>${first ? 'Welcome. Who’s first?' : 'Add someone'}</h1>
    ${first ? '<p class="small gate-lede">Larder keeps a food diary for each person in the house. Set yourself up here; anyone else can add themselves from the start screen later.</p>' : ''}
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
  editing = null;
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

// Phone photos are 4–12 MB; Claude reads up to ~1568 px on the long edge anyway, so shrink first
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
  $('#send').disabled = !!pendingMessage || (!$('#text').value.trim() && !pendingImages.length);
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
  pendingMessage = { pending: true, text, images, created_at: '' };
  pendingImages = [];
  $('#text').value = '';
  autosize();
  renderPreviews();
  $('#send').classList.add('busy');
  renderMeals();
  renderThread();
  try {
    const r = await api('/api/log', { method: 'POST', body: { text, images, date } });
    if (r.weight) toast(`Logged ${r.weight} kg`);
    else toast(r.added ? `Added ${r.added} item${r.added > 1 ? 's' : ''}` : 'Nothing added');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pendingMessage = null;
    $('#send').classList.remove('busy');
    updateSend();
    await load();
  }
}

/* ---------- Events ---------- */

$('#composer').addEventListener('submit', send);
$('#text').addEventListener('input', () => { autosize(); updateSend(); });
$('#text').addEventListener('keydown', (e) => {
  // Enter sends on desktop; on touch keyboards Enter stays a newline
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#cameraInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
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
  const t = e.target.closest('[data-suggest],[data-savepreset],[data-presets],[data-usepreset],[data-editpreset],[data-copyfrom],[data-edit],[data-cancel],[data-delete],[data-savefood],[data-retry],[data-dismiss],[data-day],[data-quick],[data-delfood],[data-delweight],[data-unpick],[data-info],[data-explain]');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.suggest) addSuggestion(presets.suggestions[Number(d.suggest)]);
    else if (d.savepreset) savePreset(d.savepreset);
    else if (d.presets !== undefined) presetsDialog();
    else if (d.usepreset) {
      $('#dialog').close();
      const p = presets.presets.find((x) => x.id === Number(d.usepreset));
      addSuggestion({ kind: 'preset', id: p.id, name: p.name, meal: p.meal, items: p.items, kcal: p.kcal });
    }
    else if (d.editpreset) editPreset(presets.presets.find((x) => x.id === Number(d.editpreset)));
    else if (d.copyfrom) copyDialog(Number(d.copyfrom));
    else if (d.edit && selected.size) toggleSelect(Number(d.edit));
    else if (d.edit) { editing = Number(d.edit); renderMeals(); $(`form[data-entry="${d.edit}"] input`)?.focus(); }
    else if (d.cancel !== undefined) { editing = null; renderMeals(); }
    else if (d.delete) { await api(`/api/entries/${d.delete}`, { method: 'DELETE' }); editing = null; toast('Deleted'); await load(); }
    else if (d.savefood) saveAsFood(state.day.entries.find((x) => x.id === Number(d.savefood)));
    else if (d.retry) {
      t.disabled = true;
      t.textContent = 'Retrying…';
      await api(`/api/messages/${d.retry}/retry`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
      await load();
    }
    else if (d.dismiss) { await api(`/api/messages/${d.dismiss}`, { method: 'DELETE' }); await load(); }
    else if (d.day) go(d.day);
    else if (d.quick) quickAdd(state.foods.find((f) => f.id === Number(d.quick)));
    else if (d.delfood) { if (confirm('Remove this saved food?')) { await api(`/api/foods/${d.delfood}`, { method: 'DELETE' }); await load(); } }
    else if (d.delweight) { if (confirm('Remove this weigh-in?')) { await api(`/api/weights/${d.delweight}`, { method: 'DELETE' }); await load(); } }
    else if (d.unpick) { pendingImages.splice(Number(d.unpick), 1); renderPreviews(); }
    else if (d.info) infoDialog(state.day.entries.find((x) => x.id === Number(d.info)));
    else if (d.explain !== undefined) { $('#dialog').close(); explainDialog(); }
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
      editing = null;
      toast('Saved');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  } else if (form.id === 'weightForm') {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try {
      await api('/api/weights', { method: 'POST', body: { date: v.date, kg: Number(v.kg) } });
      toast(`Logged ${v.kg} kg`);
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
