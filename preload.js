'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Clamp slot to a known-valid range so the renderer cannot send arbitrary slot values.
const safeSlot = (s) => (Number.isInteger(s) && s >= 0 && s <= 9) ? s : 0;

contextBridge.exposeInMainWorld('electronBridge', {
  // App version
  getVersion: () => ipcRenderer.invoke('get-app-version'),

  // WiFi bridge control — slot 0 (legacy) and multi-slot
  startBridge: (slot, opts) => {
    // Support both startBridge(opts) and startBridge(slot, opts) call signatures
    if (typeof slot === 'object') { opts = slot; slot = 0; }
    ipcRenderer.send('bridge-start', { ...opts, slot: safeSlot(slot) });
  },
  stopBridge: (slot) => ipcRenderer.send('bridge-stop', safeSlot(slot)),
  initSlot:        (slot) => ipcRenderer.invoke('slot-init', safeSlot(slot)),
  wsPort:          (slot) => 5770 + (slot ?? 0),
  onBridgeAdapter: (cb)   => ipcRenderer.on('bridge-adapter', (_, slot, name, addr) => cb(slot, name, addr)),

  // Native serial via Node.js serialport — slot-aware ──────────────────────
  serial: {
    list:  ()                    => ipcRenderer.invoke('serial-list'),
    open:  (path, baud, slot)    => ipcRenderer.invoke('serial-open', path, baud, safeSlot(slot)),
    close: (slot)                => ipcRenderer.invoke('serial-close', safeSlot(slot)),
    write: (bytes, slot)         => ipcRenderer.send('serial-write', bytes, safeSlot(slot)),

    // Callbacks receive (data, slot) — one global listener routes all slots
    onData:  (cb) => { ipcRenderer.removeAllListeners('serial-data');
                       ipcRenderer.on('serial-data',   (_, b, s) => cb(new Uint8Array(b), s ?? 0)); },
    onClose: (cb) => { ipcRenderer.removeAllListeners('serial-closed');
                       ipcRenderer.on('serial-closed',  (_, s)   => cb(s ?? 0)); },
    onError: (cb) => { ipcRenderer.removeAllListeners('serial-error');
                       ipcRenderer.on('serial-error',   (_, m, s) => cb(m, s ?? 0)); },

    removeListeners: () => {
      ipcRenderer.removeAllListeners('serial-data');
      ipcRenderer.removeAllListeners('serial-closed');
      ipcRenderer.removeAllListeners('serial-error');
    },
  },

  // App settings ─────────────────────────────────────────────────────────────
  settings: {
    get:           ()       => ipcRenderer.invoke('get-settings'),
    save:          (data)   => ipcRenderer.invoke('save-settings', data),
    setWindowMode: (mode)   => ipcRenderer.invoke('set-window-mode', mode),
  },

  // ESP32 display update
  sendDisplayUpdate: (data) => ipcRenderer.send('display-update', data),

  // External HDMI display window
  openDisplayWindow:  ()      => ipcRenderer.invoke('open-display-window'),
  sendToDisplay:      (data)  => ipcRenderer.send('display-relay', data),
  onDisplayData:      (cb)    => ipcRenderer.on('display-data', (_, data) => cb(data)),

  // Re-focus after native dialogs
  focusWindow: () => ipcRenderer.send('focus-window'),
  blurWindow:  () => ipcRenderer.send('blur-window'),

  // Tile cache file storage
  tiles: {
    getPath:    ()                                     => ipcRenderer.invoke('get-tiles-path'),
    openFolder: ()                                     => ipcRenderer.invoke('open-tiles-folder'),
    saveFile:   (regionName, layerKey, z, x, y, buf)  => ipcRenderer.invoke('save-tile-file', regionName, layerKey, z, x, y, buf),
  },

  // Video recording / snapshot save
  video: {
    saveRecording: (dateStr, timeStr, buf) => ipcRenderer.invoke('save-recording', dateStr, timeStr, buf),
    saveSnapshot:  (dateStr, timeStr, buf) => ipcRenderer.invoke('save-snapshot',  dateStr, timeStr, buf),
    openFolder:    ()                      => ipcRenderer.invoke('open-recordings-folder'),
  },
});
