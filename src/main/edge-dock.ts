import { BrowserWindow, screen } from 'electron'
import type { Point, Rectangle } from 'electron'
import type { DockPhase, EdgeNotesSettings } from '../shared/api'
import {
  CURSOR_POLL_MS,
  EXPAND_ANIMATION_MS,
  FRAME_INTERVAL_MS,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  SCREEN_EDGE_MARGIN,
  SIDE_SWITCH_ANIMATION_MS,
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
/**
 * 重新抬层的最小间隔。抬层在"未置顶"时会短暂切换一次置顶状态，
 * 鼠标在面板上来回移动时如果每 60ms 抬一次，看起来就是窗口在闪。
 */
const RAISE_THROTTLE_MS = 600

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
  /** 是否隐藏到托盘：窗口整体不可见，但鼠标贴边仍可召回 */
  private hidden = false
  /**
   * 隐藏后是否已经"离开过触发条"。
   * 用户在屏幕边缘按 Alt+F4 / 点隐藏时，指针本来就停在触发条上，
   * 不加这个门闩就会"刚藏起来立刻被自己的鼠标叫回来"。
   */
  private hoverWakeArmed = false
  /** 上一次轮询到的指针位置：用来判断"用户在动鼠标"，静态悬停不会反复抬层 */
  private lastCursor: Point = { x: Number.NaN, y: Number.NaN }
  /** 上次抬层时间：抬层会短暂切换置顶状态，必须限流，否则会闪 */
  private lastRaiseAt = 0
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

  isHidden(): boolean {
    return this.hidden
  }

  /** 从托盘/菜单主动唤出面板；若处于隐藏态则先恢复 */
  showPanel(reason = 'external'): void {
    if (this.disposed) {
      return
    }
    if (this.hidden) {
      // 把唤出原因带下去，日志里才分得清"托盘 / 快捷键 / 二次启动"
      this.setHidden(false, reason)
      return
    }
    if (this.phase === 'expanded' || this.phase === 'expanding') {
      // 已经展开但可能被浏览器盖住：唤出动作一律把它抬到最前，而不是什么都不做
      this.raise()
      log('panel-raised-by-wake', { reason, phase: this.phase })
      return
    }
    this.expand(reason)
  }

  /**
   * 隐藏到托盘 / 从托盘恢复。
   * 隐藏与"收起"是两件事：收起仍留有 4px 触发条（鼠标一碰就回），
   * 隐藏则把窗口整个藏起来，鼠标贴边也不会唤出，只能从托盘恢复。
   */
  setHidden(hidden: boolean, wakeReason = 'tray-show'): void {
    if (this.disposed || this.hidden === hidden) {
      return
    }
    this.hidden = hidden
    this.stopAnimation()
    this.clearCollapseTimer()

    if (hidden) {
      this.phase = 'collapsed'
      this.x = this.geometry.collapsedX
      this.applyBounds(true)
      this.win.hide()
      // 指针若还停在触发条上，必须先移开再回来才算"主动召回"
      this.hoverWakeArmed = !this.hitTestTrigger(screen.getCursorScreenPoint())
      log('hidden-changed', { hidden, phase: this.phase, hoverWakeArmed: this.hoverWakeArmed })
      this.hooks.onPhaseChange(this.phase)
      return
    }
    this.hoverWakeArmed = false

    this.geometry = this.computeGeometry()
    this.phase = 'collapsed'
    this.x = this.geometry.collapsedX
    this.applyBounds(true)
    this.win.showInactive()
    log('hidden-changed', { hidden, phase: this.phase })
    this.hooks.onPhaseChange(this.phase)
    // 从托盘/快捷键恢复后直接滑出，用户能立刻确认"它回来了"，随后照常按延迟收起
    this.expand(wakeReason)
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

    const sideChanged = previous.side !== next.side
    const widthChanged = previous.width !== next.width
    if (sideChanged || widthChanged) {
      const wasExpanded = this.phase === 'expanded' || this.phase === 'expanding'
      this.stopAnimation()
      this.geometry = this.computeGeometry()

      if (wasExpanded && sideChanged) {
        // 换侧：可见状态下做一次平移过渡，而不是瞬移
        this.phase = 'expanding'
        log('side-transition-start', { fromX: this.x, targetX: this.geometry.expandedX })
        this.hooks.onPhaseChange(this.phase)
        this.animateTo(this.geometry.expandedX, SIDE_SWITCH_ANIMATION_MS, () => {
          this.phase = 'expanded'
          log('expanded', { reason: 'side-switch', x: this.x, bounds: this.win.getBounds() })
          this.hooks.onPhaseChange(this.phase)
        })
      } else {
        // 宽度拖动必须跟手，收起态只露 4px 也无需过渡
        this.phase = wasExpanded ? 'expanded' : 'collapsed'
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

  /**
   * 释放"正在拖动"标记。
   * 指针捕获有可能在窗口失去焦点、用户拖到窗口外松手时丢失，标记卡住会表现成"面板再也不自动收起"。
   */
  releaseResizeLock(): void {
    if (!this.resizing) {
      return
    }
    this.resizing = false
    log('resizing-released', { reason: 'window-blur' })
  }

  /** 渲染进程崩溃/重载后，渲染层不可能再发来状态，抑制标记必须重置，否则面板会永远不收起 */
  resetInteractionLocks(): void {
    if (!this.editorFocused && !this.resizing) {
      return
    }
    log('interaction-locks-reset', { editorFocused: this.editorFocused, resizing: this.resizing })
    this.editorFocused = false
    this.resizing = false
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
    const moved = point.x !== this.lastCursor.x || point.y !== this.lastCursor.y
    this.lastCursor = point
    // 隐藏后鼠标贴边仍然可以召回：隐藏只是"完全离开可见区"，
    // 不能因此把用户逼成"必须去点托盘图标"（那是真实的体验抱怨）。
    if (this.hidden) {
      if (this.hitTestTrigger(point)) {
        if (this.hoverWakeArmed) {
          log('hidden-wake', { reason: 'trigger-hover' })
          this.setHidden(false)
        }
        return
      }
      if (!this.hoverWakeArmed) {
        this.hoverWakeArmed = true
        log('hidden-wake-armed', {})
      }
      return
    }

    // 面板已经展开、但用户去点了浏览器/别的窗口 → 它会被压到下层。
    // 指针一回到面板上就重新抬起来，"随时可唤"才对。
    this.maybeReRaise(point, moved)

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

  /**
   * 已展开却被压到下层（用户点了浏览器）时，指针回到面板上就把它抬回来。
   * 只在指针真的移动时触发：静态悬停不反复抬层，避免窗口在眼前闪。
   */
  private maybeReRaise(point: Point, moved: boolean): void {
    if (!moved || this.disposed || this.win.isDestroyed()) {
      return
    }
    if (this.phase !== 'expanded' && this.phase !== 'expanding') {
      return
    }
    if (!this.hitTestPanel(point) || this.win.isFocused()) {
      return
    }
    if (Date.now() - this.lastRaiseAt < RAISE_THROTTLE_MS) {
      return
    }
    this.raise()
    log('panel-re-raised', { reason: 'pointer-over-covered-panel', phase: this.phase })
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
    // 展开一定看得见：置顶开关关掉、浏览器最大化时，面板原本会被压在下面，
    // 表现就是"鼠标划到右边缘什么也没有"。moveTop 只抬 Z 序，不抢键盘焦点。
    this.raise()
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

  /**
   * 把面板抬到其它窗口之上，但不抢焦点（moveTop 等价于 SetWindowPos 的 HWND_TOP，
   * 不调用 SetForegroundWindow）。这样用户正在浏览器里打字时，鼠标贴边也能看见面板。
   */
  private raise(): void {
    if (this.disposed || this.win.isDestroyed()) {
      return
    }
    if (!this.win.isVisible()) {
      this.win.showInactive()
    }
    if (this.settings.alwaysOnTop) {
      // 已经是置顶窗口，moveTop 只是在本层里排到最前
      this.win.moveTop()
    } else {
      // 未置顶时 moveTop 会被前台窗口的激活顺序压回去（实测系统 Z 序仍是面板在下），
      // 改为"瞬间置顶再取消"：HWND_NOTOPMOST 会把窗口放到普通窗口层的最上面，
      // 同时不抢键盘焦点（不会把用户正在打的字抢过来）。
      this.win.setAlwaysOnTop(true)
      this.win.setAlwaysOnTop(false)
    }
    this.lastRaiseAt = Date.now()
    log('panel-raised', { phase: this.phase, alwaysOnTop: this.settings.alwaysOnTop })
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
    }, this.settings.collapseDelay)
    log('collapse-scheduled', { reason, delayMs: this.settings.collapseDelay })
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
      // 只接受整数 DIP。实测（DWM 可见矩形）150% 缩放下窗口可见底边比工作区底边多 1 物理像素，
      // 这是 DIP→物理像素两次取整的固有误差；试过主动减 1 DIP，系统仍会进位回去，
      // 所以不做无依据的补偿，而是在测试里用物理像素守住"最多 1px"这条线。
      height: Math.floor(area.height),
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
