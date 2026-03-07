#!/usr/bin/env node
/**
 * mavlink-bridge.js — UDP ↔ WebSocket bridge for ExpressLRS / WiFi backpacks.
 *
 * The ExpressLRS backpack sends MAVLink as raw UDP packets.  Browsers can't
 * receive raw UDP, so this bridge sits in between:
 *
 *   Backpack (UDP :14550) ──► this bridge ──► browser (ws://localhost:5760)
 *   Browser  (ws://localhost:5760)  ──► this bridge ──► Backpack (UDP :14555)
 *
 * Usage:
 *   node mavlink-bridge.js
 *
 * Optional env overrides:
 *   BACKPACK_IP   default 10.0.0.1   (backpack address — join its WiFi AP first)
 *   UDP_RECV      default 14550       (port backpack sends MAVLink on)
 *   UDP_SEND      default 14555       (port backpack listens for uplink)
 *   WS_PORT       default 5760        (WebSocket port the browser connects to)
 */

'use strict';

const dgram = require('dgram');
const http  = require('http');
const { WebSocketServer } = require('ws');

const BACKPACK_IP = process.env.BACKPACK_IP ?? '10.0.0.1';
const UDP_RECV    = Number(process.env.UDP_RECV  ?? 14550);
const UDP_SEND    = Number(process.env.UDP_SEND  ?? 14555);
const WS_PORT     = Number(process.env.WS_PORT   ?? 5760);

// ── UDP socket (receives MAVLink from the backpack) ───────────────────────────
const udp = dgram.createSocket('udp4');
const clients = new Set();

let udpPackets = 0;

udp.on('message', (msg, rinfo) => {
  if (rinfo.address !== BACKPACK_IP) return; // ignore packets from other sources
  udpPackets++;
  if (udpPackets === 1) {
    console.log(`[udp ] First packet received from ${rinfo.address}:${rinfo.port} (${msg.length} bytes) ✓`);
  }
  if (udpPackets % 100 === 0) {
    console.log(`[udp ] ${udpPackets} packets received · ${clients.size} browser(s) connected`);
  }
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

udp.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[udp ] FATAL: Port ${UDP_RECV} is already in use.`);
    console.error(`[udp ] Another app (Mission Planner, QGroundControl, or a second bridge) is holding it.`);
    console.error(`[udp ] Fix on Windows:  netstat -ano | findstr :${UDP_RECV}  then  taskkill /PID <pid> /F`);
    console.error(`[udp ] Fix on Linux:    fuser -k ${UDP_RECV}/udp`);
    console.error(`[udp ] Or override:     UDP_RECV=14551 node mavlink-bridge.js\n`);
    process.exit(1);
  }
  console.error('[udp ]', e.message);
});

udp.bind(UDP_RECV, () =>
  console.log(`[udp ] Listening for MAVLink on :${UDP_RECV}`)
);

// ── WebSocket server (browser connects here) ──────────────────────────────────
const server = http.createServer();
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[ws  ] Browser connected (${req.socket.remoteAddress})`);

  ws.on('message', (data) => {
    // Forward browser → backpack uplink port
    udp.send(data, UDP_SEND, BACKPACK_IP, (e) => {
      if (e) console.error('[udp↑]', e.message);
    });
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[ws  ] Browser disconnected');
  });

  ws.on('error', (e) => {
    clients.delete(ws);
    console.error('[ws  ]', e.message);
  });
});

server.listen(WS_PORT, '127.0.0.1', () => {
  console.log(`[ws  ] Listening on ws://localhost:${WS_PORT}`);
  console.log(`[    ] Backpack target : ${BACKPACK_IP}  send→:${UDP_SEND}  recv←:${UDP_RECV}`);
  console.log(`[    ] In the app      : WiFi Backpack mode → ws://localhost:${WS_PORT}`);
  console.log('[    ] Press Ctrl+C to stop.');
});
