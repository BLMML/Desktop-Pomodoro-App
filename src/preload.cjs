'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  command: (name, payload) => ipcRenderer.invoke('command', name, payload),
  onUpdate: callback => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('snapshot', handler);
    return () => ipcRenderer.removeListener('snapshot', handler);
  },
  onEvent: callback => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('app-event', handler);
    return () => ipcRenderer.removeListener('app-event', handler);
  }
});
