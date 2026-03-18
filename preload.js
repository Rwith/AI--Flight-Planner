'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  // WiFi bridge control
  startBridge: (opts) => ipcRenderer.send('bridge-start', opts),
  stopBridge:  ()     => ipcRenderer.send('bridge-stop'),
  WS_PORT: 5761,

  // Native serial via Node.js serialport (main process) ─────────────────────
  serial: {
    list:   ()           => ipcRenderer.invoke('serial-list'),
    open:   (path, baud) => ipcRenderer.invoke('serial-open', path, baud),
    close:  ()           => ipcRenderer.invoke('serial-close'),
    write:  (bytes)      => ipcRenderer.send('serial-write', bytes),

    onData:  (cb) => ipcRenderer.on('serial-data',   (_, b) => cb(new Uint8Array(b))),
    onClose: (cb) => ipcRenderer.on('serial-closed',  ()    => cb()),
    onError: (cb) => ipcRenderer.on('serial-error',   (_, m) => cb(m)),

    // Call before each new connection to avoid stacking listeners.
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
  // ESP32 display update — sends position + waypoints to the display WS server.
  sendDisplayUpdate: (data) => ipcRenderer.send('display-update', data),
  // Re-focus the Chromium renderer after native dialogs steal focus (Electron quirk).
  focusWindow: () => ipcRenderer.send('focus-window'),
  blurWindow:  () => ipcRenderer.send('blur-window'),
  // Tile cache file storage
  tiles: {
    getPath:    ()                            => ipcRenderer.invoke('get-tiles-path'),
    openFolder: ()                            => ipcRenderer.invoke('open-tiles-folder'),
    saveFile:   (regionName, layerKey, z, x, y, buf) => ipcRenderer.invoke('save-tile-file', regionName, layerKey, z, x, y, buf),
  },
  // Video recording / snapshot save to dated folders
  video: {
    saveRecording: (dateStr, timeStr, buf) => ipcRenderer.invoke('save-recording', dateStr, timeStr, buf),
    saveSnapshot:  (dateStr, timeStr, buf) => ipcRenderer.invoke('save-snapshot',  dateStr, timeStr, buf),
    openFolder:    ()                      => ipcRenderer.invoke('open-recordings-folder'),
  },
});
