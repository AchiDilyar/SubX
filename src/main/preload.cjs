const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('subx', {
  hasInsetWindowControls: process.platform === 'darwin',
  updateMenu: groups => ipcRenderer.send('menu:update', groups),
  onMenuCommand: callback => ipcRenderer.on('menu:command', (_event, id) => callback(id)),
  onOpenPath: callback => {
    const listener = (_event, path) => callback(path)
    ipcRenderer.on('app:open-path', listener)
    return () => ipcRenderer.removeListener('app:open-path', listener)
  },
  getVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),
  onCloseRequest: callback => {
    const listener = (_event, detail) => callback(detail)
    ipcRenderer.on('app:request-close', listener)
    return () => ipcRenderer.removeListener('app:request-close', listener)
  },
  allowClose: () => ipcRenderer.send('app:allow-close'),
  cancelClose: () => ipcRenderer.send('app:cancel-close'),
  cancelWaveform: () => ipcRenderer.invoke('media:cancel-waveform'),
  frameTimes: token => ipcRenderer.invoke('media:frame-times', token),
  waveform: (token, duration) => ipcRenderer.invoke('media:waveform', token, duration),
  chooseMedia: () => ipcRenderer.invoke('media:choose'),
  finishMediaSelection: (token, accepted) => ipcRenderer.invoke('media:finish-selection', token, accepted),
  installedFonts: () => ipcRenderer.invoke('fonts:installed'),
  chooseSubtitles: () => ipcRenderer.invoke('subtitles:choose'),
  chooseWatermark: () => ipcRenderer.invoke('watermark:choose'),
  readWatermark: file => ipcRenderer.invoke('watermark:read', file),
  chooseScript: () => ipcRenderer.invoke('script:choose'),
  openProject: recent => ipcRenderer.invoke('project:open', recent),
  openProjectPath: file => ipcRenderer.invoke('project:open-path', file),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  saveProject: (project, documentId, saveAs, id) => ipcRenderer.invoke('project:save', project, documentId, saveAs, id),
  finishProjectSave: id => ipcRenderer.invoke('project:save-finished', id),
  autosaveInfo: () => ipcRenderer.invoke('autosave:info'),
  autosaveRestore: () => ipcRenderer.invoke('autosave:restore'),
  autosaveWrite: data => ipcRenderer.invoke('autosave:write', data),
  autosaveClear: () => ipcRenderer.invoke('autosave:clear'),
  exportSubtitles: data => ipcRenderer.invoke('subtitles:export', data),
  exportSubtitlesBatch: data => ipcRenderer.invoke('subtitles:export-batch', data),
  composeVideo: options => ipcRenderer.invoke('video:compose', options),
  cancelCompose: () => ipcRenderer.invoke('video:cancel'),
  onComposeProgress: callback => {
    const listener = (_event, seconds) => callback(seconds)
    ipcRenderer.on('video:progress', listener)
    return () => ipcRenderer.removeListener('video:progress', listener)
  },
})
