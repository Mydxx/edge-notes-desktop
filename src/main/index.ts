import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/api'
import type { DockPhase, DockSide, EdgeNotesSettings, EdgeNotesState, NoteStatus } from '../shared/api'
import { COLLAPSE_DELAY_DEFAULT, PANEL_WIDTH_DEFAULT, TRIGGER_WIDTH } from '../shared/constants'
import { EdgeDock } from './edge-dock'
import { log } from './log'
import { NotesStore } from './notes-store'
import { SettingsStore } from './settings-store'

// 明确应用名：userData 目录与单实例锁都基于它，避免与其它 Electron 应用互相覆盖数据/互相踢掉
app.setName('Edge Notes Desktop')

const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? ''

let mainWindow: BrowserWindow | null = null
let dock: EdgeDock | null = null
let store: SettingsStore | null = null
let notes: NotesStore | null = null

function currentPhase(): DockPhase {
  return dock?.getPhase() ?? 'collapsed'
}

function buildState(): EdgeNotesState {
  const settings: EdgeNotesSettings = store?.get() ?? {
    side: 'right',
    width: PANEL_WIDTH_DEFAULT,
    alwaysOnTop: true,
    pinnedOpen: false,
    collapseDelay: COLLAPSE_DELAY_DEFAULT
  }
  const phase = currentPhase()
  return {
    settings,
    runtime: {
      phase,
      expanded: phase === 'expanded' || phase === 'expanding',
      triggerWidth: TRIGGER_WIDTH,
      collapseDelayMs: settings.collapseDelay
    }
  }
}

function broadcast(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(IPC_CHANNELS.stateChanged, buildState())
}

function broadcastNoteStatus(status: NoteStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(IPC_CHANNELS.noteStatus, status)
}

function createWindow(): BrowserWindow {
  const settings = store?.get()
  const win = new BrowserWindow({
    title: 'Edge Notes',
    width: settings?.width ?? PANEL_WIDTH_DEFAULT,
    height: 640,
    show: false,
    frame: false,
    backgroundColor: '#12151c',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    alwaysOnTop: settings?.alwaysOnTop ?? true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.on('closed', () => {
    dock?.dispose()
    dock = null
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      log('blocked-navigation', { url })
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log('load-failed', { code, description, url })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log('render-process-gone', { reason: details.reason })
  })

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/renderer/index.html'))
  }

  return win
}

function requireSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('edge-notes: untrusted ipc sender')
  }
}

function applySettings(patch: Partial<EdgeNotesSettings>): EdgeNotesState {
  if (!store) {
    throw new Error('edge-notes: settings store not ready')
  }
  const next = store.update(patch)
  dock?.applySettings(next)
  const state = buildState()
  broadcast()
  return state
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.getState, (event) => {
    requireSender(event)
    return buildState()
  })

  ipcMain.handle(IPC_CHANNELS.setAlwaysOnTop, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'boolean') {
      throw new TypeError('alwaysOnTop must be a boolean')
    }
    return applySettings({ alwaysOnTop: value })
  })

  ipcMain.handle(IPC_CHANNELS.setPinnedOpen, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'boolean') {
      throw new TypeError('pinnedOpen must be a boolean')
    }
    return applySettings({ pinnedOpen: value })
  })

  ipcMain.handle(IPC_CHANNELS.setSide, (event, value: unknown) => {
    requireSender(event)
    if (value !== 'left' && value !== 'right') {
      throw new TypeError('side must be "left" or "right"')
    }
    return applySettings({ side: value satisfies DockSide })
  })

  ipcMain.handle(IPC_CHANNELS.setWidth, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('width must be a finite number')
    }
    return applySettings({ width: value })
  })

  ipcMain.handle(IPC_CHANNELS.setCollapseDelay, (event, value: unknown) => {
    requireSender(event)
    if (value !== 300 && value !== 700 && value !== 1200) {
      throw new TypeError('collapseDelay must be one of 300 / 700 / 1200')
    }
    return applySettings({ collapseDelay: value })
  })

  ipcMain.on(IPC_CHANNELS.setResizing, (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return
    }
    dock?.setResizing(value === true)
  })

  ipcMain.handle(IPC_CHANNELS.quit, (event) => {
    requireSender(event)
    app.quit()
  })

  // ---------------------------------------------------------------- 笔记读写

  ipcMain.handle(IPC_CHANNELS.noteGet, (event) => {
    requireSender(event)
    return notes ? notes.snapshot() : { content: '', savedAt: null, status: { state: 'idle', savedAt: null, message: null } }
  })

  ipcMain.on(IPC_CHANNELS.noteUpdate, (event, value: unknown) => {
    if (!notes || !mainWindow || event.sender !== mainWindow.webContents) {
      return
    }
    if (typeof value !== 'string') {
      log('note-update-rejected', { type: typeof value })
      return
    }
    notes.setContent(value)
  })

  ipcMain.handle(IPC_CHANNELS.noteSaveNow, async (event, value: unknown) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    if (typeof value !== 'string') {
      throw new TypeError('note content must be a string')
    }
    notes.setContent(value)
    return notes.writeNow()
  })

  ipcMain.handle(IPC_CHANNELS.noteRetry, async (event) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    return notes.writeNow()
  })

  ipcMain.on(IPC_CHANNELS.editorFocus, (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return
    }
    dock?.setEditorFocused(value === true)
  })
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null)

  store = new SettingsStore(app.getPath('userData'))

  notes = new NotesStore(app.getPath('userData'), (status) => {
    log('note-status', { state: status.state, savedAt: status.savedAt, message: status.message })
    broadcastNoteStatus(status)
  })
  await notes.load()

  log('app-ready', {
    userData: app.getPath('userData'),
    settingsFile: store.getPath(),
    noteFile: notes.getFilePath(),
    settings: store.get(),
    logFile: process.env.EDGE_NOTES_LOG ?? ''
  })

  mainWindow = createWindow()
  dock = new EdgeDock(mainWindow, store.get(), {
    onPhaseChange: (phase) => {
      log('phase-change', { phase })
      broadcast()
    }
  })
  registerIpc()

  mainWindow.once('ready-to-show', () => {
    dock?.start()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  log('second-instance-exit', {})
  app.quit()
} else {
  app.on('second-instance', () => {
    mainWindow?.show()
  })

  app.on('before-quit', () => {
    notes?.flushSync()
    store?.flush()
    dock?.dispose()
    log('before-quit', {})
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    log('bootstrap-failed', { error: String(error) })
    app.quit()
  })
}
