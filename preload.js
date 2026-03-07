'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the renderer — no direct Node.js access.
contextBridge.exposeInMainWorld('electronBridge', {
  startBridge:  (opts) => ipcRenderer.send('bridge-start', opts),
  stopBridge:   ()     => ipcRenderer.send('bridge-stop'),
  WS_PORT: 5761,

  // Serial port picker: main → renderer (port list), renderer → main (choice).
  onSerialPortSelect:  (cb) => ipcRenderer.on('serial-select-port', (_, ports) => cb(ports)),
  confirmSerialPort:   (portId) => ipcRenderer.send('serial-port-chosen', portId),
});
