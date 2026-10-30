import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, protocol, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/api'
import type {
  DockPhase,
  DockSide,
  EdgeNotesSettings,
  EdgeNotesState,
  NotesFilesInfo,
  NotesIndexState,
  NoteStatus
} from '../shared/api'
import { COLLAPSE_DELAY_DEFAULT, PANEL_WIDTH_DEFAULT, TRIGGER_WIDTH } from '../shared/constants'
import {
  attachmentsDir,
  attachmentExists,
  listAttachments,
  mimeForAttachment,
  resolveAttachmentUrl,
  saveAttachment,
  trashAttachments
} from './attachments'
import { getDataDirInfo, migrateDataDir, resolveUserDataDir } from './data-location'
import { EdgeDock } from './edge-dock'
import { closeImageViewer, isImageViewerOpen, openImageViewer } from './image-viewer'
import { applyLoginItem, readLoginItem, reconcileLoginItem, removeLegacyRunEntry } from './login-item'
import { log } from './log'
import { NotesStore } from './notes-store'
import { SettingsStore } from './settings-store'
import { createTray, destroyTray, refreshTray } from './tray'
import type { TrayHandlers } from './tray'

// 明确应用名：userData 目录与单实例锁都基于它，避免与其它 Electron 应用互相覆盖数据/互相踢掉
app.setName('Edge Notes Desktop')

// 必须在 app ready 之前决定数据目录（用户可能已经把它挪到别的盘）
resolveUserDataDir()

/**
 * 笔记里的图片走自定义协议，而不是 file://：
 * file 协议会把整个磁盘暴露给渲染层，这里只允许读附件目录下的单层文件。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'edgenote-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? ''

let mainWindow: BrowserWindow | null = null
let dock: EdgeDock | null = null
let store: SettingsStore | null = null
let notes: NotesStore | null = null
/** 是否正在真正退出：用于区分"关窗口"与"退出应用" */
let quitting = false
/** 全局唤出快捷键；被别的程序占用时为 null */
let wakeShortcut: string | null = null
/** 候选快捷键：第一个注册成功的生效 */
const WAKE_ACCELERATORS = ['Control+Alt+N', 'Control+Alt+E']

function currentPhase(): DockPhase {
  return dock?.getPhase() ?? 'collapsed'
}

function buildState(): EdgeNotesState {
  const settings: EdgeNotesSettings = store?.get() ?? {
    side: 'right',
    width: PANEL_WIDTH_DEFAULT,
    alwaysOnTop: true,
    pinnedOpen: false,
    collapseDelay: COLLAPSE_DELAY_DEFAULT,
    launchAtLogin: false,
    theme: 'light',
    fontSize: 'normal',
    viewMode: 'edit',
    navCollapsed: false
  }
  const phase = currentPhase()
  return {
    settings,
    runtime: {
      phase,
      expanded: phase === 'expanded' || phase === 'expanding',
      hidden: dock?.isHidden() ?? false,
      triggerWidth: TRIGGER_WIDTH,
      collapseDelayMs: settings.collapseDelay,
      wakeShortcut
    }
  }
}

function broadcastNotesIndex(index: NotesIndexState): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(IPC_CHANNELS.notesIndexChanged, index)
}

function broadcast(): void {
  if (!trayHandlers) {
    return
  }
  refreshTray(trayHandlers)
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(IPC_CHANNELS.stateChanged, buildState())
}

/** 托盘菜单与窗口共用同一套动作，避免两处逻辑分叉 */
let trayHandlers: TrayHandlers | null = null

function toggleHidden(): void {
  if (!dock) {
    return
  }
  dock.setHidden(!dock.isHidden())
  broadcast()
}

/** 唤出面板：隐藏态先恢复、收起态直接展开，已经展开则什么都不做 */
function wakePanel(reason: string): void {
  if (!dock) {
    return
  }
  dock.showPanel(reason)
  broadcast()
}

/**
 * 托盘图标单击。
 * 以前是"纯 toggle"：面板已经展开时点一下反而把它藏起来，用户会觉得点了没反应。
 * 现在只有"确实看得见"的时候才收起，其它情况一律唤出。
 */
function wakeFromTray(): void {
  if (!dock) {
    return
  }
  const phase = dock.getPhase()
  if (dock.isHidden() || phase === 'collapsed' || phase === 'collapsing') {
    dock.showPanel('tray-click')
  } else {
    dock.setHidden(true)
  }
  broadcast()
}

function registerWakeShortcut(): void {
  for (const accelerator of WAKE_ACCELERATORS) {
    if (globalShortcut.register(accelerator, () => wakePanel('shortcut'))) {
      wakeShortcut = accelerator
      break
    }
  }
  log('wake-shortcut', { accelerator: wakeShortcut, candidates: WAKE_ACCELERATORS })
}

function openSettingsFromTray(): void {
  if (!dock || !mainWindow) {
    return
  }
  dock.showPanel('tray-settings')
  mainWindow.webContents.send(IPC_CHANNELS.openSettings)
  broadcast()
}

function broadcastNoteStatus(status: NoteStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(IPC_CHANNELS.noteStatus, status)
}

function createWindow(): BrowserWindow {
  /** 渲染进程只自动恢复一次，连续崩溃说明环境有问题，直接退出而不是无限重载 */
  let rendererRecovered = false
  const settings = store?.get()
  // 首帧底色必须跟主题一致，否则浅色主题启动时会先闪一下黑
  const dark = settings?.theme === 'dark' || (settings?.theme === 'system' && nativeTheme.shouldUseDarkColors)
  const win = new BrowserWindow({
    title: 'Edge Notes',
    width: settings?.width ?? PANEL_WIDTH_DEFAULT,
    height: 640,
    show: false,
    frame: false,
    backgroundColor: dark ? '#242321' : '#f7f3ec',
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

  // Alt+F4 / 系统关闭 = 隐藏到托盘，不退出。真正退出只走托盘菜单或设置里的「退出应用」，
  // 否则一个常驻工具很容易被误关，而用户以为"它还在后台记着"。
  win.on('close', (event) => {
    if (quitting) {
      return
    }
    event.preventDefault()
    log('close-intercepted', {})
    dock?.setHidden(true)
    broadcast()
  })

  // 窗口失去焦点时用户不可能还在拖拽，释放标记防止卡死
  win.on('blur', () => {
    dock?.releaseResizeLock()
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      log('blocked-navigation', { url })
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    log('load-failed', { code, description, url, isMainFrame })
    // -3 是用户/程序主动中断，不是失败；只有主框架真加载不出来才需要兜底页面，
    // 否则用户面对的是一个 350px 宽、什么都没有、又没有标题栏按钮的空白窗口。
    if (code === -3 || isMainFrame === false || win.isDestroyed()) {
      return
    }
    const html = `<meta charset="utf-8"><body style="margin:0;padding:18px;background:#242321;color:#f0eae0;font:13px/1.7 'Microsoft YaHei UI',sans-serif">
<div style="font-weight:600;margin-bottom:8px">界面加载失败</div>
<div style="color:#b8ad9e">${description || 'unknown error'}（${code}）</div>
<div style="color:#a99d8c;margin-top:10px">请重新执行 npm run build 后重启应用。</div>
</body>`
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log('render-process-gone', { reason: details.reason })
    // 渲染层已死，它不可能再发"失焦/结束拖动"，先解掉抑制标记
    dock?.resetInteractionLocks()
    if (rendererRecovered || win.isDestroyed()) {
      log('renderer-gone-quit', { reason: details.reason })
      app.quit()
      return
    }
    rendererRecovered = true
    log('renderer-reload', {})
    win.reload()
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
  // 主题变化时同步原生窗口底色，避免拖动/重绘时露出旧主题的底色
  if (mainWindow && !mainWindow.isDestroyed()) {
    const dark = next.theme === 'dark' || (next.theme === 'system' && nativeTheme.shouldUseDarkColors)
    mainWindow.setBackgroundColor(dark ? '#242321' : '#f7f3ec')
  }
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

  ipcMain.handle(IPC_CHANNELS.setHidden, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'boolean') {
      throw new TypeError('hidden must be a boolean')
    }
    dock?.setHidden(value)
    broadcast()
    return buildState()
  })

  ipcMain.handle(IPC_CHANNELS.setTheme, (event, value: unknown) => {
    requireSender(event)
    if (value !== 'light' && value !== 'dark' && value !== 'system') {
      throw new TypeError('theme must be light / dark / system')
    }
    return applySettings({ theme: value })
  })

  ipcMain.handle(IPC_CHANNELS.setFontSize, (event, value: unknown) => {
    requireSender(event)
    if (value !== 'small' && value !== 'normal' && value !== 'large') {
      throw new TypeError('fontSize must be small / normal / large')
    }
    return applySettings({ fontSize: value })
  })

  ipcMain.handle(IPC_CHANNELS.setViewMode, (event, value: unknown) => {
    requireSender(event)
    if (value !== 'edit' && value !== 'preview') {
      throw new TypeError('viewMode must be edit / preview')
    }
    // 既更新"新笔记的默认值"，也写进当前这篇笔记，保证外部调用语义一致
    if (notes) {
      notes.setViewState(notes.state().activeId, { viewMode: value })
      broadcastNotesIndex(notes.state())
    }
    return applySettings({ viewMode: value })
  })

  ipcMain.handle(IPC_CHANNELS.getDataDir, (event) => {
    requireSender(event)
    return getDataDirInfo()
  })

  ipcMain.handle(IPC_CHANNELS.pickDataDir, async (event) => {
    requireSender(event)
    const result = await dialog.showOpenDialog({
      title: '选择 Edge Notes 数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.setDataDir, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError('dataDir must be a non-empty string')
    }
    // 迁移前把内存里的最新内容落盘，否则复制到新目录的是旧快照
    notes?.flushSync()
    store?.flush()
    return migrateDataDir(value)
  })

  ipcMain.handle(IPC_CHANNELS.relaunch, (event) => {
    requireSender(event)
    log('relaunch-requested', {})
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle(IPC_CHANNELS.getLoginItem, (event) => {
    requireSender(event)
    return readLoginItem()
  })

  ipcMain.handle(IPC_CHANNELS.setLaunchAtLogin, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'boolean') {
      throw new TypeError('launchAtLogin must be a boolean')
    }
    // 先写系统再落设置：系统没接受就抛错，设置文件不会出现"以为成功"的假状态
    applyLoginItem(value)
    return applySettings({ launchAtLogin: value })
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

  ipcMain.handle(IPC_CHANNELS.notesList, (event) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    return notes.state()
  })

  ipcMain.handle(IPC_CHANNELS.notesCreate, (event, title: unknown) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    const result = notes.create(typeof title === 'string' ? title : undefined)
    broadcastNotesIndex(result.index)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.notesSwitch, (event, id: unknown) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    if (typeof id !== 'string') {
      throw new TypeError('note id must be a string')
    }
    const result = notes.switchTo(id)
    broadcastNotesIndex(result.index)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.notesRename, (event, id: unknown, title: unknown) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    if (typeof id !== 'string' || typeof title !== 'string') {
      throw new TypeError('rename requires id and title strings')
    }
    const index = notes.rename(id, title)
    broadcastNotesIndex(index)
    return index
  })

  ipcMain.handle(IPC_CHANNELS.notesDelete, (event, id: unknown) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    if (typeof id !== 'string') {
      throw new TypeError('note id must be a string')
    }
    const result = notes.remove(id)
    broadcastNotesIndex(result.index)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.notesReorder, (event, ids: unknown) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    if (!Array.isArray(ids) || ids.some((item) => typeof item !== 'string')) {
      throw new TypeError('reorder requires an array of ids')
    }
    const index = notes.reorder(ids as string[])
    broadcastNotesIndex(index)
    return index
  })

  ipcMain.on(IPC_CHANNELS.notesViewState, (event, id: unknown, patch: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !notes) {
      return
    }
    if (typeof id !== 'string' || !patch || typeof patch !== 'object') {
      return
    }
    const input = patch as Record<string, unknown>
    notes.setViewState(id, {
      viewMode: input.viewMode === 'preview' ? 'preview' : input.viewMode === 'edit' ? 'edit' : undefined,
      scrollTop: typeof input.scrollTop === 'number' ? input.scrollTop : undefined,
      caret: typeof input.caret === 'number' ? input.caret : undefined
    })
  })

  ipcMain.handle(IPC_CHANNELS.notesInfo, (event): NotesFilesInfo => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    const index = notes.state()
    return {
      dir: notes.getNotesDir(),
      activeFile: notes.notePath(index.activeId),
      indexFile: notes.getIndexPath(),
      count: index.notes.length
    }
  })

  ipcMain.handle(IPC_CHANNELS.openNotesFolder, async (event) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    // 先落盘再打开：用户在资源管理器里看到的必须是刚写进去的内容
    notes.flushSync()
    const dir = notes.getNotesDir()
    mkdirSync(dir, { recursive: true })
    const failure = await shell.openPath(dir)
    if (failure) {
      throw new Error(`打开文件夹失败：${failure}`)
    }
    log('notes-folder-opened', { dir })
  })

  ipcMain.handle(IPC_CHANNELS.revealActiveNote, (event) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    notes.flushSync()
    const file = notes.notePath(notes.state().activeId)
    shell.showItemInFolder(file)
    log('note-revealed', { file })
  })

  ipcMain.handle(IPC_CHANNELS.attachmentsInfo, (event) => {
    requireSender(event)
    const dir = attachmentsDir(app.getPath('userData'))
    const files = listAttachments(app.getPath('userData'))
    return { dir, count: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }
  })

  ipcMain.handle(IPC_CHANNELS.openAttachmentsFolder, async (event) => {
    requireSender(event)
    const dir = attachmentsDir(app.getPath('userData'))
    mkdirSync(dir, { recursive: true })
    const failure = await shell.openPath(dir)
    if (failure) {
      throw new Error(`打开文件夹失败：${failure}`)
    }
    log('attachments-folder-opened', { dir })
  })

  ipcMain.handle(IPC_CHANNELS.revealAttachment, (event, relative: unknown) => {
    requireSender(event)
    if (typeof relative !== 'string') {
      throw new TypeError('attachment path must be a string')
    }
    const target = resolveAttachmentUrl(app.getPath('userData'), `edgenote-media://local/${relative}`)
    if (!target) {
      throw new TypeError('附件路径非法')
    }
    shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC_CHANNELS.openImageViewer, (event, relative: unknown) => {
    requireSender(event)
    if (typeof relative !== 'string') {
      throw new TypeError('attachment path must be a string')
    }
    const target = resolveAttachmentUrl(app.getPath('userData'), `edgenote-media://local/${relative}`)
    if (!target) {
      throw new TypeError('附件路径非法')
    }
    return openImageViewer(`edgenote-media://local/${relative}`, path.basename(target))
  })

  ipcMain.handle(IPC_CHANNELS.imageViewerOpen, (event) => {
    requireSender(event)
    return isImageViewerOpen()
  })

  ipcMain.handle(IPC_CHANNELS.closeImageViewer, (event) => {
    requireSender(event)
    closeImageViewer()
  })

  ipcMain.handle(IPC_CHANNELS.referencedAttachments, (event) => {
    requireSender(event)
    if (!notes) {
      throw new Error('edge-notes: notes store not ready')
    }
    // 跨全部笔记收集引用，避免把别的笔记还在用的图片清掉
    const referenced = new Set<string>()
    for (const content of notes.allContents()) {
      for (const match of content.matchAll(/attachments\/[^\s)"']+/g)) {
        referenced.add(match[0])
      }
    }
    return [...referenced]
  })

  ipcMain.handle(IPC_CHANNELS.setNavCollapsed, (event, value: unknown) => {
    requireSender(event)
    if (typeof value !== 'boolean') {
      throw new TypeError('navCollapsed must be a boolean')
    }
    return applySettings({ navCollapsed: value })
  })

  ipcMain.handle(IPC_CHANNELS.saveAttachment, (event, bytes: unknown, mime: unknown) => {
    requireSender(event)
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('attachment bytes must be a Uint8Array')
    }
    if (typeof mime !== 'string') {
      throw new TypeError('attachment mime must be a string')
    }
    return saveAttachment(app.getPath('userData'), bytes, mime)
  })

  ipcMain.handle(IPC_CHANNELS.checkAttachments, (event, paths: unknown) => {
    requireSender(event)
    if (!Array.isArray(paths)) {
      throw new TypeError('attachment paths must be an array')
    }
    const dir = app.getPath('userData')
    return paths.filter((item): item is string => typeof item === 'string' && !attachmentExists(dir, item))
  })

  ipcMain.handle(IPC_CHANNELS.listAttachments, (event) => {
    requireSender(event)
    return listAttachments(app.getPath('userData'))
  })

  ipcMain.handle(IPC_CHANNELS.trashAttachments, async (event, relatives: unknown) => {
    requireSender(event)
    if (!Array.isArray(relatives) || relatives.some((item) => typeof item !== 'string')) {
      throw new TypeError('attachment list must be an array of strings')
    }
    return trashAttachments(app.getPath('userData'), relatives as string[])
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

  // 附件只读协议：edgenote-media://local/attachments/<file>
  protocol.handle('edgenote-media', async (request) => {
    const target = resolveAttachmentUrl(app.getPath('userData'), request.url)
    if (!target) {
      log('attachment-denied', { url: request.url.slice(0, 120) })
      return new Response('not found', { status: 404 })
    }
    try {
      const data = await readFile(target)
      return new Response(data, { headers: { 'content-type': mimeForAttachment(target) } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  log('app-ready', {
    userData: app.getPath('userData'),
    settingsFile: store.getPath(),
    notesIndex: notes.getIndexPath(),
    notesDir: notes.getNotesDir(),
    notesCount: notes.state().notes.length,
    activeNoteId: notes.state().activeId,
    migrationWarning: notes.getMigrationWarning(),
    settings: store.get(),
    launchedAtLogin: process.argv.includes('--autostart'),
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

  // 开机启动以系统实际状态为准：用户可能在 Windows"启动应用"里关掉过。
  // 现在用「启动」文件夹里的快捷方式，开发模式也能如实回读。
  // 先清掉旧版写进注册表 Run 的记录（安全软件一直弹窗的源头），再对齐当前意愿。
  removeLegacyRunEntry()
  if (store) {
    const actual = reconcileLoginItem(store.get().launchAtLogin)
    if (actual !== store.get().launchAtLogin) {
      applySettings({ launchAtLogin: actual })
    }
  }

  registerWakeShortcut()

  trayHandlers = {
    isHidden: () => dock?.isHidden() ?? false,
    isPinned: () => store?.get().pinnedOpen ?? false,
    toggleHidden,
    wake: wakeFromTray,
    show: () => wakePanel('tray-menu'),
    togglePinned: () => applySettings({ pinnedOpen: !(store?.get().pinnedOpen ?? false) }),
    openSettings: openSettingsFromTray,
    quit: () => {
      log('quit-from-tray', {})
      app.quit()
    },
    wakeShortcut: () => wakeShortcut
  }
  createTray(trayHandlers)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  log('second-instance-exit', {})
  app.quit()
} else {
  app.on('second-instance', () => {
    log('second-instance', { hidden: dock?.isHidden() ?? false })
    // 再次启动应该把面板叫回来（包括从托盘隐藏状态）
    dock?.showPanel('second-instance')
    broadcast()
  })

  app.on('before-quit', () => {
    quitting = true
    closeImageViewer()
    notes?.flushSync()
    store?.flush()
    dock?.dispose()
    log('before-quit', {})
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    destroyTray()
    log('will-quit', {})
  })

  // 有托盘常驻，关掉窗口不代表退出应用
  app.on('window-all-closed', () => {
    log('window-all-closed', {})
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    log('bootstrap-failed', { error: String(error) })
    app.quit()
  })
}
