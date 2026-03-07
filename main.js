'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const dgram  = require('dgram');
const net    = require('net');
const http   = require('http');
const { WebSocketServer } = require('ws');

// ── Bridge config (can be overridden via IPC from renderer) ───────────────────
let BACKPACK_IP = '10.0.0.1';
let UDP_RECV    = 14550;
let UDP_SEND    = 14555;
let TCP_PORT    = 5760;
const WS_PORT   = 5761; // internal bridge port (avoids conflicts with external tools)

// ── Shared state ──────────────────────────────────────────────────────────────
const clients = new Set(); // connected renderer WebSockets
let   fcSend  = null;      // function(buf) → sends data to FC
let   bridge  = null;      // active UDP socket or TCP socket

// ── Broadcast to all connected renderer windows ───────────────────────────────
function broadcast (buf) {
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(buf);
}

// ── UDP bridge ────────────────────────────────────────────────────────────────
function startUDP () {
  stopBridge();
  const udp = dgram.createSocket('udp4');
  let packets = 0;

  udp.on('message', (msg, rinfo) => {
    if (rinfo.address !== BACKPACK_IP) return;
    packets++;
    broadcast(msg);
  });

  udp.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[udp] FATAL: Port ${UDP_RECV} already in use. Close Mission Planner / QGC first.`);
    } else {
      console.error('[udp]', e.message);
    }
    udp.close();
  });

  udp.bind(UDP_RECV, () => console.log(`[udp] Listening on :${UDP_RECV}`));

  fcSend = (buf) => udp.send(buf, UDP_SEND, BACKPACK_IP, (e) => {
    if (e) console.error('[udp↑]', e.message);
  });

  bridge = udp;
}

// ── TCP bridge ────────────────────────────────────────────────────────────────
function startTCP () {
  stopBridge();
  let socket = null;
  let retryTimer = null;

  function connect () {
    console.log(`[tcp] Connecting to ${BACKPACK_IP}:${TCP_PORT} …`);
    socket = net.createConnection({ host: BACKPACK_IP, port: TCP_PORT });

    socket.on('connect', () => console.log(`[tcp] Connected ✓`));
    socket.on('data',    (buf) => broadcast(buf));
    socket.on('close',   () => {
      console.log('[tcp] Closed — retrying in 3 s …');
      fcSend = null;
      retryTimer = setTimeout(connect, 3000);
    });
    socket.on('error', (e) => console.error('[tcp]', e.message));

    fcSend = (buf) => { if (socket?.writable) socket.write(buf); };
  }

  connect();
  bridge = { close: () => { clearTimeout(retryTimer); socket?.destroy(); } };
}

function stopBridge () {
  try { bridge?.close(); } catch {}
  bridge = null;
  fcSend = null;
}

// ── Internal WebSocket server (renderer connects here) ────────────────────────
function startWSServer () {
  const server = http.createServer();
  const wss    = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => {
      if (fcSend) fcSend(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (e) => { clients.delete(ws); console.error('[ws]', e.message); });
  });

  server.listen(WS_PORT, '127.0.0.1', () =>
    console.log(`[ws] Bridge ready on ws://localhost:${WS_PORT}`)
  );
}

// ── IPC: renderer can change bridge settings at runtime ───────────────────────
ipcMain.on('bridge-start', (_, opts) => {
  if (opts.backpackIp) BACKPACK_IP = opts.backpackIp;
  if (opts.udpRecv)    UDP_RECV    = opts.udpRecv;
  if (opts.udpSend)    UDP_SEND    = opts.udpSend;
  if (opts.tcpPort)    TCP_PORT    = opts.tcpPort;
  opts.mode === 'tcp' ? startTCP() : startUDP();
  console.log(`[bridge] Started in ${opts.mode ?? 'udp'} mode → ${BACKPACK_IP}`);
});

ipcMain.on('bridge-stop', () => stopBridge());

// ── Electron window ───────────────────────────────────────────────────────────
let mainWin = null;

function createWindow () {
  mainWin = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Flight Planner',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // ── Web Serial API: port picker ───────────────────────────────────────────
  // When navigator.serial.requestPort() is called in the renderer, Electron
  // fires this event instead of showing the browser's built-in dialog.
  // We forward the port list to the renderer and wait for the user's choice.
  mainWin.webContents.session.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault(); // we handle it ourselves
    if (!portList || portList.length === 0) {
      callback(''); // no ports available
      return;
    }
    mainWin.webContents.send('serial-select-port', portList);
    ipcMain.once('serial-port-chosen', (_, portId) => callback(portId ?? ''));
  });

  // Grant serial permission automatically (this is a trusted desktop app).
  mainWin.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'serial') return true;
    return null; // default for everything else
  });
  mainWin.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial';
  });

  mainWin.loadFile('index.html');
  // mainWin.webContents.openDevTools(); // uncomment for debugging
}

app.whenReady().then(() => {
  startWSServer();
  startUDP();       // start UDP bridge by default
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBridge();
  if (process.platform !== 'darwin') app.quit();
});
