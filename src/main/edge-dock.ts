import { BrowserWindow, screen } from 'electron'
import type { Point, Rectangle } from 'electron'
import type { DockPhase, EdgeNotesSettings } from '../shared/api'
import {
  COLLAPSE_DELAY_MS,
  CURSOR_POLL_MS,
  EXPAND_ANIMATION_MS,
  FRAME_INTERVAL_MS,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  TRIGGER_WIDTH
} from '../shared/constants'
import { log } from './log'

/** 触发条左右各放宽 2px，方便用户命中 */
const HIT_TOLERANCE_PX = 2
/**
 * 面板命中判定额外放宽 6px：拖完宽度后指针常常正好停在内缘外侧 1~7px，
 * 留一点余量可以避免「刚松手面板就收起」这种讨厌的行为。
 */
const PANEL_HIT_SLOP = 6
/** 面板与屏幕边缘至少留出的空间 */
const SCREEN_EDGE_MARGIN = 40

interface DockGeometry {
  displayId: number
  scaleFactor: number
  area: Rectangle
  width: number
  height: number
  y: number
  collapsedX: number
  expandedX: number
}

export interface EdgeDockHooks {
  onPhaseChange: (phase: DockPhase) => void
}

/**
 * 边缘停靠窗口控制器（全部在主进程运行）。
 *
 * 方案：窗口始终是「面板宽度」的原生窗口，收起时把它整体向右移出屏幕，
 * 只留 TRIGGER_WIDTH 像素在可用工作区内。展开/收起 = 主进程按 16ms 帧
 * 逐步 setBounds 的位移动画，用状态机（collapsed/expanding/expanded/collapsing）
 * 保证动画期间不会重复触发，避免抖动。
 */
export class EdgeDock {
  private phase: DockPhase = 'collapsed'
  private x = 0
  private geometry: DockGeometry
  private started = false
  private disposed = false
  /** 编辑器是否持有焦点：聚焦时鼠标离开也不收起，避免打字途中的面板突然消失 */
  private editorFocused = false
  /** 是否正在拖动调整宽度：拖动期间不收起，避免面板在手里消失 */
  private resizing = false
  private pollTimer: NodeJS.Timeout | null = null
  private collapseTimer: NodeJS.Timeout | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private lastApplied: Rectangle | null = null

  constructor(
    private readonly win: BrowserWindow,
    private settings: EdgeNotesSettings,
    private readonly hooks: EdgeDockHooks
  ) {
    this.geometry = this.computeGeometry()
  }

  getPhase(): DockPhase {
    return this.phase
  }

  /** 定位到初始位置、显示窗口并开始监听鼠标 */
  start(): void {
    if (this.started || this.disposed) {
      return
    }
    this.started = true
    this.geometry = this.computeGeometry()
    this.phase = this.settings.pinnedOpen ? 'expanded' : 'collapsed'
    this.x = this.targetXFor(this.phase)
    this.applyBounds(true)
    this.win.setAlwaysOnTop(this.settings.alwaysOnTop)
    this.win.showInactive()

    screen.on('display-metrics-changed', this.handleDisplayChange)
    screen.on('display-added', this.handleDisplayChange)
    screen.on('display-removed', this.handleDisplayChange)
    this.pollTimer = setInterval(() => this.tick(), CURSOR_POLL_MS)

    log('dock-started', {
      phase: this.phase,
      requested: { x: this.x, y: this.geometry.y, width: this.geometry.width, height: this.geometry.height },
      applied: this.win.getBounds(),
      workArea: this.geometry.area,
      scaleFactor: this.geometry.scaleFactor,
      alwaysOnTop: this.win.isAlwaysOnTop()
    })
    this.hooks.onPhaseChange(this.phase)
  }

  /** 设置变化后重新应用（宽度/侧边/置顶/固定展开） */
  applySettings(next: EdgeNotesSettings): void {
    const previous = this.settings
    this.settings = next
    this.win.setAlwaysOnTop(next.alwaysOnTop)

    const layoutChanged = previous.side !== next.side || previous.width !== next.width
    if (layoutChanged) {
      this.stopAnimation()
      this.geometry = this.computeGeometry()
      this.phase = this.phase === 'expanded' || this.phase === 'expanding' ? 'expanded' : 'collapsed'
      this.x = this.targetXFor(this.phase)
      this.applyBounds(true)
      log('layout-reapplied', {
        phase: this.phase,
        requested: { x: this.x, y: this.geometry.y, width: this.geometry.width, height: this.geometry.height },
        applied: this.win.getBounds(),
        workArea: this.geometry.area
      })
      this.hooks.onPhaseChange(this.phase)
    }

    log('settings-applied', {
      from: previous,
      to: next,
      isAlwaysOnTop: this.win.isAlwaysOnTop()
    })

    if (next.pinnedOpen && !previous.pinnedOpen) {
      this.expand('pin-enabled')
      return
    }
    if (!next.pinnedOpen && previous.pinnedOpen) {
      if (this.phase === 'expanded' && !this.hitTestPanel(screen.getCursorScreenPoint())) {
        this.scheduleCollapse('pin-disabled')
      }
    }
  }

  /** 编辑器焦点变化：聚焦期间不自动收起 */
  setEditorFocused(focused: boolean): void {
    if (this.editorFocused === focused) {
      return
    }
    this.editorFocused = focused
    log('editor-focus-changed', { focused, phase: this.phase })
    if (focused) {
      this.cancelCollapse('editor-focused')
    }
  }

  /** 拖动调整宽度期间不收起 */
  setResizing(value: boolean): void {
    if (this.resizing === value) {
      return
    }
    this.resizing = value
    log('resizing-changed', { resizing: value, phase: this.phase })
    if (value) {
      this.cancelCollapse('resizing')
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.stopAnimation()
    this.clearCollapseTimer()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    screen.removeListener('display-metrics-changed', this.handleDisplayChange)
    screen.removeListener('display-added', this.handleDisplayChange)
    screen.removeListener('display-removed', this.handleDisplayChange)
  }

  // ---------------------------------------------------------------- 鼠标轮询

  private tick(): void {
    if (this.disposed || this.win.isDestroyed()) {
      return
    }
    const point = screen.getCursorScreenPoint()

    // 固定展开 / 编辑器聚焦 / 正在拖动宽度时，鼠标离开也不收起
    if (this.settings.pinnedOpen || this.editorFocused || this.resizing) {
      this.cancelCollapse('suppressed')
      if (this.phase === 'collapsed' || this.phase === 'collapsing') {
        this.expand(this.settings.pinnedOpen ? 'pinned' : this.resizing ? 'resizing' : 'editor-focused')
      }
      return
    }

    switch (this.phase) {
      case 'collapsed':
        if (this.hitTestTrigger(point)) {
          this.expand('trigger-hover')
        }
        break
      case 'collapsing':
        // 收起动画途中鼠标回来：立刻反向展开，用户感觉是「取消收起」
        if (this.hitTestPanel(point) || this.hitTestTrigger(point)) {
          this.expand('cursor-return')
        }
        break
      case 'expanding':
        // 动画进行中不做任何判断，由动画完成回调统一处理，避免抖动
        break
      case 'expanded':
        if (this.hitTestPanel(point)) {
          this.cancelCollapse('pointer-inside')
        } else {
          this.scheduleCollapse('pointer-away')
        }
        break
    }
  }

  private hitTestTrigger(point: Point): boolean {
    if (!this.isOnDockDisplay(point)) {
      return false
    }
    const area = this.geometry.area
    if (point.y < area.y - HIT_TOLERANCE_PX || point.y > area.y + area.height + HIT_TOLERANCE_PX) {
      return false
    }
    if (this.settings.side === 'right') {
      return point.x >= this.geometry.collapsedX - HIT_TOLERANCE_PX && point.x <= area.x + area.width + HIT_TOLERANCE_PX
    }
    return point.x >= area.x - HIT_TOLERANCE_PX && point.x <= area.x + TRIGGER_WIDTH + HIT_TOLERANCE_PX
  }

  private hitTestPanel(point: Point): boolean {
    if (!this.isOnDockDisplay(point)) {
      return false
    }
    const area = this.geometry.area
    if (point.y < area.y - HIT_TOLERANCE_PX || point.y > area.y + area.height + HIT_TOLERANCE_PX) {
      return false
    }
    if (this.settings.side === 'right') {
      return point.x >= this.geometry.expandedX - PANEL_HIT_SLOP && point.x <= area.x + area.width + HIT_TOLERANCE_PX
    }
    return point.x >= area.x - HIT_TOLERANCE_PX && point.x <= area.x + this.geometry.width + PANEL_HIT_SLOP
  }

  private isOnDockDisplay(point: Point): boolean {
    return screen.getDisplayNearestPoint(point).id === this.geometry.displayId
  }

  // -------------------------------------------------------------- 状态与动画

  private expand(reason: string): void {
    if (this.disposed || this.win.isDestroyed()) {
      return
    }
    if (this.phase === 'expanded' || this.phase === 'expanding') {
      return
    }
    this.clearCollapseTimer()
    this.phase = 'expanding'
    log('expand-start', {
      reason,
      fromX: this.x,
      targetX: this.geometry.expandedX,
      cursor: screen.getCursorScreenPoint()
    })
    this.hooks.onPhaseChange(this.phase)

    this.animateTo(this.geometry.expandedX, EXPAND_ANIMATION_MS, () => {
      this.phase = 'expanded'
      log('expanded', { reason, x: this.x, bounds: this.win.getBounds() })
      this.hooks.onPhaseChange(this.phase)
      // 快速划过触发条的情况：展开完成后光标已不在面板上，直接进入延迟收起
      if (!this.settings.pinnedOpen && !this.hitTestPanel(screen.getCursorScreenPoint())) {
        this.scheduleCollapse('pointer-left-during-expand')
      }
    })
  }

  private collapse(reason: string): void {
    if (this.disposed || this.win.isDestroyed()) {
      return
    }
    if (this.phase === 'collapsed' || this.phase === 'collapsing') {
      return
    }
    this.clearCollapseTimer()
    this.phase = 'collapsing'
    log('collapse-start', {
      reason,
      fromX: this.x,
      targetX: this.geometry.collapsedX,
      cursor: screen.getCursorScreenPoint()
    })
    this.hooks.onPhaseChange(this.phase)

    this.animateTo(this.geometry.collapsedX, EXPAND_ANIMATION_MS, () => {
      this.phase = 'collapsed'
      log('collapsed', { reason, x: this.x, bounds: this.win.getBounds() })
      this.hooks.onPhaseChange(this.phase)
    })
  }

  private animateTo(targetX: number, durationMs: number, onDone: () => void): void {
    this.stopAnimation()
    const startX = this.x
    const delta = targetX - startX
    if (Math.abs(delta) < 0.5) {
      this.moveTo(targetX)
      onDone()
      return
    }
    const startedAt = Date.now()
    let frames = 0
    const step = (): void => {
      if (this.disposed || this.win.isDestroyed()) {
        this.frameTimer = null
        return
      }
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs)
      const eased = 1 - Math.pow(1 - progress, 3)
      this.moveTo(startX + delta * eased)
      frames += 1
      if (progress >= 1) {
        this.frameTimer = null
        log('animation-end', { frames, x: this.x })
        onDone()
        return
      }
      this.frameTimer = setTimeout(step, FRAME_INTERVAL_MS)
    }
    step()
  }

  private stopAnimation(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer)
      this.frameTimer = null
    }
  }

  private moveTo(x: number): void {
    if (this.disposed || this.win.isDestroyed()) {
      return
    }
    const next: Rectangle = {
      x: Math.round(x),
      y: this.geometry.y,
      width: this.geometry.width,
      height: this.geometry.height
    }
    this.x = next.x
    if (
      this.lastApplied &&
      next.x === this.lastApplied.x &&
      next.y === this.lastApplied.y &&
      next.width === this.lastApplied.width &&
      next.height === this.lastApplied.height
    ) {
      return
    }
    this.win.setBounds(next)
    this.lastApplied = next
  }

  private applyBounds(force: boolean): void {
    if (force) {
      this.lastApplied = null
    }
    this.moveTo(this.x)
  }

  // ------------------------------------------------------------ 延迟收起定时

  private scheduleCollapse(reason: string): void {
    if (this.collapseTimer || this.settings.pinnedOpen || this.disposed) {
      return
    }
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null
      if (this.settings.pinnedOpen || this.editorFocused || this.resizing) {
        return
      }
      this.collapse(`auto:${reason}`)
    }, COLLAPSE_DELAY_MS)
    log('collapse-scheduled', { reason, delayMs: COLLAPSE_DELAY_MS })
  }

  private cancelCollapse(reason: string): void {
    if (!this.collapseTimer) {
      return
    }
    clearTimeout(this.collapseTimer)
    this.collapseTimer = null
    log('collapse-cancelled', { reason })
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer) {
      clearTimeout(this.collapseTimer)
      this.collapseTimer = null
    }
  }

  // ------------------------------------------------------------------ 几何量

  private computeGeometry(): DockGeometry {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    const maxWidth = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, area.width - SCREEN_EDGE_MARGIN))
    const width = Math.min(Math.max(Math.round(this.settings.width), PANEL_WIDTH_MIN), maxWidth)
    const rightEdge = area.x + area.width

    const expandedX = this.settings.side === 'right' ? rightEdge - width : area.x
    const collapsedX = this.settings.side === 'right' ? rightEdge - TRIGGER_WIDTH : area.x - (width - TRIGGER_WIDTH)

    return {
      displayId: display.id,
      scaleFactor: display.scaleFactor,
      area,
      width,
      height: area.height,
      y: area.y,
      collapsedX,
      expandedX
    }
  }

  private targetXFor(phase: DockPhase): number {
    return phase === 'collapsed' || phase === 'collapsing' ? this.geometry.collapsedX : this.geometry.expandedX
  }

  private readonly handleDisplayChange = (): void => {
    if (this.disposed) {
      return
    }
    const previousArea = this.geometry.area
    this.geometry = this.computeGeometry()
    this.x = this.targetXFor(this.phase)
    this.applyBounds(true)
    log('display-changed', {
      previousArea,
      workArea: this.geometry.area,
      phase: this.phase,
      bounds: this.win.getBounds()
    })
  }
}
