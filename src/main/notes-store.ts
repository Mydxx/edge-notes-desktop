import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import type { NoteMeta, NotesIndexState, NoteSnapshot, NoteStatus, NoteSwitchResult, ViewMode } from '../shared/api'
import { log } from './log'

/** 单条笔记的长度上限，防止异常输入把磁盘写爆 */
const MAX_NOTE_LENGTH = 1_000_000
/** 停止输入后多久落盘 */
const SAVE_DEBOUNCE_MS = 600
/** 视图状态（滚动/光标）变化后多久写索引 */
const INDEX_DEBOUNCE_MS = 400
const MAX_TITLE_LENGTH = 60
const MAX_NOTES = 200

const NOTES_DIR = 'notes'
const INDEX_FILE = 'notes-index.json'
/** 单篇笔记时代的文件名（根目录），迁移后改名保留为备份 */
const LEGACY_NOTE_FILE = 'edge-notes-note.md'
const LEGACY_BACKUP_FILE = 'edge-notes-note.md.migrated'

const REASON_BY_CODE: Record<string, string> = {
  EPERM: '没有写入权限',
  EACCES: '没有写入权限',
  EISDIR: '目标位置被占用',
  ENOTDIR: '目标路径不可用',
  ENOSPC: '磁盘空间不足',
  ENOENT: '目标路径不存在',
  EBUSY: '文件正被占用'
}

function describeError(error: unknown): string {
  const err = error as NodeJS.ErrnoException
  const code = typeof err?.code === 'string' ? err.code : ''
  const reason = REASON_BY_CODE[code] ?? '磁盘写入失败'
  return code ? `${reason}（${code}）` : reason
}

function newNoteId(): string {
  return `n-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

export function normalizeTitle(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return (text || '未命名').slice(0, MAX_TITLE_LENGTH)
}

/** Windows 不允许出现在文件名里的字符 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g
/** Windows 设备保留名，直接当文件名会失败 */
const RESERVED_FILENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_FILENAME_LENGTH = 60

/**
 * 标签 → 文件名主干（不含 .md）。
 * 只做"能落盘"的清洗，不改用户看得见的标签本身：
 * 非法字符换成 `-`，去掉结尾的点和空格，避开 Windows 保留名。
 */
export function fileNameFromTitle(title: string): string {
  const cleaned = normalizeTitle(title)
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    // 连续的点会让人以为在上一级目录，也过不了索引校验，统一压成一个
    .replace(/\.{2,}/g, '.')
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_FILENAME_LENGTH)
    .trim()
  if (!cleaned) {
    return ''
  }
  return RESERVED_FILENAMES.test(cleaned) ? `_${cleaned}` : cleaned
}

/** 索引里记录的 file 必须是我们自己写的那种名字，防止索引被改成 `..\\evil.md` */
function sanitizeFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const name = raw.trim()
  if (!name.toLowerCase().endsWith('.md') || name.length > MAX_FILENAME_LENGTH + 8) {
    return undefined
  }
  // 用非全局正则做检测：带 g 的 lastIndex 会让连续调用互相干扰
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.includes('..')) {
    return undefined
  }
  return name
}

/** 从正文猜一个标题：优先一级标题，其次第一行非空文本 */
function guessTitle(content: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content)
  if (heading) {
    return normalizeTitle(heading[1])
  }
  const firstLine = content.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return normalizeTitle(firstLine ?? '我的笔记')
}

function createMeta(id: string, title: string, now = Date.now()): NoteMeta {
  return {
    id,
    title: normalizeTitle(title),
    createdAt: now,
    updatedAt: now,
    viewMode: 'edit',
    scrollTop: 0,
    caret: 0
  }
}

function clampNumber(raw: unknown, max: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  return Math.min(Math.max(Math.round(value), 0), max)
}

function sanitizeMeta(raw: unknown): NoteMeta | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const input = raw as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return null
  }
  const viewMode: ViewMode = input.viewMode === 'preview' ? 'preview' : 'edit'
  const file = sanitizeFileName(input.file)
  return {
    id,
    title: normalizeTitle(input.title),
    ...(file ? { file } : {}),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : Date.now(),
    viewMode,
    scrollTop: clampNumber(input.scrollTop, 2_000_000),
    caret: clampNumber(input.caret, MAX_NOTE_LENGTH)
  }
}

/**
 * 多笔记持久化。
 *
 * 目录结构（都在数据目录下，跟着数据目录一起迁移）：
 *   notes-index.json   索引：笔记顺序、标题、上次打开的笔记、每篇的视图状态
 *   notes/<id>.md      每篇笔记的 Markdown 正文
 *   attachments/       图片附件（多篇共享，正文里存相对路径，改标题/改名都不影响引用）
 *
 * 设计要点：
 * - 正文仍走"内存 + 600ms 防抖 + tmp/rename 原子写"，退出时同步补写；
 * - 写盘目标在内容变更时就绑定到某一篇笔记，切换笔记不会把 A 的内容写进 B；
 * - 切换笔记前先同步补写当前笔记，保证"切走即落盘"；
 * - 索引与正文分开写，索引损坏时可以从 notes/*.md 重建，不丢正文。
 */
export class NotesStore {
  private readonly userDataDir: string
  private readonly notesDir: string
  private readonly indexPath: string
  private readonly emitStatus: (status: NoteStatus) => void

  private index: NotesIndexState = { notes: [], activeId: '' }
  private content = ''
  private savedContent = ''
  private savedAt: number | null = null
  private status: NoteStatus = { state: 'idle', savedAt: null, message: null }

  private saveTimer: NodeJS.Timeout | null = null
  private indexTimer: NodeJS.Timeout | null = null
  private writing = false
  private pendingWrite = false
  /** 退出补写后置位：阻止仍在飞行中的异步写把旧内容盖回去 */
  private frozen = false
  /** 当前内存里的内容属于哪篇笔记（防止切换笔记后写错文件） */
  private contentNoteId = ''
  /** 迁移失败时保留的提示，展示给用户 */
  private migrationWarning: string | null = null

  constructor(userDataDir: string, emitStatus: (status: NoteStatus) => void) {
    this.userDataDir = userDataDir
    this.notesDir = path.join(userDataDir, NOTES_DIR)
    this.indexPath = path.join(userDataDir, INDEX_FILE)
    this.emitStatus = emitStatus
  }

  getNotesDir(): string {
    return this.notesDir
  }

  getIndexPath(): string {
    return this.indexPath
  }

  /** 某篇笔记的真实文件路径：文件名跟着标签走，所以必须查索引（老数据回落到 `<id>.md`） */
  notePath(id: string): string {
    const meta = this.index.notes.find((note) => note.id === id)
    return path.join(this.notesDir, meta?.file ?? `${id}.md`)
  }

  /**
   * 给一篇笔记挑一个不撞车的文件名。
   * 撞车时按 `标题 (2).md`、`标题 (3).md` 递增——标签允许重复，文件名不允许。
   */
  private pickFileName(title: string, selfId: string | null, extra: NoteMeta[] = []): string {
    const base = fileNameFromTitle(title) || selfId || 'note'
    const selfPath = selfId ? this.notePath(selfId) : ''
    const taken = new Set<string>()
    for (const note of [...this.index.notes, ...extra]) {
      if (selfId && note.id === selfId) {
        continue
      }
      taken.add((note.file ?? `${note.id}.md`).toLowerCase())
    }
    for (let index = 0; index < 500; index += 1) {
      // 加序号时先给后缀腾出位置，保证整体长度不超过上限（否则回读时会被当成非法名）
      const suffix = index === 0 ? '' : ` (${index + 1})`
      const stem = base.slice(0, Math.max(1, MAX_FILENAME_LENGTH - suffix.length))
      const candidate = `${stem}${suffix}.md`
      if (taken.has(candidate.toLowerCase())) {
        continue
      }
      const abs = path.join(this.notesDir, candidate)
      if (abs !== selfPath && existsSync(abs)) {
        continue
      }
      return candidate
    }
    return `${base}-${Date.now().toString(36)}.md`
  }

  /**
   * 让某篇笔记的文件名与标签一致。失败只记日志，绝不因此丢内容：
   * 名字改不过去（文件被占用等）就先留着旧名字，下次保存再试。
   */
  private syncFileName(id: string): boolean {
    const meta = this.index.notes.find((note) => note.id === id)
    if (!meta) {
      return false
    }
    const current = meta.file ?? `${meta.id}.md`
    const desired = this.pickFileName(meta.title, meta.id)
    if (current === desired) {
      return false
    }
    const from = path.join(this.notesDir, current)
    const to = path.join(this.notesDir, desired)
    if (!existsSync(from)) {
      // 文件还没建出来（新建即改名）：只更新索引，建文件时自然用新名字
      meta.file = desired
      return true
    }
    try {
      renameSync(from, to)
      meta.file = desired
      log('note-file-renamed', { id, from: current, to: desired })
      return true
    } catch (error) {
      log('note-file-rename-failed', { id, from: current, to: desired, message: describeError(error) })
      return false
    }
  }

  /** 启动时把所有笔记的文件名对齐到标签（老数据 `<id>.md` 一次性改名） */
  private syncAllFileNames(): void {
    let changed = false
    for (const note of this.index.notes) {
      if (this.syncFileName(note.id)) {
        changed = true
      }
    }
    if (changed) {
      this.persistIndexNow()
      log('note-file-names-synced', { count: this.index.notes.length })
    }
  }

  getMigrationWarning(): string | null {
    return this.migrationWarning
  }

  async load(): Promise<void> {
    mkdirSync(this.notesDir, { recursive: true })
    this.migrateTextToMarkdown()

    const loaded = this.loadIndex()
    if (!loaded) {
      this.buildIndexFromScratch()
    }

    // 文件名跟着标签走：老数据的 `<id>.md` 在这里一次性改名成 `标签.md`，
    // 必须在读取正文之前做，这样内存里的路径与磁盘一致。
    this.syncAllFileNames()

    const active = this.index.notes.find((note) => note.id === this.index.activeId) ?? this.index.notes[0]
    this.index.activeId = active.id
    await this.loadActiveContent()
    this.persistIndexNow()
    log('notes-loaded', {
      count: this.index.notes.length,
      activeId: this.index.activeId,
      length: this.content.length,
      warning: this.migrationWarning
    })
  }

  /** 纯文本时代（.txt）的文件先改名成 .md，历史包袱只留这一层 */
  private migrateTextToMarkdown(): void {
    const legacyText = path.join(this.userDataDir, 'edge-notes-note.txt')
    const legacyMarkdown = path.join(this.userDataDir, LEGACY_NOTE_FILE)
    if (existsSync(legacyMarkdown) || !existsSync(legacyText)) {
      return
    }
    try {
      renameSync(legacyText, legacyMarkdown)
      log('note-migrated-text', {})
    } catch (error) {
      log('note-migrate-text-failed', { message: describeError(error) })
    }
  }

  /**
   * 单篇笔记 → 多笔记。
   * 顺序：写新文件 → SHA-256 校验 → 写索引 → 旧文件改名留作备份。
   * 任何一步失败都保留旧文件、删除半成品，下次启动可以重试。
   */
  private migrateSingleNote(): NoteMeta | null {
    const legacyPath = path.join(this.userDataDir, LEGACY_NOTE_FILE)
    if (!existsSync(legacyPath)) {
      return null
    }
    const meta = createMeta(newNoteId(), '我的笔记')
    meta.file = this.pickFileName(meta.title, null)
    // 此时 meta 还没进索引，notePath 会回落到 `<id>.md`，所以直接用文件名拼
    const target = path.join(this.notesDir, meta.file)
    try {
      const content = readFileSync(legacyPath, 'utf8').slice(0, MAX_NOTE_LENGTH)
      mkdirSync(this.notesDir, { recursive: true })
      writeFileSync(target, content, 'utf8')

      const sourceHash = createHash('sha256').update(readFileSync(legacyPath)).digest('hex')
      const targetHash = createHash('sha256').update(readFileSync(target)).digest('hex')
      if (sourceHash !== targetHash) {
        rmSync(target, { force: true })
        throw new Error('SHA-256 校验不一致')
      }

      const titled = { ...meta, title: guessTitle(content) }
      this.index = { notes: [titled], activeId: titled.id }
      this.persistIndexNow()

      // 最后才动旧文件：改名而不是删除，用户仍可手动找回
      renameSync(legacyPath, path.join(this.userDataDir, LEGACY_BACKUP_FILE))
      log('note-migrated-single', { to: `${NOTES_DIR}/${titled.file}`, title: titled.title })
      return titled
    } catch (error) {
      const message = describeError(error)
      this.migrationWarning = `旧笔记迁移失败（原文件未改动）：${message}`
      log('note-migrate-single-failed', { message })
      rmSync(target, { force: true })
      return null
    }
  }

  private loadIndex(): boolean {
    if (!existsSync(this.indexPath)) {
      const migrated = this.migrateSingleNote()
      return migrated !== null
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      const data = raw as { notes?: unknown; activeId?: unknown }
      const notes = Array.isArray(data.notes)
        ? data.notes.map(sanitizeMeta).filter((meta): meta is NoteMeta => meta !== null)
        : []
      if (notes.length === 0) {
        return false
      }
      const activeId =
        typeof data.activeId === 'string' && notes.some((note) => note.id === data.activeId)
          ? data.activeId
          : notes[0].id
      this.index = { notes, activeId }
      return true
    } catch (error) {
      // 索引损坏：留一份坏文件，然后从 notes/*.md 重建，正文不受影响
      log('notes-index-corrupted', { message: describeError(error) })
      try {
        renameSync(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`)
      } catch {
        // 备份失败不影响重建
      }
      return false
    }
  }

  /** 索引缺失/损坏时的兜底：直接扫描 notes/*.md 重建 */
  private buildIndexFromScratch(): void {
    const migrated = this.migrateSingleNote()
    if (migrated) {
      return
    }
    const notes: NoteMeta[] = []
    try {
      for (const entry of readdirSync(this.notesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
          continue
        }
        // 文件名现在就是标签（可能含中文/空格），id 重新生成，只保证唯一
        const file = sanitizeFileName(entry.name)
        if (!file) {
          continue
        }
        const content = readFileSync(path.join(this.notesDir, entry.name), 'utf8').slice(0, MAX_NOTE_LENGTH)
        const meta = createMeta(newNoteId(), guessTitle(content))
        meta.file = file
        meta.scrollTop = 0
        notes.push(meta)
      }
    } catch (error) {
      log('notes-rebuild-failed', { message: describeError(error) })
    }
    if (notes.length === 0) {
      const meta = createMeta(newNoteId(), '我的笔记')
      meta.file = this.pickFileName(meta.title, null, notes)
      writeFileSync(path.join(this.notesDir, meta.file), '', 'utf8')
      notes.push(meta)
      log('notes-seeded', { id: meta.id, file: meta.file })
    }
    this.index = { notes, activeId: notes[0].id }
    this.persistIndexNow()
  }

  private async loadActiveContent(): Promise<void> {
    const filePath = this.notePath(this.index.activeId)
    this.contentNoteId = this.index.activeId
    try {
      const raw = await readFile(filePath, 'utf8')
      this.content = raw.slice(0, MAX_NOTE_LENGTH)
      this.savedContent = this.content
      const info = await stat(filePath)
      this.savedAt = info.mtimeMs
      this.setStatus({ state: this.content.length > 0 ? 'saved' : 'idle', savedAt: this.savedAt, message: null })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.content = ''
        this.savedContent = ''
        this.savedAt = null
        this.setStatus({ state: 'idle', savedAt: null, message: null })
        return
      }
      const message = describeError(error)
      this.setStatus({ state: 'error', savedAt: null, message })
      log('note-load-failed', { message })
    }
  }

  state(): NotesIndexState {
    return { notes: this.index.notes.map((note) => ({ ...note })), activeId: this.index.activeId }
  }

  activeMeta(): NoteMeta {
    const meta = this.index.notes.find((note) => note.id === this.index.activeId)
    if (!meta) {
      throw new Error('当前笔记不存在')
    }
    return meta
  }

  snapshot(): NoteSnapshot {
    return { content: this.content, savedAt: this.savedAt, status: this.status }
  }

  getStatus(): NoteStatus {
    return this.status
  }

  private result(): NoteSwitchResult {
    return { index: this.state(), note: this.snapshot() }
  }

  /** 渲染层每次输入都会调用；只更新内存并安排防抖写盘 */
  setContent(raw: string): void {
    const next = raw.slice(0, MAX_NOTE_LENGTH)
    if (next === this.content) {
      return
    }
    this.content = next
    this.contentNoteId = this.index.activeId
    this.touchActive()
    this.setStatus({ state: 'saving', savedAt: this.savedAt, message: null })
    this.scheduleSave()
  }

  private touchActive(): void {
    const meta = this.index.notes.find((note) => note.id === this.index.activeId)
    if (meta) {
      meta.updatedAt = Date.now()
    }
  }

  /** 切换/新建/删除后返回新的索引与当前笔记内容 */
  switchTo(id: string): NoteSwitchResult {
    if (id === this.index.activeId) {
      return this.result()
    }
    if (!this.index.notes.some((note) => note.id === id)) {
      throw new Error('笔记不存在')
    }
    this.writeSyncNow()
    this.index.activeId = id
    this.loadActiveContentSync()
    this.persistIndexNow()
    log('note-switched', { to: id })
    return this.result()
  }

  create(title?: string): NoteSwitchResult {
    if (this.index.notes.length >= MAX_NOTES) {
      throw new Error(`笔记数量已达上限（${MAX_NOTES} 篇）`)
    }
    this.writeSyncNow()
    const meta = createMeta(newNoteId(), title ?? '新笔记')
    this.index.notes.unshift(meta)
    // 先把文件名定下来（标签即文件名），再落盘，避免先写出 `<id>.md` 再改名
    meta.file = this.pickFileName(meta.title, meta.id)
    this.index.activeId = meta.id
    try {
      writeFileSync(path.join(this.notesDir, meta.file), '', 'utf8')
    } catch (error) {
      // 建文件失败就回滚索引，避免出现"指向不存在文件"的笔记
      this.index.notes = this.index.notes.filter((note) => note.id !== meta.id)
      this.index.activeId = this.index.notes[0]?.id ?? ''
      throw new Error(`新建笔记失败：${describeError(error)}`)
    }
    this.content = ''
    this.savedContent = ''
    this.contentNoteId = meta.id
    this.savedAt = null
    this.setStatus({ state: 'idle', savedAt: null, message: null })
    this.persistIndexNow()
    log('note-created', { id: meta.id })
    return this.result()
  }

  rename(id: string, title: string): NotesIndexState {
    const meta = this.index.notes.find((note) => note.id === id)
    if (!meta) {
      throw new Error('笔记不存在')
    }
    meta.title = normalizeTitle(title)
    meta.updatedAt = Date.now()
    // 文件名跟着标签走。但当前笔记若有内容还没落盘（写盘进行中或还在防抖窗口），
    // 先让那次写完成：writeNow/writeSyncNow 落盘后会自己调 syncFileName。
    const isActive = id === this.index.activeId
    const writePending = isActive && (this.writing || this.content !== this.savedContent)
    if (!writePending) {
      this.syncFileName(id)
    }
    this.persistIndexNow()
    log('note-renamed', {
      id,
      title: meta.title,
      file: meta.file ?? null,
      deferred: writePending
    })
    return this.state()
  }

  /** 删除笔记：文件进回收站（可还原），索引移除；最后一篇会补一篇空白笔记 */
  remove(id: string): NoteSwitchResult {
    const index = this.index.notes.findIndex((note) => note.id === id)
    if (index < 0) {
      throw new Error('笔记不存在')
    }
    const wasActive = this.index.activeId === id
    if (wasActive) {
      this.clearSaveTimer()
    }
    // 必须先把真实路径取出来：splice 之后索引里就查不到这篇了，notePath 会回落到 `<id>.md`
    const filePath = this.notePath(id)
    const [removed] = this.index.notes.splice(index, 1)

    if (existsSync(filePath)) {
      void shell.trashItem(filePath).catch((error: unknown) => {
        log('note-trash-failed', { id, message: describeError(error) })
      })
    }

    if (this.index.notes.length === 0) {
      const meta = createMeta(newNoteId(), '新笔记')
      meta.file = this.pickFileName(meta.title, meta.id)
      writeFileSync(path.join(this.notesDir, meta.file), '', 'utf8')
      this.index.notes.push(meta)
      log('note-seeded-after-delete', { id: meta.id, file: meta.file })
    }

    if (wasActive) {
      const next = this.index.notes[Math.min(index, this.index.notes.length - 1)]
      this.index.activeId = next.id
      this.loadActiveContentSync()
    }
    this.persistIndexNow()
    log('note-deleted', { id, title: removed.title, remaining: this.index.notes.length })
    return this.result()
  }

  reorder(ids: string[]): NotesIndexState {
    const current = new Map(this.index.notes.map((note) => [note.id, note]))
    if (ids.length !== current.size || ids.some((id) => !current.has(id))) {
      throw new Error('排序参数与现有笔记不匹配')
    }
    this.index.notes = ids.map((id) => current.get(id)!)
    this.persistIndexNow()
    log('notes-reordered', { order: ids })
    return this.state()
  }

  /** 每篇笔记的视图状态：编辑/预览、滚动位置、光标位置 */
  setViewState(id: string, patch: { viewMode?: ViewMode; scrollTop?: number; caret?: number }): void {
    const meta = this.index.notes.find((note) => note.id === id)
    if (!meta) {
      return
    }
    if (patch.viewMode === 'edit' || patch.viewMode === 'preview') {
      meta.viewMode = patch.viewMode
    }
    if (typeof patch.scrollTop === 'number') {
      meta.scrollTop = clampNumber(patch.scrollTop, 2_000_000)
    }
    if (typeof patch.caret === 'number') {
      meta.caret = clampNumber(patch.caret, MAX_NOTE_LENGTH)
    }
    this.scheduleIndexSave()
  }

  /** 所有笔记的正文（用于统计图片附件是否仍被任何一篇引用） */
  allContents(): string[] {
    const contents: string[] = []
    for (const note of this.index.notes) {
      if (note.id === this.index.activeId) {
        contents.push(this.content)
        continue
      }
      try {
        contents.push(readFileSync(this.notePath(note.id), 'utf8'))
      } catch {
        // 文件缺失按空内容处理
      }
    }
    return contents
  }

  private loadActiveContentSync(): void {
    const filePath = this.notePath(this.index.activeId)
    this.contentNoteId = this.index.activeId
    try {
      this.content = readFileSync(filePath, 'utf8').slice(0, MAX_NOTE_LENGTH)
      this.savedContent = this.content
      const info = statSyncSafe(filePath)
      this.savedAt = info
      this.setStatus({ state: this.content.length > 0 ? 'saved' : 'idle', savedAt: info, message: null })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.content = ''
        this.savedContent = ''
        this.savedAt = null
        this.setStatus({ state: 'idle', savedAt: null, message: null })
        return
      }
      const message = describeError(error)
      this.setStatus({ state: 'error', savedAt: null, message })
      log('note-load-failed', { message })
    }
  }

  /** 立即写盘，返回写入后的状态（不抛异常，失败体现在 state=error） */
  async writeNow(): Promise<NoteStatus> {
    this.clearSaveTimer()

    if (this.writing) {
      this.pendingWrite = true
      return this.status
    }

    this.writing = true
    const snapshot = this.content
    const targetId = this.contentNoteId || this.index.activeId
    const filePath = this.notePath(targetId)
    const tmpPath = `${filePath}.tmp`

    try {
      mkdirSync(this.notesDir, { recursive: true })
      await writeFile(tmpPath, snapshot, 'utf8')
      if (this.frozen) {
        await unlink(tmpPath).catch(() => undefined)
        return this.status
      }
      await rename(tmpPath, filePath)
      // 落盘之后再对齐文件名：此刻不会有别的写正在飞，改名不会把内容写丢
      if (this.syncFileName(targetId)) {
        this.persistIndexNow()
      }
      if (targetId === this.index.activeId) {
        this.savedContent = snapshot
        this.savedAt = Date.now()
        if (this.content === this.savedContent) {
          this.setStatus({ state: 'saved', savedAt: this.savedAt, message: null })
        } else {
          this.setStatus({ state: 'saving', savedAt: this.savedAt, message: null })
        }
      }
      log('note-saved', { id: targetId, file: path.basename(this.notePath(targetId)), length: snapshot.length })
      return this.status
    } catch (error) {
      const message = describeError(error)
      log('note-save-failed', { message })
      this.setStatus({ state: 'error', savedAt: this.savedAt, message })
      await unlink(tmpPath).catch(() => undefined)
      return this.status
    } finally {
      this.writing = false
      if (this.pendingWrite) {
        this.pendingWrite = false
        if (this.content !== this.savedContent) {
          void this.writeNow()
        }
      }
    }
  }

  /** 同步补写（切换笔记、退出时用）。freeze=true 时后续异步写作废 */
  private writeSyncNow(freeze = false): void {
    this.clearSaveTimer()
    if (freeze) {
      this.frozen = true
    }
    if (this.content === this.savedContent) {
      return
    }
    const targetId = this.contentNoteId || this.index.activeId
    const filePath = this.notePath(targetId)
    const tmpPath = `${filePath}.tmp`
    try {
      mkdirSync(this.notesDir, { recursive: true })
      writeFileSync(tmpPath, this.content, 'utf8')
      renameSync(tmpPath, filePath)
      if (this.syncFileName(targetId)) {
        this.persistIndexNow()
      }
      this.savedContent = this.content
      this.savedAt = Date.now()
      log(freeze ? 'note-flushed-on-quit' : 'note-flushed-before-switch', {
        id: targetId,
        file: path.basename(this.notePath(targetId)),
        length: this.content.length
      })
    } catch (error) {
      log('note-flush-failed', { message: describeError(error) })
    }
  }

  /** 退出前同步补写，避免退出瞬间丢掉最后几个字符 */
  flushSync(): void {
    this.writeSyncNow(true)
    this.persistIndexNow()
  }

  private scheduleSave(): void {
    this.clearSaveTimer()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  private scheduleIndexSave(): void {
    if (this.indexTimer) {
      return
    }
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null
      this.persistIndexNow()
    }, INDEX_DEBOUNCE_MS)
  }

  /** 原子写索引：索引坏了还能从 notes/*.md 重建，正文永远优先 */
  private persistIndexNow(): void {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer)
      this.indexTimer = null
    }
    const tmpPath = `${this.indexPath}.tmp`
    try {
      mkdirSync(this.userDataDir, { recursive: true })
      writeFileSync(tmpPath, `${JSON.stringify({ version: 1, ...this.index }, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, this.indexPath)
    } catch (error) {
      log('notes-index-write-failed', { message: describeError(error) })
    }
  }

  private setStatus(next: NoteStatus): void {
    const same =
      this.status.state === next.state && this.status.message === next.message && this.status.savedAt === next.savedAt
    this.status = next
    if (!same) {
      this.emitStatus(next)
    }
  }
}

function statSyncSafe(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}
