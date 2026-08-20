/* ============================================================
   Aqua — трекер привычек. Вся логика рендера и состояния.
   Данные хранятся локально (localStorage). Работает и в Electron
   (нативные уведомления/трей через window.desktop), и в браузере.
   ============================================================ */
'use strict';

const DESKTOP = typeof window !== 'undefined' && window.desktop && window.desktop.isElectron;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- dates ---------- */
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const RU_MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const RU_MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const RU_DOW = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

// Selected day being viewed/edited (default today). Lets you page back and see/log past days.
function todayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
let SEL = todayStart();
function curKey() { return keyOf(SEL); }
function isSelToday() { return curKey() === todayKey(); }

/* ============================================================
   STATE
   ============================================================ */
const LS_KEY = 'aqua.state.v1';
const DEFAULTS = {
  profile: {
    name: '', sex: 'male', age: null, birthday: '', height: null, weight: null, activity: 1.375, avatar: '🙂',
    goal: 'maintain',    // lose | maintain | gain | muscle
    goalRate: 0.5,       // kg per week (for lose / gain)
    targetWeight: null,  // kg
    startWeight: null,   // kg at the moment a weight goal was set (for progress)
    goalAdj: 0,          // legacy manual % override (older profiles)
    onboarded: false,
  },
  goals: { water: null, kcal: null },
  weightLog: {},         // 'YYYY-MM-DD' -> kg
  settings: {
    theme: 'dark',
    reminder: { enabled: false, intervalMinutes: 90, quietFrom: 23, quietTo: 8 },
    aiKey: '',
    streakGoal: 7,
    lastBdayGreet: 0, // year we last showed the birthday greeting
  },
  days: {},
  tasks: [],
  habits: [],
  focus: { sessions: {}, minutes: {}, work: 25, break: 5 },
  notes: '',
  finance: {
    onboarded: false,
    balance: 0,       // spendable money right now (cash + cards + accounts, before savings)
    profile: { household: 1, goal: 'control', trigger: '', freeHours: 10, skills: [], sideBudget: 0 },
    income: [],       // [{ id, name, amount }]
    expenses: [],     // [{ id, name, amount, cat, kind: 'fixed' | 'variable' }]
    savings: { current: 0, monthly: 0, goalName: '', goalAmount: 0 },
    debts: [],        // [{ id, name, balance, apr, min }]
    extraPayment: 0,
    debtMethod: 'avalanche',
    impulse: { weeklyLimit: 0, wishlist: [] }, // wishlist: [{ id, name, price, added, waitDays, decided }]
    tx: [],           // daily ledger: [{ id, ts, date, type: 'expense'|'income'|'saving', amount, cat, note }]
  },
};

let state = load();
migrate(state);

// One-time, forward-compatible fixups for profiles created before newer fields existed.
function migrate(s) {
  const p = s.profile;
  // Existing users already have a filled profile — don't nag them with onboarding.
  if (p.weight && p.onboarded === false) p.onboarded = true;
  // Map the old 3-option "Цель" (goalAdj) onto the new goal model.
  if (!p.goal || p.goal === 'maintain') {
    if (p.goalAdj < 0) { p.goal = 'lose'; p.goalRate = p.goalRate || 0.5; }
    else if (p.goalAdj > 0) { p.goal = 'gain'; p.goalRate = p.goalRate || 0.4; }
  }
  // Seed today's weight into the log so trends/projection have a starting point.
  if (p.weight && !Object.keys(s.weightLog || {}).length) {
    s.weightLog = s.weightLog || {};
    s.weightLog[todayKey()] = p.weight;
  }
  if (p.weight && p.targetWeight && p.startWeight == null) p.startWeight = p.weight;
  // Assign a meal to older food entries based on the time they were logged.
  Object.values(s.days || {}).forEach((dd) => {
    (dd.foods || []).forEach((f) => { if (!f.meal) f.meal = mealByHour(new Date(f.ts || Date.now()).getHours()); });
  });
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULTS), parsed);
  } catch (e) {
    console.warn('load failed', e);
    return structuredClone(DEFAULTS);
  }
}
function deepMerge(base, over) {
  for (const k in over) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      base[k] = over[k];
    }
  }
  return base;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { console.warn(e); }
    if (!cloudApplying) { markUpdated(); syncPush(); } // mirror to the cloud when signed in
  }, 120);
}

function day(k = curKey()) {
  if (!state.days[k]) state.days[k] = { waterLog: [], foods: [] };
  if (!state.days[k].waterLog) state.days[k].waterLog = [];
  if (!state.days[k].foods) state.days[k].foods = [];
  return state.days[k];
}

/* ============================================================
   DERIVED: goals (Mifflin-St Jeor + realistic goal deltas)
   ============================================================ */
const GOAL_META = {
  lose:     { label: 'Похудение',    icon: '🔥', hint: 'дефицит калорий' },
  maintain: { label: 'Поддержание',  icon: '⚖️', hint: 'вес стабильный' },
  gain:     { label: 'Набор массы',  icon: '📈', hint: 'профицит калорий' },
  muscle:   { label: 'Набор мышц',   icon: '💪', hint: 'мягкий профицит + белок' },
};
const KCAL_PER_KG = 7700; // energy in 1 kg of body mass

// Daily calorie delta for the chosen goal, capped to safe bounds.
function goalDelta(tdee, goal, rate) {
  const perDay = (Math.max(0.1, rate || 0.5) * KCAL_PER_KG) / 7;
  if (goal === 'lose') return -Math.min(perDay, tdee * 0.25); // max 25% deficit
  if (goal === 'gain') return Math.min(perDay, tdee * 0.20);  // max 20% surplus
  if (goal === 'muscle') return tdee * 0.10;                  // lean gain ~+10%
  return 0;
}
// Macro split tuned to the goal (protein-forward when cutting or building).
function macroSplit(kcal, goal) {
  let p, f, c;
  if (goal === 'lose')        { p = 0.35; f = 0.30; c = 0.35; }
  else if (goal === 'muscle') { p = 0.32; f = 0.25; c = 0.43; }
  else if (goal === 'gain')   { p = 0.25; f = 0.25; c = 0.50; }
  else                        { p = 0.28; f = 0.28; c = 0.44; }
  return { prot: Math.round(kcal * p / 4), fat: Math.round(kcal * f / 9), carb: Math.round(kcal * c / 4) };
}
// Age from a YYYY-MM-DD birthday (preferred), else the legacy plain age field.
function ageFromBirthday(bd) {
  if (!bd) return null;
  const d = new Date(bd + 'T00:00'); if (isNaN(d)) return null;
  const now = new Date(); let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a > 0 && a < 130 ? a : null;
}
function profileAge() { return ageFromBirthday(state.profile.birthday) || state.profile.age || null; }

function computeGoals() {
  const p = state.profile;
  let bmr = null, tdee = null, kcal = 2000, water = 2000, delta = 0;
  const goal = p.goal || 'maintain';
  const age = profileAge();
  if (p.weight && p.height && age) {
    bmr = 10 * p.weight + 6.25 * p.height - 5 * age + (p.sex === 'male' ? 5 : -161);
    tdee = bmr * (p.activity || 1.375);
    delta = goalDelta(tdee, goal, p.goalRate);
    let target = tdee + delta;
    // Safety floor — never prescribe below BMR×1.05 or an absolute minimum.
    const floor = Math.max(Math.round(bmr * 1.05), p.sex === 'female' ? 1200 : 1500);
    if (target < floor) { target = floor; delta = target - tdee; }
    kcal = Math.round(target / 10) * 10;
  }
  if (p.weight) water = Math.round(clamp(35 * p.weight, 1200, 5000) / 50) * 50;
  const custom = !!state.goals.kcal;
  const kcalGoal = state.goals.kcal || kcal;
  const waterGoal = state.goals.water || water;
  const macros = macroSplit(kcalGoal, goal);
  return {
    bmr: bmr && Math.round(bmr), tdee: tdee && Math.round(tdee),
    activityBurn: (bmr && tdee) ? Math.round(tdee - bmr) : null,
    delta: Math.round(delta), kcalGoal, waterGoal, macros, goal, custom,
  };
}

/* ---------- weight tracking + projection ---------- */
function latestWeight() {
  const keys = Object.keys(state.weightLog || {}).sort();
  if (keys.length) return state.weightLog[keys[keys.length - 1]];
  return state.profile.weight || null;
}
function logWeight(kg, k = todayKey()) {
  kg = Number(kg);
  if (!kg || kg <= 0) return;
  state.weightLog[k] = Math.round(kg * 10) / 10;
  state.profile.weight = state.weightLog[k]; // keep profile in sync with the latest entry
  save();
}
// Estimate when the target weight is reached at the chosen weekly rate.
function weightProjection() {
  const p = state.profile;
  const cur = latestWeight();
  if (!cur || !p.targetWeight || (p.goal !== 'lose' && p.goal !== 'gain')) return null;
  const diff = p.targetWeight - cur;
  const dir = p.goal === 'lose' ? -1 : 1;
  if (Math.sign(diff) !== dir || Math.abs(diff) < 0.1) return { done: true, cur, target: p.targetWeight };
  const weeks = Math.abs(diff) / Math.max(0.1, p.goalRate || 0.5);
  const date = new Date(); date.setDate(date.getDate() + Math.round(weeks * 7));
  const start = p.startWeight || cur;
  const total = Math.abs(p.targetWeight - start) || Math.abs(diff);
  const progress = clamp((Math.abs(cur - start) / total) * 100, 0, 100);
  return { done: false, cur, target: p.targetWeight, weeks, date, progress, remaining: Math.abs(diff) };
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

/* ============================================================
   NAVIGATION
   ============================================================ */
const VIEW_TITLES = { dashboard: 'Обзор', water: 'Вода', nutrition: 'Калории', tasks: 'Задачи', habits: 'Привычки', focus: 'Фокус', finance: 'Финансы', calendar: 'Календарь', profile: 'Профиль' };

/* ---------- clean line icons (replace the chrome emoji) ---------- */
const ICON_PATHS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 4.5 12 2c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7z"/>',
  apple: '<path d="M12 20.9c1.5 0 2.7 1.1 4 1.1 3 0 6-8 6-12.2A4.9 4.9 0 0 0 17 5c-2.2 0-4 1.4-5 2-1-.6-2.8-2-5-2a4.9 4.9 0 0 0-5 4.8C2 14 5 22 8 22c1.3 0 2.5-1.1 4-1.1z"/><path d="M10 2c1 .5 2 2 2 5"/>',
  check: '<path d="M9 11.5l2.5 2.5L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="12" y1="14" y2="9"/><circle cx="12" cy="14" r="8"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  grid: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  palette: '<path d="M12 22a10 10 0 1 1 0-20 8 8 0 0 1 0 16h-2a2 2 0 0 0 0 4z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  barcode: '<path d="M3 5v14M7 5v14M11 5v14M15 5v14M18 5v14M21 5v14"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  skip: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a6 6 0 0 1 0 12h-3"/>',
};
function icon(name) {
  const p = ICON_PATHS[name]; if (!p) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
function paintIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.dataset.icon;
    if (el._iconPainted === name) return; el._iconPainted = name;
    el.innerHTML = icon(name);
  });
}
let currentView = 'dashboard';
function switchView(v) {
  if (!VIEW_TITLES[v]) return;
  currentView = v;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  // mobile bottom-nav active state ("Ещё" lights up for views not on the bar)
  const MOBILE_TABS = ['dashboard', 'water', 'nutrition', 'finance'];
  $$('.mnav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  const more = $('#mnavMore'); if (more) more.classList.toggle('active', !MOBILE_TABS.includes(v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.dataset.view === v));
  $('#viewTitle').textContent = VIEW_TITLES[v];
  renderView(v);
}
function openMobileSheet() { const s = $('#mobileSheet'); if (!s) return; s.hidden = false; requestAnimationFrame(() => s.classList.add('open')); }
function closeMobileSheet() { const s = $('#mobileSheet'); if (!s) return; s.classList.remove('open'); setTimeout(() => { s.hidden = true; }, 280); }

// ---- day paging (view/log past days) ----
function shiftDay(delta) {
  const d = new Date(SEL); d.setDate(d.getDate() + delta);
  if (d > todayStart()) return; // no future
  SEL = d; renderView(currentView);
}
function gotoToday() { SEL = todayStart(); renderView(currentView); }

/* ============================================================
   WATER
   ============================================================ */
function waterTotal(k = curKey()) { return day(k).waterLog.reduce((s, w) => s + w.ml, 0); }

function addWater(ml) {
  ml = Math.round(Number(ml));
  if (!ml || ml <= 0) return;
  day().waterLog.push({ ml, ts: Date.now() });
  save();
  const g = computeGoals().waterGoal;
  const t = waterTotal();
  pulseBottles();
  if (t >= g && t - ml < g) toast('🎉 Дневная норма воды выполнена!', 'ok');
  else toast(`+${ml} мл · всего ${t} мл`, 'ok');
  renderWater(); renderDashboard(); updateTopbar();
}
function undoWater() {
  const d = day();
  if (!d.waterLog.length) return toast('Нечего убирать');
  const last = d.waterLog.pop();
  save();
  toast(`Убрано ${last.ml} мл`);
  renderWater(); renderDashboard(); updateTopbar();
}
function pulseBottles() {
  ['#dashBottle', '#mainBottle'].forEach((s) => {
    const el = $(s); if (!el) return;
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
  });
}

const QUICK = [{ ml: 200, em: '🥃' }, { ml: 300, em: '🥤' }, { ml: 500, em: '🍶' }, { ml: 750, em: '💧' }];
function renderQuickAdd(container) {
  container.innerHTML = '';
  QUICK.forEach((q) => {
    const b = document.createElement('button');
    b.className = 'qa-btn';
    b.innerHTML = `<span class="qa-em">${q.em}</span> +${q.ml}`;
    b.onclick = () => addWater(q.ml);
    container.appendChild(b);
  });
}

function setBottle(waterEl, fillPct) {
  waterEl.style.height = clamp(fillPct, 0, 100) + '%';
}

function renderWater() {
  const g = computeGoals().waterGoal;
  const t = waterTotal();
  const pct = g ? (t / g) * 100 : 0;
  // main
  const mw = $('#mainBottleWater'); if (mw) setBottle(mw, pct);
  animateCount($('#mainWaterMl'), t);
  const mg = $('#mainWaterGoal'); if (mg) mg.textContent = g;
  const wp = $('#waterPercent'); if (wp) wp.textContent = Math.round(pct) + '%';
  // log
  const log = $('#waterLog');
  if (log) {
    const items = day().waterLog;
    $('#waterLogCount').textContent = `${items.length} приёмов · ${t} мл`;
    if (!items.length) log.innerHTML = '<p class="empty">Сегодня ещё не пил воду. Нажми быструю кнопку слева.</p>';
    else log.innerHTML = items.slice().reverse().map((w) => {
      const tm = new Date(w.ts); return `<div class="wl-item">💧 <b>${w.ml}</b> мл <span class="wl-time">${pad(tm.getHours())}:${pad(tm.getMinutes())}</span></div>`;
    }).join('');
  }
  // reminder controls sync
  const r = state.settings.reminder;
  const re = $('#reminderEnabled'); if (re) re.checked = r.enabled;
  const ri = $('#reminderInterval'); if (ri) ri.value = r.intervalMinutes;
  const ril = $('#reminderIntervalLabel'); if (ril) ril.textContent = r.intervalMinutes;
  const qf = $('#quietFrom'); if (qf) qf.value = r.quietFrom;
  const qt = $('#quietTo'); if (qt) qt.value = r.quietTo;
}

/* ============================================================
   RINGS (canvas)
   ============================================================ */
function drawRing(canvas, pct, colorA, colorB) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 12;
  const lw = Math.max(9, r * 0.16);
  ctx.clearRect(0, 0, w, h);
  // track
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.stroke();
  // value
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, colorA); grad.addColorStop(1, colorB);
  const end = -Math.PI / 2 + (Math.PI * 2) * clamp(pct, 0, 1);
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, end);
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.strokeStyle = grad; ctx.stroke();
}

/* ============================================================
   NUTRITION
   ============================================================ */
// Meals + how the daily calorie norm is auto-split across them.
const MEALS = [
  { id: 'breakfast', name: 'Завтрак', icon: '🌅', pct: 0.25 },
  { id: 'lunch',     name: 'Обед',    icon: '🍽️', pct: 0.35 },
  { id: 'dinner',    name: 'Ужин',    icon: '🌙', pct: 0.30 },
  { id: 'snack',     name: 'Перекус', icon: '🍎', pct: 0.10 },
];
const MEAL_BY_ID = Object.fromEntries(MEALS.map((m) => [m.id, m]));
function mealByHour(h) { return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snack'; }
function currentMeal() { return mealByHour(new Date().getHours()); }

// Portion units -> grams per unit. Count-based units (шт/порция/…) use an average weight.
const UNITS = [
  ['g', 'г', 1], ['ml', 'мл', 1], ['tsp', 'ч.л.', 5], ['tbsp', 'ст.л.', 15],
  ['cup', 'стакан', 250], ['piece', 'шт', 100], ['plate', 'порция', 300], ['handful', 'горсть', 30],
];
const COUNT_UNITS = ['tsp', 'tbsp', 'cup', 'piece', 'plate', 'handful'];
function unitGrams(id) { const u = UNITS.find((x) => x[0] === id); return u ? u[2] : 1; }
function unitName(id) { const u = UNITS.find((x) => x[0] === id); return u ? u[1] : 'г'; }
function unitOptions(sel) { return UNITS.map((u) => `<option value="${u[0]}" ${u[0] === sel ? 'selected' : ''}>${u[1]}</option>`).join(''); }

function foodTotals(k = curKey()) {
  return day(k).foods.reduce((a, f) => ({
    kcal: a.kcal + (f.kcal || 0), prot: a.prot + (f.prot || 0),
    fat: a.fat + (f.fat || 0), carb: a.carb + (f.carb || 0),
  }), { kcal: 0, prot: 0, fat: 0, carb: 0 });
}

function addFood(f) {
  const meal = f.meal || ($('#foodMeal') ? $('#foodMeal').value : currentMeal());
  day().foods.push({ ...f, meal, ts: Date.now() });
  save();
  toast(`+ ${f.name} в «${MEAL_BY_ID[meal].name.toLowerCase()}» · ${Math.round(f.kcal)} ккал`, 'ok');
  renderNutrition(); renderDashboard(); updateTopbar();
}
function delFood(ts) {
  const d = day(); d.foods = d.foods.filter((f) => f.ts !== ts); save();
  renderNutrition(); renderDashboard(); updateTopbar();
}

function macroBar(label, val, goal, cls) {
  const pct = goal ? clamp((val / goal) * 100, 0, 100) : 0;
  return `<div class="macro"><div class="macro-top"><span>${label}</span><span>${Math.round(val)} / ${goal} г</span></div>
    <div class="macro-track"><div class="macro-fill ${cls}" style="width:${pct}%"></div></div></div>`;
}

function renderNutrition() {
  const G = computeGoals(); const t = foodTotals();
  animateCount($('#kcalNow'), t.kcal);
  const kg = $('#kcalGoal'); if (kg) kg.textContent = G.kcalGoal;
  const left = Math.round(G.kcalGoal - t.kcal);
  const kl = $('#kcalLeft'); if (kl) kl.textContent = left >= 0 ? `осталось ${left}` : `перебор ${-left}`;
  drawRing($('#kcalRing'), t.kcal / G.kcalGoal, '#34d399', '#22d3ee');
  const mb = $('#macroBars');
  if (mb) mb.innerHTML = macroBar('Белки', t.prot, G.macros.prot, 'prot') + macroBar('Жиры', t.fat, G.macros.fat, 'fat') + macroBar('Углеводы', t.carb, G.macros.carb, 'carb');
  // meal selector default
  const ms = $('#foodMeal'); if (ms && !ms.dataset.touched) ms.value = currentMeal();
  renderMeals();
}
// One food row inside a meal section.
function foodRowHTML(f) {
  const portion = (f.unit && f.unit !== 'g' && f.unit !== 'ml')
    ? `${round1(f.qty || 0)} ${unitName(f.unit)} · ${f.grams} г`
    : (f.grams ? `${f.grams} ${unitName(f.unit || 'g')}` : '');
  const thumb = f.img ? `<img class="fr-thumb" src="${f.img}" alt="">` : `<div class="fr-thumb" style="display:grid;place-items:center">${f.icon || '🍽️'}</div>`;
  return `<div class="fl-item">
    ${thumb}
    <div class="fr-body"><div class="fr-name">${escapeHtml(f.name)}</div>
      <div class="fr-meta">${portion ? portion + ' · ' : ''}Б ${Math.round(f.prot)} · Ж ${Math.round(f.fat)} · У ${Math.round(f.carb)}</div></div>
    <div class="fr-kcal">${Math.round(f.kcal)}</div>
    <button class="fl-del" data-ts="${f.ts}" title="Удалить">✕</button>
  </div>`;
}
function renderMeals() {
  const wrap = $('#mealsWrap'); if (!wrap) return;
  const G = computeGoals();
  const foods = day().foods;
  wrap.innerHTML = MEALS.map((m) => {
    const items = foods.filter((f) => (f.meal || 'snack') === m.id);
    const t = items.reduce((a, f) => ({ kcal: a.kcal + (f.kcal || 0), prot: a.prot + (f.prot || 0), fat: a.fat + (f.fat || 0), carb: a.carb + (f.carb || 0) }), { kcal: 0, prot: 0, fat: 0, carb: 0 });
    const target = Math.round(G.kcalGoal * m.pct);
    const pct = target ? clamp((t.kcal / target) * 100, 0, 100) : 0;
    const over = t.kcal > target * 1.08;
    const list = items.length
      ? items.slice().reverse().map(foodRowHTML).join('')
      : '<div class="meal-empty">Пусто</div>';
    return `<div class="meal-card" data-meal="${m.id}">
      <div class="meal-head">
        <div class="meal-title"><span class="meal-ic">${m.icon}</span><b>${m.name}</b></div>
        <div class="meal-kcal ${over ? 'over' : ''}">${Math.round(t.kcal)} <small>/ ${target} ккал</small></div>
      </div>
      <div class="meal-bar"><div class="meal-bar-fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
      <div class="meal-sub"><span class="meal-macros">Б ${Math.round(t.prot)} · Ж ${Math.round(t.fat)} · У ${Math.round(t.carb)}</span></div>
      <div class="meal-list">${list}</div>
      <button class="meal-add" data-addmeal="${m.id}">＋ Добавить</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.fl-del').forEach((b) => (b.onclick = () => delFood(Number(b.dataset.ts))));
  wrap.querySelectorAll('[data-addmeal]').forEach((b) => (b.onclick = () => {
    const ms = $('#foodMeal'); if (ms) { ms.value = b.dataset.addmeal; ms.dataset.touched = '1'; }
    $$('#foodTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.ftab === 'search'));
    $$('.ftab').forEach((f) => f.classList.toggle('active', f.dataset.ftab === 'search'));
    const card = $('#addFoodCard'); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const inp = $('#foodSearchInput'); if (inp) setTimeout(() => inp.focus(), 120);
    toast(`Добавляем в «${MEAL_BY_ID[b.dataset.addmeal].name}»`);
  }));
}

/* ---------- HTTP ----------
   Requests to external APIs are routed around browser CORS:
   - Electron: through the main process (window.desktop.request)
   - Served over http (our local server.js): through same-origin /proxy
   - Opened as a plain file:// : direct fetch (may hit CORS on some endpoints)
   All proxied paths return { ok, status, body }. */
const SERVED = location.protocol === 'http:' || location.protocol === 'https:';
let proxyAvail = null; // null=unknown, true=local server proxy works, false=static host (GitHub Pages)

async function proxyRequest(url, options) {
  if (DESKTOP) return window.desktop.request(url, options);
  const res = await fetch('/proxy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, options: options || {} }),
  });
  if (!res.ok) throw new Error('no-proxy'); // static host: /proxy doesn't exist
  return res.json();
}
async function httpJSON(url, options) {
  if (DESKTOP) {
    const r = await window.desktop.request(url, options);
    if (r.error) throw new Error(r.error);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.body);
  }
  // Served over http(s): prefer the same-origin proxy (dodges CORS). If there is no
  // proxy (static hosting like GitHub Pages), fall back to a direct request.
  if (SERVED && proxyAvail !== false) {
    try {
      const r = await proxyRequest(url, options);
      proxyAvail = true;
      if (r.error) throw new Error(r.error);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return JSON.parse(r.body);
    } catch (e) {
      if (proxyAvail === true) throw e; // proxy works, this was a real target error
      proxyAvail = false; // no proxy here — fall through to direct fetch
    }
  }
  const res = await fetch(url, options);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ---------- Open Food Facts ---------- */
const OFF = 'https://world.openfoodfacts.org';
function offNutr(n = {}) {
  return {
    kcal: n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : 0),
    prot: n['proteins_100g'] || 0, fat: n['fat_100g'] || 0, carb: n['carbohydrates_100g'] || 0,
  };
}
function offName(p) { return p.product_name_ru || p.product_name || p.generic_name || p.brands || 'Без названия'; }
function offImage(p) {
  return p.image_small_url || p.image_front_small_url || p.image_thumb_url || p.image_front_url || p.image_url || '';
}
const OFF_FIELDS = 'product_name,product_name_ru,generic_name,brands,nutriments,image_small_url,image_front_small_url,image_thumb_url,image_url,code';

/* ---------- Local RU food base (per 100 g) ----------
   Instant, offline, reliable. Open Food Facts (Cyrillic full-text) is very slow,
   so this is the primary source; OFF is queried in the background for photos. */
const FOODS_RU = [
  ['Банан', '🍌', 89, 1.1, 0.3, 23], ['Яблоко', '🍎', 52, 0.3, 0.2, 14], ['Груша', '🍐', 57, 0.4, 0.1, 15],
  ['Апельсин', '🍊', 47, 0.9, 0.1, 12], ['Мандарин', '🍊', 53, 0.8, 0.3, 13], ['Виноград', '🍇', 69, 0.6, 0.2, 18],
  ['Клубника', '🍓', 33, 0.7, 0.3, 8], ['Арбуз', '🍉', 30, 0.6, 0.2, 8], ['Лимон', '🍋', 29, 1.1, 0.3, 9],
  ['Персик', '🍑', 39, 0.9, 0.3, 10], ['Ананас', '🍍', 50, 0.5, 0.1, 13], ['Киви', '🥝', 61, 1.1, 0.5, 15],
  ['Авокадо', '🥑', 160, 2, 15, 9], ['Манго', '🥭', 60, 0.8, 0.4, 15],
  ['Помидор', '🍅', 18, 0.9, 0.2, 3.9], ['Огурец', '🥒', 15, 0.7, 0.1, 3.6], ['Морковь', '🥕', 41, 0.9, 0.2, 10],
  ['Картофель', '🥔', 77, 2, 0.1, 17], ['Картофель варёный', '🥔', 82, 2, 0.1, 17], ['Лук репчатый', '🧅', 40, 1.1, 0.1, 9],
  ['Капуста', '🥬', 25, 1.3, 0.1, 6], ['Брокколи', '🥦', 34, 2.8, 0.4, 7], ['Перец болгарский', '🫑', 27, 1, 0.3, 6],
  ['Кукуруза', '🌽', 86, 3.2, 1.2, 19], ['Свёкла', '🥗', 43, 1.6, 0.2, 10], ['Чеснок', '🧄', 149, 6.4, 0.5, 33],
  ['Курица грудка', '🍗', 165, 31, 3.6, 0], ['Курица бедро', '🍗', 209, 26, 11, 0], ['Куриное филе жареное', '🍗', 197, 30, 8, 0],
  ['Говядина', '🥩', 187, 26, 9, 0], ['Свинина', '🥩', 242, 27, 14, 0], ['Индейка', '🦃', 189, 29, 7, 0],
  ['Фарш говяжий', '🥩', 254, 17, 20, 0], ['Сосиски', '🌭', 266, 11, 24, 2], ['Колбаса варёная', '🥓', 257, 13, 22, 1.5],
  ['Бекон', '🥓', 541, 37, 42, 1.4], ['Яйцо куриное', '🥚', 155, 13, 11, 1.1], ['Яичница', '🍳', 196, 14, 15, 1],
  ['Лосось', '🐟', 208, 20, 13, 0], ['Тунец', '🐟', 132, 28, 1, 0], ['Тунец консерв.', '🐟', 116, 26, 1, 0],
  ['Креветки', '🦐', 99, 24, 0.3, 0.2], ['Сельдь', '🐟', 158, 18, 9, 0], ['Треска', '🐟', 82, 18, 0.7, 0],
  ['Молоко 2.5%', '🥛', 52, 2.9, 2.5, 4.7], ['Молоко 3.2%', '🥛', 59, 2.9, 3.2, 4.7], ['Кефир 1%', '🥛', 40, 3, 1, 4],
  ['Творог 5%', '🧀', 121, 17, 5, 3], ['Творог 9%', '🧀', 159, 16, 9, 3], ['Творог обезжир.', '🧀', 71, 18, 0.6, 1.8],
  ['Сыр твёрдый', '🧀', 364, 25, 29, 0.5], ['Сыр плавленый', '🧀', 290, 12, 24, 5], ['Сметана 20%', '🥛', 206, 2.8, 20, 3.2],
  ['Йогурт натуральный', '🥛', 60, 4.3, 3, 6], ['Йогурт греческий', '🥛', 97, 9, 5, 4], ['Масло сливочное', '🧈', 748, 0.5, 82, 0.8],
  ['Рис варёный', '🍚', 116, 2.2, 0.5, 25], ['Рис (сухой)', '🍚', 344, 6.7, 0.7, 78], ['Гречка варёная', '🥣', 110, 4, 1.1, 21],
  ['Гречка (сухая)', '🥣', 343, 13, 3.4, 62], ['Овсянка на воде', '🥣', 88, 3, 1.7, 15], ['Овсяные хлопья', '🥣', 366, 12, 7, 62],
  ['Макароны варёные', '🍝', 131, 5, 1.1, 25], ['Паста (сухая)', '🍝', 371, 13, 1.5, 75], ['Пшено варёное', '🥣', 90, 3, 0.7, 17],
  ['Перловка варёная', '🥣', 106, 2.3, 0.4, 22], ['Булгур варёный', '🥣', 83, 3, 0.2, 19], ['Киноа варёная', '🥣', 120, 4.4, 1.9, 21],
  ['Хлеб белый', '🍞', 265, 8, 3.2, 49], ['Хлеб чёрный', '🍞', 214, 6.6, 1.2, 40], ['Батон', '🍞', 264, 7.5, 2.9, 51],
  ['Лаваш', '🫓', 236, 7.9, 1, 48], ['Хлебцы', '🍘', 295, 11, 3, 57],
  ['Фасоль варёная', '🫘', 123, 8, 0.5, 21], ['Чечевица варёная', '🫘', 116, 9, 0.4, 20], ['Нут варёный', '🫘', 164, 9, 2.6, 27],
  ['Горох', '🫛', 81, 5, 0.4, 14], ['Тофу', '🧈', 76, 8, 4.8, 1.9],
  ['Грецкий орех', '🌰', 654, 15, 65, 14], ['Миндаль', '🌰', 579, 21, 50, 22], ['Арахис', '🥜', 567, 26, 49, 16],
  ['Кешью', '🥜', 553, 18, 44, 30], ['Фундук', '🌰', 628, 15, 61, 17], ['Семечки подсолнечные', '🌻', 584, 21, 52, 20],
  ['Арахисовая паста', '🥜', 588, 25, 50, 20], ['Мёд', '🍯', 304, 0.3, 0, 82], ['Сахар', '🍬', 387, 0, 0, 100],
  ['Шоколад молочный', '🍫', 535, 8, 30, 59], ['Шоколад тёмный', '🍫', 546, 5, 31, 61], ['Печенье', '🍪', 417, 6, 15, 65],
  ['Мороженое', '🍨', 207, 3.5, 11, 24], ['Торт', '🍰', 350, 5, 18, 43], ['Пончик', '🍩', 452, 5, 25, 51],
  ['Чипсы', '🍟', 536, 6, 35, 53], ['Картофель фри', '🍟', 312, 3.4, 15, 41], ['Пицца', '🍕', 266, 11, 10, 33],
  ['Бургер', '🍔', 295, 17, 14, 24], ['Шаурма', '🌯', 215, 12, 11, 18], ['Суши ролл', '🍣', 145, 5, 4, 22],
  ['Пельмени', '🥟', 275, 12, 12, 29], ['Блины', '🥞', 227, 6, 8, 33], ['Сырники', '🧀', 220, 15, 10, 18],
  ['Каша манная', '🥣', 98, 3, 3.2, 15], ['Плов', '🍚', 190, 5, 8, 24], ['Борщ', '🍲', 49, 1.6, 2.7, 5],
  ['Суп куриный', '🍲', 36, 2.5, 1.5, 3], ['Салат овощной', '🥗', 55, 1.2, 3.5, 5],
  ['Кофе чёрный', '☕', 2, 0.1, 0, 0], ['Кофе с молоком', '☕', 35, 1.8, 1.5, 3.6], ['Чай без сахара', '🍵', 1, 0, 0, 0],
  ['Сок апельсиновый', '🧃', 45, 0.7, 0.2, 10], ['Кола', '🥤', 42, 0, 0, 11], ['Пиво', '🍺', 43, 0.5, 0, 3.6],
  ['Вино красное', '🍷', 68, 0.1, 0, 2.6], ['Протеин (порошок)', '💪', 375, 75, 5, 10], ['Протеиновый батончик', '🍫', 350, 30, 12, 35],
  ['Оливковое масло', '🫒', 884, 0, 100, 0], ['Растительное масло', '🫗', 899, 0, 99.9, 0],
  // fruits & berries
  ['Гранат', '🍎', 72, 0.9, 0.3, 14], ['Слива', '🍑', 46, 0.8, 0.3, 11], ['Черешня', '🍒', 50, 1.1, 0.4, 12],
  ['Вишня', '🍒', 52, 0.8, 0.5, 11], ['Малина', '🍓', 46, 0.8, 0.5, 8], ['Черника', '🫐', 44, 1.1, 0.4, 8],
  ['Смородина', '🫐', 44, 1, 0.4, 8], ['Хурма', '🍊', 67, 0.5, 0.4, 15], ['Дыня', '🍈', 35, 0.6, 0.3, 7],
  ['Грейпфрут', '🍊', 35, 0.7, 0.2, 8], ['Абрикос', '🍑', 44, 0.9, 0.1, 9],
  // vegetables
  ['Кабачок', '🥒', 24, 0.6, 0.3, 4.6], ['Баклажан', '🍆', 24, 1, 0.2, 6], ['Тыква', '🎃', 26, 1, 0.1, 6],
  ['Редис', '🥗', 20, 1.2, 0.1, 3.4], ['Шпинат', '🥬', 23, 2.9, 0.4, 3.6], ['Шампиньоны', '🍄', 22, 3.1, 0.3, 3.3],
  ['Зелёный горошек', '🫛', 81, 5, 0.4, 14], ['Стручковая фасоль', '🫛', 31, 1.8, 0.1, 7],
  // grains
  ['Рис бурый', '🍚', 111, 2.6, 0.9, 23], ['Кускус варёный', '🥣', 112, 3.8, 0.2, 23], ['Спагетти варёные', '🍝', 131, 5, 1.1, 25],
  ['Пшеничная каша', '🥣', 90, 3, 0.4, 18], ['Овсяноблин', '🥞', 180, 12, 8, 14], ['Мюсли', '🥣', 352, 9, 6, 65],
  ['Гранола', '🥣', 471, 10, 20, 64], ['Кукурузные хлопья', '🥣', 357, 7, 0.9, 84],
  // meat / fish
  ['Куриные крылья', '🍗', 222, 24, 14, 0], ['Куриная печень', '🍗', 137, 20, 6, 0.7], ['Печень говяжья', '🥩', 127, 20, 3.6, 4],
  ['Котлета', '🍖', 261, 15, 20, 8], ['Стейк говяжий', '🥩', 271, 25, 19, 0], ['Шашлык свиной', '🍢', 280, 20, 22, 0],
  ['Наггетсы', '🍗', 296, 15, 19, 16], ['Скумбрия', '🐟', 191, 18, 13, 0], ['Минтай', '🐟', 72, 16, 0.9, 0],
  ['Кальмар', '🦑', 92, 18, 2.2, 2], ['Крабовые палочки', '🦀', 88, 6, 1, 14], ['Икра красная', '🐟', 249, 32, 13, 0],
  // dairy
  ['Ряженка', '🥛', 54, 2.9, 2.5, 4.2], ['Сливки 10%', '🥛', 118, 3, 10, 4], ['Сгущёнка', '🥫', 320, 7.2, 8.5, 56],
  ['Моцарелла', '🧀', 280, 22, 22, 2], ['Фета', '🧀', 265, 14, 21, 4], ['Брынза', '🧀', 260, 17, 20, 0],
  ['Сырок глазированный', '🍫', 407, 8.5, 27, 32], ['Питьевой йогурт', '🥛', 68, 2.8, 1.5, 11],
  // snacks / sweets
  ['Сухофрукты', '🍇', 280, 2.5, 0.5, 68], ['Курага', '🍑', 241, 3.4, 0.5, 55], ['Чернослив', '🍇', 231, 2.3, 0.4, 57],
  ['Изюм', '🍇', 299, 3.1, 0.5, 79], ['Финики', '🌴', 277, 1.8, 0.2, 75], ['Зефир', '🍬', 304, 0.8, 0, 78],
  ['Мармелад', '🍬', 321, 0.4, 0.1, 79], ['Халва', '🍯', 523, 12, 30, 54], ['Вафли', '🧇', 425, 8, 12, 71],
  ['Пряник', '🍪', 364, 5, 3, 77], ['Круассан', '🥐', 406, 8, 21, 46], ['Кекс', '🧁', 380, 6, 15, 55],
  // dishes
  ['Хот-дог', '🌭', 247, 10, 15, 18], ['Чебурек', '🥟', 264, 8, 15, 24], ['Хачапури', '🧀', 285, 10, 14, 30],
  ['Вареники с картошкой', '🥟', 165, 4.4, 3.7, 29], ['Оладьи', '🥞', 208, 5, 5, 35], ['Омлет', '🍳', 184, 10, 15, 2],
  ['Рисовая каша молочная', '🥣', 97, 2.5, 3.1, 16], ['Гречневая каша молочная', '🥣', 100, 3.2, 2.9, 16],
  ['Уха', '🍲', 46, 4, 2, 2], ['Щи', '🍲', 34, 1.2, 2, 3], ['Гороховый суп', '🍲', 66, 4, 2, 8], ['Солянка', '🍲', 62, 4, 4, 3],
  // drinks
  ['Компот', '🧃', 60, 0.1, 0, 15], ['Морс', '🧃', 41, 0.1, 0, 10], ['Смузи', '🥤', 60, 1, 0.5, 13],
  ['Какао с молоком', '☕', 85, 3.5, 3.2, 11], ['Латте', '☕', 44, 2.4, 1.8, 5], ['Капучино', '☕', 40, 2, 1.7, 4],
  ['Энергетик', '🥤', 45, 0, 0, 11], ['Квас', '🥤', 27, 0.2, 0, 5], ['Лимонад', '🥤', 40, 0, 0, 10], ['Минералка', '💧', 0, 0, 0, 0],
  // sauces
  ['Кетчуп', '🍅', 112, 1.8, 0.2, 26], ['Майонез', '🥚', 627, 1.2, 67, 3], ['Горчица', '🌭', 143, 9.9, 4, 22],
  ['Соевый соус', '🍶', 53, 8, 0, 5], ['Сыр Российский', '🧀', 363, 23, 30, 0],
  // sandwiches / toasts
  ['Бутерброд с колбасой', '🥪', 280, 10, 16, 24], ['Бутерброд с сыром', '🥪', 300, 12, 18, 22],
  ['Бутерброд с маслом', '🥪', 330, 7, 20, 30], ['Бутерброд с икрой', '🥪', 270, 12, 12, 26],
  ['Тост с сыром', '🍞', 312, 13, 17, 27], ['Сэндвич с ветчиной', '🥪', 250, 11, 10, 28],
  ['Клаб-сэндвич', '🥪', 290, 14, 15, 25], ['Гренки', '🍞', 380, 8, 18, 45],
  ['Хлеб с маслом', '🍞', 335, 6, 19, 33], ['Канапе', '🥪', 260, 9, 15, 22],
  ['Хот-дог в тесте', '🌭', 290, 9, 16, 27],
  // salads
  ['Оливье', '🥗', 198, 6, 15, 10], ['Салат Цезарь', '🥗', 180, 11, 13, 5], ['Греческий салат', '🥗', 110, 3, 9, 5],
  ['Крабовый салат', '🥗', 170, 6, 12, 9], ['Винегрет', '🥗', 76, 1.5, 4, 9], ['Мимоза', '🥗', 210, 8, 17, 5],
  ['Селёдка под шубой', '🥗', 195, 6, 14, 10], ['Салат из капусты', '🥗', 60, 1.5, 3, 7],
  // dishes / sides
  ['Картофельное пюре', '🥔', 88, 2, 3.5, 13], ['Жареная картошка', '🍟', 192, 2.8, 9, 25],
  ['Макароны по-флотски', '🍝', 210, 10, 10, 20], ['Гуляш', '🍲', 148, 14, 8, 4], ['Овощное рагу', '🍲', 70, 2, 3, 9],
  ['Голубцы', '🥬', 110, 6, 6, 8], ['Фаршированный перец', '🫑', 120, 6, 7, 8], ['Творожная запеканка', '🧀', 168, 17, 5, 14],
  ['Лазанья', '🍝', 180, 9, 9, 16], ['Ризотто', '🍚', 160, 4, 5, 24], ['Тефтели', '🍖', 170, 12, 10, 7],
  ['Люля-кебаб', '🍢', 245, 15, 20, 2], ['Шницель', '🍖', 270, 16, 17, 13], ['Котлета по-киевски', '🍗', 290, 17, 20, 10],
  ['Рыба жареная', '🐟', 180, 20, 10, 3], ['Рыбные котлеты', '🐟', 180, 14, 10, 8], ['Драники', '🥔', 200, 4, 11, 22],
  // meat / deli
  ['Ветчина', '🥓', 270, 16, 22, 0], ['Буженина', '🥩', 233, 15, 19, 0], ['Карбонад', '🥩', 135, 16, 8, 0],
  ['Курица копчёная', '🍗', 184, 18, 12, 0], ['Салями', '🥓', 420, 21, 38, 1], ['Сервелат', '🥓', 360, 16, 32, 1],
  ['Стейк индейки', '🦃', 195, 24, 10, 0], ['Куриный рулет', '🍗', 190, 18, 12, 1],
  // fish
  ['Сёмга', '🐟', 201, 20, 13, 0], ['Форель', '🐟', 141, 20, 6, 0], ['Шпроты', '🐟', 363, 17, 32, 0],
  ['Сельдь солёная', '🐟', 217, 19, 15, 0], ['Кальмары жареные', '🦑', 150, 16, 7, 5], ['Мидии', '🦪', 77, 12, 2, 3],
  // dairy
  ['Кефир 2.5%', '🥛', 53, 2.9, 2.5, 4], ['Айран', '🥛', 24, 1, 1, 1.5], ['Творожная масса', '🧀', 340, 7, 23, 27],
  ['Творожный сыр', '🧀', 260, 6, 24, 5], ['Маскарпоне', '🧀', 412, 5, 44, 4], ['Пармезан', '🧀', 392, 36, 26, 3],
  // baking / sweets
  ['Ватрушка', '🧀', 290, 7, 9, 45], ['Булочка', '🥐', 300, 8, 7, 52], ['Пирожок с картошкой', '🥟', 250, 5, 10, 35],
  ['Пирожок с мясом', '🥟', 270, 9, 12, 32], ['Чизкейк', '🍰', 321, 6, 22, 26], ['Тирамису', '🍰', 300, 5, 20, 25],
  ['Эклер', '🍥', 360, 6, 24, 32], ['Маффин', '🧁', 380, 5, 18, 50], ['Овсяное печенье', '🍪', 437, 6, 16, 68],
  ['Пломбир', '🍨', 232, 3.5, 15, 21], ['Пастила', '🍬', 324, 0.5, 0, 80], ['Батончик Snickers', '🍫', 480, 9, 24, 60],
  ['Варенье', '🍯', 270, 0.3, 0, 68], ['Круассан с шоколадом', '🥐', 420, 8, 22, 48],
  // fast food
  ['Чизбургер', '🍔', 303, 15, 15, 28], ['Двойной бургер', '🍔', 350, 20, 20, 25], ['Картошка по-деревенски', '🍟', 180, 3, 7, 27],
  ['Крылышки BBQ', '🍗', 250, 20, 16, 6], ['Буррито', '🌯', 210, 8, 8, 26], ['Тако', '🌮', 220, 9, 11, 20],
  ['Начос', '🧀', 330, 6, 18, 38], ['Попкорн', '🍿', 400, 10, 12, 63], ['Сухарики', '🍘', 390, 11, 12, 60],
  ['Крекеры', '🍘', 421, 9, 14, 66],
  // nuts / seeds
  ['Кедровые орехи', '🌰', 673, 14, 68, 13], ['Тыквенные семечки', '🎃', 556, 30, 49, 11], ['Кунжут', '🌱', 565, 20, 49, 12],
  ['Семена чиа', '🌱', 486, 17, 31, 42], ['Льняные семена', '🌱', 534, 18, 42, 29],
  // fruit / veg
  ['Инжир', '🍈', 74, 0.8, 0.3, 19], ['Нектарин', '🍑', 44, 1.1, 0.3, 11], ['Ежевика', '🫐', 43, 1.4, 0.5, 9],
  ['Голубика', '🫐', 57, 0.7, 0.3, 14], ['Оливки', '🫒', 115, 0.8, 11, 6], ['Маслины', '🫒', 115, 0.8, 11, 6],
  ['Квашеная капуста', '🥬', 19, 0.9, 0.1, 4], ['Солёный огурец', '🥒', 11, 0.8, 0.1, 1.7], ['Помидоры черри', '🍅', 18, 0.9, 0.2, 3.9],
  // drinks
  ['Кокосовая вода', '🥥', 19, 0.7, 0.2, 3.7], ['Кисель', '🥤', 53, 0, 0, 13], ['Молочный коктейль', '🥤', 110, 3.5, 3, 17],
  ['Виски', '🥃', 250, 0, 0, 0], ['Водка', '🍸', 231, 0, 0, 0], ['Шампанское', '🍾', 88, 0.2, 0, 1.4],
  // sauces
  ['Песто', '🌿', 450, 5, 45, 6], ['Соус барбекю', '🍖', 172, 1, 1, 40], ['Аджика', '🌶️', 59, 1, 3.7, 5], ['Табаско', '🌶️', 12, 1, 0.5, 1],
  // branded snacks & sweets (Russian spelling — how they're actually searched)
  ['Чоко Пай', '🍫', 439, 4.5, 16, 68], ['Барни', '🐻', 385, 6, 14, 58], ['Киндер Шоколад', '🍫', 566, 8.7, 35, 53],
  ['Киндер Буэно', '🍫', 572, 9, 37, 50], ['Киндер Сюрприз', '🥚', 566, 8.7, 35, 53], ['Нутелла', '🍫', 539, 6.3, 31, 57],
  ['Твикс', '🍫', 495, 4.7, 24, 64], ['Марс', '🍫', 449, 4, 17, 70], ['Баунти', '🥥', 483, 4, 26, 58],
  ['Кит-Кат', '🍫', 518, 6.6, 27, 61], ['Милки Вэй', '🍫', 456, 3.7, 16, 73], ['Альпен Гольд', '🍫', 549, 6.5, 32, 58],
  ['Рафаэлло', '🥥', 615, 6.5, 47, 42], ['Ферреро Роше', '🍫', 580, 8, 42, 44], ['Милка', '🍫', 530, 6.6, 29, 59],
  ['Эмэндэмс', '🍫', 492, 4.6, 20, 71], ['Принглс', '🍟', 533, 4, 34, 51], ['Лейс', '🥔', 550, 6, 35, 52],
  ['Орео', '🍪', 480, 5, 20, 70], ['Бельвита', '🍪', 450, 8, 14, 70], ['Сникерс', '🍫', 480, 9, 24, 60],
  // branded dairy
  ['Растишка', '🥛', 98, 3.5, 2, 16], ['Активиа', '🥛', 90, 4.4, 3.2, 11], ['Чудо йогурт', '🥛', 85, 2.8, 2.4, 13],
  ['Данон', '🥛', 87, 4, 2.5, 12], ['Актимель', '🥛', 71, 2.6, 1.5, 11], ['Эпика', '🥛', 92, 8, 3, 8],
  ['Кола Зеро', '🥤', 0, 0, 0, 0], ['Кока-Кола', '🥤', 42, 0, 0, 11], ['Пепси', '🥤', 43, 0, 0, 11], ['Спрайт', '🥤', 40, 0, 0, 10],
  ['Фанта', '🥤', 48, 0, 0, 12], ['Ред Булл', '🥤', 45, 0, 0, 11], ['Адреналин Раш', '🥤', 48, 0, 0, 12],
  // fast food
  ['Биг Мак', '🍔', 257, 12, 15, 17], ['Воппер', '🍔', 240, 11, 14, 17], ['Чикенбургер', '🍔', 260, 13, 11, 27],
  ['Макфлурри', '🍨', 175, 3.5, 5, 28], ['Твистер', '🌯', 220, 9, 10, 24], ['Айс латте', '☕', 60, 2, 2.5, 8],
  ['Фри большая', '🍟', 312, 3.4, 15, 41], ['Луковые кольца', '🧅', 411, 5.4, 26, 40], ['Донер', '🌯', 215, 12, 11, 18],
  // common foods
  ['Яйцо перепелиное', '🥚', 168, 12, 13, 0.6], ['Сыр косичка', '🧀', 313, 20, 26, 2], ['Хумус', '🥣', 166, 8, 10, 14],
  ['Гуакамоле', '🥑', 150, 2, 14, 8], ['Кукуруза консерв.', '🌽', 58, 2.2, 0.4, 11], ['Горошек консерв.', '🫛', 55, 3.6, 0.2, 9],
  ['Тортилья', '🫓', 310, 8, 8, 50], ['Пита', '🫓', 275, 9, 1.2, 55], ['Багет', '🥖', 270, 9, 3, 52],
  ['Протеиновый коктейль', '🥤', 60, 6, 1.5, 5], ['Гейнер', '💪', 380, 15, 5, 70], ['Яблочное пюре', '🍎', 82, 0.2, 0.2, 21],
  ['Кокос', '🥥', 354, 3.3, 33, 15], ['Рамен', '🍜', 88, 4, 3, 11], ['Удон', '🍜', 130, 4.5, 0.6, 27],
  ['Фунчоза', '🍜', 110, 0.2, 0.1, 27], ['Кимчи', '🥬', 34, 1.7, 0.5, 6], ['Спаржа', '🥬', 20, 2.2, 0.1, 3.9],
  ['Брюссельская капуста', '🥬', 43, 3.4, 0.3, 9], ['Цветная капуста', '🥦', 25, 1.9, 0.3, 5], ['Руккола', '🥬', 25, 2.6, 0.7, 3.7],
  ['Салат айсберг', '🥬', 14, 0.9, 0.1, 3], ['Имбирь', '🫚', 80, 1.8, 0.8, 18], ['Базилик', '🌿', 23, 3.2, 0.6, 2.7],
  // meat / fish
  ['Куриный фарш', '🍗', 143, 17, 8, 0], ['Фарш индейки', '🦃', 150, 18, 8, 0], ['Дорадо', '🐟', 96, 18, 3, 0],
  ['Сибас', '🐟', 97, 18, 2.5, 0], ['Тилапия', '🐟', 96, 20, 1.7, 0], ['Хек', '🐟', 86, 16, 2, 0],
  ['Ягнёнок', '🥩', 209, 25, 12, 0], ['Утка', '🦆', 337, 16, 30, 0], ['Кролик', '🐰', 156, 21, 8, 0],
  // sweets / baking
  ['Пахлава', '🍯', 480, 6, 27, 55], ['Чак-чак', '🍯', 380, 5, 8, 72], ['Рахат-лукум', '🍬', 340, 0.8, 0.4, 84],
  ['Козинак', '🌰', 490, 12, 28, 50], ['Блин с мясом', '🥞', 250, 10, 12, 25], ['Блин с творогом', '🥞', 210, 8, 8, 27],
  ['Каша кукурузная', '🥣', 86, 2, 0.6, 18], ['Панкейки', '🥞', 227, 6, 8, 33], ['Творожная запеканка', '🧀', 168, 17, 5, 14],
  // --- more porridges (cooked, per 100 g) ---
  ['Овсяная каша на молоке', '🥣', 102, 3.2, 4.1, 14], ['Пшённая каша на молоке', '🥣', 103, 3, 2.5, 17], ['Ячневая каша', '🥣', 96, 2.3, 0.3, 20],
  ['Полба варёная', '🥣', 127, 5.5, 0.9, 26], ['Каша 5 злаков', '🥣', 100, 3, 2, 17], ['Гороховая каша', '🥣', 90, 6, 1, 16],
  ['Тыквенная каша', '🥣', 82, 1.2, 2.6, 14], ['Рис басмати варёный', '🍚', 120, 3, 0.5, 25], ['Рис жасмин варёный', '🍚', 129, 2.7, 0.3, 28],
  ['Дикий рис варёный', '🍚', 101, 4, 0.3, 21], ['Овсянка запаренная (ПП)', '🥣', 110, 4, 3, 17], ['Гранола с йогуртом', '🥣', 150, 5, 5, 22],
  ['Смузи-боул', '🥣', 120, 3, 3, 20],
  // --- fast food ---
  ['Ролл Цезарь', '🌯', 210, 10, 9, 22], ['Стрипсы куриные', '🍗', 240, 18, 12, 15], ['Боксмастер', '🌯', 230, 11, 10, 24],
  ['Филе-о-Фиш', '🍔', 250, 10, 12, 26], ['Роял чизбургер', '🍔', 280, 14, 15, 22], ['Макчикен', '🍔', 240, 10, 12, 24],
  ['Чикен Кинг', '🍔', 260, 12, 13, 22], ['Корн-дог', '🌭', 260, 9, 15, 22], ['Дюрюм', '🌯', 220, 11, 9, 24],
  ['Кесадилья', '🫓', 280, 12, 16, 22], ['Фахитас', '🌮', 180, 12, 8, 15], ['Энчилада', '🌯', 200, 9, 10, 18],
  ['Чили кон карне', '🌶️', 130, 9, 5, 12], ['Гирос', '🌯', 215, 12, 10, 20], ['Веган-бургер', '🍔', 220, 9, 9, 26],
  // --- italian ---
  ['Паста карбонара', '🍝', 190, 8, 9, 20], ['Паста болоньезе', '🍝', 150, 8, 5, 18], ['Паста песто', '🍝', 230, 7, 12, 24],
  ['Брускетта', '🍞', 190, 5, 8, 25], ['Капрезе', '🥗', 190, 9, 15, 4], ['Минестроне', '🍲', 45, 2, 1.5, 6],
  ['Равиоли', '🥟', 200, 8, 7, 26], ['Ньокки', '🥔', 160, 4, 2, 32], ['Панна котта', '🍮', 240, 4, 16, 20],
  ['Фокачча', '🫓', 270, 7, 8, 42], ['Кальцоне', '🥟', 260, 11, 11, 30],
  // --- japanese / asian ---
  ['Ролл Филадельфия', '🍣', 230, 9, 11, 22], ['Ролл Калифорния', '🍣', 175, 6, 6, 24], ['Спайси ролл', '🍣', 190, 7, 8, 22],
  ['Нигири с лососем', '🍣', 150, 6, 3, 24], ['Сашими лосось', '🐟', 130, 20, 5, 0], ['Темпура', '🍤', 200, 10, 10, 18],
  ['Гёдза', '🥟', 210, 9, 10, 22], ['Мисо-суп', '🍲', 40, 3, 1.5, 4], ['Онигири', '🍙', 170, 4, 1, 35],
  ['Курица терияки', '🍗', 190, 15, 8, 14], ['Вок с курицей', '🍜', 130, 9, 5, 12], ['Том ям', '🍲', 60, 5, 3, 4],
  ['Пад тай', '🍜', 150, 7, 5, 20], ['Утка по-пекински', '🦆', 240, 19, 18, 2], ['Свинина кисло-сладкая', '🍖', 180, 10, 8, 18],
  ['Курица кунг-пао', '🍗', 200, 14, 12, 10], ['Жареный рис с овощами', '🍚', 160, 4, 5, 25], ['Димсам', '🥟', 180, 8, 7, 22],
  ['Спринг-роллы', '🥟', 150, 4, 5, 22],
  // --- indian / middle east ---
  ['Курица тикка масала', '🍛', 160, 12, 9, 6], ['Карри с курицей', '🍛', 140, 11, 8, 6], ['Наан', '🫓', 310, 9, 6, 52],
  ['Самоса', '🥟', 280, 8, 16, 26], ['Фалафель', '🧆', 330, 13, 18, 32], ['Дал чечевичный', '🍲', 120, 6, 4, 15],
  ['Бирьяни', '🍚', 180, 8, 6, 24], ['Долма', '🍃', 170, 5, 11, 13], ['Табуле', '🥗', 120, 3, 6, 14],
  ['Кускус с овощами', '🥣', 130, 4, 3, 22], ['Шакшука', '🍳', 100, 6, 7, 5],
  // --- georgian ---
  ['Хинкали', '🥟', 200, 8, 8, 24], ['Лобио', '🫘', 130, 7, 4, 17], ['Сациви', '🍗', 220, 12, 17, 5],
  ['Чахохбили', '🍗', 120, 10, 7, 4], ['Аджапсандали', '🍆', 90, 2, 6, 8], ['Хачапури по-аджарски', '🧀', 300, 11, 15, 30],
  // --- korean ---
  ['Бибимбап', '🍚', 130, 6, 4, 18], ['Токпокки', '🌶️', 180, 4, 3, 34], ['Кимпаб', '🍙', 150, 4, 3, 27],
  // --- american / european ---
  ['Рёбрышки BBQ', '🍖', 290, 20, 20, 8], ['Мак-энд-чиз', '🧀', 180, 7, 8, 20], ['Клэм-чаудер', '🍲', 90, 4, 5, 8],
  ['Крем-брюле', '🍮', 290, 4, 20, 24], ['Профитроли', '🍥', 360, 6, 22, 34], ['Луковый суп', '🍲', 45, 2, 2, 5],
  ['Киш лорен', '🥧', 280, 9, 20, 16], ['Рататуй', '🍆', 80, 2, 5, 8], ['Клаб-сэндвич', '🥪', 260, 13, 13, 22],
  // --- slavic ---
  ['Окрошка', '🍲', 60, 3, 3, 5], ['Холодец', '🍖', 110, 15, 5, 1], ['Рассольник', '🍲', 50, 2, 2, 6],
  ['Куриный бульон', '🍲', 15, 2, 0.5, 0.5], ['Заливное', '🐟', 90, 12, 4, 1], ['Пшёнка на воде', '🥣', 90, 3, 0.7, 17],
  // --- drinks ---
  ['Раф кофе', '☕', 120, 3, 8, 10], ['Флэт уайт', '☕', 55, 3, 3, 4], ['Матча латте', '🍵', 60, 2, 2.5, 8],
  ['Бабл-ти', '🧋', 90, 0.5, 1, 20], ['Горячий шоколад', '☕', 110, 3.5, 4, 16], ['Апельсиновый фреш', '🍊', 45, 0.7, 0.2, 10],
  // --- healthy / bowls ---
  ['Поке-боул', '🍚', 130, 10, 4, 14], ['Боул с курицей и рисом', '🍚', 150, 12, 4, 18], ['Протеиновые панкейки', '🥞', 170, 15, 5, 15],
  ['Греческий йогурт с мёдом', '🥛', 120, 6, 3, 16], ['Авокадо-тост', '🥑', 210, 6, 13, 18], ['Яйцо пашот', '🥚', 143, 12.5, 10, 0.7],
].map(([name, icon, kcal, prot, fat, carb]) => ({ name, icon, kcal, prot, fat, carb, local: true }));

function normFood(s) { return String(s).toLowerCase().replace(/ё/g, 'е').trim(); }
// Returns { matches, similar }: `matches` = name contains the whole query or ALL its
// words (any order) — shown on top; `similar` = only partial word matches — shown below.
function localFoodSearch(q) {
  const ql = normFood(q);
  if (ql.length < 2) return { matches: [], similar: [] };
  const qlNs = ql.replace(/\s+/g, '');
  const toks = ql.split(/\s+/).filter((t) => t.length >= 2);
  const rank = [];
  for (const f of FOODS_RU) {
    const n = normFood(f.name);
    const nNs = n.replace(/\s+/g, '');
    const words = n.split(/[\s,()]+/).filter(Boolean);
    let s = 0, whole = false;
    if (n === ql) { s += 1000; whole = true; }
    else if (nNs === qlNs) { s += 850; whole = true; }
    else if (n.startsWith(ql) || nNs.startsWith(qlNs)) { s += 500; whole = true; }
    else if (n.includes(ql) || nNs.includes(qlNs)) { s += 300; whole = true; }
    let hit = 0, wstart = 0;
    for (const t of toks) {
      const stem = t.slice(0, Math.max(4, t.length - 3)); // "куриная"->"кури" matches "курица"/"куриный"
      if (words.some((w) => w.startsWith(t))) { s += 45; hit++; wstart++; }
      else if (n.includes(t)) { s += 28; hit++; }
      else if (words.some((w) => w.startsWith(stem) || t.startsWith(w.slice(0, Math.max(4, w.length - 3))))) { s += 12; hit++; }
    }
    const allTokens = toks.length > 0 && hit === toks.length;
    if (allTokens) s += 500;                       // every query word appears → strong match
    if (toks.length > 0 && wstart === toks.length) s += 250; // every word starts a word in the name
    if (s <= 0) continue;
    rank.push({ f, s, full: whole || allTokens });
  }
  rank.sort((a, b) => b.s - a.s);
  return {
    matches: rank.filter((r) => r.full).slice(0, 24).map((r) => r.f),
    similar: rank.filter((r) => !r.full).slice(0, 12).map((r) => r.f),
  };
}
// Friendly empty state with one-tap "add manually" (prefills the name).
function showFoodEmpty(box, q) {
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = `Не нашли «${escapeHtml(q)}».<br><button class="btn primary sm" style="margin-top:10px">Добавить вручную</button>`;
  box.appendChild(d);
  d.querySelector('button').onclick = () => {
    $$('#foodTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.ftab === 'manual'));
    $$('.ftab').forEach((f) => f.classList.toggle('active', f.dataset.ftab === 'manual'));
    $('#mName').value = q; $('#mKcal').focus();
  };
}
function normOff(p) {
  const n = offNutr(p.nutriments);
  return { name: offName(p), kcal: n.kcal, prot: n.prot, fat: n.fat, carb: n.carb, img: offImage(p) };
}

async function searchFood(q, target) {
  const box = $(target);
  // 1) Instant local results — exact/name matches on top, partial ones under "Похожие"
  const { matches, similar } = localFoodSearch(q);
  const hasLocal = matches.length || similar.length;
  if (hasLocal) {
    box.innerHTML = '';
    if (matches.length) renderFoodItems(box, matches, true);
    if (similar.length) { addResultsDivider(box, 'Похожие'); renderFoodItems(box, similar, true); }
  } else box.innerHTML = '<p class="hint">Ищу в базе продуктов…</p>';

  // 2) Open Food Facts in the background (adds branded products with photos)
  try {
    const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=30&fields=${OFF_FIELDS}`;
    const data = await httpJSON(url);
    const ql = q.trim().toLowerCase();
    let list = (data.products || []).filter((p) => offNutr(p.nutriments).kcal > 0).map(normOff);
    const score = (it) => {
      const n = it.name.toLowerCase(); let s = 0;
      if (n === ql) s += 8; else if (n.startsWith(ql)) s += 5; else if (n.includes(ql)) s += 2;
      if (it.img) s += 2;
      return s;
    };
    list.sort((a, b) => score(b) - score(a));
    list = list.slice(0, 20);
    if (list.length) {
      if (hasLocal) { addResultsDivider(box, 'Из базы Open Food Facts'); renderFoodItems(box, list, true); }
      else renderFoodItems(box, list, false);
    } else if (!hasLocal) {
      showFoodEmpty(box, q);
    }
  } catch (e) {
    // OFF unavailable (slow Cyrillic search / offline). Local results, if any, stay visible.
    if (!hasLocal) showFoodEmpty(box, q);
  }
}

async function lookupBarcode(code, target) {
  const box = $(target);
  box.innerHTML = '<p class="hint">Ищу…</p>';
  const url = `${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
  try {
    // A missing barcode returns 404 with {status:0} — parse the body anyway so it reads
    // "not found", not "no connection". Use the proxy when present, else fetch directly
    // (the v2 product endpoint sends CORS headers, so direct works on static hosting too).
    let data;
    if (DESKTOP) {
      const r = await window.desktop.request(url);
      data = JSON.parse(r.body || '{}');
    } else if (SERVED && proxyAvail !== false) {
      try {
        const r = await proxyRequest(url); proxyAvail = true;
        data = JSON.parse(r.body || '{}');
      } catch (e) {
        if (proxyAvail === true) throw e;
        proxyAvail = false; data = await (await fetch(url)).json();
      }
    } else {
      data = await (await fetch(url)).json();
    }
    if (!data || data.status !== 1 || !data.product) {
      return (box.innerHTML = '<p class="empty">Штрихкод не найден в базе. Добавь продукт вручную.</p>');
    }
    renderFoodItems(box, [normOff(data.product)], false);
  } catch (e) {
    box.innerHTML = '<p class="empty">Нет связи с базой продуктов.</p>';
  }
}

function addResultsDivider(box, text) {
  const d = document.createElement('div');
  d.className = 'results-divider';
  d.textContent = text;
  box.appendChild(d);
}

// Render normalized food items {name, kcal, prot, fat, carb, img?, icon?} (values per 100 g).
function renderFoodItems(box, items, append) {
  if (!append) box.innerHTML = '';
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'fr-item';
    const thumb = it.img
      ? `<img class="fr-thumb" src="${it.img}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="fr-thumb" style="display:grid;place-items:center">${it.icon || '🍽️'}</div>`;
    el.innerHTML = `
      ${thumb}
      <div class="fr-body"><div class="fr-name">${escapeHtml(it.name)}</div>
        <div class="fr-meta">${Math.round(it.kcal)} ккал · Б ${round1(it.prot)} · Ж ${round1(it.fat)} · У ${round1(it.carb)} <span style="opacity:.6">/100г</span></div></div>
      <div class="fr-portion">
        <input type="number" class="fr-qty" value="100" min="1" title="количество">
        <select class="fr-unit" title="единица">${unitOptions('g')}</select>
      </div>
      <button class="btn primary sm fr-add">+</button>`;
    const im = el.querySelector('img.fr-thumb');
    if (im) im.onerror = () => { const d = document.createElement('div'); d.className = 'fr-thumb'; d.textContent = it.icon || '🍽️'; d.style.cssText = 'display:grid;place-items:center'; im.replaceWith(d); };
    const qtyEl = el.querySelector('.fr-qty'), unitEl = el.querySelector('.fr-unit');
    // Switching from grams to a count unit resets the "100" default to a sensible "1".
    unitEl.onchange = () => {
      if (COUNT_UNITS.includes(unitEl.value) && Number(qtyEl.value) === 100) qtyEl.value = 1;
      if (!COUNT_UNITS.includes(unitEl.value) && Number(qtyEl.value) <= 5) qtyEl.value = 100;
    };
    el.querySelector('.fr-add').onclick = (ev) => {
      ev.stopPropagation();
      const qty = Number(qtyEl.value) || 1;
      const unit = unitEl.value;
      const grams = Math.max(1, Math.round(qty * unitGrams(unit)));
      const k = grams / 100;
      addFood({ name: it.name, kcal: it.kcal * k, prot: it.prot * k, fat: it.fat * k, carb: it.carb * k, grams, qty, unit, icon: it.icon || '', img: it.img || '' });
    };
    box.appendChild(el);
  });
}
function round1(n) { return Math.round((n || 0) * 10) / 10; }
// Smoothly count a number element from its current value to `to`.
function animateCount(el, to) {
  if (!el) return;
  to = Math.round(to || 0);
  const from = parseInt(String(el.textContent).replace(/[^\d-]/g, '')) || 0;
  if (from === to) { el.textContent = to; return; }
  const start = performance.now(), dur = 650;
  const step = (t) => {
    const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- AI photo (optional, user's own key) ---------- */
let photoData = null;
async function analyzePhoto() {
  const box = $('#photoResults');
  const key = state.settings.aiKey;
  if (!key) { box.innerHTML = '<p class="empty">Нужен ключ Anthropic. Раскрой «Как это работает» и вставь ключ. Либо пользуйся поиском — это бесплатно.</p>'; return; }
  if (!photoData) return;
  box.innerHTML = '<p class="hint">Анализирую фото…</p>';
  try {
    const [meta, b64] = photoData.split(',');
    const media = (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
    const data = await httpJSON('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
            { type: 'text', text: 'Определи блюдо на фото и оцени порцию. Ответь ТОЛЬКО одним JSON без пояснений: {"name":"...","grams":число,"kcal":число,"prot":число,"fat":число,"carb":число}. Значения — на всю порцию на фото.' },
          ],
        }],
      }),
    });
    if (data.error) throw new Error(data.error.message || 'API error');
    const text = (data.content || []).map((c) => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Не смог разобрать ответ');
    const f = JSON.parse(m[0]);
    box.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'fr-item';
    el.innerHTML = `<div class="fr-thumb" style="display:grid;place-items:center">🤖</div>
      <div class="fr-body"><div class="fr-name">${escapeHtml(f.name || 'Блюдо')}</div>
      <div class="fr-meta">~${f.grams || '?'} г · Б ${Math.round(f.prot||0)} Ж ${Math.round(f.fat||0)} У ${Math.round(f.carb||0)}</div></div>
      <div class="fr-kcal">${Math.round(f.kcal||0)}</div>
      <button class="btn primary sm">Добавить</button>`;
    el.querySelector('button').onclick = () => addFood({ name: f.name || 'Блюдо', kcal: +f.kcal || 0, prot: +f.prot || 0, fat: +f.fat || 0, carb: +f.carb || 0, grams: +f.grams || 0, img: '' });
    box.appendChild(el);
  } catch (e) {
    box.innerHTML = `<p class="empty">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}

/* ============================================================
   TASKS
   ============================================================ */
let taskFilter = 'all';
let currentFolder = 'all';
function catOf(t) { return (t.category && t.category.trim()) ? t.category.trim() : 'Общие'; }
// Styled category picker: type your own OR pick a template (replaces the plain white <datalist>).
const CAT_TEMPLATES = [
  ['💼', 'Работа'], ['🙂', 'Личное'], ['🏠', 'Дом'], ['📚', 'Учёба'],
  ['❤️', 'Здоровье'], ['🛒', 'Покупки'], ['🚀', 'Проект'], ['💡', 'Идеи'],
];
function initCatPicker() {
  const field = $('#catField'), input = $('#taskCat'), menu = $('#catMenu'), caret = $('#catCaret');
  if (!field || field._wired) return; field._wired = true;
  const cur = () => (input.value || '').trim().toLowerCase();
  const close = () => field.classList.remove('open');
  const render = () => {
    const f = cur();
    const items = CAT_TEMPLATES.filter(([, n]) => !f || n.toLowerCase().includes(f));
    if (items.length) {
      menu.innerHTML = items.map(([ic, n]) =>
        `<button type="button" class="cat-item${input.value.trim() === n ? ' sel' : ''}" data-val="${n}"><span class="cat-ic">${ic}</span>${n}</button>`).join('');
    } else {
      menu.innerHTML = `<div class="cat-empty">Своя категория: <b>${escapeHtml(input.value.trim())}</b></div>`;
    }
    menu.querySelectorAll('.cat-item').forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); input.value = b.dataset.val; close(); }));
  };
  const open = () => { render(); field.classList.add('open'); };
  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  caret.addEventListener('mousedown', (e) => { e.preventDefault(); if (field.classList.contains('open')) close(); else { input.focus(); open(); } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); });
  document.addEventListener('click', (e) => { if (!field.contains(e.target)) close(); });
}
function addTask() {
  const inp = $('#taskInput');
  const text = inp.value.trim();
  if (!text) return;
  const category = ($('#taskCat').value || '').trim();
  state.tasks.push({ id: uid(), text, done: false, priority: $('#taskPriority').value, due: $('#taskDue').value || '', category, createdAt: todayKey(), doneAt: '' });
  inp.value = ''; $('#taskDue').value = ''; // keep category for quick multi-add into the same folder
  save(); renderTasks(); renderDashboard(); updateBadges();
}
function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  t.done = !t.done; t.doneAt = t.done ? todayKey() : '';
  save(); renderTasks(); renderDashboard(); updateBadges();
  if (t.done) toast('Задача выполнена 💪', 'ok');
}
function delTask(id) { state.tasks = state.tasks.filter((x) => x.id !== id); save(); renderTasks(); renderDashboard(); updateBadges(); }
function clearDone() { const n = state.tasks.filter((x) => x.done).length; state.tasks = state.tasks.filter((x) => !x.done); save(); renderTasks(); renderDashboard(); updateBadges(); if (n) toast(`Удалено готовых: ${n}`); }

function filteredTasks() {
  const tk = todayKey();
  return state.tasks.filter((t) => {
    if (currentFolder !== 'all' && catOf(t) !== currentFolder) return false;
    if (taskFilter === 'active') return !t.done;
    if (taskFilter === 'done') return t.done;
    if (taskFilter === 'today') return t.due === tk || (!t.done && t.due && t.due <= tk);
    return true;
  }).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pr = { high: 0, mid: 1, low: 2 };
    if (pr[a.priority] !== pr[b.priority]) return pr[a.priority] - pr[b.priority];
    return (a.due || '9999').localeCompare(b.due || '9999');
  });
}
function renderTaskFolders() {
  const box = $('#taskFolders'); if (!box) return;
  const counts = new Map();
  state.tasks.forEach((t) => { const c = catOf(t); counts.set(c, (counts.get(c) || 0) + (t.done ? 0 : 1)); });
  const cats = [...counts.keys()].sort((a, b) => a === 'Общие' ? 1 : b === 'Общие' ? -1 : a.localeCompare(b));
  const chip = (folder, label, n) =>
    `<button class="folder ${currentFolder === folder ? 'active' : ''}" data-folder="${escapeHtml(folder)}">${label}${n ? ` <span class="fcount">${n}</span>` : ''}</button>`;
  box.innerHTML = chip('all', '🗂 Все', 0) + cats.map((c) => chip(c, '📁 ' + escapeHtml(c), counts.get(c))).join('');
  $$('#taskFolders .folder').forEach((b) => (b.onclick = () => { currentFolder = b.dataset.folder; renderTasks(); }));
}
function taskItemHTML(t) {
  const tk = todayKey();
  const overdue = t.due && !t.done && t.due < tk;
  const dueTxt = t.due ? fmtDue(t.due) : '';
  return `<div class="task-item ${t.done ? 'done' : ''}" data-id="${t.id}">
    <button class="task-check ${t.done ? 'on' : ''}" data-act="toggle"></button>
    <span class="task-pri ${t.priority}"></span>
    <span class="task-text">${escapeHtml(t.text)}</span>
    ${dueTxt ? `<span class="task-due ${overdue ? 'overdue' : ''}">${dueTxt}</span>` : ''}
    <button class="task-del" data-act="del">✕</button>
  </div>`;
}
function renderTasks() {
  renderTaskFolders();
  const list = $('#taskList'); if (!list) return;
  const items = filteredTasks();
  if (!items.length) { list.innerHTML = '<p class="empty">Задач нет. Добавь первую сверху ✍️</p>'; return; }
  if (currentFolder === 'all') {
    // grouped "folder" view (общий экран)
    const groups = new Map();
    items.forEach((t) => { const c = catOf(t); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(t); });
    list.innerHTML = [...groups.entries()].map(([cat, arr]) =>
      `<div class="task-group"><div class="task-group-head">📁 ${escapeHtml(cat)} <span class="tg-count">${arr.length}</span></div>${arr.map(taskItemHTML).join('')}</div>`
    ).join('');
  } else {
    list.innerHTML = items.map(taskItemHTML).join('');
  }
  $$('#taskList .task-item').forEach((li) => {
    const id = li.dataset.id;
    li.querySelector('[data-act=toggle]').onclick = () => toggleTask(id);
    li.querySelector('[data-act=del]').onclick = () => delTask(id);
  });
}
function fmtDue(d) {
  const tk = todayKey();
  if (d === tk) return 'сегодня';
  const dt = new Date(d + 'T00:00'); const now = new Date();
  const diff = Math.round((dt - new Date(tk + 'T00:00')) / 86400000);
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  return `${dt.getDate()} ${RU_MONTHS_GEN[dt.getMonth()]}`;
}

/* ============================================================
   HABITS
   ============================================================ */
const HABIT_ICONS = ['🏃','📚','🧘','💤','🚭','🥗','💪','🎯','🎸','🖊️','☀️','🧠','🦷','🚶'];
const HABIT_COLORS = ['#6366f1','#22d3ee','#34d399','#fb7185','#fbbf24','#a78bfa','#f472b6'];

function weekDates() {
  // Monday..Sunday of the current week
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0=Mon
  const mon = new Date(now); mon.setDate(now.getDate() - dow); mon.setHours(0,0,0,0);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
}
function habitStreak(h) {
  let s = 0; const d = new Date();
  // count back from today while marked
  for (;;) {
    const k = keyOf(d);
    if (h.log[k]) { s++; d.setDate(d.getDate() - 1); }
    else if (k === todayKey()) { d.setDate(d.getDate() - 1); } // today not yet done doesn't break streak
    else break;
  }
  return s;
}
function toggleHabitDay(id, k) {
  const h = state.habits.find((x) => x.id === id); if (!h) return;
  if (h.log[k]) delete h.log[k]; else h.log[k] = true;
  save(); renderHabits(); renderDashboard();
}
const HABIT_EMOJIS = ['🏃','🚶','🧘','💪','🏋️','🚴','🏊','⚽','🥊','🎯','📚','✍️','🧠','💡','🎨','🎸','🎹','🎧','🎮','💻','📖','💤','☀️','🌙','🚭','🍎','🥗','🥦','🍳','💧','☕','🍵','🦷','🚿','🧹','💊','🧴','💰','📅','✅','🔥','⭐','❤️','🌱','📵','🙏','🏆','🎵','🧺','🐕'];

async function addHabit() {
  const chosen = await openHabitModal();
  if (!chosen) return;
  state.habits.push({ id: uid(), name: chosen.name, icon: chosen.icon, color: HABIT_COLORS[state.habits.length % HABIT_COLORS.length], log: {} });
  save(); renderHabits(); renderDashboard();
}
function openHabitModal() {
  return new Promise((resolve) => {
    let icon = HABIT_EMOJIS[Math.floor(Math.random() * HABIT_EMOJIS.length)];
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `<div class="card habit-modal">
      <h3 class="modal-title">Новая привычка</h3>
      <label class="mlabel">Название</label>
      <input id="hmName" placeholder="Напр. Зарядка" autocomplete="off">
      <label class="mlabel">Иконка <span id="hmPicked" class="hm-picked">${icon}</span></label>
      <div class="emoji-grid" id="hmGrid">${HABIT_EMOJIS.map((e) => `<button class="emoji-btn ${e === icon ? 'sel' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
      <div class="modal-actions"><button class="btn ghost" data-cancel>Отмена</button><button class="btn primary" data-ok>Создать</button></div>
    </div>`;
    document.body.appendChild(ov);
    const nameEl = ov.querySelector('#hmName');
    setTimeout(() => nameEl.focus(), 30);
    ov.querySelectorAll('.emoji-btn').forEach((b) => (b.onclick = () => {
      icon = b.dataset.e; ov.querySelector('#hmPicked').textContent = icon;
      ov.querySelectorAll('.emoji-btn').forEach((x) => x.classList.toggle('sel', x === b));
    }));
    const close = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('[data-cancel]').onclick = () => close(null);
    const ok = () => { const name = nameEl.value.trim(); if (!name) { nameEl.focus(); return; } close({ name, icon }); };
    ov.querySelector('[data-ok]').onclick = ok;
    nameEl.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    ov.onclick = (e) => { if (e.target === ov) close(null); };
  });
}
function delHabit(id) { state.habits = state.habits.filter((x) => x.id !== id); save(); renderHabits(); renderDashboard(); }

function renderHabits() {
  const box = $('#habitsList'); if (!box) return;
  if (!state.habits.length) { box.innerHTML = '<p class="empty">Привычек пока нет. Нажми «+ Привычка», чтобы начать отслеживать.</p>'; return; }
  const wd = weekDates(); const tk = todayKey();
  box.innerHTML = state.habits.map((h) => {
    const streak = habitStreak(h);
    const doneToday = !!h.log[tk];
    const cells = wd.map((d) => {
      const k = keyOf(d); const on = !!h.log[k]; const isToday = k === tk;
      return `<div class="hw-cell ${on ? 'on' : ''} ${isToday ? 'today' : ''}" data-id="${h.id}" data-k="${k}" title="${k}">${RU_DOW[(d.getDay()+6)%7]}</div>`;
    }).join('');
    return `<div class="habit-card">
      <button class="habit-del" data-del="${h.id}">✕</button>
      <div class="habit-top">
        <div class="habit-icon" style="background:${h.color}33">${h.icon}</div>
        <div class="habit-name">${escapeHtml(h.name)}</div>
      </div>
      <div class="habit-streak">🔥 ${streak} дн.</div>
      <div class="habit-week">${cells}</div>
      <button class="btn ${doneToday ? 'ghost' : 'primary'} habit-check" data-toggle="${h.id}">${doneToday ? '✓ Сделано сегодня' : 'Отметить сегодня'}</button>
    </div>`;
  }).join('');
  $$('#habitsList .hw-cell').forEach((c) => (c.onclick = () => toggleHabitDay(c.dataset.id, c.dataset.k)));
  $$('#habitsList [data-toggle]').forEach((b) => (b.onclick = () => toggleHabitDay(b.dataset.toggle, tk)));
  $$('#habitsList [data-del]').forEach((b) => (b.onclick = () => delHabit(b.dataset.del)));
}

/* ============================================================
   FOCUS — Pomodoro + notes + productivity stats
   ============================================================ */
let pomo = { running: false, mode: 'work', remaining: 0, total: 0, timer: null };

function pomoDurations() { return { work: (state.focus.work || 25) * 60, break: (state.focus.break || 5) * 60 }; }
function stopPomoTimer() { if (pomo.timer) { clearInterval(pomo.timer); pomo.timer = null; } pomo.running = false; }
function pomoResetTo(mode) {
  stopPomoTimer();
  pomo.mode = mode;
  pomo.total = pomoDurations()[mode];
  pomo.remaining = pomo.total;
  renderPomo();
}
function pomoStartPause() {
  if (pomo.running) { stopPomoTimer(); renderPomo(); return; }
  if (pomo.remaining <= 0) pomo.remaining = pomo.total;
  pomo.running = true;
  pomo.timer = setInterval(() => {
    pomo.remaining--;
    if (pomo.remaining <= 0) pomoComplete();
    renderPomo();
  }, 1000);
  renderPomo();
}
function pomoComplete() {
  stopPomoTimer();
  if (pomo.mode === 'work') {
    const k = todayKey();
    state.focus.sessions[k] = (state.focus.sessions[k] || 0) + 1;
    state.focus.minutes[k] = (state.focus.minutes[k] || 0) + Math.round(pomo.total / 60);
    save();
    notifyNow('🍅 Помодоро завершён', 'Отличная работа! Время на перерыв.');
    toast('🍅 Сессия засчитана!', 'ok');
    pomoResetTo('break');
  } else {
    notifyNow('☕ Перерыв окончен', 'Возвращайся к работе.');
    pomoResetTo('work');
  }
  renderFocus(); renderDashboard();
}
function pomoSkip() { pomoResetTo(pomo.mode === 'work' ? 'break' : 'work'); }
function fmtMMSS(s) { const m = Math.floor(s / 60), ss = s % 60; return `${pad(m)}:${pad(ss)}`; }

function renderPomo() {
  const t = $('#pomoTime'); if (t) t.textContent = fmtMMSS(Math.max(0, pomo.remaining));
  const lbl = $('#pomoLabel'); if (lbl) lbl.textContent = pomo.mode === 'work' ? 'работа' : 'перерыв';
  const mode = $('#pomoMode'); if (mode) mode.textContent = pomo.mode === 'work' ? 'Фокус · работа' : 'Перерыв ☕';
  const btn = $('#pomoStart'); if (btn) btn.innerHTML = `<i class="btn-ic">${icon(pomo.running ? 'pause' : 'play')}</i>${pomo.running ? 'Пауза' : 'Старт'}`;
  const card = $('.pomodoro-card'); if (card) card.classList.toggle('run', pomo.running);
  const frac = pomo.total ? (pomo.total - pomo.remaining) / pomo.total : 0;
  drawRing($('#pomoRing'), frac, pomo.mode === 'work' ? '#6366f1' : '#34d399', pomo.mode === 'work' ? '#22d3ee' : '#10b981');
}
function statTile(ic, val, label, accent) {
  return `<div class="stat-tile ${accent ? 'accent' : ''}"><div class="st-val">${val}</div><div class="st-label"><span class="st-ic">${ic}</span>${label}</div></div>`;
}
function renderFocus() {
  const w = $('#pomoWork'); if (w) w.value = state.focus.work || 25;
  const b = $('#pomoBreak'); if (b) b.value = state.focus.break || 5;
  if (pomo.total === 0) pomoResetTo('work'); else renderPomo();
  const k = todayKey();
  const ft = $('#focusToday');
  if (ft) ft.innerHTML = statTile('🍅', state.focus.sessions[k] || 0, 'сессий сегодня', true) + statTile('⏳', state.focus.minutes[k] || 0, 'минут фокуса', false);
  const na = $('#notesArea'); if (na && document.activeElement !== na) na.value = state.notes || '';
}
function renderWeekStats() {
  const box = $('#weekStats'); if (!box) return;
  const G = computeGoals();
  let waterDays = 0, focusMin = 0, focusSess = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i); const k = keyOf(d);
    const dd = state.days[k]; const w = dd ? dd.waterLog.reduce((a, x) => a + x.ml, 0) : 0;
    if (w >= G.waterGoal) waterDays++;
    focusMin += state.focus.minutes[k] || 0; focusSess += state.focus.sessions[k] || 0;
  }
  const tk = todayKey();
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
  const tasksWeek = state.tasks.filter((t) => t.done && t.doneAt && t.doneAt >= keyOf(weekStart)).length;
  const habitsToday = state.habits.filter((h) => h.log[tk]).length;
  box.innerHTML =
    statTile('✅', tasksWeek, 'задач за неделю', true) +
    statTile('💧', waterDays + '/7', 'дней с нормой воды', false) +
    statTile('🍅', focusSess, 'фокус-сессий', false) +
    statTile('⏳', focusMin, 'минут фокуса', false) +
    statTile('🔥', habitsToday + '/' + (state.habits.length || 0), 'привычек сегодня', false);
}

/* ============================================================
   CALENDAR
   ============================================================ */
let calCursor = new Date();
function renderCalendar() {
  const grid = $('#calGrid'); if (!grid) return;
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $('#calTitle').textContent = `${RU_MONTHS[m]} ${y}`;
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const G = computeGoals(); const tk = todayKey();
  let html = RU_DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < startDow; i++) html += '<div class="cal-cell empty"></div>';
  for (let dnum = 1; dnum <= days; dnum++) {
    const k = keyOf(new Date(y, m, dnum));
    const d = state.days[k];
    const water = d ? d.waterLog.reduce((s, w) => s + w.ml, 0) : 0;
    const kcal = d ? d.foods.reduce((s, f) => s + (f.kcal || 0), 0) : 0;
    const tasksDone = state.tasks.filter((t) => t.done && t.doneAt === k).length;
    const dots = [
      water > 0 ? `<span class="dot water" style="opacity:${water >= G.waterGoal ? 1 : .45}"></span>` : '',
      kcal > 0 ? '<span class="dot kcal"></span>' : '',
      tasksDone > 0 ? '<span class="dot task"></span>' : '',
    ].join('');
    html += `<div class="cal-cell ${k === tk ? 'today' : ''}" data-k="${k}"><span class="cal-num">${dnum}</span><div class="cal-dots">${dots}</div></div>`;
  }
  grid.innerHTML = html;
  $$('#calGrid .cal-cell[data-k]').forEach((c) => (c.onclick = () => showDay(c.dataset.k)));
}
function showDay(k) {
  const d = state.days[k]; const G = computeGoals();
  const water = d ? d.waterLog.reduce((s, w) => s + w.ml, 0) : 0;
  const tot = d ? d.foods.reduce((a, f) => ({ kcal: a.kcal + (f.kcal||0), prot: a.prot+(f.prot||0), fat: a.fat+(f.fat||0), carb: a.carb+(f.carb||0) }), {kcal:0,prot:0,fat:0,carb:0}) : {kcal:0,prot:0,fat:0,carb:0};
  const habitsDone = state.habits.filter((h) => h.log[k]);
  // Tasks tied to this day: due on it, created on it, or completed on it.
  const dayTasks = state.tasks.filter((t) => t.due === k || t.doneAt === k || (!t.due && t.createdAt === k));
  dayTasks.sort((a, b) => (a.done === b.done) ? 0 : a.done ? 1 : -1);
  const doneCount = dayTasks.filter((t) => t.done).length;
  const dt = new Date(k + 'T00:00');
  $('#dayDetailTitle').textContent = `${dt.getDate()} ${RU_MONTHS_GEN[dt.getMonth()]} ${dt.getFullYear()}`;
  let tasksBlock;
  if (!dayTasks.length) {
    tasksBlock = '<div class="dd-tasks-empty">Задач на этот день нет</div>';
  } else {
    tasksBlock = dayTasks.map((t) => {
      const why = t.done && t.doneAt === k ? 'выполнена' : (t.due === k ? 'срок' : 'создана');
      return `<div class="dd-task ${t.done ? 'done' : ''}">
        <span class="dd-task-check ${t.done ? 'on' : ''}"></span>
        <span class="task-pri ${t.priority}"></span>
        <span class="dd-task-text">${escapeHtml(t.text)}</span>
        <span class="dd-task-tag">${why}</span>
      </div>`;
    }).join('');
  }
  $('#dayDetailBody').innerHTML = `
    <div class="dd-row"><span>💧 Вода</span><b>${water} / ${G.waterGoal} мл</b></div>
    <div class="dd-row"><span>🍎 Калории</span><b>${Math.round(tot.kcal)} ккал · Б${Math.round(tot.prot)} Ж${Math.round(tot.fat)} У${Math.round(tot.carb)}</b></div>
    <div class="dd-row"><span>🔥 Привычек отмечено</span><b>${habitsDone.length}${habitsDone.length ? ' · ' + habitsDone.map((h)=>h.icon).join(' ') : ''}</b></div>
    <div class="dd-tasks-head"><span>✅ Задачи</span><b>${doneCount}/${dayTasks.length} выполнено</b></div>
    <div class="dd-tasks">${tasksBlock}</div>`;
  $('#dayDetailCard').hidden = false;
  $('#dayDetailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function waterStreak() {
  const G = computeGoals().waterGoal; let s = 0; const d = new Date();
  for (;;) {
    const k = keyOf(d); const dd = state.days[k];
    const w = dd ? dd.waterLog.reduce((a, x) => a + x.ml, 0) : 0;
    if (w >= G) { s++; d.setDate(d.getDate() - 1); }
    else if (k === todayKey()) { d.setDate(d.getDate() - 1); } // today incomplete doesn't break
    else break;
  }
  return s;
}
function renderDashboard() {
  const G = computeGoals();
  // water
  const t = waterTotal();
  const wpct = (t / G.waterGoal) * 100;
  const dw = $('#dashBottleWater'); if (dw) setBottle(dw, wpct);
  animateCount($('#dashWaterMl'), t);
  const dg = $('#dashWaterGoal'); if (dg) dg.textContent = `цель ${G.waterGoal} мл`;
  const dqa = $('#dashQuickAdd'); if (dqa && !dqa.children.length) renderQuickAdd(dqa);
  // kcal
  const ft = foodTotals();
  animateCount($('#dashKcalNow'), ft.kcal);
  const kg = $('#dashKcalGoal'); if (kg) kg.textContent = `цель ${G.kcalGoal}`;
  drawRing($('#dashKcalRing'), ft.kcal / G.kcalGoal, '#34d399', '#22d3ee');
  const dm = $('#dashMacros');
  if (dm) dm.innerHTML = macroBar('Белки', ft.prot, G.macros.prot, 'prot') + macroBar('Углеводы', ft.carb, G.macros.carb, 'carb');
  // tasks mini
  const dt = $('#dashTasks');
  if (dt) {
    const items = state.tasks.filter((x) => !x.done).slice(0, 5);
    if (!items.length) dt.innerHTML = '<li class="empty" style="padding:10px">Все задачи выполнены 🎉</li>';
    else dt.innerHTML = items.map((x) => `<li><button class="task-check" data-id="${x.id}"></button><span class="task-pri ${x.priority}"></span>${escapeHtml(x.text)}</li>`).join('');
    $$('#dashTasks .task-check').forEach((b) => (b.onclick = () => toggleTask(b.dataset.id)));
  }
  // habits tiles (streak-style, toggle for the selected day)
  const dh = $('#dashHabits'); const sk = curKey();
  if (dh) {
    if (!state.habits.length) {
      dh.innerHTML = '<div class="empty-add"><p>Добавь привычки — тут появятся плитки со стриками и недельной сеткой.</p><button class="btn primary sm" data-goto="habits">+ Добавить привычку</button></div>';
    } else {
      const wd = weekDates();
      dh.innerHTML = state.habits.map((h) => {
        const streak = habitStreak(h);
        const doneSel = !!h.log[sk];
        const cells = wd.map((d) => {
          const k = keyOf(d); const on = !!h.log[k]; const sel = k === sk;
          return `<div class="dh-cell ${on ? 'on' : ''} ${sel ? 'sel' : ''}" data-h="${h.id}" data-k="${k}" title="${k}">${RU_DOW[(d.getDay()+6)%7]}</div>`;
        }).join('');
        return `<div class="dh-tile">
          <div class="dh-top"><div class="dh-icon" style="background:${h.color}33">${h.icon}</div><div class="dh-name">${escapeHtml(h.name)}</div></div>
          <div><span class="dh-streak">${streak}</span><small>дн. подряд 🔥</small></div>
          <div class="dh-week">${cells}</div>
          <button class="dh-toggle ${doneSel ? 'on' : 'off'}" data-htoggle="${h.id}">${doneSel ? '✓ Отмечено' : 'Отметить день'}</button>
        </div>`;
      }).join('');
      $$('#dashHabits .dh-cell').forEach((c) => (c.onclick = () => toggleHabitDay(c.dataset.h, c.dataset.k)));
      $$('#dashHabits [data-htoggle]').forEach((b) => (b.onclick = () => toggleHabitDay(b.dataset.htoggle, sk)));
    }
    $$('#dashHabits [data-goto]').forEach((b) => (b.onclick = () => switchView(b.dataset.goto)));
  }
  // weight + goal
  renderWeightCard();
  // finance snapshot
  renderFinanceDash();
  // weekly productivity stats
  renderWeekStats();
  // streak + weekbar
  const ws = $('#waterStreak'); if (ws) ws.textContent = waterStreak();
  const wb = $('#weekBar');
  if (wb) {
    const tk = todayKey();
    const days = [];
    for (let i = -2; i <= 4; i++) { const d = new Date(); d.setDate(d.getDate() + i); days.push(d); } // 2 back + today + 4 ahead
    wb.innerHTML = days.map((d) => {
      const k = keyOf(d); const dd = state.days[k];
      const w = dd ? dd.waterLog.reduce((a, x) => a + x.ml, 0) : 0;
      const pct = clamp((w / G.waterGoal) * 100, 0, 100);
      const isToday = k === tk, future = k > tk, met = w >= G.waterGoal;
      return `<div class="wb-day ${isToday ? 'today' : ''} ${future ? 'future' : ''}">
        <div class="wb-bar"><div class="wb-fill ${met ? 'met' : ''}" style="height:${future ? 0 : pct}%"></div></div>
        <span class="wb-label">${isToday ? 'сег.' : RU_DOW[(d.getDay()+6)%7]}</span></div>`;
    }).join('');
  }
  renderStreakGoal();
}
/* ---------- weight & goal card ---------- */
function weightSparkline(vals) {
  if (vals.length < 2) return '<div class="wc-spark-empty">Записывай вес — здесь появится график</div>';
  const w = 260, h = 46, pad = 5;
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1].split(',');
  return `<svg class="wc-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="wcg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs>
    <polyline points="${pts.join(' ')}" fill="none" stroke="url(#wcg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="3.5" fill="var(--accent-2)"/>
  </svg>`;
}
function renderWeightCard() {
  const box = $('#weightBody'); if (!box) return;
  const p = state.profile;
  const cur = latestWeight();
  if (!cur) {
    box.innerHTML = `<div class="empty-add"><p>Укажи вес и цель — покажу прогресс и прогноз даты.</p><button class="btn primary sm" data-goto="profile">Настроить профиль</button></div>`;
    box.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => switchView(b.dataset.goto)));
    return;
  }
  const proj = weightProjection();
  const gm = GOAL_META[p.goal] || GOAL_META.maintain;
  const entries = Object.keys(state.weightLog).sort().slice(-14).map((k) => state.weightLog[k]);
  const delta14 = entries.length > 1 ? round1(entries[entries.length - 1] - entries[0]) : 0;
  let goalBlock;
  if (proj && !proj.done) {
    goalBlock = `<div class="wc-progress"><div class="wc-progress-fill" style="width:${proj.progress}%"></div></div>
      <div class="wc-proj">осталось <b>${round1(proj.remaining)} кг</b><br><span class="wc-date">${proj.date.getDate()} ${RU_MONTHS_GEN[proj.date.getMonth()]} ${proj.date.getFullYear()}</span></div>`;
  } else if (proj && proj.done) {
    goalBlock = `<div class="wc-proj" style="color:var(--ok)">🎉 Цель<br><b>${round1(proj.target)} кг</b> достигнута</div>`;
  } else {
    goalBlock = `<div class="wc-proj">${gm.icon} ${gm.label}<br><span class="wc-date">${gm.hint}</span></div>`;
  }
  box.innerHTML = `
    <div class="wc-now">
      <div class="wc-cur"><span class="wc-val">${round1(cur)}</span><small>кг${p.targetWeight ? ` · цель ${round1(p.targetWeight)}` : ''}</small></div>
      ${entries.length > 1 ? `<div class="wc-trend ${delta14 < 0 ? 'down' : delta14 > 0 ? 'up' : ''}">${delta14 > 0 ? '▲' : delta14 < 0 ? '▼' : '▬'} ${Math.abs(delta14)} кг<small>за ${entries.length} записей</small></div>` : ''}
    </div>
    <div class="wc-chart">${weightSparkline(entries)}</div>
    <div class="wc-goal">${goalBlock}</div>`;
}
function openWeightModal() {
  openModal({ title: 'Записать вес', fields: [{ key: 'w', label: 'Вес сегодня, кг', value: latestWeight() || '', placeholder: 'кг' }], okText: 'Сохранить' }).then((r) => {
    if (!r) return;
    const w = Number(String(r.w).replace(',', '.'));
    if (!w || w <= 0) return toast('Некорректный вес', 'err');
    logWeight(w);
    renderDashboard(); renderCalc(); updateTopbar();
    toast('Вес записан 📉', 'ok');
  });
}

function renderStreakGoal() {
  const el = $('#streakGoal'); if (!el) return;
  const goal = state.settings.streakGoal || 7;
  const streak = waterStreak();
  const pct = clamp((streak / goal) * 100, 0, 100);
  const done = streak >= goal;
  const left = Math.max(0, goal - streak);
  el.innerHTML = `
    <div class="sg-head">🎯 Цель: <b>${goal}</b> дней подряд — ${done ? '<span class="sg-done">выполнено! 🎉</span>' : `осталось <b>${left}</b>`}</div>
    <div class="sg-bar"><div class="sg-fill" style="width:${pct}%"></div></div>
    <div class="sg-chips">${[7, 14, 30, 50, 100].map((g) => `<button class="sg-chip ${g === goal ? 'active' : ''}" data-goal="${g}">${g}</button>`).join('')}</div>`;
  $$('#streakGoal .sg-chip').forEach((b) => (b.onclick = () => { state.settings.streakGoal = Number(b.dataset.goal); save(); renderStreakGoal(); toast(`Цель: ${b.dataset.goal} дней подряд`, 'ok'); }));
}

/* ============================================================
   PROFILE
   ============================================================ */
// Digit-only DOB fields: strip non-digits, soft-clamp day/month, auto-advance, backspace-back.
function wireDob(root) {
  (root || document).querySelectorAll('.dob-row[data-dob]').forEach((row) => {
    if (row._dobWired) return; row._dobWired = true;
    const ins = [...row.querySelectorAll('input')];
    ins.forEach((el, i) => {
      const max = el.maxLength;
      el.addEventListener('input', () => {
        let v = el.value.replace(/\D/g, '').slice(0, max);
        if (max === 2 && v.length === 2) {          // full day/month → clamp into range
          const n = Number(v), cap = i === 0 ? 31 : 12;
          if (n > cap) v = String(cap);
          else if (n === 0) v = i === 0 ? '01' : '01';
        }
        el.value = v;
        if (v.length >= max && ins[i + 1]) ins[i + 1].focus();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !el.value && ins[i - 1]) { ins[i - 1].focus(); e.preventDefault(); }
      });
    });
  });
}
function loadProfileForm() {
  const p = state.profile;
  $('#pName').value = p.name || '';
  $('#pSex').value = p.sex;
  const bd = /^\d{4}-\d{2}-\d{2}$/.test(p.birthday || '') ? p.birthday.split('-') : ['', '', ''];
  $('#pDobD').value = bd[2] ? Number(bd[2]) : '';
  $('#pDobM').value = bd[1] ? Number(bd[1]) : '';
  $('#pDobY').value = bd[0] ? Number(bd[0]) : '';
  $('#pHeight').value = p.height || '';
  $('#pWeight').value = p.weight || '';
  $('#pActivity').value = String(p.activity);
  $('#pGoal').value = p.goal || 'maintain';
  $('#pGoalRate').value = String(p.goalRate || 0.5);
  $('#pTargetWeight').value = p.targetWeight || '';
  updateGoalFields();
  renderAvatarInto($('#pAvatarPreview'), p.avatar);
  $('#pWaterGoal').value = state.goals.water || '';
  $('#pKcalGoal').value = state.goals.kcal || '';
  if (DESKTOP && window.desktop) {
    const ur = $('#updateRow'); if (ur) ur.hidden = false;
    const av = $('#appVer'); if (av) av.textContent = window.desktop.appVersion || '1.0.0';
  } else if (SERVED) {
    const ur = $('#updateRow'); if (ur) ur.hidden = false;
    const av = $('#appVer'); if (av && bootVersion) av.textContent = bootVersion;
  }
  renderAccountCard();
  renderCalc();
  wireDob(document);
}
// Show target-weight + rate only for weight-change goals.
function updateGoalFields() {
  const g = $('#pGoal') ? $('#pGoal').value : 'maintain';
  const show = g === 'lose' || g === 'gain';
  const rw = $('#pRateWrap'), tw = $('#pTargetWrap');
  if (rw) rw.hidden = !show;
  if (tw) tw.hidden = !show;
}
function saveProfile() {
  const p = state.profile;
  p.name = $('#pName').value.trim();
  p.sex = $('#pSex').value;
  const dd = Number($('#pDobD').value), mm = Number($('#pDobM').value), yy = Number($('#pDobY').value);
  if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yy >= 1900 && yy <= 2100) {
    p.birthday = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    p.age = ageFromBirthday(p.birthday) || p.age;
  } else if (!$('#pDobD').value && !$('#pDobM').value && !$('#pDobY').value) {
    p.birthday = '';
  }
  p.height = Number($('#pHeight').value) || null;
  const newWeight = Number($('#pWeight').value) || null;
  p.activity = Number($('#pActivity').value);
  p.goal = $('#pGoal').value;
  p.goalRate = Number($('#pGoalRate').value) || 0.5;
  const tw = Number($('#pTargetWeight').value) || null;
  if (tw && tw !== p.targetWeight) p.startWeight = latestWeight() || newWeight;
  p.targetWeight = tw;
  // avatar is set live by the picker (openAvatarPicker), nothing to read here
  if (newWeight) logWeight(newWeight); else p.weight = null;
  save(); renderCalc(); updateTopbar(); renderAll();
  toast('Профиль сохранён', 'ok');
}
function saveGoals() {
  state.goals.water = Number($('#pWaterGoal').value) || null;
  state.goals.kcal = Number($('#pKcalGoal').value) || null;
  save(); renderCalc(); renderAll();
  toast('Цели обновлены', 'ok');
}
function renderCalc() {
  const G = computeGoals();
  const box = $('#calcList'); if (!box) return;
  const gm = GOAL_META[G.goal] || GOAL_META.maintain;
  const proj = weightProjection();
  let projRow = '';
  if (proj && !proj.done) {
    projRow = `<div class="calc-item highlight"><span class="ci-label">${proj.target} кг — примерно к</span><span class="ci-val" style="font-size:15px">${proj.date.getDate()} ${RU_MONTHS_GEN[proj.date.getMonth()]} ${proj.date.getFullYear()}</span></div>`;
  } else if (proj && proj.done) {
    projRow = `<div class="calc-item highlight"><span class="ci-label">Цель по весу</span><span class="ci-val" style="font-size:15px;color:var(--ok)">достигнута 🎉</span></div>`;
  }
  box.innerHTML = `
    <div class="calc-item"><span class="ci-label">Базовый обмен (BMR)</span><span class="ci-val">${G.bmr || '—'}<small> ккал</small></span></div>
    <div class="calc-item"><span class="ci-label">Расход на активность</span><span class="ci-val">${G.activityBurn ? '+' + G.activityBurn : '—'}<small> ккал</small></span></div>
    <div class="calc-item"><span class="ci-label">Всего за день (TDEE)</span><span class="ci-val">${G.tdee || '—'}<small> ккал</small></span></div>
    <div class="calc-item"><span class="ci-label">${gm.icon} ${gm.label} · ${G.delta >= 0 ? '+' : ''}${G.delta} ккал</span><span class="ci-val" style="font-size:14px;color:var(--muted)">${gm.hint}</span></div>
    <div class="calc-item accent-item"><span class="ci-label">Цель калорий${G.custom ? ' · своя' : ''}</span><span class="ci-val">${G.kcalGoal}<small> ккал</small></span></div>
    <div class="calc-item"><span class="ci-label">Цель воды</span><span class="ci-val">${G.waterGoal}<small> мл</small></span></div>
    <div class="calc-item"><span class="ci-label">Белки / Жиры / Углеводы</span><span class="ci-val" style="font-size:15px">${G.macros.prot} / ${G.macros.fat} / ${G.macros.carb}<small> г</small></span></div>
    ${projRow}
    ${G.custom ? '<button class="btn ghost sm" id="clearCustomGoal" style="margin-top:6px">↩ Вернуть расчётную цель</button>' : ''}`;
  const cc = $('#clearCustomGoal');
  if (cc) cc.onclick = () => { state.goals.kcal = null; if ($('#pKcalGoal')) $('#pKcalGoal').value = ''; save(); renderCalc(); renderAll(); toast('Цель калорий снова расчётная', 'ok'); };
}

/* ---------- avatar (emoji or custom photo) ---------- */
const AVATAR_EMOJIS = ['🙂','😎','🤓','🥳','😇','🤩','🥰','😌','🤠','🥸','😺','🐶','🐱','🦊','🐼','🐨','🦁','🐯','🐸','🐵','🦄','🐷','🐰','🐻','🐧','🦉','🦋','🐙','🦈','🐢','🌟','🔥','💧','🌈','🍀','⚡','🌸','🍎','🏆','💪','🧠','🎧','🎮','⚽','🎸','🚀','👑','🦸','🧘','🏃','🥷','🧙','🧑‍💻','🌚'];
function isImgAvatar(a) { return typeof a === 'string' && a.startsWith('data:'); }
function renderAvatarInto(el, a) {
  if (!el) return;
  a = a || '🙂';
  if (isImgAvatar(a)) el.innerHTML = `<img src="${a}" alt="" class="avatar-img">`;
  else { el.innerHTML = ''; el.textContent = a; }
}
// Downscale any uploaded image to a 128px square jpeg so it stays tiny in localStorage.
function avatarFromFile(file, cb) {
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => {
      const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
      const ctx = c.getContext('2d');
      const scale = Math.max(S / img.width, S / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      try { cb(c.toDataURL('image/jpeg', 0.82)); } catch (e) { toast('Не удалось загрузить фото', 'err'); }
    };
    img.onerror = () => toast('Не удалось прочитать изображение', 'err');
    img.src = rd.result;
  };
  rd.readAsDataURL(file);
}
function openAvatarPicker() {
  const cur = state.profile.avatar || '🙂';
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `<div class="card avatar-modal">
    <h3 class="modal-title">Аватар</h3>
    <div class="avatar-current">
      <div class="avatar-current-face" id="avCurFace"></div>
      <div class="avatar-current-side">
        <button class="btn ghost sm" id="avUploadBtn">📷 Загрузить своё фото</button>
        <input type="file" id="avFile" accept="image/*" hidden>
        <span class="hint" style="margin:0">PNG/JPG — обрежется в квадрат</span>
      </div>
    </div>
    <label class="mlabel">Или выбери эмодзи</label>
    <div class="emoji-grid" id="avGrid">${AVATAR_EMOJIS.map((e) => `<button class="emoji-btn ${e === cur ? 'sel' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
    <div class="modal-actions"><button class="btn primary" data-close>Готово</button></div>
  </div>`;
  document.body.appendChild(ov);
  renderAvatarInto(ov.querySelector('#avCurFace'), cur);
  const apply = (a) => {
    state.profile.avatar = a; save();
    renderAvatarInto(ov.querySelector('#avCurFace'), a);
    renderAvatarInto($('#pAvatarPreview'), a);
    updateTopbar();
    ov.querySelectorAll('.emoji-btn').forEach((x) => x.classList.toggle('sel', x.dataset.e === a));
  };
  ov.querySelectorAll('.emoji-btn').forEach((b) => (b.onclick = () => apply(b.dataset.e)));
  ov.querySelector('#avUploadBtn').onclick = () => ov.querySelector('#avFile').click();
  ov.querySelector('#avFile').onchange = (e) => { if (e.target.files[0]) avatarFromFile(e.target.files[0], apply); };
  const close = () => ov.remove();
  ov.querySelector('[data-close]').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

/* ============================================================
   ONBOARDING QUIZ (goal setup — Yazio-style)
   ============================================================ */
const ACT_OPTS = [
  ['1.2', '🪑', 'Сидячий', 'офис, мало движения'],
  ['1.375', '🚶', 'Лёгкая', '1–3 трен/нед'],
  ['1.55', '🏃', 'Умеренная', '3–5 трен/нед'],
  ['1.725', '🏋️', 'Высокая', '6–7 трен/нед'],
  ['1.9', '🔥', 'Очень высокая', '2× в день / физ. работа'],
];
const RATE_OPTS = [['0.25', 'Мягко', '0.25 кг/нед'], ['0.5', 'Обычно', '0.5 кг/нед'], ['0.75', 'Быстро', '0.75 кг/нед'], ['1', 'Агрессивно', '1.0 кг/нед']];

// Pure calc for a draft profile (no manual-goal override) — used for the live preview.
function previewGoals(d) {
  if (!(d.weight && d.height && d.age)) return null;
  const bmr = 10 * d.weight + 6.25 * d.height - 5 * d.age + (d.sex === 'male' ? 5 : -161);
  const tdee = bmr * d.activity;
  let delta = goalDelta(tdee, d.goal, d.goalRate);
  let target = tdee + delta;
  const floor = Math.max(Math.round(bmr * 1.05), d.sex === 'female' ? 1200 : 1500);
  if (target < floor) { target = floor; delta = target - tdee; }
  const kcal = Math.round(target / 10) * 10;
  const water = Math.round(clamp(35 * d.weight, 1200, 5000) / 50) * 50;
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), delta: Math.round(delta), kcal, water, macros: macroSplit(kcal, d.goal) };
}

function openOnboarding(first) {
  const p = state.profile;
  const bd0 = /^\d{4}-\d{2}-\d{2}$/.test(p.birthday || '') ? p.birthday.split('-') : ['', '', ''];
  const d = {
    sex: p.sex || 'male', age: p.age || null, birthday: p.birthday || '',
    dobD: bd0[2] ? Number(bd0[2]) : '', dobM: bd0[1] ? Number(bd0[1]) : '', dobY: bd0[0] ? Number(bd0[0]) : '',
    height: p.height || null, weight: p.weight || null,
    activity: p.activity || 1.375, goal: p.goal || 'maintain', goalRate: p.goalRate || 0.5,
    targetWeight: p.targetWeight || null,
  };
  let step = 0;
  const ov = document.createElement('div');
  ov.className = 'modal-ov onb-ov';
  document.body.appendChild(ov);

  const stepList = () => {
    const a = ['welcome', 'body', 'activity', 'goal'];
    if (d.goal === 'lose' || d.goal === 'gain') a.push('target');
    a.push('summary');
    return a;
  };
  const card = (sel, icon, title, sub, val) =>
    `<button class="onb-card ${sel ? 'sel' : ''}" data-val="${val}"><span class="onb-card-ic">${icon}</span><span class="onb-card-txt"><span class="onb-card-t">${title}</span>${sub ? `<span class="onb-card-s">${sub}</span>` : ''}</span></button>`;

  function body(cur) {
    if (cur === 'welcome') {
      return `<div class="onb-hero">🎯</div>
        <h3 class="onb-title">${first ? 'Настроим Aqua под тебя' : 'Настройка цели'}</h3>
        <p class="onb-sub">Пара вопросов — и приложение само посчитает норму калорий, воды и БЖУ под твою цель.</p>
        <label class="mlabel">Пол</label>
        <div class="onb-cards two">
          ${card(d.sex === 'male', '👨', 'Мужской', '', 'male')}
          ${card(d.sex === 'female', '👩', 'Женский', '', 'female')}
        </div>
        <label class="mlabel">Дата рождения</label>
        <div class="dob-row" data-dob>
          <input type="text" id="onbDobD" maxlength="2" placeholder="ДД" inputmode="numeric" autocomplete="off" value="${d.dobD || ''}">
          <span class="dob-sep">.</span>
          <input type="text" id="onbDobM" maxlength="2" placeholder="ММ" inputmode="numeric" autocomplete="off" value="${d.dobM || ''}">
          <span class="dob-sep">.</span>
          <input type="text" id="onbDobY" maxlength="4" placeholder="ГГГГ" inputmode="numeric" autocomplete="off" value="${d.dobY || ''}">
        </div>`;
    }
    if (cur === 'body') {
      return `<h3 class="onb-title">Параметры тела</h3>
        <p class="onb-sub">Нужны для формулы Миффлина-Сан Жеора.</p>
        <label class="mlabel">Рост, см</label>
        <input type="number" id="onbHeight" min="120" max="230" placeholder="см" value="${d.height || ''}">
        <label class="mlabel">Вес, кг</label>
        <input type="number" id="onbWeight" min="30" max="250" step="0.1" placeholder="кг" value="${d.weight || ''}">`;
    }
    if (cur === 'activity') {
      return `<h3 class="onb-title">Насколько ты активен?</h3>
        <p class="onb-sub">Честно — завышенная активность раздувает норму калорий.</p>
        <div class="onb-cards">${ACT_OPTS.map((o) => card(String(d.activity) === o[0], o[1], o[2], o[3], o[0])).join('')}</div>`;
    }
    if (cur === 'goal') {
      return `<h3 class="onb-title">Какая цель?</h3>
        <p class="onb-sub">Под неё подстроятся калории и баланс БЖУ.</p>
        <div class="onb-cards">${['lose', 'maintain', 'gain', 'muscle'].map((g) => card(d.goal === g, GOAL_META[g].icon, GOAL_META[g].label, GOAL_META[g].hint, g)).join('')}</div>`;
    }
    if (cur === 'target') {
      const dirTxt = d.goal === 'lose' ? 'сбросить' : 'набрать';
      return `<h3 class="onb-title">Целевой вес и темп</h3>
        <p class="onb-sub">Сколько хочешь ${dirTxt} и как быстро.</p>
        <label class="mlabel">Целевой вес, кг</label>
        <input type="number" id="onbTarget" min="30" max="250" step="0.1" placeholder="кг" value="${d.targetWeight || ''}">
        <label class="mlabel">Темп</label>
        <div class="onb-cards">${RATE_OPTS.map((o) => card(String(d.goalRate) === o[0], '⚡', o[1], o[2], o[0])).join('')}</div>`;
    }
    if (cur === 'summary') {
      const g = previewGoals(d);
      if (!g) return '<p class="onb-sub">Заполни параметры тела на предыдущих шагах.</p>';
      let projTxt = '';
      if ((d.goal === 'lose' || d.goal === 'gain') && d.targetWeight && d.weight) {
        const weeks = Math.abs(d.targetWeight - d.weight) / Math.max(0.1, d.goalRate);
        const date = new Date(); date.setDate(date.getDate() + Math.round(weeks * 7));
        projTxt = `<div class="onb-proj">📅 ${d.targetWeight} кг примерно к <b>${date.getDate()} ${RU_MONTHS_GEN[date.getMonth()]} ${date.getFullYear()}</b></div>`;
      }
      return `<div class="onb-hero">${GOAL_META[d.goal].icon}</div>
        <h3 class="onb-title">Твой план готов</h3>
        <div class="onb-summary">
          <div class="onb-big"><span class="onb-big-val">${g.kcal}</span><span class="onb-big-lbl">ккал / день</span></div>
          <div class="onb-macros">
            <div class="onb-macro"><b>${g.macros.prot}</b><small>Белки, г</small></div>
            <div class="onb-macro"><b>${g.macros.fat}</b><small>Жиры, г</small></div>
            <div class="onb-macro"><b>${g.macros.carb}</b><small>Углеводы, г</small></div>
            <div class="onb-macro"><b>${g.water}</b><small>Вода, мл</small></div>
          </div>
          <div class="onb-break">BMR ${g.bmr} · активность +${g.tdee - g.bmr} · цель ${g.delta >= 0 ? '+' : ''}${g.delta} ккал</div>
          ${projTxt}
        </div>`;
    }
    return '';
  }

  function render() {
    const S = stepList();
    if (step >= S.length) step = S.length - 1;
    const cur = S[step];
    const last = step === S.length - 1;
    ov.innerHTML = `<div class="card onb-modal">
      <div class="onb-dots">${S.map((_, i) => `<span class="onb-dot ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}"></span>`).join('')}</div>
      <div class="onb-body">${body(cur)}</div>
      <div class="onb-actions">
        ${step > 0 ? '<button class="btn ghost" data-back>Назад</button>' : (first ? '<button class="btn ghost" data-skip>Позже</button>' : '<button class="btn ghost" data-skip>Отмена</button>')}
        <button class="btn primary" data-next>${last ? '🚀 Погнали' : 'Далее'}</button>
      </div>
    </div>`;
    // card selects
    ov.querySelectorAll('.onb-card').forEach((b) => (b.onclick = () => {
      const v = b.dataset.val;
      if (cur === 'welcome') d.sex = v;
      else if (cur === 'activity') d.activity = Number(v);
      else if (cur === 'goal') d.goal = v;
      else if (cur === 'target') d.goalRate = Number(v);
      render();
    }));
    // Live-bind text inputs so a card click (which re-renders) never wipes typed values.
    const bind = (sel, key) => { const el = ov.querySelector(sel); if (el) el.oninput = () => { d[key] = Number(el.value) || null; }; };
    bind('#onbDobD', 'dobD'); bind('#onbDobM', 'dobM'); bind('#onbDobY', 'dobY');
    bind('#onbHeight', 'height'); bind('#onbWeight', 'weight'); bind('#onbTarget', 'targetWeight');
    wireDob(ov);
    ov.querySelector('[data-next]').onclick = next;
    const bk = ov.querySelector('[data-back]'); if (bk) bk.onclick = () => { step--; render(); };
    const sk = ov.querySelector('[data-skip]'); if (sk) sk.onclick = () => { if (first) { state.profile.onboarded = true; save(); } ov.remove(); };
  }

  function next() {
    const S = stepList();
    const cur = S[step];
    if (cur === 'welcome') {
      d.dobD = Number($('#onbDobD', ov).value) || ''; d.dobM = Number($('#onbDobM', ov).value) || ''; d.dobY = Number($('#onbDobY', ov).value) || '';
      if (!(d.dobD >= 1 && d.dobD <= 31 && d.dobM >= 1 && d.dobM <= 12 && d.dobY >= 1900 && d.dobY <= 2100)) return toast('Укажи дату рождения', 'err');
      d.birthday = `${d.dobY}-${String(d.dobM).padStart(2, '0')}-${String(d.dobD).padStart(2, '0')}`;
      d.age = ageFromBirthday(d.birthday);
      if (!d.age) return toast('Проверь дату рождения', 'err');
    }
    if (cur === 'body') {
      d.height = Number($('#onbHeight', ov).value) || null;
      d.weight = Number($('#onbWeight', ov).value) || null;
      if (!d.height || !d.weight) return toast('Укажи рост и вес', 'err');
    }
    if (cur === 'target') {
      d.targetWeight = Number($('#onbTarget', ov).value) || null;
      if (!d.targetWeight) return toast('Укажи целевой вес', 'err');
      if (d.goal === 'lose' && d.targetWeight >= d.weight) return toast('Целевой вес должен быть меньше текущего', 'err');
      if (d.goal === 'gain' && d.targetWeight <= d.weight) return toast('Целевой вес должен быть больше текущего', 'err');
    }
    if (step < S.length - 1) { step++; render(); return; }
    finish();
  }

  function finish() {
    Object.assign(state.profile, {
      sex: d.sex, age: d.age, birthday: d.birthday || '', height: d.height, activity: d.activity,
      goal: d.goal, goalRate: d.goalRate,
      targetWeight: (d.goal === 'lose' || d.goal === 'gain') ? d.targetWeight : null,
      startWeight: d.weight, onboarded: true,
    });
    state.goals.kcal = null; // let the freshly computed goal take effect
    logWeight(d.weight);
    save();
    loadProfileForm(); renderAll();
    ov.remove();
    toast('Цель настроена 🎯', 'ok');
  }

  render();
  ov.onclick = (e) => { if (e.target === ov && !first) ov.remove(); };
}

/* ---------- data export / import / reset ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `aqua-backup-${todayKey()}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast('Данные экспортированы', 'ok');
}
function importData(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try { state = deepMerge(structuredClone(DEFAULTS), JSON.parse(rd.result)); save(); loadProfileForm(); renderAll(); applyTheme(); applyReminder(); toast('Импортировано', 'ok'); }
    catch (e) { toast('Не удалось прочитать файл', 'err'); }
  };
  rd.readAsText(file);
}
async function resetAll() {
  const r = await openModal({ title: 'Сбросить все данные?', body: 'Вода, еда, задачи, привычки и профиль будут удалены безвозвратно.', okText: 'Удалить всё', danger: true, fields: [] });
  if (!r) return;
  state = structuredClone(DEFAULTS); save(); loadProfileForm(); renderAll(); applyTheme(); applyReminder();
  toast('Всё сброшено');
}

/* ============================================================
   THEME
   ============================================================ */
const THEMES = [
  { id: 'dark', name: 'Тёмная', icon: '🌙', prev: 'linear-gradient(135deg,#0e0f1c 42%,#6366f1,#22d3ee)' },
  { id: 'light', name: 'Светлая', icon: '☀️', prev: 'linear-gradient(135deg,#f3f4fb 42%,#6366f1,#22d3ee)' },
  { id: 'evening', name: 'Вечер', icon: '🌆', prev: 'linear-gradient(135deg,#160f26 42%,#a855f7,#f0883e)' },
  { id: 'morning', name: 'Утро', icon: '🌅', prev: 'linear-gradient(135deg,#eef3fb 42%,#60a5fa,#fbbf77)' },
  { id: 'cream', name: 'Кремовая', icon: '🍦', prev: 'linear-gradient(135deg,#f4ecdf 42%,#d9a441,#e07a5f)' },
  { id: 'ocean', name: 'Океан', icon: '🌊', prev: 'linear-gradient(135deg,#0a1a24 42%,#06b6d4,#0ea5e9)' },
  { id: 'forest', name: 'Лес', icon: '🌲', prev: 'linear-gradient(135deg,#0e1a12 42%,#34d399,#a3e635)' },
];
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  const t = $('#themeToggle');
  const th = THEMES.find((x) => x.id === state.settings.theme) || THEMES[0];
  if (t) t.querySelector('.ic').textContent = th.icon;
}
function setTheme(id) {
  const applyNow = () => { state.settings.theme = id; save(); applyTheme(); renderView(currentView); };
  if (!document.startViewTransition) { applyNow(); return; }
  const btn = document.getElementById('themeToggle');
  const rect = btn ? btn.getBoundingClientRect() : { left: 40, top: innerHeight - 40, width: 40, height: 40 };
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(applyNow);
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 500, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: '::view-transition-new(root)' }
    );
  });
}
function openThemePicker() {
  const cur = state.settings.theme;
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `<div class="card theme-picker">
    <h3 class="modal-title">Тема оформления</h3>
    <div class="theme-grid">${THEMES.map((t) => `<button class="theme-sw ${t.id === cur ? 'active' : ''}" data-id="${t.id}"><span class="tsw-prev" style="background:${t.prev}"></span><span class="tsw-name">${t.icon} ${t.name}</span></button>`).join('')}</div>
    <button class="btn ghost full" data-close>Закрыть</button></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('[data-close]').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelectorAll('.theme-sw').forEach((b) => (b.onclick = () => { close(); setTheme(b.dataset.id); }));
}

/* ============================================================
   REMINDERS
   ============================================================ */
let webReminderTimer = null;

// Ask for OS notification permission (must be triggered by a user gesture).
async function ensureNotifyPermission() {
  if (DESKTOP) return true;
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch (e) { return false; }
}

// Show a notification now. Prefers the service worker (survives window in background).
async function notifyNow(title, body) {
  if (DESKTOP) { window.desktop.notify({ title, body, tab: 'water' }); return true; }
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, icon: 'assets/icon-192.png', badge: 'assets/icon-192.png', tag: 'aqua-water', renotify: true });
      return true;
    }
  } catch (e) { /* fall through */ }
  try { new Notification(title, { body, icon: 'assets/icon-192.png' }); return true; } catch (e) { return false; }
}

function applyReminder() {
  const cfg = { ...state.settings.reminder, body: 'Сделай пару глотков — тело скажет спасибо.' };
  if (DESKTOP) { window.desktop.setReminder(cfg); return; }
  if (webReminderTimer) { clearInterval(webReminderTimer); webReminderTimer = null; }
  if (!cfg.enabled) return;
  webReminderTimer = setInterval(() => {
    const h = new Date().getHours(); const { quietFrom: f, quietTo: to } = cfg;
    const quiet = f === to ? false : (f < to ? (h >= f && h < to) : (h >= f || h < to));
    if (quiet) return;
    notifyNow('💧 Пора пить воду', cfg.body).then((ok) => { if (!ok) toast('💧 Пора пить воду!', 'ok'); });
  }, Math.max(5, cfg.intervalMinutes) * 60 * 1000);
}

async function testNotify() {
  const ok = await ensureNotifyPermission();
  if (!ok) {
    toast('Уведомления заблокированы. Разреши их для приложения (значок замка в адресе / настройки Windows)', 'err');
    return;
  }
  const shown = await notifyNow('💧 Проверка', 'Уведомления работают!');
  if (shown) toast('Уведомление отправлено', 'ok');
  else toast('Не удалось показать уведомление', 'err');
}

/* ============================================================
   MODAL
   ============================================================ */
function openModal({ title, body = '', fields = [], okText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);display:grid;place-items:center;z-index:200;animation:fadeUp .2s';
    const inputs = fields.map((f) => `<label style="display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--text-dim);font-weight:600;margin-bottom:10px">${f.label}<input data-k="${f.key}" placeholder="${f.placeholder||''}" value="${(f.value||'').toString().replace(/"/g,'&quot;')}"></label>`).join('');
    ov.innerHTML = `<div class="card" style="width:min(420px,92vw)">
      <h3 style="font-family:var(--display);font-size:19px;margin-bottom:${body||fields.length?'12px':'18px'}">${title}</h3>
      ${body ? `<p class="hint" style="margin-bottom:14px">${body}</p>` : ''}
      ${inputs}
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn ghost" data-cancel style="flex:1">Отмена</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok style="flex:1">${okText}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const close = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('[data-cancel]').onclick = () => close(null);
    ov.querySelector('[data-ok]').onclick = () => {
      const r = {}; ov.querySelectorAll('input[data-k]').forEach((i) => (r[i.dataset.k] = i.value));
      close(fields.length ? r : true);
    };
    ov.onclick = (e) => { if (e.target === ov) close(null); };
    const first = ov.querySelector('input'); if (first) first.focus();
    ov.querySelectorAll('input').forEach((i) => (i.onkeydown = (e) => { if (e.key === 'Enter') ov.querySelector('[data-ok]').click(); }));
  });
}

/* ============================================================
   HELPERS
   ============================================================ */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function updateTopbar() {
  const G = computeGoals(); const t = waterTotal();
  // selected-day label with relative hint
  const diff = Math.round((SEL - todayStart()) / 86400000);
  let rel = '';
  if (diff === 0) rel = 'Сегодня'; else if (diff === -1) rel = 'Вчера'; else if (diff === 1) rel = 'Завтра';
  const dateEl = $('#topbarDate');
  if (dateEl) {
    dateEl.textContent = `${rel ? rel + ', ' : RU_DOW[(SEL.getDay()+6)%7] + ', '}${SEL.getDate()} ${RU_MONTHS_GEN[SEL.getMonth()]}`;
    dateEl.classList.toggle('past', !isSelToday());
  }
  const nextBtn = $('#dayNext'); if (nextBtn) nextBtn.disabled = isSelToday();
  renderAvatarInto($('#topAvatar'), state.profile.avatar);
  // mini water ring
  const pct = clamp((t / G.waterGoal) * 100, 0, 100);
  const ring = $('#miniWaterRing');
  if (ring) { ring.style.background = `conic-gradient(#38bdf8 ${pct}%, rgba(255,255,255,.12) 0)`; ring.innerHTML = `<div style="width:34px;height:34px;border-radius:50%;background:var(--bg-2);display:grid;place-items:center">${Math.round(pct)}</div>`; }
  if (DESKTOP) window.desktop.setTrayTooltip(`Aqua · Вода: ${t}/${G.waterGoal} мл`);
}
function updateBadges() {
  const n = state.tasks.filter((t) => !t.done).length;
  const b = $('#navTasksBadge');
  if (b) { b.textContent = n; b.classList.toggle('show', n > 0); }
}

/* ============================================================
   FINANCE — planner (budget, savings, debt, leaks, income, hustles)
   Deterministic math runs offline; advisory modules optionally use the
   user's own Claude key for a personalized plan.
   ============================================================ */
const F = () => state.finance;
// [name, kind, icon, benchmark share of income] — benchmark drives leak flags.
const FIN_CATS = [
  ['Аренда/ипотека', 'fixed', '🏠', 0.30], ['Коммуналка', 'fixed', '💡', 0.08],
  ['Связь и интернет', 'fixed', '📶', 0.03], ['Подписки', 'fixed', '📺', 0.03],
  ['Страховка', 'fixed', '🛡️', 0.05], ['Кредиты', 'fixed', '🏦', 0.15],
  ['Продукты', 'variable', '🛒', 0.15], ['Кафе и доставка', 'variable', '🍔', 0.07],
  ['Транспорт', 'variable', '🚗', 0.10], ['Развлечения', 'variable', '🎮', 0.06],
  ['Одежда', 'variable', '👕', 0.05], ['Здоровье', 'variable', '💊', 0.05],
  ['Прочее', 'variable', '🧾', 0.05],
];
const FIN_CAT = Object.fromEntries(FIN_CATS.map((c) => [c[0], { kind: c[1], icon: c[2], bench: c[3] }]));
const FIN_GOALS = {
  control:   { icon: '🎯', label: 'Контроль расходов', hint: 'видеть, куда уходят деньги' },
  save:      { icon: '🐷', label: 'Копить на цель',    hint: 'откладывать системно' },
  emergency: { icon: '💰', label: 'Финансовая подушка', hint: 'резерв 3–6 месяцев' },
  debt:      { icon: '🏦', label: 'Закрыть долги',      hint: 'выбраться из кредитов' },
  income:    { icon: '📈', label: 'Больше дохода',      hint: 'снизить зависимость от ЗП' },
};
const SKILL_CHIPS = ['Программирование', 'Дизайн', 'Копирайтинг', 'Английский', 'Продажи', 'Маркетинг', 'Видео/монтаж', 'Фото', 'Excel/таблицы', 'Репетиторство', 'Музыка', 'Ремонт/руки', 'Готовка', 'SMM', 'Вождение', 'Аналитика'];

function finFmt(n) { return (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + ' ₽'; }
function finShort(n) {
  n = Math.round(Number(n) || 0); const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' млн';
  if (a >= 1e4) return Math.round(n / 1e3) + 'к';
  return n.toLocaleString('ru-RU');
}
function totalIncome() { return F().income.reduce((s, i) => s + (+i.amount || 0), 0); }
function expensesByKind(kind) { return F().expenses.filter((e) => e.kind === kind).reduce((s, e) => s + (+e.amount || 0), 0); }
function totalExpenses() { return F().expenses.reduce((s, e) => s + (+e.amount || 0), 0); }
function totalDebt() { return F().debts.reduce((s, d) => s + (+d.balance || 0), 0); }
function netCashFlow() { return totalIncome() - totalExpenses() - (F().savings.monthly || 0); }
function savingsRatePct() { const inc = totalIncome(); return inc ? Math.round((F().savings.monthly / inc) * 100) : 0; }

/* ---------- money inputs (pretty thousands separators while typing) ---------- */
function parseMoney(v) { return Number(String(v == null ? '' : v).replace(/[^\d]/g, '')) || 0; }
function fmtMoneyInput(v) { const n = String(v == null ? '' : v).replace(/[^\d]/g, ''); return n ? Number(n).toLocaleString('ru-RU') : ''; }
// Format every input.money inside root as the user types; optional cb fires after each edit.
function bindMoney(root, cb) {
  root.querySelectorAll('input.money').forEach((el) => {
    el.value = fmtMoneyInput(el.value);
    el.oninput = () => {
      const before = el.value.length, caret = el.selectionStart || 0;
      el.value = fmtMoneyInput(el.value);
      const d = el.value.length - before, pos = Math.max(0, caret + d);
      try { el.setSelectionRange(pos, pos); } catch (e) {}
      if (cb) cb();
    };
  });
}

/* ---------- daily ledger (transactions) ---------- */
const TX_TYPES = {
  expense: { label: 'Расход', icon: '🛒', color: 'var(--danger)' },
  saving: { label: 'Отложил', icon: '🐷', color: 'var(--accent-2)' },
  unsave: { label: 'Из подушки', icon: '🏦', color: 'var(--warn)' }, // spent from set-aside money
  income: { label: 'Доход', icon: '💵', color: 'var(--ok)' },
};
function curMonth() { return todayKey().slice(0, 7); }
function monthKey(dstr) { return (dstr || todayKey()).slice(0, 7); }
function txThisMonth() { const m = curMonth(); return F().tx.filter((t) => monthKey(t.date) === m); }
function sumTx(list, type) { return list.filter((t) => t.type === type).reduce((s, t) => s + (+t.amount || 0), 0); }
function spentThisMonth() { return sumTx(txThisMonth(), 'expense'); }
function savedThisMonth() { return sumTx(txThisMonth(), 'saving') - sumTx(txThisMonth(), 'unsave'); } // net into the pot
function extraIncomeThisMonth() { return sumTx(txThisMonth(), 'income'); }
function totalSaved() { return (F().savings.current || 0) + sumTx(F().tx, 'saving') - sumTx(F().tx, 'unsave'); }
function monthlyIncome() { return totalIncome() + extraIncomeThisMonth(); }
// Actual month spend by category, falling back to the planned quiz expenses before anything is logged.
function spentByCatMonth() {
  const map = {}; let any = false;
  txThisMonth().filter((t) => t.type === 'expense').forEach((t) => { any = true; const c = t.cat || 'Прочее'; map[c] = (map[c] || 0) + (+t.amount || 0); });
  if (!any) F().expenses.forEach((e) => { map[e.cat] = (map[e.cat] || 0) + (+e.amount || 0); });
  return map;
}
function spentByKindMonth(kind) {
  const map = spentByCatMonth(); let s = 0;
  Object.keys(map).forEach((c) => { if (((FIN_CAT[c] && FIN_CAT[c].kind) || 'variable') === kind) s += map[c]; });
  return s;
}
function addTx(t) {
  F().tx.push({ id: uid(), ts: Date.now(), date: t.date || todayKey(), type: t.type, amount: +t.amount || 0, cat: t.cat || '', note: t.note || '' });
  save();
}
function delTx(id) { F().tx = F().tx.filter((t) => t.id !== id); save(); }
// Money available right now: starting balance + all income − expenses − amounts moved to savings.
function currentBalance() { return (F().balance || 0) + sumTx(F().tx, 'income') - sumTx(F().tx, 'expense') - sumTx(F().tx, 'saving'); }
function totalWealth() { return currentBalance() + totalSaved(); }

/* ---------- budget 50/30/20 (adaptive) ---------- */
function budgetPlan() {
  const income = totalIncome();
  const needs = spentByKindMonth('fixed');
  const wants = spentByKindMonth('variable');
  const save = savedThisMonth() || F().savings.monthly || 0;
  const ideal = { needs: income * 0.5, wants: income * 0.3, save: income * 0.2 };
  const leftover = income - needs - wants - save;
  // If essentials already blow past 50%, propose a realistic split from what's left.
  let advice = 'balanced';
  if (income > 0) {
    if (needs > income * 0.55) advice = 'needs-heavy';
    else if (save < income * 0.1) advice = 'low-savings';
    else if (leftover < 0) advice = 'overspend';
  }
  return { income, needs, wants, save, ideal, leftover, advice };
}

/* ---------- savings / emergency fund ---------- */
function savingsPlan() {
  const f = F(); const income = totalIncome();
  const essentials = spentByKindMonth('fixed') + spentByKindMonth('variable') * 0.6;
  const emerg3 = Math.round(essentials * 3), emerg6 = Math.round(essentials * 6);
  const cur = totalSaved();
  const base = f.savings.monthly || savedThisMonth() || Math.round(income * 0.1) || 0;
  const goalAmount = f.savings.goalAmount || emerg3;
  const remaining = Math.max(0, goalAmount - cur);
  const monthsFor = (m) => (m > 0 ? Math.ceil(remaining / m) : null);
  return {
    income, essentials, emerg3, emerg6, cur, base, goalAmount, remaining,
    rate: savingsRatePct(),
    emergProgress: emerg3 ? clamp((cur / emerg3) * 100, 0, 100) : 0,
    goalProgress: goalAmount ? clamp((cur / goalAmount) * 100, 0, 100) : 0,
    scenarios: [
      { key: 'small', label: 'Спокойно', m: Math.max(1, Math.round(base * 0.5)), months: monthsFor(Math.round(base * 0.5)) },
      { key: 'medium', label: 'Обычно', m: Math.max(1, base), months: monthsFor(base) },
      { key: 'aggr', label: 'Агрессивно', m: Math.max(1, Math.round(base * 2)), months: monthsFor(Math.round(base * 2)) },
    ],
  };
}

/* ---------- debt payoff simulation ---------- */
function simulateDebts(method) {
  const src = F().debts.filter((d) => (+d.balance || 0) > 0);
  if (!src.length) return null;
  const ds = src.map((d) => ({ id: d.id, name: d.name, bal: +d.balance, apr: +d.apr || 0, min: +d.min || 0 }));
  const totalMin = ds.reduce((s, d) => s + d.min, 0);
  const budget = totalMin + (+F().extraPayment || 0);
  let month = 0, totalInterest = 0;
  const perDebt = {}; ds.forEach((d) => (perDebt[d.id] = { interest: 0, paidMonth: 0 }));
  const orderActive = () => {
    const active = ds.filter((d) => d.bal > 0.005);
    const totalBal = active.reduce((s, d) => s + d.bal, 0);
    if (method === 'snowball') return active.slice().sort((a, b) => a.bal - b.bal);
    if (method === 'hybrid') return active.slice().sort((a, b) => {
      const aS = a.bal < totalBal * 0.1, bS = b.bal < totalBal * 0.1;
      if (aS !== bS) return aS ? -1 : 1;
      return b.apr - a.apr;
    });
    return active.slice().sort((a, b) => b.apr - a.apr); // avalanche
  };
  while (ds.some((d) => d.bal > 0.005) && month < 600) {
    month++;
    ds.forEach((d) => { if (d.bal > 0) { const i = d.bal * (d.apr / 1200); d.bal += i; totalInterest += i; perDebt[d.id].interest += i; } });
    let pool = budget;
    ds.forEach((d) => { if (d.bal > 0) { const pay = Math.min(d.min, d.bal); d.bal -= pay; pool -= pay; } });
    if (pool < 0) pool = 0;
    for (const d of orderActive()) { if (pool <= 0.005) break; const pay = Math.min(pool, d.bal); d.bal -= pay; pool -= pay; }
    ds.forEach((d) => { if (d.bal <= 0.005 && !perDebt[d.id].paidMonth) perDebt[d.id].paidMonth = month; });
  }
  return { method, months: month, totalInterest: Math.round(totalInterest), perDebt, monthly: budget, cleared: !ds.some((d) => d.bal > 0.005) };
}
function debtCompare() {
  const methods = ['snowball', 'avalanche', 'hybrid'];
  const res = {}; methods.forEach((m) => (res[m] = simulateDebts(m)));
  if (!res.avalanche) return null;
  // Best = least total interest (ties broken by fewer months). Note snowball's motivational edge.
  let best = 'avalanche';
  methods.forEach((m) => { if (res[m] && (res[m].totalInterest < res[best].totalInterest - 1 || (Math.abs(res[m].totalInterest - res[best].totalInterest) <= 1 && res[m].months < res[best].months))) best = m; });
  return { res, best };
}

/* ---------- expense leaks ---------- */
function leakClass(cat, over) {
  const map = {
    'Подписки': ['лёгкая', 'без потерь', 'высокий'], 'Кафе и доставка': ['средняя', 'заметно', 'высокий'],
    'Развлечения': ['средняя', 'заметно', 'средний'], 'Одежда': ['лёгкая', 'без потерь', 'средний'],
    'Связь и интернет': ['лёгкая', 'без потерь', 'средний'], 'Транспорт': ['средняя', 'заметно', 'средний'],
    'Прочее': ['средняя', 'без потерь', 'средний'], 'Продукты': ['средняя', 'заметно', 'низкий'],
    'Коммуналка': ['высокая', 'без потерь', 'низкий'], 'Страховка': ['средняя', 'без потерь', 'средний'],
  };
  const [difficulty, impact, priority] = map[cat] || ['средняя', 'заметно', 'средний'];
  return { difficulty, impact, priority };
}
function leakScan() {
  const income = totalIncome() || 1;
  const leaks = [];
  const byCat = spentByCatMonth();
  Object.keys(byCat).forEach((cat) => {
    const amount = +byCat[cat] || 0; if (amount <= 0) return;
    const bench = (FIN_CAT[cat] && FIN_CAT[cat].bench) || 0.05;
    const share = amount / income;
    const target = bench * income;
    if (share > bench * 1.25) {
      leaks.push({ name: cat, cat, amount, over: Math.round(amount - target), share, ...leakClass(cat, amount - target) });
    }
  });
  leaks.sort((a, b) => b.over - a.over);
  const totalSave = leaks.reduce((s, l) => s + l.over, 0);
  return { leaks, totalSave };
}

/* ---------- curated income & side-hustle ideas (offline advisory) ---------- */
// [name, tags, start(1-5 easy→hard), invest, timeToIncome, risk(1-5), growth(1-5)]
const INCOME_IDEAS = [
  ['Фриланс по основному навыку', ['Программирование', 'Дизайн', 'Копирайтинг', 'Видео/монтаж', 'Маркетинг', 'SMM', 'Аналитика'], 2, 'низкие', '2–4 нед', 2, 4],
  ['Репетиторство / консультации', ['Английский', 'Репетиторство', 'Программирование', 'Музыка', 'Аналитика'], 1, 'нет', '1–2 нед', 1, 3],
  ['Онлайн-курс или гайд', ['Программирование', 'Дизайн', 'Маркетинг', 'Английский', 'Фото'], 4, 'низкие', '1–3 мес', 2, 5],
  ['Контент/блог с монетизацией', ['Видео/монтаж', 'Фото', 'Копирайтинг', 'SMM', 'Музыка'], 3, 'низкие', '3–6 мес', 3, 5],
  ['Товарка / маркетплейсы', ['Продажи', 'Маркетинг'], 4, 'средние', '1–2 мес', 4, 4],
  ['Услуги руками (ремонт, сборка)', ['Ремонт/руки', 'Вождение'], 1, 'низкие', '1 нед', 2, 2],
  ['Микро-SaaS / шаблоны', ['Программирование', 'Дизайн', 'Excel/таблицы'], 5, 'низкие', '2–4 мес', 3, 5],
  ['Партнёрские программы', ['Маркетинг', 'SMM', 'Копирайтинг'], 3, 'нет', '1–3 мес', 3, 4],
  ['Дивиденды / вклады', [], 2, 'высокие', 'сразу', 2, 2],
  ['Аренда вещей/техники', [], 2, 'средние', '2–4 нед', 3, 2],
];

/* ---------- finance onboarding quiz (fills all the [bracket] data once) ---------- */
function openFinanceQuiz(first) {
  const f = F();
  const d = {
    goal: f.profile.goal || 'control', household: f.profile.household || 1, trigger: f.profile.trigger || '',
    income: f.income.length ? f.income.map((x) => ({ ...x })) : [{ id: uid(), name: 'Зарплата', amount: '' }],
    exp: {}, savings: { ...f.savings }, balance: f.balance || '',
    debts: f.debts.map((x) => ({ ...x })), extraPayment: f.extraPayment || '',
  };
  f.expenses.forEach((e) => { d.exp[e.cat] = (d.exp[e.cat] || 0) + (+e.amount || 0); });
  let step = 0;
  const ov = document.createElement('div');
  ov.className = 'modal-ov onb-ov fin-quiz';
  document.body.appendChild(ov);
  const steps = ['goal', 'income', 'expenses', 'savings', 'debts', 'summary'];
  const card = (sel, icon, title, sub, val) =>
    `<button class="onb-card ${sel ? 'sel' : ''}" data-val="${val}"><span class="onb-card-ic">${icon}</span><span class="onb-card-txt"><span class="onb-card-t">${title}</span>${sub ? `<span class="onb-card-s">${sub}</span>` : ''}</span></button>`;

  function body(cur) {
    if (cur === 'goal') {
      return `<h3 class="onb-title">Финансовая цель</h3><p class="onb-sub">С чего начнём наводить порядок в деньгах.</p>
        <div class="onb-cards">${Object.keys(FIN_GOALS).map((g) => card(d.goal === g, FIN_GOALS[g].icon, FIN_GOALS[g].label, FIN_GOALS[g].hint, g)).join('')}</div>
        <div class="fin-two">
          <label class="mlabel">Человек в семье<input type="number" id="fqHouse" min="1" max="12" value="${d.household}"></label>
          <label class="mlabel">Главный триггер трат<input type="text" id="fqTrigger" placeholder="скука, стресс, акции…" value="${escapeAttr(d.trigger)}"></label>
        </div>`;
    }
    if (cur === 'income') {
      return `<h3 class="onb-title">Доходы в месяц</h3><p class="onb-sub">Зарплата и любые другие поступления.</p>
        <div id="fqIncomeList">${d.income.map((i) => incomeRow(i)).join('')}</div>
        <button class="btn ghost sm" id="fqAddIncome">＋ Источник дохода</button>
        <div class="fin-quiz-total">Итого: <b id="fqIncTotal">${finFmt(d.income.reduce((s, i) => s + parseMoney(i.amount), 0))}</b> / мес</div>`;
    }
    if (cur === 'expenses') {
      return `<h3 class="onb-title">Расходы в месяц</h3><p class="onb-sub">Примерные суммы для плана. Дальше будешь просто отмечать реальные траты каждый день.</p>
        <div class="fin-exp-grid">${FIN_CATS.map((c) => `
          <label class="fin-exp-row"><span class="fin-exp-ic">${c[2]}</span><span class="fin-exp-name">${c[0]}</span>
            <input type="text" inputmode="numeric" class="fin-exp-inp money" data-cat="${c[0]}" placeholder="0" value="${d.exp[c[0]] || ''}"></label>`).join('')}</div>
        <div class="fin-quiz-total">Итого расходов: <b id="fqExpTotal">${finFmt(Object.values(d.exp).reduce((s, v) => s + (+v || 0), 0))}</b></div>`;
    }
    if (cur === 'savings') {
      return `<h3 class="onb-title">Деньги и сбережения</h3><p class="onb-sub">Сколько сейчас на руках и что уже отложено.</p>
        <label class="mlabel">💼 Денег сейчас (наличные + карты + счёт)<input type="text" inputmode="numeric" class="money" id="fqBalance" placeholder="0" value="${d.balance || ''}"></label>
        <div class="fin-two">
          <label class="mlabel">Уже отложено (подушка/цель)<input type="text" inputmode="numeric" class="money" id="fqSaveCur" placeholder="0" value="${d.savings.current || ''}"></label>
          <label class="mlabel">Откладываю в месяц<input type="text" inputmode="numeric" class="money" id="fqSaveMon" placeholder="0" value="${d.savings.monthly || ''}"></label>
          <label class="mlabel">Цель (на что)<input type="text" id="fqSaveGoal" placeholder="отпуск, техника…" value="${escapeAttr(d.savings.goalName)}"></label>
          <label class="mlabel">Сумма цели<input type="text" inputmode="numeric" class="money" id="fqSaveGoalAmt" placeholder="0" value="${d.savings.goalAmount || ''}"></label>
        </div>`;
    }
    if (cur === 'debts') {
      return `<h3 class="onb-title">Долги и кредиты</h3><p class="onb-sub">Если нет — просто нажми «Далее».</p>
        <div id="fqDebtList">${d.debts.length ? d.debts.map((x) => debtRow(x)).join('') : '<div class="meal-empty">Долгов пока нет 🎉</div>'}</div>
        <button class="btn ghost sm" id="fqAddDebt">＋ Долг / кредит</button>
        <label class="mlabel" style="margin-top:12px">Могу доплачивать сверх минималок, ₽/мес<input type="text" inputmode="numeric" class="money" id="fqExtra" placeholder="0" value="${d.extraPayment || ''}"></label>`;
    }
    if (cur === 'summary') {
      const inc = d.income.reduce((s, i) => s + parseMoney(i.amount), 0);
      const exp = Object.values(d.exp).reduce((s, v) => s + (+v || 0), 0);
      const net = inc - exp - (+d.savings.monthly || 0);
      return `<div class="onb-hero">${FIN_GOALS[d.goal].icon}</div><h3 class="onb-title">Готово!</h3>
        <div class="onb-summary">
          <div class="fin-sum-grid">
            <div class="fin-sum"><b>${finFmt(inc)}</b><small>доход</small></div>
            <div class="fin-sum"><b>${finFmt(exp)}</b><small>расходы</small></div>
            <div class="fin-sum ${net < 0 ? 'neg' : 'pos'}"><b>${net >= 0 ? '+' : ''}${finFmt(net)}</b><small>остаётся</small></div>
            <div class="fin-sum"><b>${d.debts.length}</b><small>долгов</small></div>
          </div>
          <div class="onb-break">Цель: ${FIN_GOALS[d.goal].icon} ${FIN_GOALS[d.goal].label} · дальше открой модули на вкладке «Финансы»</div>
        </div>`;
    }
    return '';
  }
  const incomeRow = (i) => `<div class="fin-row" data-id="${i.id}"><input type="text" class="fq-inc-name" placeholder="Источник" value="${escapeAttr(i.name)}"><input type="text" inputmode="numeric" class="fq-inc-amt money" placeholder="₽/мес" value="${i.amount || ''}"><button class="fin-row-del" data-del="${i.id}">✕</button></div>`;
  const debtRow = (x) => `<div class="fin-row debt" data-id="${x.id}"><input type="text" class="fq-debt-name" placeholder="Название" value="${escapeAttr(x.name || '')}"><input type="text" inputmode="numeric" class="fq-debt-bal money" placeholder="Баланс" value="${x.balance || ''}"><input type="number" class="fq-debt-apr" placeholder="% год" min="0" value="${x.apr || ''}"><input type="text" inputmode="numeric" class="fq-debt-min money" placeholder="Мин/мес" value="${x.min || ''}"><button class="fin-row-del" data-del="${x.id}">✕</button></div>`;

  // Read the currently-visible step's DOM back into the draft (so nothing is lost on nav).
  function grab(cur) {
    const q = (s) => ov.querySelector(s);
    if (cur === 'goal') { d.household = Number(q('#fqHouse').value) || 1; d.trigger = q('#fqTrigger').value; }
    if (cur === 'income') d.income = [...ov.querySelectorAll('#fqIncomeList .fin-row')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.fq-inc-name').value, amount: parseMoney(r.querySelector('.fq-inc-amt').value) }));
    if (cur === 'expenses') { d.exp = {}; ov.querySelectorAll('.fin-exp-inp').forEach((i) => { const v = parseMoney(i.value); if (v) d.exp[i.dataset.cat] = v; }); }
    if (cur === 'savings') { d.balance = parseMoney(q('#fqBalance').value); d.savings.current = parseMoney(q('#fqSaveCur').value); d.savings.monthly = parseMoney(q('#fqSaveMon').value); d.savings.goalName = q('#fqSaveGoal').value; d.savings.goalAmount = parseMoney(q('#fqSaveGoalAmt').value); }
    if (cur === 'debts') { d.debts = [...ov.querySelectorAll('#fqDebtList .fin-row')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.fq-debt-name').value, balance: parseMoney(r.querySelector('.fq-debt-bal').value), apr: Number(r.querySelector('.fq-debt-apr').value) || 0, min: parseMoney(r.querySelector('.fq-debt-min').value) })); d.extraPayment = parseMoney(q('#fqExtra').value); }
  }
  function render() {
    if (step >= steps.length) step = steps.length - 1;
    const cur = steps[step]; const last = step === steps.length - 1;
    ov.innerHTML = `<div class="card onb-modal fin-modal">
      <div class="onb-dots">${steps.map((_, i) => `<span class="onb-dot ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}"></span>`).join('')}</div>
      <div class="onb-body">${body(cur)}</div>
      <div class="onb-actions">
        ${step > 0 ? '<button class="btn ghost" data-back>Назад</button>' : `<button class="btn ghost" data-skip>${first ? 'Позже' : 'Отмена'}</button>`}
        <button class="btn primary" data-next>${last ? '💰 Готово' : 'Далее'}</button>
      </div></div>`;
    // goal cards
    ov.querySelectorAll('.onb-card').forEach((b) => (b.onclick = () => { grab(cur); d.goal = b.dataset.val; render(); }));
    // skill chips
    ov.querySelectorAll('.skill-chip').forEach((b) => (b.onclick = () => { const s = b.dataset.skill; const i = d.skills.indexOf(s); if (i >= 0) d.skills.splice(i, 1); else d.skills.push(s); b.classList.toggle('on'); }));
    // income add/del
    const ia = ov.querySelector('#fqAddIncome'); if (ia) ia.onclick = () => { grab(cur); d.income.push({ id: uid(), name: '', amount: '' }); render(); };
    const da = ov.querySelector('#fqAddDebt'); if (da) da.onclick = () => { grab(cur); d.debts.push({ id: uid(), name: '', balance: '', apr: '', min: '' }); render(); };
    ov.querySelectorAll('.fin-row-del').forEach((b) => (b.onclick = () => { grab(cur); const id = b.dataset.del; d.income = d.income.filter((x) => x.id !== id); d.debts = d.debts.filter((x) => x.id !== id); render(); }));
    // money inputs: format with separators + live-update the step totals
    const updTotals = () => {
      const it = ov.querySelector('#fqIncTotal'); if (it) it.textContent = finFmt([...ov.querySelectorAll('.fq-inc-amt')].reduce((s, x) => s + parseMoney(x.value), 0));
      const et = ov.querySelector('#fqExpTotal'); if (et) et.textContent = finFmt([...ov.querySelectorAll('.fin-exp-inp')].reduce((s, x) => s + parseMoney(x.value), 0));
    };
    bindMoney(ov, updTotals);
    ov.querySelector('[data-next]').onclick = () => { grab(cur); if (last) return finish(); step++; render(); };
    const bk = ov.querySelector('[data-back]'); if (bk) bk.onclick = () => { grab(cur); step--; render(); };
    const sk = ov.querySelector('[data-skip]'); if (sk) sk.onclick = () => { if (first) { F().onboarded = true; save(); } ov.remove(); };
  }
  function finish() {
    const fin = F();
    fin.profile = { household: d.household, goal: d.goal, trigger: d.trigger };
    fin.income = d.income.filter((i) => i.name || i.amount).map((i) => ({ id: i.id, name: i.name || 'Доход', amount: +i.amount || 0 }));
    fin.expenses = Object.keys(d.exp).filter((c) => d.exp[c] > 0).map((c) => ({ id: uid(), name: c, cat: c, amount: d.exp[c], kind: (FIN_CAT[c] && FIN_CAT[c].kind) || 'variable' }));
    fin.savings = { current: +d.savings.current || 0, monthly: +d.savings.monthly || 0, goalName: d.savings.goalName || '', goalAmount: +d.savings.goalAmount || 0 };
    fin.balance = +d.balance || 0;
    fin.debts = d.debts.filter((x) => +x.balance > 0).map((x) => ({ id: x.id, name: x.name || 'Долг', balance: +x.balance, apr: +x.apr || 0, min: +x.min || 0 }));
    fin.extraPayment = +d.extraPayment || 0;
    fin.onboarded = true;
    save(); renderFinance(); renderDashboard(); ov.remove();
    toast('Финансовый план создан 💰', 'ok');
  }
  render();
  ov.onclick = (e) => { if (e.target === ov && !first) ov.remove(); };
}
function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }

/* ---------- finance tab render ---------- */
let finQuizAuto = false;
function finCard(id, icon, title, body, action) {
  return `<div class="fin-card" data-mod="${id}"><div class="fin-card-head"><span class="fin-card-ic">${icon}</span><h4>${title}</h4>${action || ''}</div><div class="fin-card-body">${body}</div></div>`;
}
function finStat(label, val, ic, cls) {
  return `<div class="fin-stat ${cls || ''}"><span class="fin-stat-ic">${ic}</span><div class="fin-stat-txt"><b>${val}</b><small>${label}</small></div></div>`;
}
function renderFinance() {
  const root = $('#financeRoot'); if (!root) return;
  const f = F();
  if (!f.onboarded) {
    root.innerHTML = `<div class="card fin-hero">
      <div class="fin-hero-ic">💰</div>
      <h3>Финансовый планировщик</h3>
      <p>Пройди короткий квиз — получишь бюджет 50/30/20, стратегию по долгам, подушку безопасности, поиск утечек, план доходов, подработки и скрипты для переговоров о зарплате. Всё считается на твоём компьютере, данные никуда не уходят.</p>
      <button class="btn primary" id="finStartQuiz">🎯 Пройти квиз (2 минуты)</button>
    </div>`;
    $('#finStartQuiz').onclick = () => openFinanceQuiz(true);
    if (!finQuizAuto) { finQuizAuto = true; setTimeout(() => { if (!F().onboarded && currentView === 'finance') openFinanceQuiz(true); }, 350); }
    return;
  }
  const inc = monthlyIncome(), spent = spentThisMonth(), saved = savedThisMonth();
  root.innerHTML = `
    ${finBalanceCard()}
    <div class="fin-strip">
      ${finStat('Доход / мес', finFmt(inc), '📥')}
      ${finStat('Потрачено', finFmt(spent), '📤', spent > inc ? 'neg' : '')}
      ${finStat('Отложено', finFmt(saved), '🐷')}
      ${finStat('Долги', finFmt(totalDebt()), '🏦')}
      <button class="btn ghost sm fin-edit" id="finEdit">✎ План</button>
    </div>
    ${finTrackerCard()}
    <div class="fin-modules" id="finModules">${[finBudgetCard(), finSavingsCard(), finDebtCard(), finLeaksCard(), finImpulseCard()].join('')}</div>`;
  $('#finEdit').onclick = () => openFinanceQuiz(false);
  wireFinance();
}
/* ---------- current balance ("сколько денег сейчас") ---------- */
function finBalanceCard() {
  const bal = currentBalance();
  return `<div class="card fin-balance">
    <div class="fin-bal-main">
      <div class="fin-bal-head"><span class="fin-bal-label">💼 Сейчас денег</span><span class="fin-bal-val ${bal < 0 ? 'neg' : ''}">${finFmt(bal)}</span></div>
      <button class="btn ghost sm" id="finAdjBal">✎ Скорректировать</button>
    </div>
    <div class="fin-bal-sub">
      <span>🐷 Отложено <b>${finFmt(totalSaved())}</b></span>
      <span>💰 Всего с накоплениями <b>${finFmt(totalWealth())}</b></span>
    </div>
  </div>`;
}
function adjustBalance() {
  openModal({ title: '💼 Сколько сейчас денег', body: 'Наличные + карты + счёт (без учёта отложенного). Дальше баланс меняется сам от записей.', fields: [{ key: 'b', label: 'Текущий баланс, ₽', value: fmtMoneyInput(currentBalance()) }], okText: 'Сохранить' }).then((r) => {
    if (!r) return;
    const want = parseMoney(r.b);
    // back-solve the base so the shown balance equals what the user entered
    F().balance = want - (sumTx(F().tx, 'income') - sumTx(F().tx, 'expense') - sumTx(F().tx, 'saving'));
    save(); renderFinance(); renderDashboard(); toast('Баланс обновлён 💼', 'ok');
  });
}

/* ---------- daily tracker card (the core: log spend / save / income) ---------- */
let txType = 'expense';
function curMonthLabel() { const d = new Date(); return RU_MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
function finTrackerCard() {
  const cats = FIN_CATS.map((c) => `<option value="${c[0]}">${c[2]} ${c[0]}</option>`).join('');
  return `<div class="card fin-tracker">
    <div class="card-head"><h3>➕ Записать операцию</h3><span class="muted" style="text-transform:capitalize">${curMonthLabel()}</span></div>
    <div class="fin-type-seg" id="txSeg">${['expense', 'saving', 'unsave', 'income'].map((t) => `<button data-txtype="${t}" class="${t === txType ? 'on ' + t : t}">${TX_TYPES[t].icon} ${TX_TYPES[t].label}</button>`).join('')}</div>
    <div class="fin-add-row">
      <input type="text" inputmode="numeric" class="money" id="txAmount" placeholder="Сумма ₽">
      <select id="txCat" ${txType !== 'expense' ? 'style="display:none"' : ''}>${cats}</select>
      <input type="text" id="txNote" placeholder="Заметка…">
      <input type="date" id="txDate" value="${curKey()}" max="${todayKey()}">
      <button class="btn primary" id="txAdd">Добавить</button>
    </div>
    <div class="fin-ledger" id="finLedger">${ledgerHTML()}</div>
  </div>`;
}
// The ledger follows the top day-nav: it shows the currently selected day's operations.
function ledgerHTML() {
  const day = curKey();
  const items = F().tx.filter((t) => t.date === day).sort((a, b) => b.ts - a.ts);
  const dt = new Date(day + 'T00:00');
  const ykey = keyOf(new Date(Date.now() - 86400000));
  const dlabel = day === todayKey() ? 'Сегодня' : day === ykey ? 'Вчера' : `${RU_DOW[(dt.getDay() + 6) % 7]}, ${dt.getDate()} ${RU_MONTHS_GEN[dt.getMonth()]}`;
  const rows = items.map((t) => {
    const tt = TX_TYPES[t.type]; const sign = (t.type === 'expense' || t.type === 'unsave') ? '−' : t.type === 'income' ? '+' : '';
    return `<div class="fin-led-item"><span class="fin-led-ic">${tt.icon}</span><div class="fin-led-body"><span class="fin-led-cat">${escapeHtml(t.cat || tt.label)}</span>${t.note ? `<span class="fin-led-note">${escapeHtml(t.note)}</span>` : ''}</div><span class="fin-led-amt ${t.type}">${sign}${finFmt(t.amount)}</span><button class="fin-row-del" data-txdel="${t.id}">✕</button></div>`;
  }).join('');
  const dayFlow = items.reduce((s, t) => s + (t.type === 'income' ? +t.amount : t.type === 'expense' ? -+t.amount : 0), 0);
  const daySaved = items.reduce((s, t) => s + (t.type === 'saving' ? +t.amount : t.type === 'unsave' ? -+t.amount : 0), 0);
  const badge = items.length ? `${dayFlow < 0 ? '−' : '+'}${finFmt(Math.abs(dayFlow))}${daySaved ? ' · 🐷 ' + (daySaved < 0 ? '−' : '') + finFmt(Math.abs(daySaved)) : ''}` : '';
  return `<div class="fin-led-day"><div class="fin-led-date"><span>${dlabel}</span><span class="fin-led-day-sum">${badge}</span></div>${items.length ? rows : '<div class="meal-empty">Нет операций за этот день. Запиши сверху ☝️</div>'}</div>`;
}
function addTxFromForm() {
  const amount = parseMoney($('#txAmount').value);
  if (!amount) return toast('Введи сумму', 'err');
  const date = $('#txDate').value || todayKey();
  const cat = txType === 'expense' ? $('#txCat').value : '';
  addTx({ type: txType, amount, cat, note: $('#txNote').value.trim(), date });
  toast(`${TX_TYPES[txType].label}: ${finFmt(amount)}`, 'ok');
  renderFinance(); renderDashboard();
}
function wireFinance() {
  // daily tracker
  $$('#txSeg [data-txtype]').forEach((b) => (b.onclick = () => {
    txType = b.dataset.txtype;
    $$('#txSeg [data-txtype]').forEach((x) => x.className = (x.dataset.txtype === txType ? 'on ' + x.dataset.txtype : x.dataset.txtype));
    const cat = $('#txCat'); if (cat) cat.style.display = txType === 'expense' ? '' : 'none';
    const a = $('#txAmount'); if (a) a.focus();
  }));
  const ab = $('#finAdjBal'); if (ab) ab.onclick = adjustBalance;
  const ta = $('#txAdd'); if (ta) ta.onclick = addTxFromForm;
  const ti = $('#txAmount'); if (ti) ti.onkeydown = (e) => { if (e.key === 'Enter') addTxFromForm(); };
  $$('#finLedger [data-txdel]').forEach((b) => (b.onclick = () => { delTx(b.dataset.txdel); renderFinance(); renderDashboard(); }));
  // modules
  $$('#finModules [data-method]').forEach((b) => (b.onclick = () => { F().debtMethod = b.dataset.method; save(); renderFinance(); }));
  $$('#finModules [data-finaddebt]').forEach((b) => (b.onclick = addFinDebt));
  $$('#finModules [data-debtcompare]').forEach((b) => (b.onclick = openDebtCompare));
  $$('#finModules [data-leakplan]').forEach((b) => (b.onclick = openLeakPlan));
  $$('#finModules [data-refuse]').forEach((b) => (b.onclick = openRefusalPhrases));
  const wa = $('#finWishAdd'); if (wa) wa.onclick = addWish;
  $$('#finModules [data-wishdel]').forEach((b) => (b.onclick = () => { F().impulse.wishlist = F().impulse.wishlist.filter((w) => w.id !== b.dataset.wishdel); save(); renderFinance(); }));
  bindMoney($('#financeRoot'));
}

function finBudgetCard() {
  const b = budgetPlan();
  const row = (label, actual, ideal, cls) => {
    const pct = b.income ? clamp(actual / b.income * 100, 0, 100) : 0;
    const idealPct = b.income ? clamp(ideal / b.income * 100, 0, 100) : 0;
    return `<div class="fin-bud-row"><div class="fin-bud-top"><span>${label}</span><span>${finFmt(actual)} <small>/ ${finFmt(ideal)}</small></span></div>
      <div class="fin-bud-track"><div class="fin-bud-fill ${cls}" style="width:${pct}%"></div><span class="fin-bud-ideal" style="left:${idealPct}%"></span></div></div>`;
  };
  const advice = { 'needs-heavy': 'Обязательные расходы съедают >55% дохода — главный тормоз. Загляни в «Утечки».', 'low-savings': 'Откладываешь <10%. Настрой авто-сбережения в «Резерве».', 'overspend': 'Тратишь больше, чем зарабатываешь. Срочно в «Утечки расходов».', 'balanced': 'Близко к 50/30/20 — держи темп 👌' }[b.advice] || 'Заполни доход и расходы в квизе.';
  return finCard('budget', '⚖️', 'Бюджет 50/30/20', `
    ${row('Нужное', b.needs, b.ideal.needs, 'needs')}
    ${row('Хотелки', b.wants, b.ideal.wants, 'wants')}
    ${row('Сбережения', b.save, b.ideal.save, 'save')}
    <div class="fin-note">${advice}</div>
    <div class="fin-week">Недельный лимит на хотелки без чувства вины: <b>${finFmt(b.ideal.wants / 4.3)}</b></div>
    <button class="btn ghost sm" data-refuse>🗣 5 фраз, чтобы вежливо отказать</button>`);
}
function openRefusalPhrases() {
  const phrases = [
    ['🍽 Дорогой ужин', '«Звучит здорово! Но в этом месяце я держу бюджет. Давай выберем место попроще или перенесём на следующий раз?»'],
    ['✈️ Поездка', '«Очень хочу, но сейчас это не вписывается в мой план. Давай прикинем более бюджетный вариант или другую дату?»'],
    ['🎂 Дорогой день рождения', '«Я обязательно приду поздравить! По тратам в этот раз ограничусь — посидим по-простому, главное — вместе.»'],
    ['🎁 Общий подарок', '«Я в деле. Давай уложимся в комфортную сумму — скину пару идей, которые впишутся в бюджет.»'],
    ['☕ Спонтанная встреча', '«Сегодня пас по тратам, но я за прогулку или кофе дома — так тоже отлично повидаемся.»'],
  ];
  openInfoModal('🗣 Отказать без чувства вины', `
    <p class="hint">Коротко, тепло и без оправданий — деньги это нормально обсуждать.</p>
    ${phrases.map((p) => `<div class="fin-script"><div class="fin-script-t">${p[0]}</div><p>${escapeHtml(p[1])}</p></div>`).join('')}`);
}
function finSavingsCard() {
  const s = savingsPlan();
  const scen = s.scenarios.map((x) => `<div class="fin-scen"><span class="fin-scen-l">${x.label}</span><b>${finFmt(x.m)}</b><small>${x.months ? '≈ ' + x.months + ' мес' : '—'}</small></div>`).join('');
  const goalLine = (s.goalAmount && F().savings.goalName)
    ? `До цели «${escapeHtml(F().savings.goalName)}» (${finFmt(s.goalAmount)}): осталось ${finFmt(s.remaining)}`
    : 'Сколько времени до подушки при разных взносах:';
  return finCard('savings', '🐷', 'Резерв и сбережения', `
    <div class="fin-bud-top"><span>Подушка на 3 мес (${finFmt(s.emerg3)})</span><span>${Math.round(s.emergProgress)}%</span></div>
    <div class="fin-bud-track"><div class="fin-bud-fill save" style="width:${s.emergProgress}%"></div></div>
    <div class="fin-note">Накоплено ${finFmt(s.cur)} · норма сбережений ${s.rate}% · на 6 мес нужно ${finFmt(s.emerg6)}</div>
    <div class="fin-sub-title">${goalLine}</div>
    <div class="fin-scens">${scen}</div>`);
}
function finDebtCard() {
  const cmp = debtCompare();
  const names = { snowball: 'Снежный ком', avalanche: 'Лавина', hybrid: 'Гибрид' };
  let body;
  if (!cmp) {
    body = `<div class="meal-empty">Долгов нет 🎉</div><button class="btn ghost sm" data-finaddebt>＋ Добавить долг</button>`;
  } else {
    const method = F().debtMethod || 'avalanche';
    const cur = simulateDebts(method);
    const chips = ['snowball', 'avalanche', 'hybrid'].map((m) => `<button class="fin-method ${method === m ? 'on' : ''}" data-method="${m}">${names[m]}</button>`).join('');
    body = `
      <div class="fin-debt-total">Всего долгов: <b>${finFmt(totalDebt())}</b></div>
      <div class="fin-methods">${chips}</div>
      <div class="fin-debt-res">
        <div><b>${cur.months}</b><small>мес до нуля</small></div>
        <div><b>${finFmt(cur.totalInterest)}</b><small>переплата</small></div>
        <div><b>${finFmt(cur.monthly)}</b><small>всего/мес</small></div>
      </div>
      ${!cur.cleared ? '<div class="fin-note warn">⚠️ Минималок не хватает — долг почти не гасится. Увеличь доплату.</div>' : `<div class="fin-note">Меньшая переплата у метода «${names[cmp.best]}». Снежный ком мотивирует быстрыми победами.</div>`}
      <div class="fin-actions-row"><button class="btn ghost sm" data-debtcompare>📊 Сравнить методы</button><button class="btn ghost sm" data-finaddebt>＋ Долг</button></div>`;
  }
  return finCard('debt', '🏦', 'Долги и кредиты', body);
}
function finLeaksCard() {
  const { leaks, totalSave } = leakScan();
  let body;
  if (!leaks.length) body = `<div class="meal-empty">Явных утечек не видно 👍 Категории в норме.</div>`;
  else body = `<div class="fin-note">Можно вернуть ~<b>${finFmt(totalSave)}</b>/мес. Топ утечек:</div>
    <div class="fin-leaks">${leaks.slice(0, 5).map((l) => `<div class="fin-leak"><div class="fin-leak-main"><span class="fin-leak-name">${escapeHtml(l.name)}</span><span class="fin-leak-over">−${finFmt(l.over)}</span></div>
      <div class="fin-leak-tags"><span class="ftag">сложность: ${l.difficulty}</span><span class="ftag">качество: ${l.impact}</span><span class="ftag pri-${l.priority === 'высокий' ? 'hi' : l.priority === 'средний' ? 'mid' : 'lo'}">приоритет: ${l.priority}</span></div></div>`).join('')}</div>
    <button class="btn ghost sm" data-leakplan>📋 План на 30 дней</button>`;
  return finCard('leaks', '🔍', 'Утечки расходов', body);
}
function finImpulseCard() {
  const f = F(); const wl = f.impulse.wishlist || []; const now = Date.now();
  const items = wl.map((w) => {
    const ready = (w.added || now) + (w.waitDays || 3) * 86400000;
    const daysLeft = Math.ceil((ready - now) / 86400000);
    const ok = daysLeft <= 0;
    return `<div class="fin-wish ${ok ? 'ready' : ''}"><span class="fin-wish-name">${escapeHtml(w.name)}</span><span class="fin-wish-price">${finFmt(w.price)}</span><span class="fin-wish-state">${ok ? '✅ решай на холодную' : '⏳ ' + daysLeft + ' дн'}</span><button class="fin-row-del" data-wishdel="${w.id}">✕</button></div>`;
  }).join('');
  return finCard('impulse', '🛑', 'Импульс-контроль', `
    <div class="fin-note">Захотел купить? Добавь в список — вернись через пару дней на холодную голову. Триггер: <b>${escapeHtml(f.profile.trigger || '—')}</b></div>
    <div class="fin-wish-add"><input type="text" id="finWishName" placeholder="Что хочу купить"><input type="text" inputmode="numeric" class="money" id="finWishPrice" placeholder="₽"><button class="btn primary sm" id="finWishAdd">Позже</button></div>
    <div class="fin-wishes">${wl.length ? items : '<div class="meal-empty">Список пуст — и кошелёк цел 😌</div>'}</div>
    <div class="fin-check-legend"><b class="yn-yes">ДА</b> — нужно и в бюджете · <b class="yn-later">ПОЗЖЕ</b> — импульс, в список · <b class="yn-no">НЕТ</b> — сработал триггер</div>`);
}
function addWish() {
  const name = $('#finWishName').value.trim(); const price = parseMoney($('#finWishPrice').value);
  if (!name) return toast('Что за покупка?', 'err');
  F().impulse.wishlist.unshift({ id: uid(), name, price, added: Date.now(), waitDays: 3, decided: false });
  save(); renderFinance(); toast('В списке желаний — вернись через 3 дня 😌', 'ok');
}
function addFinDebt() {
  openModal({ title: 'Новый долг', fields: [{ key: 'name', label: 'Название', placeholder: 'напр. Кредитка' }, { key: 'balance', label: 'Баланс, ₽' }, { key: 'apr', label: 'Ставка, % годовых' }, { key: 'min', label: 'Мин. платёж, ₽/мес' }], okText: 'Добавить' }).then((r) => {
    if (!r) return; const bal = Number(r.balance) || 0; if (!bal) return toast('Укажи баланс', 'err');
    F().debts.push({ id: uid(), name: r.name || 'Долг', balance: bal, apr: Number(r.apr) || 0, min: Number(r.min) || 0 });
    save(); renderFinance(); renderDashboard(); toast('Долг добавлен', 'ok');
  });
}
function openInfoModal(title, html) {
  const ov = document.createElement('div'); ov.className = 'modal-ov';
  ov.innerHTML = `<div class="card info-modal"><h3 class="modal-title">${title}</h3><div class="info-body">${html}</div><button class="btn primary full" data-close>Понятно</button></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('[data-close]').onclick = close; ov.onclick = (e) => { if (e.target === ov) close(); };
}
function openDebtCompare() {
  const cmp = debtCompare(); if (!cmp) return;
  const names = { snowball: 'Снежный ком', avalanche: 'Лавина', hybrid: 'Гибрид' };
  const rows = ['snowball', 'avalanche', 'hybrid'].map((m) => { const r = cmp.res[m]; return `<tr class="${m === cmp.best ? 'best' : ''}"><td>${names[m]}${m === cmp.best ? ' 🏆' : ''}</td><td>${r.months} мес</td><td>${finFmt(r.totalInterest)}</td><td>${finFmt(r.monthly)}</td></tr>`; }).join('');
  const best = simulateDebts(cmp.best);
  const order = F().debts.filter((d) => +d.balance > 0).map((d) => ({ name: d.name, paid: (best.perDebt[d.id] || {}).paidMonth || 0 })).sort((a, b) => a.paid - b.paid);
  const orderHtml = order.map((o, i) => `<div class="dd-task"><span class="task-pri high"></span><span class="dd-task-text">${i + 1}. ${escapeHtml(o.name)}</span><span class="dd-task-tag">${o.paid ? 'к ' + o.paid + ' мес' : '—'}</span></div>`).join('');
  openInfoModal('📊 Сравнение методов', `
    <div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>Метод</th><th>Срок</th><th>Переплата</th><th>В месяц</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">🏆 «${names[cmp.best]}» — минимальная переплата. Лавина (высокий % сначала) экономит деньги, снежный ком (мелкие сначала) мотивирует, гибрид — баланс.</p>
    <div class="fin-sub-title">Порядок закрытия (${names[cmp.best]}):</div><div class="dd-tasks">${orderHtml}</div>
    <div class="fin-note">Чек-лист: 1) плати минимум по всем; 2) всю доплату — в первый долг из списка; 3) закрыл — его минимум добавь к следующему; 4) повторяй.</div>`);
}
function openLeakPlan() {
  const { leaks, totalSave } = leakScan();
  const thr = finFmt(totalIncome() * 0.02);
  const weeks = [
    ['Неделя 1 — Аудит', 'Выпиши все подписки и автосписания. Отмени то, чем не пользовался 30 дней. Проверь банковские комиссии и тарифы.'],
    ['Неделя 2 — Еда', 'Готовь дома 5 дней. Доставка/кафе — только по плану. Список покупок заранее и не голодным.'],
    ['Неделя 3 — Импульс', `Правило 48 часов на любую незапланированную покупку дороже ${thr}. Удали сохранённые карты из маркетплейсов.`],
    ['Неделя 4 — Счета', 'Пересмотри тариф связи/интернета, страховки, энергию. Позвони и попроси условия лучше — часто дают скидку.'],
  ];
  const list = leaks.slice(0, 6).map((l) => `<div class="dd-task"><span class="dd-task-text">${escapeHtml(l.name)} — вернуть ~${finFmt(l.over)}</span><span class="dd-task-tag">${l.priority}</span></div>`).join('');
  openInfoModal('📋 План сокращения на 30 дней', `
    <div class="fin-note">Цель: вернуть ~<b>${finFmt(totalSave)}</b>/мес, не превращая жизнь в финансовую тюрьму.</div>
    ${leaks.length ? `<div class="fin-sub-title">Куда смотреть:</div><div class="dd-tasks">${list}</div>` : ''}
    <div class="fin-sub-title">По неделям:</div>${weeks.map((w) => `<div class="fin-week-plan"><b>${w[0]}</b><p>${w[1]}</p></div>`).join('')}`);
}

/* ---------- finance dashboard card ---------- */
function renderFinanceDash() {
  const box = $('#financeDash'); if (!box) return;
  const f = F();
  if (!f.onboarded) {
    box.innerHTML = `<div class="empty-add"><p>Заведи финансовый трекер — записывай траты и сбережения, а бюджет, долги и подушка посчитаются сами.</p><button class="btn primary sm" id="finDashStart">🎯 Пройти квиз</button></div>`;
    const b = $('#finDashStart'); if (b) b.onclick = () => { switchView('finance'); };
    return;
  }
  const spent = spentThisMonth(), saved = savedThisMonth();
  const bal = currentBalance();
  box.innerHTML = `
    <div class="fin-dash-grid">
      <div class="fin-dash-stat ${bal < 0 ? 'neg' : 'pos'}"><b>${finFmt(bal)}</b><small>сейчас денег</small></div>
      <div class="fin-dash-stat"><b>${finFmt(spent)}</b><small>потрачено в ${curMonthLabel().split(' ')[0]}</small></div>
      <div class="fin-dash-stat"><b>${finFmt(saved)}</b><small>отложено</small></div>
      <div class="fin-dash-stat"><b>${finFmt(totalSaved())}</b><small>всего в подушке</small></div>
    </div>
    <div class="fin-dash-leak">💡 Записывай траты во вкладке «Финансы» — баланс и аналитика обновятся сами.</div>`;
}

/* ============================================================
   RENDER DISPATCH
   ============================================================ */
function renderView(v) {
  if (v === 'dashboard') renderDashboard();
  else if (v === 'water') renderWater();
  else if (v === 'nutrition') renderNutrition();
  else if (v === 'tasks') renderTasks();
  else if (v === 'habits') renderHabits();
  else if (v === 'focus') renderFocus();
  else if (v === 'finance') renderFinance();
  else if (v === 'calendar') renderCalendar();
  else if (v === 'profile') loadProfileForm();
  updateTopbar(); updateBadges();
}
function renderAll() {
  renderDashboard(); renderWater(); renderNutrition(); renderTasks(); renderHabits(); renderCalendar(); renderCalc(); renderFinance();
  updateTopbar(); updateBadges();
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wire() {
  // nav
  $$('.nav-item').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  $$('[data-goto]').forEach((b) => (b.onclick = () => switchView(b.dataset.goto)));
  $('#themeToggle').onclick = openThemePicker;
  const topAv = $('#topAvatar'); if (topAv) { topAv.onclick = () => switchView('profile'); topAv.title = 'Профиль'; topAv.style.cursor = 'pointer'; }

  // mobile bottom nav + "Ещё" sheet
  $$('#mobileNav .mnav-item[data-view]').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  const mMore = $('#mnavMore'); if (mMore) mMore.onclick = openMobileSheet;
  $$('#mobileSheet .msheet-item[data-view]').forEach((b) => (b.onclick = () => { switchView(b.dataset.view); closeMobileSheet(); }));
  const mTheme = $('#msheetTheme'); if (mTheme) mTheme.onclick = () => { closeMobileSheet(); openThemePicker(); };
  const sheet = $('#mobileSheet'); if (sheet) sheet.onclick = (e) => { if (e.target === sheet) closeMobileSheet(); };

  // day paging
  $('#dayPrev').onclick = () => shiftDay(-1);
  $('#dayNext').onclick = () => shiftDay(1);
  $('#topbarDate').onclick = gotoToday;

  // water
  renderQuickAdd($('#waterQuickAdd'));
  $('#customWaterBtn').onclick = () => { const v = Number($('#customWaterInput').value); if (v > 0) { addWater(v); $('#customWaterInput').value = ''; } };
  $('#customWaterInput').onkeydown = (e) => { if (e.key === 'Enter') $('#customWaterBtn').click(); };
  $('#undoWaterBtn').onclick = undoWater;
  $('#reminderEnabled').onchange = async (e) => {
    if (e.target.checked) {
      const ok = await ensureNotifyPermission();
      if (!ok) { e.target.checked = false; toast('Разреши уведомления, чтобы включить напоминания', 'err'); return; }
    }
    state.settings.reminder.enabled = e.target.checked; save(); applyReminder();
    toast(e.target.checked ? 'Напоминания включены' : 'Напоминания выключены');
  };
  $('#reminderInterval').oninput = (e) => { state.settings.reminder.intervalMinutes = Number(e.target.value); $('#reminderIntervalLabel').textContent = e.target.value; };
  $('#reminderInterval').onchange = () => { save(); applyReminder(); };
  $('#quietFrom').onchange = (e) => { state.settings.reminder.quietFrom = clamp(Number(e.target.value)||0,0,23); save(); applyReminder(); };
  $('#quietTo').onchange = (e) => { state.settings.reminder.quietTo = clamp(Number(e.target.value)||0,0,23); save(); applyReminder(); };
  $('#testNotifyBtn').onclick = testNotify;

  // nutrition
  if ($('#mUnit')) $('#mUnit').innerHTML = unitOptions('g');
  if ($('#foodMeal')) { $('#foodMeal').value = currentMeal(); $('#foodMeal').onchange = (e) => { e.target.dataset.touched = '1'; }; }
  // nutrition tabs
  $$('#foodTabs .tab').forEach((t) => (t.onclick = () => {
    $$('#foodTabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.ftab').forEach((f) => f.classList.toggle('active', f.dataset.ftab === t.dataset.ftab));
  }));
  $('#foodSearchBtn').onclick = () => { const q = $('#foodSearchInput').value.trim(); if (q) searchFood(q, '#foodResults'); };
  $('#foodSearchInput').onkeydown = (e) => { if (e.key === 'Enter') $('#foodSearchBtn').click(); };
  $('#barcodeBtn').onclick = () => { const c = $('#barcodeInput').value.trim(); if (c) lookupBarcode(c, '#barcodeResults'); };
  $('#barcodeInput').onkeydown = (e) => { if (e.key === 'Enter') $('#barcodeBtn').click(); };
  $('#manualAddBtn').onclick = () => {
    const name = $('#mName').value.trim(); if (!name) return toast('Впиши название', 'err');
    const qty = +$('#mGrams').value || 0;
    const unit = $('#mUnit') ? $('#mUnit').value : 'g';
    const grams = (unit === 'g' || unit === 'ml') ? qty : Math.round(qty * unitGrams(unit));
    addFood({ name, kcal: +$('#mKcal').value || 0, prot: +$('#mProt').value || 0, fat: +$('#mFat').value || 0, carb: +$('#mCarb').value || 0, grams, qty: qty || undefined, unit, img: '' });
    ['#mName','#mKcal','#mProt','#mFat','#mCarb'].forEach((s) => ($(s).value = '')); $('#mGrams').value = 100;
    if ($('#mUnit')) $('#mUnit').value = 'g';
  };
  // photo
  const drop = $('#photoDrop'), input = $('#photoInput');
  drop.onclick = () => input.click();
  input.onchange = () => { if (input.files[0]) loadPhoto(input.files[0]); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) loadPhoto(e.dataTransfer.files[0]); };
  $('#analyzePhotoBtn').onclick = analyzePhoto;
  $('#saveKeyBtn').onclick = () => { state.settings.aiKey = $('#aiKey').value.trim(); save(); toast(state.settings.aiKey ? 'Ключ сохранён' : 'Ключ очищен', 'ok'); };
  $('#aiKey').value = state.settings.aiKey || '';

  // tasks
  $('#taskAddBtn').onclick = addTask;
  $('#taskInput').onkeydown = (e) => { if (e.key === 'Enter') addTask(); };
  initCatPicker();
  $$('.task-filters .chip').forEach((c) => (c.onclick = () => { taskFilter = c.dataset.filter; $$('.task-filters .chip').forEach((x) => x.classList.toggle('active', x === c)); renderTasks(); }));
  $('#clearDoneBtn').onclick = clearDone;

  // habits
  $('#addHabitBtn').onclick = addHabit;

  // weight
  $('#logWeightBtn').onclick = openWeightModal;

  // focus / pomodoro
  $('#pomoStart').onclick = pomoStartPause;
  $('#pomoReset').onclick = () => pomoResetTo(pomo.mode);
  $('#pomoSkip').onclick = pomoSkip;
  $('#pomoWork').onchange = (e) => { state.focus.work = clamp(Number(e.target.value) || 25, 5, 90); save(); if (!pomo.running && pomo.mode === 'work') pomoResetTo('work'); };
  $('#pomoBreak').onchange = (e) => { state.focus.break = clamp(Number(e.target.value) || 5, 1, 30); save(); if (!pomo.running && pomo.mode === 'break') pomoResetTo('break'); };
  $('#notesArea').oninput = (e) => { state.notes = e.target.value; save(); };

  // calendar
  $('#calPrev').onclick = () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); $('#dayDetailCard').hidden = true; };
  $('#calNext').onclick = () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); $('#dayDetailCard').hidden = true; };
  $('#closeDayDetail').onclick = () => ($('#dayDetailCard').hidden = true);

  // profile
  $('#pAvatarBtn').onclick = openAvatarPicker;
  $('#pGoal').onchange = updateGoalFields;
  $('#quizBtn').onclick = () => openOnboarding();
  $('#saveProfileBtn').onclick = saveProfile;
  $('#saveGoalsBtn').onclick = saveGoals;
  $('#exportBtn').onclick = exportData;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); };
  $('#resetBtn').onclick = resetAll;

  // desktop bridge
  if (DESKTOP) {
    window.desktop.onQuickWater((ml) => addWater(ml));
    window.desktop.onOpenTab((tab) => switchView(tab));
    if (window.desktop.onUpdateAvailable) window.desktop.onUpdateAvailable((v) => showUpdateBanner(v));
    if (window.desktop.onUpdateChecked) window.desktop.onUpdateChecked((r) => {
      if (r === 'staged') return; // banner already shown by onUpdateAvailable
      if (r === 'uptodate') toast('У тебя последняя версия ✓', 'ok');
      else if (r === 'off') toast('Автообновление ещё не настроено');
      else toast('Не удалось проверить обновления', 'err');
    });
  }
  if (DESKTOP && window.desktop && $('#checkUpdateBtn')) {
    $('#checkUpdateBtn').onclick = () => { window.desktop.checkUpdate(); toast('Проверяю обновления…'); };
  } else if (SERVED && $('#checkUpdateBtn')) {
    $('#checkUpdateBtn').onclick = async () => {
      toast('Проверяю обновления…');
      const latest = await fetchRemoteVersion();
      if (latest && bootVersion && verGt(latest, bootVersion)) showUpdateBanner(latest, true);
      else toast('У тебя последняя версия ✓', 'ok');
    };
  }
}
/* ---------- auto-update: version polling (PWA / served) ---------- */
let bootVersion = null; // remote version.json at the moment the page loaded
function verGt(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
async function fetchRemoteVersion() {
  try {
    const r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.version ? String(j.version) : null;
  } catch (e) { return null; }
}
async function startServedUpdateWatch() {
  bootVersion = await fetchRemoteVersion();
  const av = $('#appVer'); if (av && bootVersion) av.textContent = bootVersion;
  const check = async () => {
    const latest = await fetchRemoteVersion();
    if (latest && bootVersion && verGt(latest, bootVersion)) showUpdateBanner(latest, true);
  };
  setInterval(check, 5 * 60 * 1000); // poll every 5 min
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
}
/* ---------- update banner (desktop applies in place, PWA reloads) ---------- */
function showUpdateBanner(version, served) {
  if (document.getElementById('updateBanner')) return;
  // Let the splash animation finish first, then slide the banner in.
  const splash = document.getElementById('splash');
  if (splash && !splash.classList.contains('done')) { setTimeout(() => showUpdateBanner(version, served), 300); return; }
  const b = document.createElement('div');
  b.id = 'updateBanner'; b.className = 'update-banner';
  b.innerHTML = `<div class="ub-ic">✨</div>
    <div class="ub-txt"><b>Обновление ${escapeHtml(String(version))}</b><span>готово — установить в один клик</span></div>
    <div class="ub-actions"><button class="btn ghost sm" id="ubLater">Позже</button><button class="btn primary sm" id="ubNow">Обновить</button></div>`;
  document.body.appendChild(b);
  const close = () => { b.classList.add('out'); setTimeout(() => b.remove(), 320); };
  b.querySelector('#ubLater').onclick = close;
  b.querySelector('#ubNow').onclick = () => {
    const btn = b.querySelector('#ubNow'); btn.textContent = 'Обновляю…'; btn.disabled = true;
    if (served || !DESKTOP) {
      // Activate the waiting service worker, then reload to run the fresh (network-first) code.
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg && reg.waiting) reg.waiting.postMessage({ type: 'skipWaiting' });
        }).finally(() => setTimeout(() => location.reload(), 350));
      } else { location.reload(); }
    } else {
      window.desktop.applyUpdate();
    }
  };
}
function loadPhoto(file) {
  const rd = new FileReader();
  rd.onload = () => {
    photoData = rd.result;
    const img = $('#photoPreview'); img.src = photoData; img.hidden = false;
    $('#photoPlaceholder').hidden = true;
    $('#analyzePhotoBtn').disabled = false;
  };
  rd.readAsDataURL(file);
}

/* ============================================================
   INIT
   ============================================================ */
/* ============================================================
   ACCOUNTS + CLOUD SYNC (Firebase Auth + Firestore)
   Local-first: the app works fully offline; signing in mirrors
   the whole state to the cloud and syncs it across devices
   (last-write-wins by an updatedAt timestamp).
   ============================================================ */
const FB = (typeof window !== 'undefined' && window.FB) || null;
let account = null;         // { uid, email, nickname }
let syncUnsub = null;       // Firestore snapshot unsubscribe
let cloudApplying = false;  // guard: don't re-upload while applying a remote change
let pushTimer = null;

function localUpdatedAt() { return Number(localStorage.getItem('aqua.updatedAt') || 0); }
function markUpdated() { try { localStorage.setItem('aqua.updatedAt', String(Date.now())); } catch (e) {} }

// Debounced push of the whole state to the user's cloud doc.
function syncPush() {
  if (!FB || !account) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await FB.db.collection('users').doc(account.uid).set(
        { data: JSON.stringify(state), nickname: account.nickname || '', updatedAt: Date.now() },
        { merge: true }
      );
      setSyncBadge('ok');
    } catch (e) { setSyncBadge('off'); }
  }, 900);
}
function applyCloudState(json) {
  try {
    cloudApplying = true;
    state = deepMerge(structuredClone(DEFAULTS), JSON.parse(json));
    migrate(state);
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    markUpdated();
    loadProfileForm(); renderAll(); applyTheme(); applyReminder();
    toast('Данные синхронизированы ☁️', 'ok');
  } catch (e) { console.warn('applyCloud failed', e); }
  finally { cloudApplying = false; }
}
// Profile "identity" fields — these must never be wiped by a blank device on first login.
const PROFILE_IDENTITY = ['name', 'birthday', 'sex', 'age', 'height', 'weight', 'avatar', 'goal', 'goalRate', 'targetWeight', 'startWeight'];
// Copy identity fields from `source` into `target` wherever target is empty. Returns true if anything changed.
function fillEmptyIdentity(target, source) {
  if (!target || !source) return false;
  let changed = false;
  for (const k of PROFILE_IDENTITY) {
    const tv = target[k], sv = source[k];
    const tEmpty = tv === '' || tv == null;
    const sEmpty = sv === '' || sv == null;
    if (tEmpty && !sEmpty) { target[k] = sv; changed = true; }
  }
  return changed;
}
async function startSync() {
  if (!FB || !account) return;
  const ref = FB.db.collection('users').doc(account.uid);
  try {
    const snap = await ref.get();
    if (snap.exists && snap.data() && snap.data().data) {
      const cloud = snap.data();
      let cloudProfile = null;
      try { cloudProfile = JSON.parse(cloud.data).profile || null; } catch (e) {}
      if ((cloud.updatedAt || 0) > localUpdatedAt()) {
        // cloud is newer — pull it, but keep any identity field only THIS device had
        const localProfBefore = structuredClone(state.profile);
        applyCloudState(cloud.data);
        if (fillEmptyIdentity(state.profile, localProfBefore)) { save(); loadProfileForm(); updateTopbar(); }
      } else {
        // local is newer — but first fill our own identity holes from the cloud so the
        // upload carries the UNION (a blank name here must not erase the cloud's name).
        if (fillEmptyIdentity(state.profile, cloudProfile)) { loadProfileForm(); updateTopbar(); }
        markUpdated(); syncPush();
      }
    } else {
      syncPush(); // brand-new account → seed it with local data
    }
    setSyncBadge('ok');
  } catch (e) { setSyncBadge('off'); }
  // live updates pushed from other devices
  syncUnsub = ref.onSnapshot((s) => {
    if (!s.exists || s.metadata.hasPendingWrites) return; // ignore our own optimistic writes
    const cloud = s.data();
    if (cloud && cloud.data && (cloud.updatedAt || 0) > localUpdatedAt()) applyCloudState(cloud.data);
  }, () => setSyncBadge('off'));
}
function stopSync() { if (syncUnsub) { syncUnsub(); syncUnsub = null; } }

function authRegister(email, password, nickname) {
  return FB.auth.createUserWithEmailAndPassword(email, password).then((cred) =>
    (nickname ? cred.user.updateProfile({ displayName: nickname }) : Promise.resolve())
      .then(() => cred.user.sendEmailVerification().catch(() => {})) // send confirmation email (non-fatal)
      .then(() => cred.user));
}
function authLogin(email, password) { return FB.auth.signInWithEmailAndPassword(email, password).then((c) => c.user); }
function authLogout() { return FB.auth.signOut(); }
function authReset(email) { return FB.auth.sendPasswordResetEmail(email); }
function authErrMsg(e) {
  const c = (e && e.code) || '';
  if (c.includes('email-already-in-use')) return 'Эта почта уже занята — войди';
  if (c.includes('invalid-email')) return 'Неверный формат почты';
  if (c.includes('weak-password')) return 'Пароль слишком простой (минимум 6 символов)';
  if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found')) return 'Неверная почта или пароль';
  if (c.includes('too-many-requests')) return 'Слишком много попыток — подожди немного';
  if (c.includes('network')) return 'Нет подключения к сети';
  return (e && e.message) || 'Ошибка';
}
function initAuth() {
  if (!FB) return;
  FB.auth.onAuthStateChanged((user) => {
    if (user) { account = { uid: user.uid, email: user.email, nickname: user.displayName || '', verified: !!user.emailVerified }; window.account = account; startSync(); }
    else { account = null; window.account = null; stopSync(); setSyncBadge(null); }
    renderAccountCard(); updateTopbar();
  });
}
function setSyncBadge(status) {
  const b = $('#syncBadge'); if (!b) return;
  if (!account || !status) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = status === 'ok' ? '☁️' : '⚠️';
  b.title = status === 'ok' ? 'Синхронизировано' : 'Нет синхронизации';
}
function renderAccountCard() {
  const box = $('#accountCard'); if (!box) return;
  if (!FB) { box.innerHTML = '<div class="card"><p class="hint" style="margin:0">Облачная синхронизация недоступна (не загрузился Firebase).</p></div>'; return; }
  if (account) {
    const initial = (account.nickname || account.email || '?').trim().slice(0, 1).toUpperCase();
    const verifyRow = account.verified ? '' :
      `<div class="acc-verify">✉️ Почта не подтверждена. Проверь ящик и перейди по ссылке.
        <button class="acc-link" id="accResend">Отправить письмо ещё раз</button></div>`;
    box.innerHTML = `<div class="card acc-card">
      <div class="acc-head">
        <div class="acc-avatar">${escapeHtml(initial)}</div>
        <div class="acc-info"><b>${escapeHtml(account.nickname || 'Аккаунт')}</b><span>${escapeHtml(account.email || '')}</span></div>
        ${account.verified ? '<span class="acc-verified" title="Почта подтверждена">✅</span>' : ''}
      </div>
      ${verifyRow}
      <div class="acc-sync">☁️ Синхронизация включена — данные на телефоне и компьютере совпадают</div>
      <button class="btn ghost full" id="accLogout">Выйти</button>
    </div>`;
    $('#accLogout').onclick = () => { authLogout(); toast('Вышел из аккаунта'); };
    const rs = $('#accResend');
    if (rs) rs.onclick = () => {
      const u = FB.auth.currentUser;
      if (!u) return;
      rs.disabled = true;
      u.sendEmailVerification().then(() => toast('Письмо отправлено — проверь почту ✉️', 'ok'))
        .catch((e) => { rs.disabled = false; toast(authErrMsg(e), 'err'); });
    };
    return;
  }
  box.innerHTML = `<div class="card acc-card">
    <div class="card-head"><h3>👤 Аккаунт и синхронизация</h3></div>
    <p class="hint" style="margin-top:0">Войди, чтобы данные синхронизировались между телефоном и компьютером.</p>
    <div class="acc-tabs" data-mode="login">
      <span class="acc-pill"></span>
      <button class="acc-tab active" data-at="login">Вход</button>
      <button class="acc-tab" data-at="register">Регистрация</button>
    </div>
    <div class="acc-form">
      <div class="acc-nick-wrap"><input type="text" id="accNick" placeholder="Никнейм" autocomplete="nickname"></div>
      <input type="email" id="accEmail" placeholder="Почта" autocomplete="email">
      <input type="password" id="accPass" placeholder="Пароль (мин. 6 символов)" autocomplete="current-password">
      <button type="button" class="acc-link acc-forgot" id="accForgot">Забыл пароль?</button>
      <div class="acc-err" id="accErr"></div>
      <button class="btn primary full" id="accSubmit">Войти</button>
    </div>
  </div>`;
  let mode = 'login';
  const tabs = box.querySelector('.acc-tabs'), nickWrap = box.querySelector('.acc-nick-wrap'), forgot = $('#accForgot');
  const nick = $('#accNick'), submit = $('#accSubmit'), err = $('#accErr');
  $$('.acc-tab').forEach((t) => (t.onclick = () => {
    mode = t.dataset.at; tabs.dataset.mode = mode;
    $$('.acc-tab').forEach((x) => x.classList.toggle('active', x === t));
    nickWrap.classList.toggle('show', mode === 'register');
    forgot.hidden = mode === 'register';
    submit.textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти'; err.textContent = '';
    if (mode === 'register') setTimeout(() => nick.focus(), 200);
  }));
  forgot.onclick = async () => {
    err.textContent = '';
    const email = $('#accEmail').value.trim();
    if (!email) { err.textContent = 'Введи почту — пришлём ссылку для сброса'; $('#accEmail').focus(); return; }
    forgot.disabled = true;
    try { await authReset(email); toast('Ссылка для сброса пароля отправлена на почту 📧', 'ok'); }
    catch (e) { err.textContent = authErrMsg(e); }
    finally { forgot.disabled = false; }
  };
  submit.onclick = async () => {
    err.textContent = '';
    const email = $('#accEmail').value.trim(), pass = $('#accPass').value, nk = nick.value.trim();
    if (!email || !pass) { err.textContent = 'Заполни почту и пароль'; return; }
    if (mode === 'register' && !nk) { err.textContent = 'Придумай никнейм'; return; }
    submit.disabled = true; const label = submit.textContent; submit.textContent = '…';
    try {
      if (mode === 'register') { await authRegister(email, pass, nk); toast('Аккаунт создан! Проверь почту — подтверди адрес ✉️', 'ok'); }
      else { await authLogin(email, pass); toast('Готово! Синхронизация включена ☁️', 'ok'); }
    } catch (e) { err.textContent = authErrMsg(e); submit.disabled = false; submit.textContent = label; }
  };
}

/* ---------- birthday greeting + confetti ---------- */
function isBirthdayToday() {
  const bd = state.profile.birthday; if (!bd) return false;
  const d = new Date(bd + 'T00:00'); if (isNaN(d)) return false;
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
function checkBirthday() {
  if (!isBirthdayToday()) return;
  const y = new Date().getFullYear();
  if (state.settings.lastBdayGreet === y) return; // already greeted this year
  state.settings.lastBdayGreet = y; save();
  setTimeout(birthdayGreeting, 1700); // after the splash
}
function confettiBurst() {
  const box = document.createElement('div'); box.className = 'confetti-box';
  document.body.appendChild(box);
  const colors = ['#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#f472b6', '#f59e0b'];
  for (let i = 0; i < 80; i++) {
    const c = document.createElement('i'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + '%';
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';
    c.style.animationDuration = (2.2 + Math.random() * 1.8).toFixed(2) + 's';
    if (Math.random() < 0.4) c.style.borderRadius = '50%';
    if (Math.random() < 0.5) c.classList.add('rev');
    box.appendChild(c);
  }
  ['pop-tl', 'pop-tr', 'pop-bl', 'pop-br'].forEach((cls) => {
    const p = document.createElement('div'); p.className = 'popper ' + cls; p.textContent = '🎉'; box.appendChild(p);
  });
  setTimeout(() => box.remove(), 5200);
}
function birthdayGreeting() {
  const name = (state.profile.name || (window.account && account.nickname) || '').trim();
  const age = ageFromBirthday(state.profile.birthday);
  confettiBurst();
  const ov = document.createElement('div'); ov.className = 'modal-ov bday-ov';
  ov.innerHTML = `<div class="card bday-card">
    <div class="bday-emoji">🎂</div>
    <h3 class="modal-title">С днём рождения${name ? ', ' + escapeHtml(name) : ''}!</h3>
    <p class="onb-sub">${age ? 'Тебе сегодня ' + age + '! ' : ''}Пусть новый год будет самым здоровым и ярким. Aqua рядом каждый день 💧</p>
    <button class="btn primary full" data-close>Спасибо 🥳</button>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('[data-close]').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

/* ---------- "Add to Home Screen" hint (mobile PWA, not Electron) ---------- */
function maybeShowInstallHint() {
  if (DESKTOP || !SERVED) return; // Electron is already a real app
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return; // already added to Home Screen
  if (localStorage.getItem('aqua.installHint') === 'off') return;
  const ua = navigator.userAgent;
  const isMobile = /iphone|ipad|ipod|android/i.test(ua) || window.innerWidth <= 820;
  if (!isMobile) return;
  const ios = /iphone|ipad|ipod/i.test(ua);
  const el = document.createElement('div'); el.className = 'install-hint';
  const steps = ios
    ? `<span class="ih-step"><i class="ih-num">1</i>Нажми <b>Поделиться</b> <span class="ih-share">⬆︎</span> внизу Safari</span>
       <span class="ih-step"><i class="ih-num">2</i>Выбери <b>«На экран „Домой"»</b> ➕</span>`
    : `<span class="ih-step"><i class="ih-num">1</i>Открой меню браузера <b>⋮</b></span>
       <span class="ih-step"><i class="ih-num">2</i>Нажми <b>«Установить приложение»</b></span>`;
  el.innerHTML = `<button class="ih-close" aria-label="Закрыть">✕</button>
    <div class="ih-ic">📲</div>
    <div class="ih-body">
      <b>Установи Aqua на телефон</b>
      <div class="ih-steps">${steps}</div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  el.querySelector('.ih-close').onclick = () => { localStorage.setItem('aqua.installHint', 'off'); el.classList.remove('show'); setTimeout(() => el.remove(), 320); };
}

function initSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  const kill = () => s.classList.add('done');
  s.addEventListener('click', kill);
  setTimeout(kill, 1350); // cleanup after the (shortened) animation
}

function init() {
  initSplash();
  applyTheme();
  wire();
  paintIcons(document); // swap chrome emoji for clean line icons
  // Only render the dashboard at startup; other views render lazily on first open
  // (switchView -> renderView). Big win: no building nutrition/finance/calendar/etc up front.
  switchView('dashboard');
  updateBadges();
  applyReminder();
  // First run (no profile yet): offer the goal quiz once the splash clears.
  if (!state.profile.onboarded && !state.profile.weight) setTimeout(() => openOnboarding(true), 1000);
  checkBirthday();
  setTimeout(maybeShowInstallHint, 2800);
  initAuth(); // Firebase auth state + cloud sync
  // PWA: register service worker (offline shell + notifications). Only over http(s).
  if (SERVED && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // A new SW taking over means fresh code is live — reload once so the page runs it.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return; reloaded = true; location.reload();
      });
      // Nudge the SW to look for a new version now and then.
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    }).catch(() => {});
    startServedUpdateWatch();
  }
  // redraw rings on resize (canvas is bitmap)
  window.addEventListener('resize', () => renderView(currentView));
}
document.addEventListener('DOMContentLoaded', init);
