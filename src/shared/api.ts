/** 渲染进程可见的唯一 API 契约。主进程与 preload 共用这些类型与通道名。 */

export type DockSide = 'right' | 'left'

export type DockPhase = 'collapsed' | 'expanding' | 'expanded' | 'collapsing'

/** 自动收起延迟档位 */
export type CollapseDelay = 300 | 700 | 1200

/** 主题：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 正文字号档位 */
export type FontScale = 'small' | 'normal' | 'large'

/** 视图模式：编辑源码 / 阅读预览 */
export type ViewMode = 'edit' | 'preview'

export interface EdgeNotesSettings {
  /** 停靠边：右侧（默认）/ 左侧 */
  side: DockSide
  /** 面板宽度（DIP） */
  width: number
  /** 置顶开关 */
  alwaysOnTop: boolean
  /** 固定展开开关：开启后鼠标离开不自动收起 */
  pinnedOpen: boolean
  /** 鼠标离开后多久自动收起 */
  collapseDelay: CollapseDelay
  /** 登录 Windows 后自动启动（默认关闭） */
  launchAtLogin: boolean
  /** 主题（默认浅色） */
  theme: ThemeMode
  /** 正文字号档位 */
  fontSize: FontScale
  /** 上次使用的视图模式，重启后沿用 */
  viewMode: ViewMode
}

/** 数据目录信息（目录本身不在 settings.json 里，避免自指） */
export interface DataDirInfo {
  current: string
  isDefault: boolean
  pointer: string
}

export interface MigrationResult {
  from: string
  to: string
  copied: string[]
  requiresRestart: boolean
}

export interface EdgeNotesRuntime {
  phase: DockPhase
  expanded: boolean
  /** 是否被隐藏到托盘（隐藏后贴屏幕边缘不会再唤出，只能从托盘恢复） */
  hidden: boolean
  triggerWidth: number
  collapseDelayMs: number
}

export interface EdgeNotesState {
  settings: EdgeNotesSettings
  runtime: EdgeNotesRuntime
}

/** 开机启动的真实状态：enabled 以系统回读为准，不是我们"以为"的值 */
export interface LoginItemState {
  /** 当前构建是否支持（由 Electron 平台实现决定） */
  supported: boolean
  /** 启动项是否已注册（用户意图） */
  enabled: boolean
  /** 系统是否真的会在登录时启动它（可能被 Windows「启动应用」禁用） */
  active: boolean
  /** 需要向用户解释的附加信息（例如开发模式下注册的是 Electron 本体） */
  message: string | null
}

/** 保存状态：idle 表示还没有任何内容被写入过 */
export type NoteSaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface NoteStatus {
  state: NoteSaveState
  savedAt: number | null
  /** 保存失败时的简短原因，成功时为 null */
  message: string | null
}

export interface NoteSnapshot {
  content: string
  savedAt: number | null
  status: NoteStatus
}

/** 附件目录里的一个文件 */
export interface AttachmentFile {
  /** Markdown 里使用的相对路径 */
  relative: string
  name: string
  bytes: number
}

export interface TrashResult {
  trashed: number
  failed: string[]
}

export const IPC_CHANNELS = {
  getState: 'edge-notes:get-state',
  setAlwaysOnTop: 'edge-notes:set-always-on-top',
  setPinnedOpen: 'edge-notes:set-pinned-open',
  setSide: 'edge-notes:set-side',
  setWidth: 'edge-notes:set-width',
  setCollapseDelay: 'edge-notes:set-collapse-delay',
  setResizing: 'edge-notes:set-resizing',
  setHidden: 'edge-notes:set-hidden',
  setTheme: 'edge-notes:set-theme',
  setFontSize: 'edge-notes:set-font-size',
  setViewMode: 'edge-notes:set-view-mode',
  getLoginItem: 'edge-notes:get-login-item',
  setLaunchAtLogin: 'edge-notes:set-launch-at-login',
  getDataDir: 'edge-notes:get-data-dir',
  pickDataDir: 'edge-notes:pick-data-dir',
  setDataDir: 'edge-notes:set-data-dir',
  relaunch: 'edge-notes:relaunch',
  quit: 'edge-notes:quit',
  stateChanged: 'edge-notes:state-changed',
  openSettings: 'edge-notes:open-settings',
  saveAttachment: 'edge-notes:save-attachment',
  checkAttachments: 'edge-notes:check-attachments',
  listAttachments: 'edge-notes:list-attachments',
  trashAttachments: 'edge-notes:trash-attachments',
  noteGet: 'edge-notes:note-get',
  noteUpdate: 'edge-notes:note-update',
  noteSaveNow: 'edge-notes:note-save-now',
  noteRetry: 'edge-notes:note-retry',
  noteStatus: 'edge-notes:note-status',
  editorFocus: 'edge-notes:editor-focus'
} as const

export interface EdgeNotesApi {
  getState(): Promise<EdgeNotesState>
  setAlwaysOnTop(value: boolean): Promise<EdgeNotesState>
  setPinnedOpen(value: boolean): Promise<EdgeNotesState>
  setSide(side: DockSide): Promise<EdgeNotesState>
  setWidth(width: number): Promise<EdgeNotesState>
  setCollapseDelay(delay: CollapseDelay): Promise<EdgeNotesState>
  /** 拖动调整宽度期间调用，避免鼠标暂时离开面板就被收起 */
  setResizing(value: boolean): void
  /** 隐藏到托盘 / 从托盘恢复 */
  setHidden(hidden: boolean): Promise<EdgeNotesState>
  setTheme(theme: ThemeMode): Promise<EdgeNotesState>
  setFontSize(scale: FontScale): Promise<EdgeNotesState>
  setViewMode(mode: ViewMode): Promise<EdgeNotesState>
  getLoginItemState(): Promise<LoginItemState>
  setLaunchAtLogin(enabled: boolean): Promise<EdgeNotesState>
  getDataDir(): Promise<DataDirInfo>
  /** 打开系统选择目录对话框，取消返回 null */
  pickDataDir(): Promise<string | null>
  /** 迁移数据目录（复制 + 校验 + 写指针），需要重启生效 */
  setDataDir(dir: string): Promise<MigrationResult>
  relaunch(): Promise<void>
  quit(): Promise<void>

  getNote(): Promise<NoteSnapshot>
  /** 每次输入都会调用，主进程负责防抖落盘 */
  updateNote(content: string): void
  /** 立即落盘（清空等需要立刻生效的场景） */
  saveNoteNow(content: string): Promise<NoteStatus>
  /** 保存失败后重试上一次内容 */
  retrySave(): Promise<NoteStatus>
  /** 把剪贴板里的图片写入附件目录，返回可嵌入 Markdown 的相对路径 */
  saveAttachment(bytes: Uint8Array, mime: string): Promise<{ relative: string; bytes: number }>
  /** 返回其中已经不存在的附件路径（用于预览时提示"图片缺失"） */
  checkAttachments(paths: string[]): Promise<string[]>
  /** 列出附件目录里的全部文件（用于清理未被引用的图片） */
  listAttachments(): Promise<AttachmentFile[]>
  /** 把指定附件移入回收站（可还原） */
  trashAttachments(relatives: string[]): Promise<TrashResult>
  /** 编辑器聚焦时抑制自动收起 */
  setEditorFocused(focused: boolean): void

  onStateChanged(listener: (state: EdgeNotesState) => void): () => void
  onNoteStatus(listener: (status: NoteStatus) => void): () => void
  /** 从托盘「设置…」打开设置面板 */
  onOpenSettings(listener: () => void): () => void
}
