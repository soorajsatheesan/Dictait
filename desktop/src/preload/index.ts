import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DictaitAPI } from '@shared/types'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: DictaitAPI = {
  preview: process.argv.includes('--dictait-preview'),
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => subscribe('state', callback),
  onLevel: (callback) => subscribe('level', callback),
  onArchiveChanged: (callback) => subscribe('archive:changed', () => callback()),
  onNavigate: (callback) => subscribe('navigate', callback),
  readArchive: () => ipcRenderer.invoke('archive:read'),
  toggleRecording: () => ipcRenderer.send('recording:toggle'),
  cancelRecording: () => ipcRenderer.send('recording:cancel'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('login:set', enabled),
  openLoginItems: () => ipcRenderer.send('login:open'),
  retryShortcut: () => ipcRenderer.send('shortcut:retry'),
  requestMicrophone: () => ipcRenderer.send('permission:microphone'),
  requestAccessibility: () => ipcRenderer.send('permission:accessibility'),
  reloadModels: () => ipcRenderer.send('models:reload'),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  learnCorrection: () => ipcRenderer.invoke('correction:learn'),
  addWord: (word, alias) => ipcRenderer.invoke('vocabulary:add', word, alias),
  removeWord: (id) => ipcRenderer.invoke('vocabulary:remove', id),
  restoreWord: (entry, index) => ipcRenderer.invoke('vocabulary:restore', entry, index),
  openFolder: (which) => ipcRenderer.send('folder:open', which),
  microphones: () => ipcRenderer.invoke('microphones:list'),
  suggestions: () => ipcRenderer.invoke('vocabulary:suggestions'),
  dismissSuggestion: (word) => ipcRenderer.invoke('vocabulary:dismiss', word),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onHud: (callback) => subscribe('hud', callback),
  hudHidden: () => ipcRenderer.send('hud:hidden'),
  onRecorder: (callback) => {
    const listener = (_event: IpcRendererEvent, command: Parameters<typeof callback>[0], options?: Parameters<typeof callback>[1]) => callback(command, options)
    ipcRenderer.on('recorder', listener)
    return () => { ipcRenderer.removeListener('recorder', listener) }
  },
  recorderStarted: () => ipcRenderer.send('recorder:started'),
  recorderFailed: (message) => ipcRenderer.send('recorder:failed', message),
  recorderData: (audio) => ipcRenderer.send('recorder:data', audio),
  recorderPiece: (audio, index) => ipcRenderer.send('recorder:piece', audio, index),
  recorderEnded: () => ipcRenderer.send('recorder:ended'),
  recorderLevel: (level) => ipcRenderer.send('recorder:level', level)
}

contextBridge.exposeInMainWorld('dictait', api)
