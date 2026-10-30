import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { log } from './log'

const SETTINGS_FILE = 'edge-notes-settings.json'
const NOTE_FILE = 'edge-notes-note.txt'
const POINTER_FILE = 'data-location.json'

/**
 * 数据目录指针文件放在**默认** userData 里，而不是当前数据目录里：
 * 否则改了目录之后，下次启动就找不到"我把数据放哪了"。
 */
export function pointerPath(): string {
  return process.env.EDGE_NOTES_POINTER ?? path.join(app.getPath('appData'), 'Edge Notes Desktop', POINTER_FILE)
}

function readPointer(): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(pointerPath(), 'utf8'))
    const dir = raw && typeof raw === 'object' ? (raw as { dataDir?: unknown }).dataDir : null
    return typeof dir === 'string' && dir && existsSync(dir) ? dir : null
  } catch {
    // 没有指针文件 / JSON 损坏 / 目标目录已被删除：交给后续逻辑回落
    return null
  }
}

/** 找一个可写的非系统盘（用户要求默认不落 C 盘） */
function pickNonSystemDrive(): string | null {
  for (const letter of ['D', 'E', 'F', 'G', 'H']) {
    const root = `${letter}:\\`
    try {
      if (!existsSync(root)) {
        continue
      }
      return root
    } catch {
      continue
    }
  }
  return null
}

/**
 * 必须在 app ready 之前调用，且只调一次。
 * 优先级：显式环境变量 > 指针文件 > 首次运行自动选盘 > 系统默认（%APPDATA%）。
 */
export function resolveUserDataDir(): void {
  const explicit = process.env.EDGE_NOTES_DATA_DIR
  if (explicit && existsSync(explicit)) {
    app.setPath('userData', explicit)
    log('data-dir-selected', { source: 'env', dir: explicit })
    return
  }

  // --user-data-dir 会被 Chromium 从 argv 里吃掉，只能看 userData 是否已被改写来判断"是否外部指定"
  const pointerOverride = process.env.EDGE_NOTES_POINTER
  if (!pointerOverride && !isDefaultUserData()) {
    log('data-dir-selected', { source: 'explicit-user-data', dir: app.getPath('userData') })
    return
  }

  const pointerDir = readPointer()
  if (pointerDir) {
    app.setPath('userData', pointerDir)
    log('data-dir-selected', { source: 'pointer', dir: pointerDir })
    return
  }

  // 测试显式指定了指针路径但还没生成指针文件：也不要自作主张换盘
  if (pointerOverride) {
    return
  }

  const drive = pickNonSystemDrive()
  if (!drive) {
    log('data-dir-selected', { source: 'default', dir: app.getPath('userData') })
    return
  }
  const dir = path.join(drive, 'Edge Notes Data')
  try {
    mkdirSync(dir, { recursive: true })
    // 之前的数据可能已经在系统默认目录里：先搬过去，别让人以为笔记丢了
    const previous = app.getPath('userData')
    let migrated = 0
    for (const name of [SETTINGS_FILE, NOTE_FILE]) {
      const src = path.join(previous, name)
      if (existsSync(src) && !existsSync(path.join(dir, name))) {
        copyFileSync(src, path.join(dir, name))
        migrated += 1
      }
    }
    mkdirSync(path.dirname(pointerPath()), { recursive: true })
    writeFileSync(pointerPath(), `${JSON.stringify({ dataDir: dir }, null, 2)}\n`, 'utf8')
    app.setPath('userData', dir)
    log('data-dir-selected', { source: 'first-run-default', dir, migratedFrom: previous, migrated })
  } catch (error) {
    log('data-dir-default-failed', { dir, message: error instanceof Error ? error.message : String(error) })
  }
}

export interface DataDirInfo {
  /** 当前生效的数据目录 */
  current: string
  /** 是否为默认的 %APPDATA% 目录 */
  isDefault: boolean
  /** 指针文件位置（排查问题时有用） */
  pointer: string
}

function isDefaultUserData(): boolean {
  const current = path.resolve(app.getPath('userData')).toLowerCase()
  const fallback = path.resolve(path.join(app.getPath('appData'), 'Edge Notes Desktop')).toLowerCase()
  return current === fallback
}

export function getDataDirInfo(): DataDirInfo {
  const current = app.getPath('userData')
  const fallback = path.join(app.getPath('appData'), 'Edge Notes Desktop')
  return {
    current,
    isDefault: path.resolve(current).toLowerCase() === path.resolve(fallback).toLowerCase(),
    pointer: pointerPath()
  }
}

export interface MigrationResult {
  from: string
  to: string
  copied: string[]
  requiresRestart: boolean
}

/**
 * 迁移数据目录：先复制并逐文件校验，最后才写指针。
 * 任何一步失败都抛错，指针不动——不会出现"指针指向空目录、笔记看起来丢了"的状态。
 */
export function migrateDataDir(target: string): MigrationResult {
  const from = app.getPath('userData')
  const to = path.resolve(target)
  if (to.toLowerCase() === path.resolve(from).toLowerCase()) {
    throw new Error('目标目录与当前数据目录相同')
  }
  if (!existsSync(to)) {
    mkdirSync(to, { recursive: true })
  }
  if (existsSync(path.join(to, NOTE_FILE)) || existsSync(path.join(to, SETTINGS_FILE))) {
    throw new Error('目标目录里已经有 Edge Notes 的数据，请另选一个空目录')
  }

  const copied: string[] = []
  for (const name of [SETTINGS_FILE, NOTE_FILE]) {
    const src = path.join(from, name)
    if (!existsSync(src)) {
      continue
    }
    const dest = path.join(to, name)
    copyFileSync(src, dest)
    if (statSync(src).size !== statSync(dest).size) {
      throw new Error(`迁移校验失败：${name} 大小不一致`)
    }
    copied.push(name)
  }

  mkdirSync(path.dirname(pointerPath()), { recursive: true })
  writeFileSync(pointerPath(), `${JSON.stringify({ dataDir: to }, null, 2)}\n`, 'utf8')
  log('data-dir-migrated', { from, to, copied })
  return { from, to, copied, requiresRestart: true }
}
