import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { log } from './log'

const SETTINGS_FILE = 'edge-notes-settings.json'
/** 多笔记：索引 + 每篇一个 md */
const NOTES_INDEX_FILE = 'notes-index.json'
const NOTES_DIR = 'notes'
/** 单篇笔记时代的历史文件名，迁移时一起带走，避免升级用户的笔记留在旧目录 */
const LEGACY_NOTE_FILE = 'edge-notes-note.md'
const LEGACY_TEXT_FILE = 'edge-notes-note.txt'
/** 图片附件目录：笔记里写的是 attachments/xxx.png 相对路径，搬家时必须整目录带走 */
const ATTACHMENT_DIR = 'attachments'
const POINTER_FILE = 'data-location.json'

/** 复制一个"目录下所有文件"（只一层，与附件/笔记目录结构一致） */
function copyFlatDirectory(source: string, target: string, written: string[]): number {
  if (!existsSync(source)) {
    return 0
  }
  mkdirSync(target, { recursive: true })
  const entries = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isFile())
  let copied = 0
  for (const entry of entries) {
    const src = path.join(source, entry.name)
    const dest = path.join(target, entry.name)
    copyVerified(src, dest)
    written.push(dest)
    copied += 1
  }
  if (copied !== entries.length) {
    throw new Error(`文件数量校验失败：应有 ${entries.length} 个，实际复制 ${copied} 个`)
  }
  return copied
}

const FS_REASON: Record<string, string> = {
  ENOSPC: '磁盘空间不足',
  EACCES: '没有写入权限',
  EPERM: '没有写入权限',
  EEXIST: '目标已存在',
  ENOTDIR: '目标路径不可用',
  EISDIR: '目标路径被占用',
  ENOENT: '路径不存在',
  EBUSY: '文件正被占用'
}

function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (!code) {
    return error instanceof Error ? error.message : String(error)
  }
  return `${FS_REASON[code] ?? '文件操作失败'}（${code}）`
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** 复制单个文件并做 SHA-256 一致性校验；不一致就删掉目标文件并抛错 */
function copyVerified(src: string, dest: string): void {
  copyFileSync(src, dest)
  if (sha256(src) !== sha256(dest)) {
    rmSync(dest, { force: true })
    throw new Error(`文件内容校验失败（SHA-256 不一致）：${path.basename(src)}`)
  }
}

/**
 * 复制附件目录（只处理一层，与附件协议的白名单保持一致）。
 * 返回复制的文件数；每个文件都做 SHA-256 校验，并核对文件数量。
 * `written` 用于失败回滚，避免在目标目录留下半套数据。
 */
function copyAttachments(from: string, to: string, written: string[]): number {
  return copyFlatDirectory(path.join(from, ATTACHMENT_DIR), path.join(to, ATTACHMENT_DIR), written)
}

/** 多笔记的正文文件：notes/<id>.md 必须整目录带走，否则换盘后笔记全丢 */
function copyNotes(from: string, to: string, written: string[]): number {
  return copyFlatDirectory(path.join(from, NOTES_DIR), path.join(to, NOTES_DIR), written)
}

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

  // 便携版优先于指针文件：electron-builder 的 portable 目标会注入原始 exe 所在目录，
  // 数据就放在它旁边，U 盘拔走整套数据一起走（否则会读到本机 %APPDATA% 里的旧指针）
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir && existsSync(portableDir)) {
    const portableDataDir = path.join(portableDir, 'Edge Notes Data')
    try {
      mkdirSync(portableDataDir, { recursive: true })
      app.setPath('userData', portableDataDir)
      log('data-dir-selected', { source: 'portable', dir: portableDataDir })
      return
    } catch (error) {
      log('data-dir-portable-failed', {
        dir: portableDataDir,
        message: error instanceof Error ? error.message : String(error)
      })
    }
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
    const written: string[] = []
    let migrated = 0
    for (const name of [SETTINGS_FILE, NOTES_INDEX_FILE, LEGACY_NOTE_FILE, LEGACY_TEXT_FILE]) {
      const src = path.join(previous, name)
      const dest = path.join(dir, name)
      if (existsSync(src) && !existsSync(dest)) {
        copyVerified(src, dest)
        written.push(dest)
        migrated += 1
      }
    }
    // 正文与图片必须跟着走，否则换盘后笔记空、图片全部失效
    migrated += copyNotes(previous, dir, written)
    migrated += copyAttachments(previous, dir, written)
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
  if (
    existsSync(path.join(to, NOTES_INDEX_FILE)) ||
    existsSync(path.join(to, NOTES_DIR)) ||
    existsSync(path.join(to, LEGACY_NOTE_FILE)) ||
    existsSync(path.join(to, LEGACY_TEXT_FILE)) ||
    existsSync(path.join(to, SETTINGS_FILE))
  ) {
    throw new Error('目标目录里已经有 Edge Notes 的数据，请另选一个空目录')
  }

  const copied: string[] = []
  /** 已写入目标目录的文件，失败时逐个回滚，目标目录不会留下半套数据 */
  const written: string[] = []

  try {
    for (const name of [SETTINGS_FILE, NOTES_INDEX_FILE, LEGACY_NOTE_FILE, LEGACY_TEXT_FILE]) {
      const src = path.join(from, name)
      if (!existsSync(src)) {
        continue
      }
      const dest = path.join(to, name)
      copyVerified(src, dest)
      written.push(dest)
      copied.push(name)
    }

    const noteCount = copyNotes(from, to, written)
    if (noteCount > 0) {
      copied.push(`${NOTES_DIR}/ (${noteCount})`)
    }
    const attachmentCount = copyAttachments(from, to, written)

    // 指针最后写：只有数据确认到位才切换，失败时仍使用原目录
    mkdirSync(path.dirname(pointerPath()), { recursive: true })
    writeFileSync(pointerPath(), `${JSON.stringify({ dataDir: to }, null, 2)}\n`, 'utf8')
    log('data-dir-migrated', { from, to, copied, notes: noteCount, attachments: attachmentCount })
    return { from, to, copied, requiresRestart: true }
  } catch (error) {
    for (const file of written.reverse()) {
      rmSync(file, { force: true })
    }
    const message = describeFsError(error)
    log('data-dir-migrate-failed', { from, to, message })
    throw new Error(`数据迁移失败：${message}；原始数据未改动`)
  }
}
