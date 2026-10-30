import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CollapseDelay, EdgeNotesState, NoteStatus } from '../shared/api'
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

function IconClose() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
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

  const settings = state?.settings
  const alwaysOnTop = settings?.alwaysOnTop ?? false
  const pinnedOpen = settings?.pinnedOpen ?? false

  const statusLabel =
    status.state === 'saving' ? '保存中' : status.state === 'error' ? '保存失败' : status.savedAt ? '已保存' : ''

  return (
    <div className={`panel panel--${settings?.side ?? 'right'}`}>
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

          <p className="settings__hint">拖动面板内侧边缘可调整宽度；Esc 关闭本面板。</p>
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

      <textarea
        ref={editorRef}
        id="note-editor"
        className="editor"
        placeholder="随手记点什么…"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => window.edgeNotes.updateNote(event.target.value)}
        onFocus={() => window.edgeNotes.setEditorFocused(true)}
        onBlur={() => window.edgeNotes.setEditorFocused(false)}
      />

      <footer className="foot">
        <span id="save-status" className={`foot__status foot__status--${status.state}`} title={status.message ?? ''}>
          {statusLabel}
        </span>
        <button id="clear-note" type="button" className="textBtn textBtn--quiet" title="清空当前笔记" onClick={() => setConfirmingClear(true)}>
          清空
        </button>
        <button
          id="panel-close"
          type="button"
          className="iconBtn iconBtn--sm"
          aria-label="退出 Edge Notes"
          title="退出 Edge Notes"
          onClick={() => {
            void window.edgeNotes.quit()
          }}
        >
          <IconClose />
        </button>
      </footer>
    </div>
  )
}
