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

/**
 * 未打包时 Windows 启动项不可靠：实测 Electron 的 setLoginItemSettings 回读 launchItems 说已注册，
 * 但 HKCU\...\Run 里并没有对应项，几秒后回读又变回 false（打包前后行为不一致）。
 * 这种情况按"不支持"处理，绝不把回读到的短暂 true 当成成功。
 */
const DEV_UNSUPPORTED = '开发模式（未打包）下 Windows 启动项不可靠；打包版可用'

/** 以系统回读为准，而不是我们"以为"的状态 */
export function readLoginItem(): LoginItemState {
  if (!app.isPackaged) {
    return { supported: false, enabled: false, active: false, message: DEV_UNSUPPORTED }
  }
  try {
    const state = app.getLoginItemSettings({ path: process.execPath, args: launchArgs() })
    // openAtLogin = 启动项是否存在（用户的意图）；executableWillLaunchAtLogin = 系统是否真的会启动它。
    // Windows 的"启动应用"里被关掉时两者不一致，这时必须如实告诉用户，而不是显示"已开启"。
    const enabled = state.openAtLogin === true
    const active = state.executableWillLaunchAtLogin ?? enabled
    const parts: string[] = []
    if (!app.isPackaged) {
      parts.push('开发模式下注册的是 node_modules 里的 Electron；打包后指向应用本体')
    }
    if (enabled && !active) {
      parts.push('启动项已写入，但被 Windows「启动应用」禁用，实际不会自动启动')
    }
    return {
      supported: true,
      enabled,
      active,
      message: parts.length > 0 ? parts.join('；') : null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('login-item-read-failed', { message })
    return { supported: false, enabled: false, active: false, message }
  }
}

/** 写入后立刻回读校验；系统没接受就抛错，绝不返回"假的成功" */
export function applyLoginItem(enabled: boolean): LoginItemState {
  if (!app.isPackaged) {
    throw new Error(`${DEV_UNSUPPORTED}；本次未写入任何启动项`)
  }
  // Windows 上还要带 enabled：它同时改写 StartupApproved 的启用位，
  // 用户在"启动应用"里手动关过时，只写 Run 项会被系统判为未启用。
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: process.execPath, args: launchArgs() })
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
