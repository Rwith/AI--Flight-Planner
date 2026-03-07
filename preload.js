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
});
