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
    udp.close();
  });
  udp.bind(UDP_RECV, () => console.log(`[udp] Listening on :${UDP_RECV}`));
  fcSend = (buf) => udp.send(buf, UDP_SEND, BACKPACK_IP, (e) => { if (e) console.error('[udp↑]', e.message); });
  bridge = udp;
}

// ── TCP bridge ────────────────────────────────────────────────────────────────
function startTCP () {
  stopBridge();
  let socket = null, retryTimer = null;
  function connect () {
    socket = net.createConnection({ host: BACKPACK_IP, port: TCP_PORT });
    socket.on('connect', () => console.log('[tcp] Connected'));
    socket.on('data',    (buf) => broadcast(buf));
    socket.on('close',   () => { fcSend = null; retryTimer = setTimeout(connect, 3000); });
    socket.on('error',   (e) => console.error('[tcp]', e.message));
    fcSend = (buf) => { if (socket?.writable) socket.write(buf); };
  }
  connect();
  bridge = { close: () => { clearTimeout(retryTimer); socket?.destroy(); } };
}

function stopBridge () {
  try { bridge?.close(); } catch {}
  bridge = null; fcSend = null;
}

// ── Internal WebSocket server (renderer ↔ WiFi bridge) ───────────────────────
function startWSServer () {
  const server = http.createServer();
  const wss    = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => { if (fcSend) fcSend(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
    ws.on('close',   () => clients.delete(ws));
    ws.on('error',   (e) => { clients.delete(ws); console.error('[ws]', e.message); });
  });
  server.listen(WS_PORT, '127.0.0.1', () => console.log(`[ws] Bridge on ws://localhost:${WS_PORT}`));
}

// ── IPC: WiFi bridge control ──────────────────────────────────────────────────
ipcMain.on('bridge-start', (_, opts) => {
  if (opts.backpackIp) BACKPACK_IP = opts.backpackIp;
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
    const sp = new SerialPort({ path: portPath, baudRate }, (err) => {
      if (err) { reject(err.message); return; }
      serialPort = sp;
      sp.on('data',  (buf) => mainWin?.webContents.send('serial-data',  [...buf]));
      sp.on('close', ()    => { serialPort = null; mainWin?.webContents.send('serial-closed'); });
      sp.on('error', (e)   => mainWin?.webContents.send('serial-error', e.message));
      resolve(true);
    });
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
  catch { return { windowMode: 'fullscreen' }; }
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

ipcMain.handle('get-settings',      ()         => loadSettings());
ipcMain.handle('save-settings',     (_, data)  => { persistSettings(data); return true; });
ipcMain.handle('set-window-mode',   (_, mode)  => {
  if (mainWin) applyWindowMode(mainWin, mode);
  return true;
});

// ── Tile cache file storage ────────────────────────────────────────────────────
let tilesBasePath = null;

ipcMain.handle('get-tiles-path', () => tilesBasePath);

ipcMain.handle('open-tiles-folder', async () => {
  if (!tilesBasePath) return;
  try { fs.mkdirSync(tilesBasePath, { recursive: true }); } catch {}
  await shell.openPath(tilesBasePath);
});

ipcMain.handle('save-tile-file', async (_, layerKey, z, x, y, arrayBuffer) => {
  if (!tilesBasePath) return;
  try {
    const dir = path.join(tilesBasePath, layerKey, String(z), String(x));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${y}.png`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    }
  } catch (e) { console.error('[tile-save]', e.message); }
});
// Re-focus the renderer's Chromium context after native dialogs (confirm/alert) steal it.
ipcMain.on('focus-window', () => mainWin?.webContents.focus());
ipcMain.on('blur-window',  () => { mainWin?.blur(); setTimeout(() => mainWin?.focus(), 50); });

// ── Electron window ───────────────────────────────────────────────────────────
function createWindow () {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'AeroNav AI',
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
  // mainWin.webContents.openDevTools();
}

app.whenReady().then(() => {
  settingsPath  = path.join(app.getPath('userData'), 'settings.json');
  tilesBasePath = path.join(app.getPath('userData'), 'tiles');
  Menu.setApplicationMenu(null);
  startWSServer();
  startUDP();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  stopBridge();
  if (process.platform !== 'darwin') app.quit();
});
