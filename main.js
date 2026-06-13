'use strict';

const { app, BrowserWindow, ipcMain, Menu, screen, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const dgram  = require('dgram');
const net    = require('net');
const http   = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// ── Bridge config — N-slot array ─────────────────────────────────────────────
const SLOT_DEFAULTS = { backpackIp: '10.0.0.1', udpRecv: 14550, udpSend: 14555, tcpPort: 5760, wsDronePort: 5760 };
const slotConfigs   = [{ ...SLOT_DEFAULTS }, { ...SLOT_DEFAULTS }];

function getSlotCfg (slot) {
  if (!slotConfigs[slot]) slotConfigs[slot] = { ...SLOT_DEFAULTS };
  return slotConfigs[slot];
}

// ── Shared state ──────────────────────────────────────────────────────────────
const clientSets = [];   // per-slot Set of renderer WS clients
const fcSends    = [];   // per-slot write-to-drone fn
const bridges    = [];   // per-slot bridge handle
let   mainWin    = null;

function ensureSlot (s) {
  if (!clientSets[s]) clientSets[s] = new Set();
}
ensureSlot(0); ensureSlot(1);

// ── Module-level server references ────────────────────────────────────────────
const wsHttpServers = [];
let   displayHttpServer = null;

// ── Broadcast to renderer WS clients for a given slot ────────────────────────
function broadcastSlot (slot, buf) {
  const set = clientSets[slot];
  if (!set) return;
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(buf);
}

// ── Auto-detect which local adapter to use for a given drone IP + slot ───────
// Collects ALL adapters on the same /24, then picks by slot index.
// This means slot 0 gets the first matching adapter and slot 1 gets the second,
// so two drones on the same subnet (e.g. both 10.0.0.1) use different adapters
// as long as Windows assigned them different local IPs.
function findBindAddr (droneIp, slot) {
  slot = slot ?? 0;
  const prefix = droneIp.split('.').slice(0, 3).join('.');
  const matches = [];
  const ifaces  = os.networkInterfaces();
  for (const name of Object.keys(ifaces).sort()) {   // sort for determinism
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal
          && iface.address.startsWith(prefix + '.')) {
        matches.push({ address: iface.address, name });
      }
    }
  }
  if (matches.length === 0) return '0.0.0.0';
  const pick = matches[Math.min(slot, matches.length - 1)];
  console.log(`[slot${slot}] ${droneIp} → adapter "${pick.name}" local ${pick.address}` +
    (matches.length > 1 ? ` (${matches.length} adapters on ${prefix}.x)` : ''));
  mainWin?.webContents.send('bridge-adapter', slot, pick.name, pick.address);
  return pick.address;
}

// ── Directed subnet broadcast addresses for every active LAN adapter ──────────
// Home/office routers frequently drop the global 255.255.255.255 broadcast, so
// we also emit each adapter's directed broadcast (e.g. 192.168.1.255), which
// routers forward far more reliably. Mirrors the Android GCS home-network path.
function subnetBroadcasts () {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip   = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || mask.some(Number.isNaN)) continue;
      out.push(ip.map((o, k) => (o & mask[k]) | (~mask[k] & 0xFF)).join('.'));
    }
  }
  return out;
}

// ── UDP bridge ────────────────────────────────────────────────────────────────
function startUDP (slot) {
  slot = slot ?? 0;
  stopBridge(slot);
  const { backpackIp: ip, udpRecv: recvPort, udpSend: sendPort } = getSlotCfg(slot);
  const udp = dgram.createSocket('udp4');
  let _udpFirstPacket = true;
  udp.on('message', (msg, rinfo) => {
    if (rinfo.address === ip) {
      if (_udpFirstPacket) { _udpFirstPacket = false; console.log(`[udp${slot}] First packet from ${rinfo.address}`); }
      broadcastSlot(slot, msg);
    } else {
      console.warn(`[udp${slot}] Ignored packet from ${rinfo.address} (expected ${ip}) — wrong drone IP configured?`);
    }
  });
  udp.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `[udp${slot}] Port ${recvPort} in use — close Mission Planner / QGC first`
      : `[udp${slot}] ` + e.message);
    fcSends[slot] = null;
    udp.close();
  });
  const bindAddr = findBindAddr(ip, slot);
  udp.bind(recvPort, bindAddr, () => console.log(`[udp${slot}] Listening on ${bindAddr}:${recvPort}`));
  fcSends[slot] = (buf) => udp.send(buf, sendPort, ip, (e) => { if (e) console.error(`[udp${slot}↑]`, e.message); });
  bridges[slot] = udp;
}

// ── UDP "home network" bridge ─────────────────────────────────────────────────
// For drones that join a shared WiFi router (DHCP) instead of running their own
// SoftAP — so their address is unknown up front. We bind on all interfaces,
// learn every module that answers, auto-detect the drone IP, and send each
// outbound frame to the directed subnet broadcast(s) + 255.255.255.255 + unicast
// to every learned peer. This mirrors the Android GCS: home APs often drop the
// global broadcast for the 2nd drone, so per-peer unicast keeps every module
// trained on the GCS. Unlike startUDP, packets are accepted from any source.
function startUDPHome (slot) {
  slot = slot ?? 0;
  stopBridge(slot);
  const cfg = getSlotCfg(slot);
  const { udpRecv: recvPort, udpSend: sendPort } = cfg;
  const udp   = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const peers = new Map();             // "ip:port" → { address, port }
  let   bcasts   = subnetBroadcasts(); // recomputed once bound
  let   detected = false;
  udp.on('message', (msg, rinfo) => {
    const key = rinfo.address + ':' + rinfo.port;
    if (!peers.has(key)) {
      peers.set(key, { address: rinfo.address, port: rinfo.port });
      console.log(`[udp-home${slot}] Learned drone ${key} (${peers.size} total)`);
    }
    if (!detected) {
      detected = true;
      cfg.backpackIp = rinfo.address;
      console.log(`[udp-home${slot}] Discovered drone at ${rinfo.address}`);
      mainWin?.webContents.send('bridge-discovered', slot, rinfo.address, rinfo.port);
    }
    broadcastSlot(slot, msg);
  });
  udp.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `[udp-home${slot}] Port ${recvPort} in use — close Mission Planner / QGC first`
      : `[udp-home${slot}] ` + e.message);
    fcSends[slot] = null;
    udp.close();
  });
  // Bind on 0.0.0.0 so any drone on the LAN reaches us, regardless of its IP.
  udp.bind(recvPort, () => {
    try { udp.setBroadcast(true); } catch {}
    bcasts = subnetBroadcasts();
    console.log(`[udp-home${slot}] Listening on 0.0.0.0:${recvPort} — discovery via ` +
      (bcasts.length ? bcasts.join(', ') : '255.255.255.255'));
  });
  fcSends[slot] = (buf) => {
    const err = (e) => { if (e && e.code !== 'EACCES') console.error(`[udp-home${slot}↑]`, e.message); };
    for (const b of bcasts) udp.send(buf, sendPort, b, err);   // directed broadcast(s)
    udp.send(buf, sendPort, '255.255.255.255', err);           // global fallback
    for (const p of peers.values()) udp.send(buf, p.port, p.address, err); // learned peers
  };
  bridges[slot] = udp;
}

// ── TCP bridge ────────────────────────────────────────────────────────────────
function startTCP (slot) {
  slot = slot ?? 0;
  stopBridge(slot);
  const { backpackIp: ip, tcpPort } = getSlotCfg(slot);
  const bindAddr = findBindAddr(ip, slot);
  let socket = null, retryTimer = null, stopped = false;
  function connect () {
    if (stopped) return;
    if (socket) { socket.removeAllListeners(); socket.destroy(); }
    const connOpts = { host: ip, port: tcpPort };
    if (bindAddr !== '0.0.0.0') connOpts.localAddress = bindAddr;
    socket = net.createConnection(connOpts);
    socket.on('connect', () => console.log(`[tcp${slot}] Connected via ${bindAddr}`));
    socket.on('data',    (buf) => broadcastSlot(slot, buf));
    socket.on('close',   () => { fcSends[slot] = null; if (!stopped) retryTimer = setTimeout(connect, 3000); });
    socket.on('error',   (e) => console.error(`[tcp${slot}]`, e.message));
    fcSends[slot] = (buf) => { if (socket?.writable) socket.write(buf); };
  }
  connect();
  bridges[slot] = { close: () => { stopped = true; clearTimeout(retryTimer); socket?.destroy(); } };
}

// ── WS-client bridge — outbound WebSocket to drone, relay to renderer ─────────
// Drone must expose a WebSocket server (e.g. MAVProxy --out ws:0.0.0.0:5760).
// Uses localAddress to force traffic through the correct adapter — solves the
// same-subnet two-drone problem without needing TCP or UDP port tricks.
function startWSClientBridge (slot) {
  slot = slot ?? 0;
  stopBridge(slot);
  const { backpackIp: ip, wsDronePort: droneWsPort } = getSlotCfg(slot);
  const bindAddr = findBindAddr(ip, slot);
  const url      = `ws://${ip}:${droneWsPort}`;

  let ws = null, retryTimer = null, stopped = false;

  function connect () {
    if (stopped) return;
    const opts = { handshakeTimeout: 5000 };
    if (bindAddr !== '0.0.0.0') opts.localAddress = bindAddr;
    ws = new WebSocket(url, opts);
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      console.log(`[ws-client${slot}] Connected to ${url} via ${bindAddr}`);
      fcSends[slot] = (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); };
    });
    ws.on('message', (data) => broadcastSlot(slot, Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on('close',   () => { fcSends[slot] = null; if (!stopped) { console.log(`[ws-client${slot}] Disconnected — retrying in 3 s`); retryTimer = setTimeout(connect, 3000); } });
    ws.on('error',   (e) => console.error(`[ws-client${slot}]`, e.message));
  }

  connect();
  bridges[slot] = { close: () => { stopped = true; clearTimeout(retryTimer); try { ws?.terminate(); } catch {} } };
}

function stopBridge (slot) {
  if (slot === undefined) { for (let i = 0; i < bridges.length; i++) stopBridge(i); return; }
  try { bridges[slot]?.close(); } catch {}
  bridges[slot] = null; fcSends[slot] = null;
}

// ── Internal WebSocket server (renderer ↔ WiFi bridge) — per slot ─────────────
function startWSServer (slot) {
  slot = slot ?? 0;
  const port    = 5770 + slot;
  const httpSrv = http.createServer();
  const wss     = new WebSocketServer({ server: httpSrv });
  wss.on('connection', (ws) => {
    clientSets[slot].add(ws);
    ws.on('message', (data) => { if (fcSends[slot]) fcSends[slot](Buffer.isBuffer(data) ? data : Buffer.from(data)); });
    ws.on('close',   () => clientSets[slot].delete(ws));
    ws.on('error',   (e) => { clientSets[slot].delete(ws); console.error(`[ws${slot}]`, e.message); });
  });
  httpSrv.listen(port, '127.0.0.1', () => console.log(`[ws${slot}] Bridge on ws://localhost:${port}`));
  wsHttpServers[slot] = httpSrv;
}

// ── Display WebSocket server (ESP32 / external display clients) ───────────────
const DISPLAY_WS_PORT = 5763;
const displayClients  = new Set();

function startDisplayWSServer () {
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

ipcMain.on('display-update', (_, data) => {
  if (displayClients.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of displayClients) if (ws.readyState === ws.OPEN) ws.send(msg);
});

// ── IPC: WiFi bridge control ──────────────────────────────────────────────────
ipcMain.on('bridge-start', (_, opts) => {
  const slot = opts.slot ?? 0;
  if (opts.backpackIp) {
    const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Re.test(opts.backpackIp)) {
      console.error('[bridge-start] Invalid IP address:', opts.backpackIp);
      return;
    }
  }
  const cfg = getSlotCfg(slot);
  if (opts.backpackIp) cfg.backpackIp  = opts.backpackIp;
  if (opts.udpRecv)    cfg.udpRecv     = opts.udpRecv;
  if (opts.udpSend)    cfg.udpSend     = opts.udpSend;
  if (opts.tcpPort)    cfg.tcpPort     = opts.tcpPort;
  if (opts.wsPort)     cfg.wsDronePort = opts.wsPort;
  ensureSlot(slot);
  if (!wsHttpServers[slot]) startWSServer(slot);
  if (opts.mode === 'tcp') startTCP(slot);
  else if (opts.mode === 'ws') startWSClientBridge(slot);
  else if (opts.mode === 'udp-home') startUDPHome(slot);
  else startUDP(slot);
});

ipcMain.on('bridge-stop', (_, slot) => stopBridge(slot ?? 0));

ipcMain.handle('slot-init', (_, slot) => {
  ensureSlot(slot);
  if (!wsHttpServers[slot]) startWSServer(slot);
  return 5770 + slot;
});

// ── IPC: Native serial ports (USB) — two slots ───────────────────────────────
const serialPorts = [];

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

ipcMain.handle('serial-open', async (_, portPath, baudRate, slot) => {
  const s = slot ?? 0;
  const { SerialPort } = require('serialport');
  if (serialPorts[s]?.isOpen) {
    await new Promise(r => serialPorts[s].close(() => r()));
    serialPorts[s] = null;
  }
  return new Promise((resolve, reject) => {
    let sp;
    try {
      sp = new SerialPort({ path: portPath, baudRate }, (err) => {
        if (err) { reject(err.message); return; }
        serialPorts[s] = sp;
        sp.on('data',  (buf) => mainWin?.webContents.send('serial-data',  [...buf], s));
        sp.on('close', ()    => { serialPorts[s] = null; mainWin?.webContents.send('serial-closed', s); });
        sp.on('error', (e)   => mainWin?.webContents.send('serial-error', e.message, s));
        resolve(true);
      });
    } catch (e) {
      reject(e.message);
    }
  });
});

ipcMain.handle('serial-close', async (_, slot) => {
  const s = slot ?? 0;
  if (!serialPorts[s]?.isOpen) { serialPorts[s] = null; return; }
  await new Promise(r => serialPorts[s].close(() => r()));
  serialPorts[s] = null;
});

ipcMain.on('serial-write', (_, bytes, slot) => {
  const s = slot ?? 0;
  if (serialPorts[s]?.isOpen) serialPorts[s].write(Buffer.from(bytes));
});

// ── Settings persistence ───────────────────────────────────────────────────────
let settingsPath = null;

function loadSettings () {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) {
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
    const safeRegion = (regionName || 'default').replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'default';
    const dir = path.join(tilesBasePath, safeRegion, layerKey, String(zi), String(xi));
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${yi}.png`);
    try {
      await fs.promises.access(filePath);
    } catch {
      await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    }
  } catch (e) { console.error('[tile-save]', e.message); }
});

ipcMain.on('focus-window', () => mainWin?.webContents.focus());
ipcMain.on('blur-window',  () => { mainWin?.blur(); setTimeout(() => mainWin?.focus(), 50); });

// ── External display window (HDMI / secondary monitor) ────────────────────────
let displayWin = null;
ipcMain.handle('open-display-window', () => {
  if (displayWin && !displayWin.isDestroyed()) { displayWin.focus(); return; }
  displayWin = new BrowserWindow({
    width: 900, height: 650, minWidth: 500, minHeight: 400,
    title: 'AeroNav Map',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  displayWin.loadFile('index.html', { query: { popup: '1' } });
  displayWin.on('closed', () => { displayWin = null; });
});

// Relay drone data from main window to display window
ipcMain.on('display-relay', (_, data) => {
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('display-data', data);
  }
});

// ── Electron window ───────────────────────────────────────────────────────────
function createWindow () {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'geolocation') { callback(true); return; }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'geolocation') return true;
    return false;
  });

  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'AeroNav',
    show: false,
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
  mainWin.on('closed', () => { mainWin = null; });
}

// ── Auto-update (electron-updater) ────────────────────────────────────────────
// Checks GitHub releases (Rwith/AeroNav) on launch. If a newer version is
// published, prompts the user, downloads in the background, then prompts to
// restart and install. Only meaningful in packaged builds — skipped in dev.
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = false;          // we ask the user first
autoUpdater.autoInstallOnAppQuit = false;  // we restart explicitly after confirmation

function _broadcastUpdate (channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => _broadcastUpdate('updater-status', { state: 'checking' }));
autoUpdater.on('update-not-available', (info) => _broadcastUpdate('updater-status', { state: 'up-to-date', info }));
autoUpdater.on('error', (err) => {
  log.error('[updater]', err);
  _broadcastUpdate('updater-status', { state: 'error', message: err?.message || String(err) });
});
autoUpdater.on('download-progress', (p) => _broadcastUpdate('updater-status', {
  state: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total
}));

autoUpdater.on('update-available', async (info) => {
  _broadcastUpdate('updater-status', { state: 'available', version: info.version });
  const { response } = await dialog.showMessageBox(mainWin || undefined, {
    type: 'info',
    buttons: ['Update now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'AeroNav update available',
    message: `Version ${info.version} is available.`,
    detail: 'Download and install now?'
  });
  if (response === 0) {
    autoUpdater.downloadUpdate().catch((e) => log.error('[updater] downloadUpdate', e));
  }
});

autoUpdater.on('update-downloaded', async (info) => {
  _broadcastUpdate('updater-status', { state: 'downloaded', version: info.version });
  const { response } = await dialog.showMessageBox(mainWin || undefined, {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `Version ${info.version} downloaded.`,
    detail: 'Restart AeroNav to apply the update?'
  });
  if (response === 0) {
    setImmediate(() => autoUpdater.quitAndInstall());
  }
});

ipcMain.handle('updater-check', async () => {
  try { return await autoUpdater.checkForUpdates(); }
  catch (e) { return { error: e?.message || String(e) }; }
});

app.whenReady().then(() => {
  settingsPath       = path.join(app.getPath('userData'), 'settings.json');
  tilesBasePath      = path.join(app.getPath('userData'), 'tiles');
  recordingsBasePath = path.join(app.getPath('userData'), 'recordings');
  Menu.setApplicationMenu(null);
  startWSServer(0);
  startWSServer(1);
  startDisplayWSServer();
  startUDP(0);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // Check for updates 4 s after launch so the window is up and the bridge is
  // running. Silently no-op in dev (autoUpdater detects unpackaged app).
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] check failed:', e?.message || e));
    }, 4000);
  }
});

app.on('window-all-closed', () => {
  stopBridge();
  wsHttpServers.forEach(srv => { try { srv?.close(); } catch {} });
  try { displayHttpServer?.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
