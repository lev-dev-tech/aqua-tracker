const { contextBridge, ipcRenderer } = require('electron');

// Safe bridge between the renderer (app.js) and the main process (main.js).
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,

  // Renderer -> main: (re)configure the water reminder schedule.
  setReminder: (cfg) => ipcRenderer.send('reminder:set', cfg),

  // Renderer -> main: show a native OS notification right now.
  notify: (payload) => ipcRenderer.send('notify', payload),

  // Renderer -> main: update tray tooltip with today's water progress.
  setTrayTooltip: (text) => ipcRenderer.send('tray:tooltip', text),

  // Renderer -> main: proxy an HTTP request (bypasses renderer CORS).
  request: (url, options) => ipcRenderer.invoke('net:request', { url, options }),

  // Renderer -> main: save a task attachment to a temp file and open it with the OS default app.
  openFile: (payload) => ipcRenderer.invoke('file:open', payload),

  // Main -> renderer: user clicked a "quick add water" tray entry.
  onQuickWater: (cb) => ipcRenderer.on('water:add', (_e, ml) => cb(ml)),

  // Main -> renderer: focus a specific tab (from a notification click).
  onOpenTab: (cb) => ipcRenderer.on('tab:open', (_e, tab) => cb(tab)),

  // ---- auto-update ----
  appVersion: (function () { try { return String(require('./version.json').version || ''); } catch (e) { return ''; } })(),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, v) => cb(v)),
  onUpdateChecked: (cb) => ipcRenderer.on('update:checked', (_e, r) => cb(r)),
  applyUpdate: () => ipcRenderer.send('update:apply'),
  checkUpdate: () => ipcRenderer.send('update:check'),
});
