const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const APP_ID = 'com.shweppyk.aquatracker';
const isDev = process.argv.includes('--dev');

/* ============================================================
   AUTO-UPDATE — only the small web files (~250 KB), never the
   188 MB Electron binary. Friends install the setup ONCE; after
   that the app updates its own code from a public URL on launch.
   Data stays intact (origin is unchanged file://).
   To activate: set UPDATE_BASE to your public folder (e.g. a
   GitHub repo raw base) that holds version.json + the files.
   To release a new version: bump version.json "version" and
   upload the changed files there. Done — everyone auto-updates.
   ============================================================ */
const UPDATE_BASE = 'https://raw.githubusercontent.com/lev-dev-tech/aqua-tracker/main';
const UPDATE_DIR = __dirname; // resources/app — per-user install, writable without admin
// Renderer files apply on reload; main.js/preload.js apply on the next app launch.
const UPDATE_FILES = ['index.html', 'app.js', 'styles.css', 'theme-init.js', 'sw.js', 'manifest.json', 'main.js', 'preload.js',
  'firebase-init.js', 'vendor/firebase-app-compat.js', 'vendor/firebase-auth-compat.js', 'vendor/firebase-firestore-compat.js'];

function localVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(UPDATE_DIR, 'version.json'), 'utf8')).version || '0'); }
  catch (e) { return '0'; }
}
function versionGt(a, b) { // is a newer than b? (dotted numeric compare)
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
function fetchBuf(url, redirects = 0) {
  const mod = url.startsWith('http://') ? http : https;
  return new Promise((resolve, reject) => {
    mod.get(url, { headers: { 'User-Agent': 'AquaUpdater' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 4) {
        r.resume(); return resolve(fetchBuf(r.headers.location, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
// Apply an update staged on the previous launch (rename *.new -> real) BEFORE the window loads.
function applyStagedUpdate() {
  try {
    const staged = [...UPDATE_FILES, 'version.json'].filter((f) => fs.existsSync(path.join(UPDATE_DIR, f + '.new')));
    if (!staged.length) return false;
    for (const f of staged) { const dst = path.join(UPDATE_DIR, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(path.join(UPDATE_DIR, f + '.new'), dst); }
    return true;
  } catch (e) { return false; }
}
// Check the remote version; if newer, download all files to *.new (applied on next launch).
let updateStaging = null; // resolves once the *.new files are fully written

async function checkForUpdate() {
  if (!/^https?:\/\//.test(UPDATE_BASE) || UPDATE_BASE.includes('USERNAME')) return 'off'; // not configured yet
  try {
    const bust = '?_=' + Date.now();
    const remote = JSON.parse((await fetchBuf(UPDATE_BASE + '/version.json' + bust)).toString('utf8'));
    if (!remote.version || !versionGt(remote.version, localVersion())) return 'uptodate';
    // Notify the renderer right away (tiny version check) so the banner pops as the splash ends,
    // without waiting for the file downloads.
    if (win && win.webContents) win.webContents.send('update:available', remote.version);
    // Download the files in the background; remember the promise so apply can await it.
    const files = Array.isArray(remote.files) && remote.files.length ? remote.files : UPDATE_FILES;
    updateStaging = (async () => {
      const bufs = {};
      for (const f of files) bufs[f] = await fetchBuf(UPDATE_BASE + '/' + f + bust);
      for (const f of files) { const p = path.join(UPDATE_DIR, f + '.new'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bufs[f]); }
      fs.writeFileSync(path.join(UPDATE_DIR, 'version.json.new'), JSON.stringify(remote));
    })();
    await updateStaging;
    return 'staged';
  } catch (e) { updateStaging = null; return 'err'; }
}

let win = null;
let tray = null;
let reminderTimer = null;
let isQuitting = false;

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0f1020',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Closing the window hides to tray so water reminders keep firing.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ---------- tray ----------
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Aqua — трекер привычек');
  rebuildTrayMenu();
  tray.on('double-click', showWindow);
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть Aqua', click: showWindow },
    { type: 'separator' },
    { label: '+200 мл воды', click: () => quickWater(200) },
    { label: '+300 мл воды', click: () => quickWater(300) },
    { label: '+500 мл воды', click: () => quickWater(500) },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function quickWater(ml) {
  showWindow();
  win.webContents.send('water:add', ml);
}

// ---------- reminders ----------
function clearReminder() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
}

function inQuietHours(from, to) {
  if (from == null || to == null || from === to) return false;
  const h = new Date().getHours();
  // e.g. from=23 to=8 -> quiet across midnight
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

function scheduleReminder(cfg) {
  clearReminder();
  if (!cfg || !cfg.enabled) return;
  const minutes = Math.max(5, Number(cfg.intervalMinutes) || 90);
  reminderTimer = setInterval(() => {
    if (inQuietHours(cfg.quietFrom, cfg.quietTo)) return;
    showNotification({
      title: '💧 Пора пить воду',
      body: cfg.body || 'Сделай пару глотков — тело скажет спасибо.',
      tab: 'water',
    });
  }, minutes * 60 * 1000);
}

function showNotification({ title, body, tab }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: title || 'Aqua',
    body: body || '',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    silent: false,
  });
  n.on('click', () => {
    showWindow();
    if (tab) win.webContents.send('tab:open', tab);
  });
  n.show();
}

// ---------- ipc ----------
ipcMain.on('reminder:set', (_e, cfg) => scheduleReminder(cfg));
ipcMain.on('notify', (_e, payload) => showNotification(payload || {}));
ipcMain.on('tray:tooltip', (_e, text) => { if (tray && text) tray.setToolTip(text); });

// Apply the staged update now: wait for the background download if it's still going,
// rename *.new -> real, then reload the window (renderer changes apply immediately;
// main.js/preload.js changes apply on the next launch).
ipcMain.on('update:apply', async () => {
  try { if (updateStaging) await updateStaging; } catch (e) {}
  if (applyStagedUpdate() && win && win.webContents) win.webContents.reloadIgnoringCache();
});
// Manual "check for updates" from the app; report the result back to the renderer.
ipcMain.on('update:check', async () => { const r = await checkForUpdate(); if (win && win.webContents) win.webContents.send('update:checked', r); });

// Network proxy: fetch from the main process to bypass renderer CORS
// (Open Food Facts search + optional AI vision call).
ipcMain.handle('net:request', async (_e, { url, options } = {}) => {
  try {
    const opts = options || {};
    opts.headers = Object.assign({ 'User-Agent': 'AquaTracker/1.0 (personal habit tracker)' }, opts.headers || {});
    const res = await fetch(url, opts);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err && err.message || err) };
  }
});

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
    applyStagedUpdate();                 // apply an update downloaded on the previous launch
    createWindow();
    createTray();
    // Check for updates as soon as the page has loaded (renderer holds the banner until the splash ends).
    if (win && win.webContents) win.webContents.once('did-finish-load', () => setTimeout(checkForUpdate, 500));
    else setTimeout(checkForUpdate, 1500);
    // Keep checking while the app runs: every 20 min, and whenever the window regains focus
    // (throttled to once / 5 min) — so a release lands without the user clicking "check".
    setInterval(() => { checkForUpdate(); }, 20 * 60 * 1000);
    let lastFocusCheck = 0;
    if (win) win.on('focus', () => {
      const now = Date.now();
      if (now - lastFocusCheck > 5 * 60 * 1000) { lastFocusCheck = now; checkForUpdate(); }
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });
  // Keep running in tray on Windows/Linux even when all windows are hidden.
  app.on('window-all-closed', () => {});
}
