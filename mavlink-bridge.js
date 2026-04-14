#!/usr/bin/env node
/**
 * mavlink-bridge.js — UDP / TCP ↔ WebSocket bridge for WiFi backpacks / FC.
 *
 * Browsers can't open raw UDP or TCP sockets, so this bridge sits between
 * the flight controller / backpack and the browser:
 *
 *   FC/Backpack ──(UDP or TCP)──► this bridge ──(WebSocket)──► browser
 *   browser ──(WebSocket)──► this bridge ──(UDP or TCP)──► FC/Backpack
 *
 * Usage:
 *   node mavlink-bridge.js              (UDP mode, default)
 *   MODE=tcp node mavlink-bridge.js     (TCP client mode)
 *
 * Optional env overrides:
 *   MODE          udp | tcp             default: udp
 *   BACKPACK_IP   default 10.0.0.1
 *   UDP_RECV      default 14550         (UDP: port backpack sends on)
 *   UDP_SEND      default 14555         (UDP: port backpack listens on)
 *   TCP_PORT      default 5760          (TCP: port FC/backpack listens on)
 *   WS_PORT       default 5760          (WebSocket port browser connects to)
 */

'use strict';

const dgram = require('dgram');
const net   = require('net');
const http  = require('http');
const { WebSocketServer } = require('ws');

const MODE        = (process.env.MODE        ?? 'udp').toLowerCase();
const BACKPACK_IP = process.env.BACKPACK_IP  ?? '10.0.0.1';
const UDP_RECV    = Number(process.env.UDP_RECV  ?? 14550);
const UDP_SEND    = Number(process.env.UDP_SEND  ?? 14555);
const TCP_PORT    = Number(process.env.TCP_PORT  ?? 5760);
const WS_PORT     = Number(process.env.WS_PORT   ?? 5760);

const clients = new Set(); // connected WebSocket browsers
let   fcSend  = null;      // function(buf) → sends data to FC

// ── UDP mode ──────────────────────────────────────────────────────────────────
function startUDP () {
  const udp = dgram.createSocket('udp4');
  let packets = 0;

  udp.on('message', (msg, rinfo) => {
    if (rinfo.address !== BACKPACK_IP) return;
    packets++;
    if (packets === 1)        console.log(`[udp ] First packet from ${rinfo.address}:${rinfo.port} (${msg.length} B) ✓`);
    if (packets % 100 === 0)  console.log(`[udp ] ${packets} packets · ${clients.size} browser(s)`);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  });

  udp.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n[udp ] FATAL: Port ${UDP_RECV} already in use.`);
      console.error(`[udp ] Windows: netstat -ano | findstr :${UDP_RECV}  then  taskkill /PID <pid> /F`);
      console.error(`[udp ] Linux:   fuser -k ${UDP_RECV}/udp`);
      console.error(`[udp ] Or:      UDP_RECV=14551 node mavlink-bridge.js\n`);
      process.exit(1);
    }
    console.error('[udp ]', e.message);
  });

  udp.bind(UDP_RECV, () =>
    console.log(`[udp ] Listening for MAVLink on :${UDP_RECV}`)
  );

  process.on('SIGINT',  () => { try { udp.close(); } catch(_){} process.exit(0); });
  process.on('SIGTERM', () => { try { udp.close(); } catch(_){} process.exit(0); });

  fcSend = (buf) => udp.send(buf, UDP_SEND, BACKPACK_IP, (e) => {
    if (e) console.error('[udp↑]', e.message);
  });
}

// ── TCP client mode ───────────────────────────────────────────────────────────
function startTCP () {
  let socket = null;
  let packets = 0;

  function connect () {
    console.log(`[tcp ] Connecting to ${BACKPACK_IP}:${TCP_PORT} …`);
    socket = net.createConnection({ host: BACKPACK_IP, port: TCP_PORT });

    socket.on('connect', () =>
      console.log(`[tcp ] Connected to ${BACKPACK_IP}:${TCP_PORT} ✓`)
    );

    socket.on('data', (buf) => {
      packets++;
      if (packets === 1)        console.log(`[tcp ] First data received (${buf.length} B) ✓`);
      if (packets % 100 === 0)  console.log(`[tcp ] ${packets} packets · ${clients.size} browser(s)`);
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(buf);
    });

    socket.on('close', () => {
      console.log('[tcp ] Connection closed — retrying in 3 s …');
      socket.destroy(); socket = null;
      fcSend = null;
      setTimeout(connect, 3000);
    });

    socket.on('error', (e) =>
      console.error('[tcp ]', e.message)
    );

    fcSend = (buf) => {
      if (socket?.writable) socket.write(buf);
    };
  }

  connect();
}

// ── WebSocket server (browser connects here) ──────────────────────────────────
const server = http.createServer();
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[ws  ] Browser connected (${req.socket.remoteAddress})`);

  ws.on('message', (data) => {
    try { fcSend?.(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch(e) { console.error('[ws↑]', e.message); }
  });

  ws.on('close', () => { clients.delete(ws); console.log('[ws  ] Browser disconnected'); });
  ws.on('error', (e) => { clients.delete(ws); console.error('[ws  ]', e.message); });
});

server.listen(WS_PORT, '127.0.0.1', () => {
  console.log(`[ws  ] Listening on ws://localhost:${WS_PORT}`);
  if (MODE === 'tcp') {
    console.log(`[    ] Mode: TCP client → ${BACKPACK_IP}:${TCP_PORT}`);
    console.log(`[    ] Override port:  TCP_PORT=14550 node mavlink-bridge.js`);
  } else {
    console.log(`[    ] Mode: UDP  recv←:${UDP_RECV}  send→:${UDP_SEND}  target:${BACKPACK_IP}`);
    console.log(`[    ] Switch to TCP:  MODE=tcp node mavlink-bridge.js`);
  }
  console.log(`[    ] In the app: WiFi + Bridge → ws://localhost:${WS_PORT}`);
  console.log('[    ] Press Ctrl+C to stop.');
});

// ── Start the chosen transport ─────────────────────────────────────────────────
if (MODE === 'tcp') {
  startTCP();
} else {
  if (MODE !== 'udp') console.warn(`[    ] Unknown MODE="${MODE}", defaulting to UDP`);
  startUDP();
}
