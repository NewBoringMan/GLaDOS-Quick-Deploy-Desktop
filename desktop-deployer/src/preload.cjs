'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickDeploy', Object.freeze({
  getState: () => ipcRenderer.invoke('qd:state'),
  action: (name, payload = {}) => ipcRenderer.invoke('qd:action', name, payload),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('qd:state', listener);
    return () => ipcRenderer.removeListener('qd:state', listener);
  },
}));
