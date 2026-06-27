const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe set of APIs to the renderer process
contextBridge.exposeInMainWorld('api', {
  toggleOverlay: (show) => ipcRenderer.invoke('toggle-overlay', show),
  togglePedalsCoach: (show) => ipcRenderer.invoke('toggle-pedals-coach', show),
  toggleLineCoach: (show) => ipcRenderer.invoke('toggle-line-coach', show),
  setOverlayLock: (lock) => ipcRenderer.invoke('set-overlay-lock', lock),
  openFileDialog: (filters) => ipcRenderer.invoke('open-file-dialog', filters),
  getDocumentsPath: () => ipcRenderer.invoke('get-documents-path')
});
