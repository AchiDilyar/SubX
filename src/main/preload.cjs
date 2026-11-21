const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('subx', {
  hasInsetWindowControls: process.platform === 'darwin',
  updateMenu: groups => ipcRenderer.send('menu:update', groups),
  onMenuCommand: callback => ipcRenderer.on('menu:command', (_event, id) => callback(id)),
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
  chooseSubtitles: () => ipcRenderer.invoke('subtitles:choose'),
  chooseScript: () => ipcRenderer.invoke('script:choose'),
  openProject: recent => ipcRenderer.invoke('project:open', recent),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  saveProject: (project, documentId, saveAs, id) => ipcRenderer.invoke('project:save', project, documentId, saveAs, id),
  finishProjectSave: id => ipcRenderer.invoke('project:save-finished', id),
  exportSubtitles: data => ipcRenderer.invoke('subtitles:export', data),
  composeVideo: options => ipcRenderer.invoke('video:compose', options),
  cancelCompose: () => ipcRenderer.invoke('video:cancel'),
  onComposeProgress: callback => {
    const listener = (_event, seconds) => callback(seconds)
    ipcRenderer.on('video:progress', listener)
    return () => ipcRenderer.removeListener('video:progress', listener)
  },
})
