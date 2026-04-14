'use strict';

const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const dgram  = require('dgram');
const net    = require('net');
const http   = require('http');
const { WebSocketServer } = require('ws');

// ── Bridge config (can be overridden via IPC from renderer) ───────────────────
let BACKPACK_IP = '10.0.0.1';
let UDP_RECV    = 14550;
let UDP_SEND    = 14555;
let TCP_PORT    = 5760;
const WS_PORT   = 5761;

// ── Shared state ──────────────────────────────────────────────────────────────
const clients = new Set();
let   fcSend  = null;
let   bridge  = null;
let   mainWin = null;

// ── Module-level server references (Bug #10) ──────────────────────────────────
let wsHttpServer      = null;
let displayHttpServer = null;

// ── Broadcast to all renderer WebSocket clients ───────────────────────────────
function broadcast (buf) {
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(buf);
}

// ── UDP bridge ────────────────────────────────────────────────────────────────
function startUDP () {
  stopBridge();
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => { if (rinfo.address === BACKPACK_IP) broadcast(msg); });
  udp.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `[udp] Port ${UDP_RECV} in use — close Mission Planner / QGC first`
      : '[udp] ' + e.message);
    // Bug #9: reset fcSend so callers don't use the dead socket's send function
    fcSend = null;
    udp.close();
  });
  udp.bind(UDP_RECV, () => console.log(`[udp] Listening on :${UDP_RECV}`));
  fcSend = (buf) => udp.send(buf, UDP_SEND, BACKPACK_IP, (e) => { if (e) console.error('[udp↑]', e.message); });
  bridge = udp;
}

// ── TCP bridge ────────────────────────────────────────────────────────────────
function startTCP () {
  stopBridge();
  let socket = null, retryTimer = null, stopped = false;
  function connect () {
    if (stopped) return;
    // Bug #2: remove all listeners from any existing socket before creating a
    // new connection so listeners don't accumulate across reconnect attempts.
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    socket = net.createConnection({ host: BACKPACK_IP, port: TCP_PORT });
    socket.on('connect', () => console.log('[tcp] Connected'));
    socket.on('data',    (buf) => broadcast(buf));
    socket.on('close',   () => { fcSend = null; if (!stopped) retryTimer = setTimeout(connect, 3000); });
    socket.on('error',   (e) => console.error('[tcp]', e.message));
    fcSend = (buf) => { if (socket?.writable) socket.write(buf); };
  }
  connect();
  bridge = { close: () => { stopped = true; clearTimeout(retryTimer); socket?.destroy(); } };
}

function stopBridge () {
  try { bridge?.close(); } catch {}
  bridge = null; fcSend = null;
}

// ── Internal WebSocket server (renderer ↔ WiFi bridge) ───────────────────────
function startWSServer () {
  // Bug #10: store the http server reference so it can be closed on exit
  wsHttpServer = http.createServer();
  const wss    = new WebSocketServer({ server: wsHttpServer });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => { if (fcSend) fcSend(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
    ws.on('close',   () => clients.delete(ws));
    ws.on('error',   (e) => { clients.delete(ws); console.error('[ws]', e.message); });
  });
  wsHttpServer.listen(WS_PORT, '127.0.0.1', () => console.log(`[ws] Bridge on ws://localhost:${WS_PORT}`));
}

// ── Display WebSocket server (ESP32 / external display clients) ───────────────
// Binds on all interfaces so an ESP32 on the same WiFi network can connect.
const DISPLAY_WS_PORT = 5763;
const displayClients  = new Set();

function startDisplayWSServer () {
  // Bug #10: store the http server reference so it can be closed on exit
  displayHttpServer = http.createServer();
  const wss         = new WebSocketServer({ server: displayHttpServer });
  wss.on('connection', (ws) => {
    displayClients.add(ws);
    ws.on('close', () => displayClients.delete(ws));
    ws.on('error', (e) => { displayClients.delete(ws); console.error('[display-ws]', e.message); });
  });
  displayHttpServer.listen(DISPLAY_WS_PORT, '0.0.0.0', () =>
    console.log(`[display-ws] ESP32 display server on :${DISPLAY_WS_PORT}`));
}

// Renderer pushes position + waypoints; forwarded as JSON to all display clients.
ipcMain.on('display-update', (_, data) => {
  if (displayClients.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of displayClients) if (ws.readyState === ws.OPEN) ws.send(msg);
});

// ── IPC: WiFi bridge control ──────────────────────────────────────────────────
ipcMain.on('bridge-start', (_, opts) => {
  // Bug #13: validate IPv4 format before accepting the IP from the renderer
  if (opts.backpackIp) {
    const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Re.test(opts.backpackIp)) {
      console.error('[bridge-start] Invalid IP address:', opts.backpackIp);
      return;
    }
    BACKPACK_IP = opts.backpackIp;
  }
  if (opts.udpRecv)    UDP_RECV    = opts.udpRecv;
  if (opts.udpSend)    UDP_SEND    = opts.udpSend;
  if (opts.tcpPort)    TCP_PORT    = opts.tcpPort;
  opts.mode === 'tcp' ? startTCP() : startUDP();
});
ipcMain.on('bridge-stop', () => stopBridge());

// ── IPC: Native serial port (USB) ─────────────────────────────────────────────
let serialPort = null;

ipcMain.handle('serial-list', async () => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return { ports };
  } catch (e) {
    console.error('[serial-list]', e.message);
    return { ports: [], error: e.message };
  }
});

ipcMain.handle('serial-open', async (_, portPath, baudRate) => {
  const { SerialPort } = require('serialport');
  if (serialPort?.isOpen) {
    await new Promise(r => serialPort.close(() => r()));
    serialPort = null;
  }
  return new Promise((resolve, reject) => {
    // Bug #3: wrap the SerialPort constructor in a try-catch so synchronous
    // throws (e.g. invalid arguments) are caught and the promise is rejected.
    let sp;
    try {
      sp = new SerialPort({ path: portPath, baudRate }, (err) => {
        if (err) { reject(err.message); return; }
        serialPort = sp;
        sp.on('data',  (buf) => mainWin?.webContents.send('serial-data',  [...buf]));
        sp.on('close', ()    => { serialPort = null; mainWin?.webContents.send('serial-closed'); });
        sp.on('error', (e)   => mainWin?.webContents.send('serial-error', e.message));
        resolve(true);
      });
    } catch (e) {
      reject(e.message);
    }
  });
});

ipcMain.handle('serial-close', async () => {
  if (!serialPort?.isOpen) { serialPort = null; return; }
  await new Promise(r => serialPort.close(() => r()));
  serialPort = null;
});

ipcMain.on('serial-write', (_, bytes) => {
  if (serialPort?.isOpen) serialPort.write(Buffer.from(bytes));
});

// ── Settings persistence ───────────────────────────────────────────────────────
let settingsPath = null;

function loadSettings () {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) {
    // Bug #25: warn so developers know that settings were reset to defaults
    console.warn('[settings] Failed to parse settings file, resetting to defaults:', e.message);
    return { windowMode: 'fullscreen' };
  }
}

function persistSettings (data) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[settings]', e.message); }
}

function applyWindowMode (win, mode) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const cx = (w) => Math.max(0, Math.round((sw - w) / 2));
  const cy = (h) => Math.max(0, Math.round((sh - h) / 2));
  win.unmaximize();
  switch (mode) {
    case 'fullscreen':
      win.maximize(); break;
    case 'windowed-lg':
      win.setBounds({ x: cx(1600), y: cy(1000), width: Math.min(1600, sw), height: Math.min(1000, sh) }); break;
    case 'windowed-md':
      win.setBounds({ x: cx(1280), y: cy(820),  width: Math.min(1280, sw), height: Math.min(820,  sh) }); break;
    case 'windowed-sm':
      win.setBounds({ x: cx(1024), y: cy(700),  width: Math.min(1024, sw), height: Math.min(700,  sh) }); break;
    case 'windowed-xs':
      win.setBounds({ x: cx(900),  y: cy(620),  width: 900, height: 620 }); break;
    case 'center-float':
      win.setBounds({ x: cx(800),  y: cy(580),  width: 800, height: 580 }); break;
    case 'left-half':
      win.setBounds({ x: 0, y: 0, width: Math.floor(sw / 2), height: sh }); break;
    case 'right-half':
      win.setBounds({ x: Math.ceil(sw / 2), y: 0, width: Math.floor(sw / 2), height: sh }); break;
    case 'left-two-thirds':
      win.setBounds({ x: 0, y: 0, width: Math.floor(sw * 2 / 3), height: sh }); break;
    case 'right-two-thirds':
      win.setBounds({ x: Math.ceil(sw / 3), y: 0, width: Math.floor(sw * 2 / 3), height: sh }); break;
    case 'top-half':
      win.setBounds({ x: 0, y: 0, width: sw, height: Math.floor(sh / 2) }); break;
    case 'bottom-half':
      win.setBounds({ x: 0, y: Math.ceil(sh / 2), width: sw, height: Math.floor(sh / 2) }); break;
    default:
      win.maximize();
  }
}

ipcMain.handle('get-app-version',   ()         => app.getVersion());
ipcMain.handle('get-settings',      ()         => loadSettings());
ipcMain.handle('save-settings',     (_, data)  => { persistSettings(data); return true; });
ipcMain.handle('set-window-mode',   (_, mode)  => {
  if (mainWin) applyWindowMode(mainWin, mode);
  return true;
});

// ── Video recording save ───────────────────────────────────────────────────────
let recordingsBasePath = null;

// Bug #24: converted from sync fs calls to async fs.promises to avoid blocking
// the main process event loop inside async IPC handlers.
ipcMain.handle('save-recording', async (_, dateStr, timeStr, arrayBuffer) => {
  if (!recordingsBasePath) return { ok: false, error: 'No path' };
  try {
    const dir = path.join(recordingsBasePath, dateStr);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `recording-${dateStr}_${timeStr}.webm`);
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    return { ok: true, path: filePath };
  } catch (e) {
    console.error('[save-recording]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-snapshot', async (_, dateStr, timeStr, arrayBuffer) => {
  if (!recordingsBasePath) return { ok: false, error: 'No path' };
  try {
    const dir = path.join(recordingsBasePath, dateStr);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `snapshot-${dateStr}_${timeStr}.png`);
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    return { ok: true, path: filePath };
  } catch (e) {
    console.error('[save-snapshot]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-recordings-folder', async () => {
  if (!recordingsBasePath) return;
  try { fs.mkdirSync(recordingsBasePath, { recursive: true }); } catch {}
  await shell.openPath(recordingsBasePath);
});

// ── Tile cache file storage ────────────────────────────────────────────────────
let tilesBasePath = null;

ipcMain.handle('get-tiles-path', () => tilesBasePath);

ipcMain.handle('open-tiles-folder', async () => {
  if (!tilesBasePath) return;
  try { fs.mkdirSync(tilesBasePath, { recursive: true }); } catch {}
  await shell.openPath(tilesBasePath);
});

ipcMain.handle('save-tile-file', async (_, regionName, layerKey, z, x, y, arrayBuffer) => {
  if (!tilesBasePath) return;

  // Bug #12: validate z/x/y as integers and layerKey against a safe allowlist
  // to prevent path traversal attacks via crafted tile coordinates or keys.
  const layerKeyRe = /^[a-zA-Z0-9_-]+$/;
  if (!layerKeyRe.test(layerKey)) {
    console.error('[tile-save] Invalid layerKey:', layerKey);
    return { ok: false, error: 'Invalid layerKey' };
  }
  const zi = parseInt(z, 10), xi = parseInt(x, 10), yi = parseInt(y, 10);
  if (!Number.isInteger(zi) || !Number.isInteger(xi) || !Number.isInteger(yi) ||
      String(zi) !== String(z) || String(xi) !== String(x) || String(yi) !== String(y)) {
    console.error('[tile-save] Non-integer tile coordinates:', z, x, y);
    return { ok: false, error: 'Invalid tile coordinates' };
  }

  try {
    // Sanitize region name for use as a folder name
    const safeRegion = (regionName || 'default').replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'default';
    const dir = path.join(tilesBasePath, safeRegion, layerKey, String(zi), String(xi));
    // Bug #24: use async fs.promises calls to avoid blocking the event loop
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${yi}.png`);
    try {
      await fs.promises.access(filePath);
      // File already exists — skip writing
    } catch {
      await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    }
  } catch (e) { console.error('[tile-save]', e.message); }
});

// Re-focus the renderer's Chromium context after native dialogs (confirm/alert) steal it.
ipcMain.on('focus-window', () => mainWin?.webContents.focus());
ipcMain.on('blur-window',  () => { mainWin?.blur(); setTimeout(() => mainWin?.focus(), 50); });

// ── Electron window ───────────────────────────────────────────────────────────
function createWindow () {
  // Grant camera (video capture) permission automatically so getUserMedia works
  // for the live HDMI/AV feed in the GCS panel.
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });
  // Also grant media device enumeration so the dropdown is populated.
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'AeroNav',
    show: false, // shown after mode is applied
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  mainWin.loadFile('index.html');
  mainWin.once('ready-to-show', () => {
    const settings = loadSettings();
    applyWindowMode(mainWin, settings.windowMode || 'fullscreen');
    mainWin.show();
  });
  // Bug #11: clear mainWin reference after the window is destroyed so stale
  // references to the closed BrowserWindow don't linger.
  mainWin.on('closed', () => { mainWin = null; });
  // mainWin.webContents.openDevTools();
}

app.whenReady().then(() => {
  settingsPath      = path.join(app.getPath('userData'), 'settings.json');
  tilesBasePath     = path.join(app.getPath('userData'), 'tiles');
  recordingsBasePath = path.join(app.getPath('userData'), 'recordings');
  Menu.setApplicationMenu(null);
  startWSServer();
  startDisplayWSServer();
  startUDP();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  stopBridge();
  // Bug #10: close both WebSocket HTTP servers so their handles don't keep the
  // process alive and ports are released cleanly.
  try { wsHttpServer?.close(); }      catch {}
  try { displayHttpServer?.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
