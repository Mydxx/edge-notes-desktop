import { Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'
import { log } from './log'

export interface TrayHandlers {
  isHidden(): boolean
  isPinned(): boolean
  toggleHidden(): void
  togglePinned(): void
  openSettings(): void
  quit(): void
}

let tray: Tray | null = null

/** 图标随仓库提供，打包后从 resources/assets 读取，绝不依赖开发机的临时路径 */
function trayIconPath(): string {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'assets')
  return path.join(base, 'tray.png')
}

export function createTray(handlers: TrayHandlers): void {
  if (tray) {
    return
  }
  const iconPath = trayIconPath()
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    log('tray-icon-missing', { iconPath })
  }
  try {
    tray = new Tray(image)
  } catch (error) {
    // 托盘创建失败不应该让整个应用起不来
    log('tray-create-failed', { iconPath, message: error instanceof Error ? error.message : String(error) })
    tray = null
    return
  }
  tray.on('click', () => handlers.toggleHidden())
  refreshTray(handlers)
  log('tray-created', { iconPath, empty: image.isEmpty(), size: image.getSize() })
}

/** 状态变化后重建菜单（勾选态、显示/隐藏文案都要跟着变） */
export function refreshTray(handlers: TrayHandlers): void {
  if (!tray || tray.isDestroyed()) {
    return
  }
  const hidden = handlers.isHidden()
  const pinned = handlers.isPinned()
  const menu = Menu.buildFromTemplate([
    {
      label: hidden ? '显示笔记栏' : '隐藏笔记栏',
      click: () => handlers.toggleHidden()
    },
    {
      label: '固定展开',
      type: 'checkbox',
      checked: pinned,
      click: () => handlers.togglePinned()
    },
    { type: 'separator' },
    { label: '设置…', click: () => handlers.openSettings() },
    { type: 'separator' },
    { label: '退出 Edge Notes', click: () => handlers.quit() }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(hidden ? 'Edge Notes · 已隐藏到托盘' : 'Edge Notes · 鼠标贴屏幕边缘展开')
  log('tray-menu-built', { hidden, pinned, items: menu.items.map((item) => item.label || item.type) })
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
    log('tray-destroyed', {})
  }
  tray = null
}
