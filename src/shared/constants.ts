/** 主进程窗口行为的关键常量，渲染层可用作展示提示。 */

/** 收起时仍留在屏幕内的触发条宽度（px / DIP） */
export const TRIGGER_WIDTH = 4

/** 默认面板宽度（DIP） */
export const PANEL_WIDTH_DEFAULT = 350

/** 宽度可调范围：下限保证还能写字，上限避免占满屏幕 */
export const PANEL_WIDTH_MIN = 280
export const PANEL_WIDTH_MAX = 600

/** 面板与屏幕边缘至少保留的空间，避免大屏以外的地方宽度失控 */
export const SCREEN_EDGE_MARGIN = 120

/** 自动收起延迟：三档可选 */
export const COLLAPSE_DELAY_OPTIONS = [300, 700, 1200] as const
export const COLLAPSE_DELAY_DEFAULT = 700

/** 展开/收起动画时长 */
export const EXPAND_ANIMATION_MS = 180

/** 切换左右停靠时的平移时长 */
export const SIDE_SWITCH_ANIMATION_MS = 220

/** 动画帧间隔 */
export const FRAME_INTERVAL_MS = 16

/** 主进程轮询鼠标位置的间隔 */
export const CURSOR_POLL_MS = 40
