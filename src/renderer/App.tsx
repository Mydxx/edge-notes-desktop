import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  CollapseDelay,
  DataDirInfo,
  EdgeNotesState,
  LoginItemState,
  NoteMeta,
  NotesFilesInfo,
  NotesIndexState,
  NoteSnapshot,
  NoteStatus,
  ViewMode
} from '../shared/api'
import { COLLAPSE_DELAY_OPTIONS } from '../shared/constants'

const EMPTY_STATUS: NoteStatus = { state: 'idle', savedAt: null, message: null }

const DELAY_LABEL: Record<CollapseDelay, string> = {
  300: '0.3s',
  700: '0.7s',
  1200: '1.2s'
}

function IconTopMost() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.2 2.8h9.6" />
      <path d="M8 13.2V5.6" />
      <path d="M5.1 8.5 8 5.6l2.9 2.9" />
    </svg>
  )
}

function IconPin() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.6" y="7.2" width="8.8" height="6.2" rx="1.5" />
      <path d="M5.9 7.2V5.3a2.2 2.2 0 0 1 4.4 0" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2.8 4.6h10.4M2.8 11.4h10.4" />
      <circle cx="6.2" cy="4.6" r="1.5" />
      <circle cx="9.8" cy="11.4" r="1.5" />
    </svg>
  )
}

function IconEye() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.8 8s2.3-4.1 6.2-4.1S14.2 8 14.2 8s-2.3 4.1-6.2 4.1S1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  )
}

function IconPencil() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.1 2.6a1.5 1.5 0 0 1 2.1 2.1l-7.3 7.3-2.9.8.8-2.9 7.3-7.3Z" />
      <path d="M10 3.7l2.3 2.3" />
    </svg>
  )
}

function IconChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
    >
      <path d="M9.8 3.6 5.4 8l4.4 4.4" />
    </svg>
  )
}

function IconMinimize() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M4.2 8h7.6" />
    </svg>
  )
}

export default function App() {
  const [state, setState] = useState<EdgeNotesState | null>(null)
  const [status, setStatus] = useState<NoteStatus>(EMPTY_STATUS)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loginItem, setLoginItem] = useState<LoginItemState | null>(null)
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [contentVersion, setContentVersion] = useState(0)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [attachmentsInfo, setAttachmentsInfo] = useState<{ dir: string; count: number; bytes: number } | null>(null)
  const [notesInfo, setNotesInfo] = useState<NotesFilesInfo | null>(null)
  const [prune, setPrune] = useState<{ count: number; bytes: number; relatives: string[] } | null>(null)
  const [notes, setNotes] = useState<NotesIndexState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<NoteMeta | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragNoteRef = useRef<{ id: string; startY: number; rowHeight: number } | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const loadedRef = useRef(false)
  /** 拖动调宽时的锚点（面板贴边那一侧的屏幕坐标） */
  const dragRef = useRef<{ anchor: number; side: 'left' | 'right' } | null>(null)
  const lastWidthRef = useRef(0)

  // 窗口设置
  useEffect(() => {
    let alive = true
    const unsubscribe = window.edgeNotes.onStateChanged((next) => {
      if (alive) {
        setState(next)
      }
    })
    window.edgeNotes
      .getState()
      .then((initial) => {
        if (alive) {
          setState(initial)
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          setSettingsError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 笔记载入 + 保存状态订阅
  useEffect(() => {
    let alive = true
    const unsubscribe = window.edgeNotes.onNoteStatus((next) => {
      if (alive) {
        setStatus(next)
      }
    })
    window.edgeNotes
      .getNote()
      .then((snapshot) => {
        if (!alive || loadedRef.current) {
          return
        }
        loadedRef.current = true
        const editor = editorRef.current
        if (editor && editor.value !== snapshot.content) {
          editor.value = snapshot.content
        }
        setContentVersion((version) => version + 1)
        setStatus(snapshot.status)
      })
      .catch((reason: unknown) => {
        if (alive) {
          setStatus({ state: 'error', savedAt: null, message: reason instanceof Error ? reason.message : String(reason) })
        }
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 笔记索引：初次拉取 + 订阅变更（新建/重命名/删除/排序后主进程会广播）
  useEffect(() => {
    let alive = true
    const unsubscribe = window.edgeNotes.onNotesIndexChanged((next) => {
      if (alive) {
        setNotes(next)
      }
    })
    window.edgeNotes
      .listNotes()
      .then((index) => {
        if (alive) {
          setNotes(index)
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          setAttachError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 设置弹层：Esc 或点击外部关闭
  useEffect(() => {
    if (!settingsOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.settings') || target?.closest('#open-settings')) {
        return
      }
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [settingsOpen])

  // 托盘「设置…」会请求打开设置面板
  useEffect(() => window.edgeNotes.onOpenSettings(() => setSettingsOpen(true)), [])

  // 主题：system 时跟随系统（Windows 深色模式会反映到 prefers-color-scheme）
  const themeSetting = state?.settings.theme ?? 'light'
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = themeSetting === 'system' ? (query.matches ? 'dark' : 'light') : themeSetting
      document.documentElement.dataset.theme = resolved
    }
    apply()
    if (themeSetting !== 'system') {
      return
    }
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [themeSetting])

  // 字号档位：只改正文
  const fontSetting = state?.settings.fontSize ?? 'normal'
  useEffect(() => {
    document.documentElement.dataset.font = fontSetting
  }, [fontSetting])

  // 数据目录（只在打开设置时刷新，避免每次状态广播都读磁盘）
  useEffect(() => {
    if (!settingsOpen) {
      return
    }
    let alive = true
    window.edgeNotes
      .getDataDir()
      .then((info) => {
        if (alive) {
          setDataDir(info)
        }
      })
      .catch(() => undefined)
    window.edgeNotes
      .getAttachmentsInfo()
      .then((info) => {
        if (alive) {
          setAttachmentsInfo(info)
        }
      })
      .catch(() => undefined)
    window.edgeNotes
      .getNotesInfo()
      .then((info) => {
        if (alive) {
          setNotesInfo(info)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [settingsOpen, notes?.notes.length, notes?.activeId])

  // 开机启动以系统回读为准，每次设置变化后刷新
  useEffect(() => {
    let alive = true
    window.edgeNotes
      .getLoginItemState()
      .then((next) => {
        if (alive) {
          setLoginItem(next)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [state?.settings.launchAtLogin])

  // 面板真正收起后关掉设置浮层，否则下次展开时它会又挂在那里
  const wasExpandedRef = useRef(false)
  const phase = state?.runtime.phase
  useEffect(() => {
    if (!phase) {
      return
    }
    if (phase === 'expanded' || phase === 'expanding') {
      wasExpandedRef.current = true
      return
    }
    if (phase === 'collapsed' && wasExpandedRef.current) {
      wasExpandedRef.current = false
      setSettingsOpen(false)
    }
  }, [phase])

  // 拖动内缘调整宽度：锚点取贴边那一侧的屏幕坐标，宽度由指针位置直接算出，避免累积误差
  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !state) {
        return
      }
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const side = state.settings.side
      dragRef.current = {
        side,
        anchor: side === 'right' ? window.screenX + window.innerWidth : window.screenX
      }
      lastWidthRef.current = state.settings.width
      window.edgeNotes.setResizing(true)
    },
    [state]
  )

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) {
      return
    }
    const width = drag.side === 'right' ? drag.anchor - event.screenX : event.screenX - drag.anchor
    const rounded = Math.round(width)
    if (rounded === lastWidthRef.current) {
      return
    }
    lastWidthRef.current = rounded
    void window.edgeNotes.setWidth(rounded).catch(() => undefined)
  }, [])

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return
    }
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.edgeNotes.setResizing(false)
  }, [])

  const applySettings = useCallback(async (action: () => Promise<EdgeNotesState>) => {
    setBusy(true)
    try {
      setState(await action())
      setSettingsError(null)
    } catch (reason) {
      setSettingsError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleClear = useCallback(async () => {
    setConfirmingClear(false)
    const editor = editorRef.current
    if (editor) {
      editor.value = ''
      editor.focus()
    }
    setContentVersion((version) => version + 1)
    try {
      setStatus(await window.edgeNotes.saveNoteNow(''))
    } catch (reason) {
      setStatus({ state: 'error', savedAt: null, message: reason instanceof Error ? reason.message : String(reason) })
    }
  }, [])

  const handleRetry = useCallback(async () => {
    try {
      setStatus(await window.edgeNotes.retrySave())
    } catch (reason) {
      setStatus({ state: 'error', savedAt: null, message: reason instanceof Error ? reason.message : String(reason) })
    }
  }, [])

  const handleChangeDataDir = useCallback(async () => {
    try {
      const picked = await window.edgeNotes.pickDataDir()
      if (!picked) {
        return
      }
      const result = await window.edgeNotes.setDataDir(picked)
      setNotice(`已迁移到 ${result.to}，正在重启…`)
      setDataDir(await window.edgeNotes.getDataDir().catch(() => null))
      // 迁移后必须立刻重启：否则用户继续输入会写进旧目录，新目录就成了旧快照
      setTimeout(() => {
        void window.edgeNotes.relaunch()
      }, 1500)
    } catch (reason) {
      setSettingsError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  /**
   * Markdown → 安全 HTML。
   * 两道处理：DOMPurify 净化（笔记内容可能是粘贴来的，绝不当可信 HTML），
   * 再把附件相对路径改写成自定义协议，外链图片直接抹掉 src（应用不联网）。
   */
  const renderMarkdown = useCallback((source: string, missing: Set<string>): string => {
    const raw = marked.parse(source, { gfm: true, breaks: true, async: false })
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
    const container = document.createElement('div')
    container.innerHTML = clean

    container.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? ''
      if (src.startsWith('attachments/') && missing.has(src)) {
        const gone = document.createElement('span')
        gone.className = 'preview__blocked'
        gone.textContent = `［图片缺失：${src.split('/').pop()}］`
        img.replaceWith(gone)
      } else       if (src.startsWith('attachments/')) {
        // 不用 loading="lazy"：便签里图片数量很少，懒加载反而会让刚切到预览时图片空白
        img.setAttribute('src', `edgenote-media://local/${src}`)
        img.setAttribute('title', '点击放大到屏幕（Esc 关闭）')
      } else {
        // 外链图片不加载（应用不联网），也不用留一个破图标，换成可读的说明
        const blocked = document.createElement('span')
        blocked.className = 'preview__blocked'
        blocked.textContent = `［外链图片已阻止${img.getAttribute('alt') ? `：${img.getAttribute('alt')}` : ''}］`
        img.replaceWith(blocked)
      }
    })

    container.querySelectorAll('a').forEach((anchor) => {
      const href = anchor.getAttribute('href') ?? ''
      anchor.removeAttribute('href')
      anchor.setAttribute('data-href', href)
      anchor.setAttribute('title', '预览模式不打开链接')
    })

    return container.innerHTML
  }, [])

  /** 进预览前先问主进程"这些附件还在不在"，缺的当场换成提示，不依赖图片加载错误事件 */
  const refreshPreview = useCallback(
    async (source: string) => {
      const paths = Array.from(new Set(source.match(/attachments\/[^\s)"']+/g) ?? []))
      let missing: string[] = []
      if (paths.length > 0) {
        try {
          missing = await window.edgeNotes.checkAttachments(paths)
        } catch {
          missing = []
        }
      }
      setPreviewHtml(renderMarkdown(source, new Set(missing)))
    },
    [renderMarkdown]
  )

  /** 记录当前笔记的光标与滚动位置（切走前调用，切回来能接着看） */
  const captureViewState = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !notes) {
      return
    }
    window.edgeNotes.setNoteViewState(notes.activeId, {
      caret: editor.selectionStart,
      scrollTop: editor.scrollTop
    })
  }, [notes])

  /** 光标/滚动变化后节流保存，保证退出前最后一次位置也记下来 */
  const viewStateTimer = useRef<number | null>(null)
  const scheduleViewState = useCallback(() => {
    if (viewStateTimer.current !== null) {
      window.clearTimeout(viewStateTimer.current)
    }
    viewStateTimer.current = window.setTimeout(() => {
      viewStateTimer.current = null
      captureViewState()
    }, 400)
  }, [captureViewState])

  /** 编辑区当前装载的是哪一篇笔记；用于识别"外部把 activeId 改了"的情况 */
  const loadedNoteIdRef = useRef<string | null>(null)

  // 主进程广播的 activeId 与编辑区内容不一致时（例如托盘/其它入口切换了笔记），重新拉取正文。
  // 没有这一步，后续任何一次输入都会把旧笔记的内容写进新笔记。
  useEffect(() => {
    if (!notes) {
      return
    }
    if (loadedNoteIdRef.current === null) {
      loadedNoteIdRef.current = notes.activeId
      return
    }
    if (loadedNoteIdRef.current === notes.activeId) {
      return
    }
    loadedNoteIdRef.current = notes.activeId
    const meta = notes.notes.find((note) => note.id === notes.activeId)
    void window.edgeNotes
      .getNote()
      .then((snapshot) => {
        const editor = editorRef.current
        if (editor && editor.value !== snapshot.content) {
          editor.value = snapshot.content
        }
        setStatus(snapshot.status)
        setContentVersion((version) => version + 1)
        if (editor && meta) {
          const caret = Math.min(meta.caret, editor.value.length)
          editor.setSelectionRange(caret, caret)
          editor.scrollTop = meta.scrollTop
        }
      })
      .catch(() => undefined)
  }, [notes])

  /** 首次加载完成后，把上次的光标与滚动位置还原到编辑区 */
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || !notes || !loadedRef.current) {
      return
    }
    const editor = editorRef.current
    if (!editor) {
      return
    }
    const meta = notes.notes.find((note) => note.id === notes.activeId)
    if (!meta) {
      return
    }
    restoredRef.current = true
    const caret = Math.min(meta.caret, editor.value.length)
    editor.setSelectionRange(caret, caret)
    editor.scrollTop = meta.scrollTop
  }, [notes, contentVersion])

  /** 切换/新建/删除后：替换正文、恢复光标与滚动、重建预览 */
  const applyNote = useCallback((index: NotesIndexState, snapshot: NoteSnapshot) => {
    loadedNoteIdRef.current = index.activeId
    setNotes(index)
    const editor = editorRef.current
    const meta = index.notes.find((note) => note.id === index.activeId)
    if (editor && editor.value !== snapshot.content) {
      editor.value = snapshot.content
    }
    if (editor && meta) {
      const caret = Math.min(meta.caret, editor.value.length)
      editor.focus()
      editor.setSelectionRange(caret, caret)
      editor.scrollTop = meta.scrollTop
    }
    setStatus(snapshot.status)
    setContentVersion((version) => version + 1)
  }, [])

  const switchTo = useCallback(
    async (id: string) => {
      if (!notes || id === notes.activeId) {
        return
      }
      captureViewState()
      setRenamingId(null)
      try {
        const result = await window.edgeNotes.switchNote(id)
        applyNote(result.index, result.note)
      } catch (reason) {
        setAttachError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [applyNote, captureViewState, notes]
  )

  const createNote = useCallback(async () => {
    captureViewState()
    try {
      const result = await window.edgeNotes.createNote()
      // 不自动进入改名：Ctrl+N 之后用户多半想写内容，焦点必须落在正文
      applyNote(result.index, result.note)
    } catch (reason) {
      setAttachError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [applyNote, captureViewState])

  const commitRename = useCallback(async (id: string, draft: string) => {
    setRenamingId(null)
    try {
      setNotes(await window.edgeNotes.renameNote(id, draft))
    } catch (reason) {
      setAttachError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const deleteNote = useCallback(
    async (id: string) => {
      setPendingDelete(null)
      try {
        const result = await window.edgeNotes.deleteNote(id)
        applyNote(result.index, result.note)
      } catch (reason) {
        setAttachError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [applyNote]
  )

  const moveNote = useCallback(
    async (from: number, to: number) => {
      if (!notes || from === to || to < 0 || to >= notes.notes.length) {
        return
      }
      const ids = notes.notes.map((note) => note.id)
      const [moved] = ids.splice(from, 1)
      ids.splice(to, 0, moved)
      // 先把本地顺序改掉（拖动手感），再让主进程落盘
      setNotes({ ...notes, notes: ids.map((id) => notes.notes.find((note) => note.id === id)!) })
      try {
        setNotes(await window.edgeNotes.reorderNotes(ids))
      } catch (reason) {
        setAttachError(reason instanceof Error ? reason.message : String(reason))
        setNotes(await window.edgeNotes.listNotes().catch(() => notes))
      }
    },
    [notes]
  )

  const activeNote = notes?.notes.find((note) => note.id === notes.activeId) ?? null
  // 每篇笔记各记各的模式；settings.viewMode 只作为新笔记的默认值（向后兼容）
  const viewMode: ViewMode = activeNote?.viewMode ?? state?.settings.viewMode ?? 'edit'
  const preview = viewMode === 'preview'

  const setView = useCallback(
    (mode: ViewMode) => {
      void window.edgeNotes
        .setViewMode(mode)
        .then(setState)
        .catch((reason: unknown) => setAttachError(reason instanceof Error ? reason.message : String(reason)))
      if (notes) {
        window.edgeNotes.setNoteViewState(notes.activeId, { viewMode: mode })
        setNotes({
          ...notes,
          notes: notes.notes.map((note) => (note.id === notes.activeId ? { ...note, viewMode: mode } : note))
        })
      }
    },
    [notes]
  )

  const togglePreview = useCallback(async () => {
    if (viewMode === 'preview') {
      setView('edit')
      return
    }
    // 先把 HTML 算好再切模式，避免"预览区空白一帧"的闪烁
    await refreshPreview(editorRef.current?.value ?? '')
    setView('preview')
  }, [refreshPreview, setView, viewMode])

  // 进入预览（或内容被替换：载入、粘贴、清空）时重新渲染一次
  useEffect(() => {
    if (viewMode === 'preview') {
      void refreshPreview(editorRef.current?.value ?? '')
    }
  }, [viewMode, contentVersion, refreshPreview])

  /** 把加载失败的图片换成可读提示（附件被删 / 路径失效时） */
  const replaceWithMissing = useCallback((img: HTMLImageElement) => {
    const name = img.getAttribute('src')?.split('/').pop() ?? ''
    const missing = document.createElement('span')
    missing.className = 'preview__blocked'
    missing.textContent = `［图片缺失：${name}］`
    img.replaceWith(missing)
  }, [])

  // 预览里的图片加载失败时给出可读提示，而不是破图标。
  // 两条路径都要覆盖：进入预览时监听后续的 error 事件；已经失败过的（complete 且宽为 0）当场替换。
  useEffect(() => {
    if (!preview) {
      return
    }
    const root = previewRef.current
    if (!root) {
      return
    }
    const onError = (event: Event): void => {
      const target = event.target as HTMLImageElement | null
      if (target && target.tagName === 'IMG') {
        replaceWithMissing(target)
      }
    }
    root.addEventListener('error', onError, true)
    root.querySelectorAll('img').forEach((img) => {
      if (img.complete && img.naturalWidth === 0) {
        replaceWithMissing(img)
      }
    })
    const sweep = setTimeout(() => {
      root.querySelectorAll('img').forEach((img) => {
        if (img.complete && img.naturalWidth === 0) {
          replaceWithMissing(img)
        }
      })
    }, 300)
    return () => {
      clearTimeout(sweep)
      root.removeEventListener('error', onError, true)
    }
  }, [preview, previewHtml, replaceWithMissing])

  /** 上一篇 / 下一篇（循环） */
  const stepNote = useCallback(
    (delta: number) => {
      if (!notes || notes.notes.length < 2) {
        return
      }
      const current = notes.notes.findIndex((note) => note.id === notes.activeId)
      if (current < 0) {
        return
      }
      const next = notes.notes[(current + delta + notes.notes.length) % notes.notes.length]
      void switchTo(next.id)
    },
    [notes, switchTo]
  )

  /** Ctrl+S：立刻落盘当前笔记 */
  const saveNow = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    void window.edgeNotes
      .saveNoteNow(editor.value)
      .then(setStatus)
      .catch((reason: unknown) => setAttachError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  // 快捷键：Ctrl+E 预览、Ctrl+N 新建、Ctrl+S 立即保存、Ctrl+Tab / Ctrl+Shift+Tab 切换笔记
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
        return
      }
      const mod = event.ctrlKey || event.metaKey
      if (!mod) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'e') {
        event.preventDefault()
        void togglePreview()
        return
      }
      if (key === 'n') {
        event.preventDefault()
        void createNote()
        return
      }
      if (key === 's') {
        event.preventDefault()
        saveNow()
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        stepNote(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [createNote, saveNow, stepNote, togglePreview])

  /** 剪贴板里的图片落盘，并在光标处插入 Markdown 图片语法 */
  const handlePaste = useCallback(async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    // 截图走 items（kind=file），部分来源只给 files，两种都收
    const fromItems = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    const files = fromItems.length > 0 ? fromItems : Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) {
      return
    }
    event.preventDefault()
    const editor = event.currentTarget
    try {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const saved = await window.edgeNotes.saveAttachment(bytes, file.type)
        const prefix = editor.selectionStart > 0 && !editor.value.endsWith('\n') ? '\n' : ''
        editor.setRangeText(`${prefix}![](${saved.relative})\n`, editor.selectionStart, editor.selectionEnd, 'end')
      }
      window.edgeNotes.updateNote(editor.value)
      setContentVersion((version) => version + 1)
      setAttachError(null)
    } catch (reason) {
      setAttachError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
      return `${bytes} B`
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  /** 扫描未被正文引用的附件：只统计并弹确认，不直接删 */
  const handleScanAttachments = useCallback(async () => {
    try {
      const files = await window.edgeNotes.listAttachments()
      // 跨全部笔记统计引用：只看当前笔记会误删别的笔记还在用的图片
      const referenced = new Set(await window.edgeNotes.getReferencedAttachments())
      const unused = files.filter((file) => !referenced.has(file.relative))
      setConfirmingClear(false)
      if (unused.length === 0) {
        setPrune(null)
        setNotice(`附件共 ${files.length} 个，没有需要清理的`)
        return
      }
      setNotice(null)
      setPrune({
        count: unused.length,
        bytes: unused.reduce((sum, file) => sum + file.bytes, 0),
        relatives: unused.map((file) => file.relative)
      })
    } catch (reason) {
      setAttachError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  /** 用户确认后才执行：移入回收站（可还原），不是直接删除 */
  const handlePrune = useCallback(async () => {
    if (!prune) {
      return
    }
    try {
      const result = await window.edgeNotes.trashAttachments(prune.relatives)
      const suffix = result.failed.length > 0 ? `，${result.failed.length} 个失败` : ''
      setNotice(`已把 ${result.trashed} 个图片移入回收站${suffix}`)
      setPrune(null)
    } catch (reason) {
      setAttachError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [prune])

  const settings = state?.settings
  // 面板过窄时导航必须自动收起，否则正文只剩一百多像素
  const navAutoCollapsed = (settings?.width ?? 350) < 340
  const navCollapsed = (settings?.navCollapsed ?? false) || navAutoCollapsed
  const alwaysOnTop = settings?.alwaysOnTop ?? false
  const pinnedOpen = settings?.pinnedOpen ?? false
  // Electron 的加速键写法对用户不友好：Control+Alt+N → Ctrl+Alt+N
  const wakeShortcutLabel = state?.runtime.wakeShortcut
    ? state.runtime.wakeShortcut.replace('Control', 'Ctrl')
    : '未注册（快捷键被占用）'

  const statusLabel =
    status.state === 'saving' ? '保存中' : status.state === 'error' ? '保存失败' : status.savedAt ? '已保存' : ''

  return (
    <div
      className={`panel panel--${settings?.side ?? 'right'}`}
      data-narrow={settings ? settings.width < 340 : false}
    >
      {/* 内缘拖拽把手：只在面板朝桌面那一侧，不与屏幕边缘的 4px 触发条重叠 */}
      <div
        id="resize-handle"
        className="resize-handle"
        title="拖动调整面板宽度"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />

      <nav
        className={`notesNav${navCollapsed ? ' notesNav--collapsed' : ''}`}
        id="notes-nav"
        aria-label="笔记列表"
      >
        <div className="notesNav__head">
          <button
            id="toggle-nav"
            type="button"
            className="iconBtn iconBtn--sm"
            aria-pressed={navCollapsed}
            disabled={navAutoCollapsed}
            aria-label={navCollapsed ? '展开笔记列表' : '收起笔记列表'}
            title={navAutoCollapsed ? '面板过窄，导航已自动收起；加宽面板后可展开' : navCollapsed ? '展开笔记列表' : '收起笔记列表'}
            onClick={() => {
              void applySettings(() => window.edgeNotes.setNavCollapsed(!navCollapsed))
            }}
          >
            <IconChevron collapsed={navCollapsed} />
          </button>
          {navCollapsed ? null : <span className="notesNav__label">笔记</span>}
        </div>

        <div className="notesNav__list" id="notes-list">
          {(notes?.notes ?? []).map((note, index) => {
            const active = note.id === notes?.activeId
            const renaming = renamingId === note.id
            return (
              <div
                key={note.id}
                id={`note-row-${note.id}`}
                className={`noteRow${active ? ' noteRow--active' : ''}${draggingId === note.id ? ' noteRow--dragging' : ''}`}
                data-note-id={note.id}
                title={renaming ? undefined : note.title}
                onPointerDown={(event) => {
                  if (renaming || event.button !== 0) {
                    return
                  }
                  dragNoteRef.current = {
                    id: note.id,
                    startY: event.clientY,
                    rowHeight: event.currentTarget.offsetHeight || 30
                  }
                }}
                onPointerMove={(event) => {
                  const drag = dragNoteRef.current
                  if (!drag || drag.id !== note.id) {
                    return
                  }
                  const delta = Math.round((event.clientY - drag.startY) / drag.rowHeight)
                  const total = notes?.notes.length ?? 1
                  const target = Math.max(0, Math.min(total - 1, index + delta))
                  if (target !== index) {
                    // 往上/下拖过半行就换位，并以当前位置为新起点，避免一次性跳太多
                    setDraggingId(note.id)
                    dragNoteRef.current = { ...drag, startY: event.clientY }
                    void moveNote(index, target)
                  }
                }}
                onPointerUp={() => {
                  dragNoteRef.current = null
                  setDraggingId(null)
                }}
                onPointerCancel={() => {
                  dragNoteRef.current = null
                  setDraggingId(null)
                }}
                onClick={() => {
                  if (!draggingId) {
                    void switchTo(note.id)
                  }
                }}
                onDoubleClick={() => {
                  setRenamingId(note.id)
                  setRenameDraft(note.title)
                }}
              >
                {renaming ? (
                  <input
                    id={`rename-input`}
                    className="noteRow__input"
                    value={renameDraft}
                    autoFocus
                    maxLength={60}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={() => void commitRename(note.id, renameDraft)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitRename(note.id, renameDraft)
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenamingId(null)
                      }
                    }}
                  />
                ) : (
                  <>
                    <span className="noteRow__mark" aria-hidden="true">
                      {note.title.slice(0, 1)}
                    </span>
                    <span className="noteRow__title">{note.title}</span>
                    <button
                      type="button"
                      className="noteRow__del"
                      aria-label={`删除 ${note.title}`}
                      title="删除笔记"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        setPendingDelete(note)
                      }}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>

        <button
          id="new-note"
          type="button"
          className="notesNav__new"
          title="新建笔记（Ctrl+N）"
          onClick={() => void createNote()}
        >
          <span className="notesNav__plus" aria-hidden="true">
            +
          </span>
          {navCollapsed ? null : <span>新建笔记</span>}
        </button>
      </nav>

      <div className="pane">
      <header className="bar">
        <span className="bar__title">Edge Notes</span>
        <span className="bar__spacer" />
        <button
          id="toggle-always-on-top"
          type="button"
          className="iconBtn"
          aria-pressed={alwaysOnTop}
          aria-label={alwaysOnTop ? '置顶：已开启' : '置顶：已关闭'}
          title={alwaysOnTop ? '置顶：已开启' : '置顶：已关闭'}
          disabled={!settings || busy}
          onClick={() => {
            void applySettings(() => window.edgeNotes.setAlwaysOnTop(!alwaysOnTop))
          }}
        >
          <IconTopMost />
        </button>
        <button
          id="toggle-pinned"
          type="button"
          className="iconBtn"
          aria-pressed={pinnedOpen}
          aria-label={pinnedOpen ? '固定展开：已开启' : '固定展开：已关闭'}
          title={pinnedOpen ? '固定展开：已开启' : '固定展开：已关闭'}
          disabled={!settings || busy}
          onClick={() => {
            void applySettings(() => window.edgeNotes.setPinnedOpen(!pinnedOpen))
          }}
        >
          <IconPin />
        </button>
        <button
          id="toggle-preview"
          type="button"
          className="iconBtn"
          aria-pressed={preview}
          aria-label={preview ? '返回编辑' : '预览 Markdown'}
          title={preview ? '返回编辑' : '预览 Markdown'}
          onClick={togglePreview}
        >
          {preview ? <IconPencil /> : <IconEye />}
        </button>
        <button
          id="open-settings"
          type="button"
          className="iconBtn"
          aria-pressed={settingsOpen}
          aria-haspopup="true"
          aria-label="设置"
          title="设置"
          disabled={!settings}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <IconSettings />
        </button>
      </header>

      {settingsOpen && settings ? (
        <div className="settings" role="dialog" aria-label="面板设置">
          <div className="settings__row">
            <span className="settings__label">停靠位置</span>
            <span className="segmented">
              <button
                id="side-left"
                type="button"
                aria-pressed={settings.side === 'left'}
                onClick={() => {
                  void applySettings(() => window.edgeNotes.setSide('left'))
                }}
              >
                左侧
              </button>
              <button
                id="side-right"
                type="button"
                aria-pressed={settings.side === 'right'}
                onClick={() => {
                  void applySettings(() => window.edgeNotes.setSide('right'))
                }}
              >
                右侧
              </button>
            </span>
          </div>

          <div className="settings__row">
            <span className="settings__label">面板宽度</span>
            <span className="settings__value">{settings.width}px</span>
          </div>

          <div className="settings__row">
            <span className="settings__label">自动收起</span>
            <span className="segmented">
              {COLLAPSE_DELAY_OPTIONS.map((option) => (
                <button
                  key={option}
                  id={`delay-${option}`}
                  type="button"
                  aria-pressed={settings.collapseDelay === option}
                  title={`鼠标离开后 ${option}ms 收起`}
                  onClick={() => {
                    void applySettings(() => window.edgeNotes.setCollapseDelay(option))
                  }}
                >
                  {DELAY_LABEL[option]}
                </button>
              ))}
            </span>
          </div>

          <div className="settings__row">
            <span className="settings__label">主题</span>
            <span className="segmented">
              <button id="theme-light" type="button" aria-pressed={settings.theme === 'light'} onClick={() => void applySettings(() => window.edgeNotes.setTheme('light'))}>
                浅色
              </button>
              <button id="theme-dark" type="button" aria-pressed={settings.theme === 'dark'} onClick={() => void applySettings(() => window.edgeNotes.setTheme('dark'))}>
                深色
              </button>
              <button id="theme-system" type="button" aria-pressed={settings.theme === 'system'} onClick={() => void applySettings(() => window.edgeNotes.setTheme('system'))}>
                自动
              </button>
            </span>
          </div>

          <div className="settings__row">
            <span className="settings__label">正文字号</span>
            <span className="segmented">
              <button id="font-small" type="button" aria-pressed={settings.fontSize === 'small'} onClick={() => void applySettings(() => window.edgeNotes.setFontSize('small'))}>
                小
              </button>
              <button id="font-normal" type="button" aria-pressed={settings.fontSize === 'normal'} onClick={() => void applySettings(() => window.edgeNotes.setFontSize('normal'))}>
                标准
              </button>
              <button id="font-large" type="button" aria-pressed={settings.fontSize === 'large'} onClick={() => void applySettings(() => window.edgeNotes.setFontSize('large'))}>
                大
              </button>
            </span>
          </div>

          <div className="settings__row">
            <span className="settings__label">开机启动</span>
            <button
              id="toggle-launch-at-login"
              type="button"
              className="switchBtn"
              aria-pressed={settings.launchAtLogin}
              title={loginItem?.message ?? '登录 Windows 后自动启动'}
              disabled={loginItem?.supported === false}
              onClick={() => {
                void applySettings(() => window.edgeNotes.setLaunchAtLogin(!settings.launchAtLogin))
              }}
            >
              {settings.launchAtLogin ? (loginItem && loginItem.enabled && !loginItem.active ? '系统禁用' : '已开启') : '已关闭'}
            </button>
          </div>
          {loginItem && loginItem.enabled && !loginItem.active ? (
            <p className="settings__hint settings__hint--warn">
              启动项已写入，但被 Windows「启动应用」禁用，登录后不会自动启动。
            </p>
          ) : null}
          {loginItem?.message && !(loginItem.enabled && !loginItem.active) ? (
            <p className="settings__hint">{loginItem.message}</p>
          ) : null}

          <div className="settings__row">
            <span className="settings__label">快速唤出</span>
            <span className="settings__value" id="wake-shortcut">
              {wakeShortcutLabel}
            </span>
          </div>

          <div className="settings__row">
            <span className="settings__label">数据目录</span>
            <button id="change-data-dir" type="button" className="switchBtn" title="把笔记和设置迁移到其它目录（例如 D 盘）" onClick={() => void handleChangeDataDir()}>
              更改…
            </button>
          </div>
          {dataDir ? (
            <p className="settings__path" title={dataDir.current}>
              {dataDir.current}
              {dataDir.isDefault ? '（默认）' : ''}
            </p>
          ) : null}
          <div className="settings__row">
            <span className="settings__label">笔记文件</span>
            <span className="settings__actions">
              <button
                id="open-notes-folder"
                type="button"
                className="switchBtn"
                title="在资源管理器里打开 notes 目录（每篇笔记一个 .md，可用记事本打开）"
                onClick={() => {
                  void window.edgeNotes
                    .openNotesFolder()
                    .catch((reason: unknown) => setAttachError(reason instanceof Error ? reason.message : String(reason)))
                }}
              >
                打开
              </button>
              <button
                id="reveal-active-note"
                type="button"
                className="switchBtn"
                title="在资源管理器里选中当前这篇笔记的 .md 文件"
                onClick={() => {
                  void window.edgeNotes
                    .revealActiveNote()
                    .catch((reason: unknown) => setAttachError(reason instanceof Error ? reason.message : String(reason)))
                }}
              >
                定位
              </button>
            </span>
          </div>
          {notesInfo ? (
            <p className="settings__path" id="notes-path" title={notesInfo.activeFile}>
              {notesInfo.activeFile.split(/[\\/]/).pop()} · 共 {notesInfo.count} 篇
            </p>
          ) : null}
          <div className="settings__row">
            <span className="settings__label">图片附件</span>
            <span className="settings__actions">
              <button
                id="open-attachments"
                type="button"
                className="switchBtn"
                title="在资源管理器里打开图片所在文件夹"
                onClick={() => {
                  void window.edgeNotes
                    .openAttachmentsFolder()
                    .catch((reason: unknown) => setAttachError(reason instanceof Error ? reason.message : String(reason)))
                }}
              >
                打开
              </button>
              <button
                id="prune-attachments"
                type="button"
                className="switchBtn"
                title="把正文里没有引用的图片移入回收站"
                onClick={() => void handleScanAttachments()}
              >
                清理…
              </button>
            </span>
          </div>
          {attachmentsInfo ? (
            <p className="settings__path" id="attachments-path" title={attachmentsInfo.dir}>
              {attachmentsInfo.dir}（{attachmentsInfo.count} 张 · {formatBytes(attachmentsInfo.bytes)}）
            </p>
          ) : null}
          {notice ? <p className="settings__hint">{notice}</p> : null}

          <p className="settings__hint">
            拖动面板内侧边缘可调整宽度；隐藏后鼠标贴屏幕边缘、单击托盘图标或按 {wakeShortcutLabel} 都能召回。
          </p>

          <div className="settings__footer">
            <button id="quit-app" type="button" className="textBtn textBtn--quiet" title="退出应用（会先保存笔记）" onClick={() => void window.edgeNotes.quit()}>
              退出 Edge Notes
            </button>
          </div>
        </div>
      ) : null}

      {confirmingClear ? (
        <div className="confirm">
          <span className="confirm__text">清空这篇笔记？内容不可恢复。</span>
          <button id="clear-cancel" type="button" className="textBtn" onClick={() => setConfirmingClear(false)}>
            取消
          </button>
          <button id="clear-confirm" type="button" className="textBtn textBtn--danger" onClick={() => void handleClear()}>
            清空
          </button>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="confirm">
          <span className="confirm__text">删除「{pendingDelete.title}」？会移入回收站，可还原。</span>
          <button id="note-delete-cancel" type="button" className="textBtn" onClick={() => setPendingDelete(null)}>
            取消
          </button>
          <button
            id="note-delete-confirm"
            type="button"
            className="textBtn textBtn--danger"
            onClick={() => void deleteNote(pendingDelete.id)}
          >
            删除
          </button>
        </div>
      ) : null}

      {prune ? (
        <div className="confirm">
          <span className="confirm__text">
            清理 {prune.count} 个未被引用的图片（{formatBytes(prune.bytes)}）？会移入回收站，可还原。
          </span>
          <button id="prune-cancel" type="button" className="textBtn" onClick={() => setPrune(null)}>
            取消
          </button>
          <button id="prune-confirm" type="button" className="textBtn textBtn--danger" onClick={() => void handlePrune()}>
            清理
          </button>
        </div>
      ) : null}

      {status.state === 'error' ? (
        <div className="errorBar" role="alert">
          <span className="errorBar__text" title={`保存失败：${status.message ?? '未知原因'}`}>
            保存失败：{status.message ?? '未知原因'} · 内容未丢失
          </span>
          <button type="button" className="textBtn" onClick={() => void handleRetry()}>
            重试
          </button>
        </div>
      ) : null}

      {settingsError ? <div className="errorBar">{settingsError}</div> : null}

      {/* 编辑区常驻挂载：切到预览时只隐藏，避免卸载丢失未受控输入框里的内容和光标 */}
      <textarea
        ref={editorRef}
        id="note-editor"
        className={`editor${preview ? ' editor--hidden' : ''}`}
        placeholder="随手记点什么…"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => window.edgeNotes.updateNote(event.target.value)}
        onPaste={(event) => void handlePaste(event)}
        onSelect={scheduleViewState}
        onScroll={scheduleViewState}
        onFocus={() => window.edgeNotes.setEditorFocused(true)}
        onBlur={() => window.edgeNotes.setEditorFocused(false)}
      />

      {preview ? (
        <div
          className="preview"
          id="note-preview"
          ref={previewRef}
          onClick={(event) => {
            const target = event.target as HTMLElement
            if (target.tagName !== 'IMG') {
              return
            }
            const src = target.getAttribute('src') ?? ''
            const relative = src.replace('edgenote-media://local/', '')
            if (!relative.startsWith('attachments/')) {
              return
            }
            // 面板只有 350px，看图必须开独立窗口放到屏幕上
            void window.edgeNotes
              .openImageViewer(relative)
              .catch((reason: unknown) => setAttachError(reason instanceof Error ? reason.message : String(reason)))
          }}
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : null}

      {attachError ? <div className="errorBar">图片插入失败：{attachError}</div> : null}

      <footer className="foot">
        <span id="save-status" className={`foot__status foot__status--${status.state}`} title={status.message ?? ''}>
          {statusLabel}
        </span>
        <button
          id="clear-note"
          type="button"
          className="textBtn textBtn--quiet"
          title="清空当前笔记"
          onClick={() => {
            setPrune(null)
            setConfirmingClear(true)
          }}
        >
          清空
        </button>
        <button
          id="hide-panel"
          type="button"
          className="iconBtn iconBtn--sm"
          aria-label="隐藏到托盘"
          title={`隐藏到托盘（鼠标贴屏幕边缘或按 ${wakeShortcutLabel} 可召回）`}
          onClick={() => {
            void window.edgeNotes.setHidden(true)
          }}
        >
          <IconMinimize />
        </button>
      </footer>
      </div>
    </div>
  )
}
