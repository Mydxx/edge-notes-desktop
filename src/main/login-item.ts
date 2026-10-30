import { app } from 'electron'
import type { LoginItemState } from '../shared/api'
import { log } from './log'

/**
 * 开机启动：Windows 下 Electron 用 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，
 * 不需要管理员权限。开发模式（未打包）下 exe 是 node_modules 里的 Electron，
 * 因此把项目目录作为参数带上，注册项才会启动真正的应用。
 */
function launchArgs(): string[] {
  return app.isPackaged ? [] : [app.getAppPath()]
}

/** 以系统回读为准，而不是我们"以为"的状态 */
export function readLoginItem(): LoginItemState {
  try {
    const state = app.getLoginItemSettings({ path: process.execPath, args: launchArgs() })
    return {
      supported: true,
      enabled: state.openAtLogin === true,
      message: app.isPackaged ? null : '开发模式下注册的是 node_modules 里的 Electron；打包后指向应用本体'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('login-item-read-failed', { message })
    return { supported: false, enabled: false, message }
  }
}

/** 写入后立刻回读校验；系统没接受就抛错，绝不返回"假的成功" */
export function applyLoginItem(enabled: boolean): LoginItemState {
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: launchArgs() })
  const after = readLoginItem()
  log('login-item-applied', { requested: enabled, readback: after.enabled })
  if (after.enabled !== enabled) {
    throw new Error(`开机启动设置未生效：系统回读为「${after.enabled ? '已启用' : '未启用'}」`)
  }
  return after
}

/** 启动时对齐：用户可能在 Windows 的"启动应用"里关掉了，以系统为准 */
export function reconcileLoginItem(expected: boolean): boolean {
  const actual = readLoginItem()
  if (!actual.supported || actual.enabled === expected) {
    return expected
  }
  log('login-item-reconciled', { expected, actual: actual.enabled })
  return actual.enabled
}
