/* ============================================================
   Aqua — локальный запуск без зависимостей.
   Отдаёт статику + проксирует внешние API (обход CORS) и
   открывает приложение в отдельном окне браузера (app-режим).
   Нужен только Node.js. Запуск: node server.js  (или Запуск Aqua.bat)
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url.split('?')[0]) || '/');
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleProxy(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
  req.on('end', async () => {
    let out;
    try {
      const { url, options } = JSON.parse(body || '{}');
      const opts = options || {};
      opts.headers = Object.assign({ 'User-Agent': 'AquaTracker/1.0 (personal habit tracker)' }, opts.headers || {});
      opts.signal = AbortSignal.timeout(8000); // don't hang on the slow OFF Cyrillic search
      const r = await fetch(url, opts);
      const text = await r.text();
      out = { ok: r.ok, status: r.status, body: text };
    } catch (e) {
      out = { ok: false, status: 0, body: '', error: String((e && e.message) || e) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(out));
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/proxy') && req.method === 'POST') return handleProxy(req, res);
  serveStatic(req, res);
});

function openApp(url) {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  const bin = [edge, edge64, chrome, chrome86].find((p) => fs.existsSync(p));
  if (bin) {
    spawn(bin, [`--app=${url}`, '--window-size=1240,860'],
      { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const PORT = 8899;
const URL = `http://127.0.0.1:${PORT}/index.html`;

// Single instance: if Aqua is already running, just open a window to it and exit —
// never start a second server (that caused multiple windows + split data).
server.once('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Aqua уже запущен — открываю окно.');
    if (!process.argv.includes('--no-open')) openApp(URL);
    setTimeout(() => process.exit(0), 400);
  } else {
    console.error('Ошибка запуска:', e.message);
    process.exit(1);
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  Aqua запущен →', URL);
  console.log('  Окно приложения откроется автоматически.');
  console.log('  Чтобы закрыть трекер — закрой это окно консоли.\n');
  if (!process.argv.includes('--no-open')) openApp(URL);
});
