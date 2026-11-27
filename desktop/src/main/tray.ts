import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron'
import { DEFAULT_SHORTCUTS, shortcutAccelerator, shortcutName } from '@shared/shortcuts'
import type { HistoryEntry, Phase } from '@shared/types'
import { readRecentSavedDictations } from './archive'
import type { Coordinator } from './coordinator'
import type { DesktopWindow } from './desktop'
import { openFolder, paths } from './paths'

const titles: Record<Phase, string> = {
  preparing: 'Getting ready', ready: 'Ready when you are', requestingMicrophone: 'Allow microphone access',
  recording: 'Listening', transcribing: 'Transcribing', cleaning: 'Tidying your words', failed: 'Needs attention'
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

/** Menu bar control; the menu is rebuilt on every open so it always reflects live state. */
export class StatusMenu {
  private startedAt = Date.now()
  private tray: Tray
  private icons: Record<'idle' | 'busy' | 'alert' | 'recording', Electron.NativeImage>

  constructor(private model: Coordinator, private desktop: DesktopWindow) {
    const load = (name: string, template: boolean) => {
      const image = nativeImage.createFromPath(paths.tray(`${name}.png`))
      image.setTemplateImage(template)
      return image
    }
    this.icons = { idle: load('trayTemplate', true), busy: load('trayBusyTemplate', true), alert: load('trayAlertTemplate', true), recording: load('trayRecording', false) }
    this.tray = new Tray(this.icons.idle)
    this.tray.on('click', () => void this.open())
    this.tray.on('right-click', () => void this.open())
    this.update()
  }

  update(): void {
    const { phase } = this.model.state
    const icon = phase === 'recording' ? this.icons.recording : phase === 'failed' ? this.icons.alert
      : ['preparing', 'transcribing', 'cleaning'].includes(phase) ? this.icons.busy : this.icons.idle
    this.tray.setImage(icon)
    this.tray.setToolTip(`Dictait · ${titles[phase]} · ${shortcutName(this.model.stored.shortcuts?.dictate ?? DEFAULT_SHORTCUTS.dictate)}`)
  }

  private async open(): Promise<void> {
    this.model.refreshPermissions()
    const saved = this.model.state.history.length < 2 && this.model.stored.memoryMode === 'notes'
      ? await readRecentSavedDictations(this.startedAt) : []
    this.tray.popUpContextMenu(Menu.buildFromTemplate(this.items(saved)))
  }

  private items(saved: HistoryEntry[]): MenuItemConstructorOptions[] {
    const model = this.model, state = model.state, settings = model.stored
    const editable = ['ready', 'failed'].includes(state.phase)
    const set = (patch: Parameters<Coordinator['setSettings']>[0]) => () => model.setSettings(patch)
    const shortcuts = settings.shortcuts ?? DEFAULT_SHORTCUTS
    // Shown in the menu only; the helper owns the real shortcuts. A lone modifier has no menu form.
    const accelerator = (value: string | null) => value ? { accelerator: value, registerAccelerator: false } : {}
    const items: MenuItemConstructorOptions[] = [
      { label: titles[state.phase], enabled: false },
      { label: clip(state.message, 90), enabled: false }
    ]
    if (state.notice) items.push({ label: clip(state.notice, 140), enabled: false })
    const recent = [...state.history, ...(settings.memoryMode === 'notes' ? saved : [])]
      .filter((entry) => entry.text.trim()).slice(0, 2)
    if (recent.length) {
      items.push({ type: 'separator' }, ...recent.map((entry) => ({
        label: `Copy “${clip(entry.text.replace(/\s+/g, ' ').trim(), 60)}”`,
        click: () => void model.copyText(entry.text).then(
          () => model.notify('Dictation copied', 'Press ⌘V to paste.'),
          () => model.notify('Could not copy dictation', 'Try again from the menu bar.')
        )
      })))
    }
    items.push(
      { type: 'separator' },
      { label: 'Open Dictait', click: () => this.desktop.show() },
      { label: 'Settings…', click: () => this.desktop.show('settings') },
      { label: 'Practice dictation…', click: () => this.desktop.show('practice') },
      {
        label: state.phase === 'recording' ? 'Finish dictation' : 'Start dictation', ...accelerator(shortcutAccelerator(shortcuts.dictate)),
        enabled: ['ready', 'recording'].includes(state.phase), click: () => model.toggleRecording()
      }
    )
    if (state.phase === 'recording') items.push({ label: 'Cancel recording', click: () => model.cancelRecording() })
    if (state.recovered?.length) {
      items.push({ label: 'Retry last failed dictation', ...accelerator(shortcutAccelerator(shortcuts.retryLast)),
        enabled: editable, click: () => void model.retryFromShortcut() })
    }
    if (state.phase === 'failed') items.push({ label: 'Retry models', click: () => model.reloadModels() })
    if (!state.microphoneAllowed) items.push({ label: 'Allow microphone…', click: () => model.requestMicrophone() })
    if (settings.autoPaste && !state.accessibilityAllowed) items.push({ label: 'Allow automatic paste…', click: () => model.requestAccessibility() })
    if (!state.shortcutRegistered || !state.correctionShortcutRegistered) items.push({ label: 'Retry keyboard shortcuts', click: () => void model.registerShortcut() })
    if (state.history.length) {
      const canPaste = state.phase === 'ready'
      items.push(
        { label: 'Paste last dictation', ...accelerator(shortcutAccelerator(shortcuts.pasteLast)), enabled: canPaste, click: () => void model.pasteLast() },
        {
          label: 'Recent dictations', enabled: canPaste, submenu: state.history.map((entry, index) => ({
            label: entry.text.replace(/\s+/g, ' ').slice(0, 60) + (entry.text.length > 60 ? '…' : ''),
            sublabel: [new Date(entry.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), entry.app].filter(Boolean).join(' · '),
            enabled: canPaste,
            click: () => void model.pasteLast(index)
          }))
        }
      )
    }
    items.push(
      { type: 'separator' },
      { label: 'Automatic paste', type: 'checkbox', checked: settings.autoPaste, click: set({ autoPaste: !settings.autoPaste }) },
      { label: 'Grammar cleanup', type: 'checkbox', enabled: editable, checked: settings.cleanup, click: set({ cleanup: !settings.cleanup }) },
      { label: 'Launch at login', type: 'checkbox', checked: state.launchAtLogin, click: () => model.setLaunchAtLogin(!state.launchAtLogin) }
    )
    if (state.loginNeedsApproval) items.push({ label: 'Approve in Login Items…', click: () => void shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension') })
    items.push(
      {
        label: 'Speech recognition', submenu: [
          { label: 'Whisper Turbo', type: 'radio', enabled: editable, checked: settings.backend === 'whisper', click: set({ backend: 'whisper' }) },
          { label: 'Parakeet · English / European languages', type: 'radio', enabled: editable, checked: settings.backend === 'parakeet', click: set({ backend: 'parakeet' }) }
        ]
      },
      {
        label: 'Language', submenu: [
          { label: 'Detect automatically', type: 'radio', checked: settings.language === 'auto', click: set({ language: 'auto' }) },
          { label: 'English · skip detection', type: 'radio', checked: settings.language === 'en', click: set({ language: 'en' }) },
          { label: 'Hindi', type: 'radio', enabled: settings.backend === 'whisper', checked: settings.language === 'hi', click: set({ language: 'hi' }) }
        ]
      },
      { type: 'separator' },
      {
        label: `Local memory · ${state.rememberedTerms} terms`, submenu: [
          { label: 'Remember terms and connections', type: 'radio', checked: settings.memoryMode === 'terms', click: set({ memoryMode: 'terms' }) },
          { label: 'Save linked notes too', type: 'radio', checked: settings.memoryMode === 'notes', click: set({ memoryMode: 'notes' }) },
          { label: 'Memory off', type: 'radio', checked: settings.memoryMode === 'off', click: set({ memoryMode: 'off' }) },
          { type: 'separator' },
          { label: 'Personal vocabulary…', click: () => this.desktop.show('vocabulary') },
          {
            label: 'Review correction from clipboard…', enabled: Boolean(state.transcript) && state.phase === 'ready',
            click: () => void model.learnCorrectionFromClipboard().then((feedback) => {
              if (!feedback.startsWith('Review')) model.notify('Nothing to review', feedback)
            })
          },
          { label: 'Remember saved corrections', type: 'checkbox', checked: settings.learnCorrections, click: set({ learnCorrections: !settings.learnCorrections }) },
          { label: 'Open memory folder', click: () => openFolder('memory') },
          { label: 'Open linked notes folder', click: () => openFolder('notes') },
          { label: 'Open graph', click: () => this.desktop.show('graph') }
        ]
      }
    )
    items.push({ type: 'separator' }, { label: 'Quit Dictait', click: () => app.quit() })
    return items
  }
}
