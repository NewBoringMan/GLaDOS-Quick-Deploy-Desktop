'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Pushes and invoke replies can arrive in a different order from their creation.
// Share the same ordering gate across both renderers so a late reply cannot
// restore an old busy flag, login prompt, or account result. This cache belongs
// only to this preload lifetime and never writes account data.
let latestSnapshot;
function keepLatestSnapshot(snapshot) {
  const sequence = snapshot?.snapshotSequence;
  if (Number.isSafeInteger(sequence) && sequence > 0) {
    if (!latestSnapshot || sequence > latestSnapshot.snapshotSequence) latestSnapshot = snapshot;
    return latestSnapshot;
  }
  return latestSnapshot || snapshot;
}

contextBridge.exposeInMainWorld('quickDeploy', Object.freeze({
  getState: () => ipcRenderer.invoke('qd:state').then(keepLatestSnapshot),
  action: (name, payload = {}) => ipcRenderer.invoke('qd:action', name, payload).then(keepLatestSnapshot),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(keepLatestSnapshot(state));
    ipcRenderer.on('qd:state', listener);
    return () => ipcRenderer.removeListener('qd:state', listener);
  },
}));
