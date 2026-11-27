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
  setShortcut: (action, shortcut) => ipcRenderer.invoke('shortcut:set', action, shortcut),
  captureShortcut: (active) => ipcRenderer.send('shortcut:capture', active),
  requestMicrophone: () => ipcRenderer.send('permission:microphone'),
  requestAccessibility: () => ipcRenderer.send('permission:accessibility'),
  reloadModels: () => ipcRenderer.send('models:reload'),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  learnCorrection: () => ipcRenderer.invoke('correction:learn'),
  previewCorrection: () => ipcRenderer.invoke('correction:preview'),
  saveCorrection: (draft) => ipcRenderer.invoke('correction:save', draft),
  dismissCorrection: () => ipcRenderer.send('correction:dismiss'),
  startMicTest: () => ipcRenderer.invoke('microphone:test'),
  stopMicTest: () => ipcRenderer.send('microphone:stop-test'),
  addWord: (word, alias, replaceId) => ipcRenderer.invoke('vocabulary:add', word, alias, replaceId),
  removeWord: (id) => ipcRenderer.invoke('vocabulary:remove', id),
  restoreWord: (entry, index) => ipcRenderer.invoke('vocabulary:restore', entry, index),
  openFolder: (which) => ipcRenderer.send('folder:open', which),
  microphones: () => ipcRenderer.invoke('microphones:list'),
  suggestions: () => ipcRenderer.invoke('vocabulary:suggestions'),
  dismissSuggestion: (word) => ipcRenderer.invoke('vocabulary:dismiss', word),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onHud: (callback) => {
    const off = subscribe('hud', callback)
    ipcRenderer.send('hud:ready')
    return off
  },
  hudHidden: () => ipcRenderer.send('hud:hidden'),
  onRecorder: (callback) => {
    const listener = (_event: IpcRendererEvent, command: Parameters<typeof callback>[0], options?: Parameters<typeof callback>[1]) => callback(command, options)
    ipcRenderer.on('recorder', listener)
    return () => { ipcRenderer.removeListener('recorder', listener) }
  },
  recorderStarted: (device, requestId) => ipcRenderer.send('recorder:started', device, requestId),
  recorderFailed: (message, requestId) => ipcRenderer.send('recorder:failed', message, requestId),
  recorderData: (audio, requestId) => ipcRenderer.send('recorder:data', audio, requestId),
  recorderPiece: (audio, index) => ipcRenderer.send('recorder:piece', audio, index),
  recorderEnded: () => ipcRenderer.send('recorder:ended'),
  recorderLevel: (level) => ipcRenderer.send('recorder:level', level)
}

contextBridge.exposeInMainWorld('dictait', api)
