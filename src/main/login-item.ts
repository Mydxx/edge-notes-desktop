import { app, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { LoginItemState } from '../shared/api'
import { log } from './log'

/**
 * 开机启动（Windows）：用「启动」文件夹里的快捷方式，不再写注册表 Run 键。
 *
 * 为什么要换：上一版把 `"electron.exe" "<项目>" --autostart` 直接写进
 * HKCU\...\Run。联想电脑管家这类安全软件会把"程序往 Run 键里塞 electron.exe"
 * 当成可疑行为，反复弹窗提醒（用户真实反馈）。
 * 「启动」文件夹里的 .lnk 是 Windows 最传统、用户完全可见的方式：
 * 用户自己会看到、也能自己拖动/删除，安全软件按"用户自己的启动项"处理，不再反复拦截。
 *
 * 另外：旧版写过的 Run 项会在启动和开关时主动清掉，避免同一功能留两份、
 * 也避免安全软件继续盯着那条旧记录。
 */
const SHORTCUT_NAME = 'Edge Notes Desktop.lnk'
const LEGACY_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const LEGACY_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
/** Windows「启动应用」里对启动文件夹项的启用/禁用标记，值名就是快捷方式文件名 */
const FOLDER_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
const LEGACY_VALUE_NAME = 'Edge Notes Desktop'
const IS_WINDOWS = process.platform === 'win32'

function startupDir(): string {
  // %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup —— 资源管理器里输入 shell:startup 就是它
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

function shortcutPath(): string {
  return path.join(startupDir(), SHORTCUT_NAME)
}

/** 快捷方式的参数：打包版什么都不带，开发模式带上项目目录（界面取上次构建结果） */
function shortcutArgs(): string {
  return app.isPackaged ? '' : `"${app.getAppPath()}" --autostart`
}

function reg(args: string[]): string | null {
  try {
    return execFileSync('reg', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    // 值不存在 / 无权限 / reg 不可用：统一按"查询失败"处理
    return null
  }
}

/** 查询某个值的原始数据；不存在返回 null */
function queryValue(key: string, name: string): string | null {
  const output = reg(['query', key, '/v', name])
  if (!output) {
    return null
  }
  const line = output.split(/\r?\n/).find((item) => item.includes(name) && /REG_(SZ|EXPAND_SZ|BINARY)/.test(item))
  if (!line) {
    return null
  }
  return line.replace(/^.*?REG_(?:SZ|EXPAND_SZ|BINARY)\s*/, '').trim()
}

/** Windows 的「启动应用」开关：首字节 02/06 为启用，03/07 为用户禁用 */
function disabledByStartupApproved(): boolean {
  const raw = queryValue(FOLDER_APPROVED_KEY, SHORTCUT_NAME)
  if (!raw) {
    return false
  }
  const first = Number.parseInt(raw.replace(/[^0-9a-fA-F]/g, '').slice(0, 2), 16)
  return first === 3 || first === 7
}

function clearStartupApproved(): void {
  // 清掉"被禁用"的标记，否则用户关过一次后即使重建快捷方式也不会自动启动
  reg(['delete', FOLDER_APPROVED_KEY, '/v', SHORTCUT_NAME, '/f'])
}

/**
 * 清理历史遗留：旧版写进注册表 Run 的那条 electron.exe 记录。
 * 这是安全软件一直在弹窗的源头，开关一次开机启动、或每次启动时都会顺手删掉。
 */
export function removeLegacyRunEntry(): void {
  if (!IS_WINDOWS) {
    return
  }
  const legacy: Array<[string, string]> = [
    [LEGACY_RUN_KEY, LEGACY_VALUE_NAME],
    [LEGACY_APPROVED_KEY, LEGACY_VALUE_NAME]
  ]
  for (const [key, name] of legacy) {
    if (reg(['query', key, '/v', name]) === null) {
      continue
    }
    if (reg(['delete', key, '/v', name, '/f']) === null) {
      log('legacy-run-entry-remove-failed', { key, name })
      continue
    }
    log('legacy-run-entry-removed', { key, name })
  }
}

/** 快捷方式当前指向的目标程序；读不出来返回空字符串 */
function shortcutTarget(): string {
  const lnk = shortcutPath()
  if (!existsSync(lnk)) {
    return ''
  }
  try {
    return shell.readShortcutLink(lnk).target ?? ''
  } catch (error) {
    log('shortcut-read-failed', { message: error instanceof Error ? error.message : String(error) })
    return ''
  }
}

function pointsToCurrentProgram(): boolean {
  const target = shortcutTarget()
  if (!target) {
    return false
  }
  return path.resolve(target).toLowerCase() === path.resolve(process.execPath).toLowerCase()
}

function writeShortcut(): void {
  mkdirSync(startupDir(), { recursive: true })
  const target = shortcutPath()
  // create 遇到已存在的文件会失败：先删再写，保证内容与当前安装位置一致
  rmSync(target, { force: true })
  const written = shell.writeShortcutLink(target, 'create', {
    target: process.execPath,
    args: shortcutArgs(),
    cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
    description: 'Edge Notes 笔记栏（开机自动启动）',
    icon: process.execPath,
    iconIndex: 0
  })
  if (!written) {
    throw new Error('开机启动设置未生效：无法创建「启动」文件夹里的快捷方式')
  }
}

function messages(enabled: boolean, matches: boolean): string | null {
  const parts: string[] = []
  if (!app.isPackaged) {
    parts.push('开发模式：快捷方式指向 node_modules 里的 Electron（界面取上次构建结果）')
  }
  if (enabled && !matches) {
    parts.push('快捷方式指向的程序已变化，重新开关一次即可修正')
  }
  if (enabled && disabledByStartupApproved()) {
    parts.push('已被 Windows「启动应用」禁用，登录后不会自动启动')
  }
  if (enabled && matches) {
    parts.push('启动方式：「启动」文件夹里的快捷方式（shell:startup 可查看）')
  }
  return parts.length > 0 ? parts.join('；') : null
}

/** 以系统现状为准，而不是我们"以为"的状态 */
export function readLoginItem(): LoginItemState {
  if (!IS_WINDOWS) {
    return {
      supported: false,
      enabled: false,
      active: false,
      message: '当前平台未实现开机启动（仅支持 Windows）'
    }
  }
  const enabled = existsSync(shortcutPath())
  if (!enabled) {
    return { supported: true, enabled: false, active: false, message: messages(false, true) }
  }
  const matches = pointsToCurrentProgram()
  return {
    supported: true,
    enabled: true,
    active: matches && !disabledByStartupApproved(),
    message: messages(true, matches)
  }
}

/** 写入/删除后立刻回读校验；系统没接受就抛错，绝不返回"假的成功" */
export function applyLoginItem(enabled: boolean): LoginItemState {
  if (!IS_WINDOWS) {
    throw new Error('当前平台不支持开机启动（仅 Windows）')
  }
  // 顺手清掉旧版注册表记录（安全软件的弹窗源头）
  removeLegacyRunEntry()

  if (enabled) {
    writeShortcut()
    clearStartupApproved()
  } else {
    rmSync(shortcutPath(), { force: true })
    clearStartupApproved()
  }

  const after = readLoginItem()
  log('login-item-applied', {
    requested: enabled,
    readback: after.enabled,
    active: after.active,
    shortcut: shortcutPath()
  })
  if (after.enabled !== enabled) {
    throw new Error(`开机启动设置未生效：系统回读为「${after.enabled ? '已启用' : '未启用'}」`)
  }
  return after
}

/** 启动时对齐：快捷方式被删/指向旧位置，按用户意愿重建一次；以系统为准 */
export function reconcileLoginItem(expected: boolean): boolean {
  const actual = readLoginItem()
  if (!actual.supported) {
    return false
  }
  const stale = expected && actual.enabled && !pointsToCurrentProgram()
  if (expected && (!actual.enabled || stale)) {
    try {
      applyLoginItem(true)
      log('login-item-restored', { reason: stale ? 'stale-target' : 'missing' })
      return true
    } catch (error) {
      log('login-item-restore-failed', { message: error instanceof Error ? error.message : String(error) })
      return false
    }
  }
  if (actual.enabled !== expected) {
    log('login-item-reconciled', { expected, actual: actual.enabled })
  }
  return actual.enabled
}
