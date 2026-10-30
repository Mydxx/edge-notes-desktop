import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NoteSnapshot, NoteStatus } from '../shared/api'
import { log } from './log'

/** 单条笔记的长度上限，防止异常输入把磁盘写爆 */
const MAX_NOTE_LENGTH = 1_000_000
/** 停止输入后多久落盘 */
const SAVE_DEBOUNCE_MS = 600

const REASON_BY_CODE: Record<string, string> = {
  EPERM: '没有写入权限',
  EACCES: '没有写入权限',
  EISDIR: '目标位置被占用',
  ENOTDIR: '目标路径不可用',
  ENOSPC: '磁盘空间不足',
  ENOENT: '目标路径不存在',
  EBUSY: '文件正被占用'
}

/**
 * 笔记持久化。
 *
 * 设计要点：
 * - 每次输入都通过 IPC 进入本模块内存，因此即便用户立刻退出应用也不会丢内容；
 * - 内存变更后 600ms 防抖写盘（tmp + rename 原子替换）；
 * - 写入串行化，避免慢盘下两次写入交叉覆盖；
 * - 退出时 flushSync() 用同步写把未落盘的内容补上。
 */
export class NotesStore {
  private readonly filePath: string
  private readonly emitStatus: (status: NoteStatus) => void
  private content = ''
  private savedContent = ''
  private savedAt: number | null = null
  private status: NoteStatus = { state: 'idle', savedAt: null, message: null }
  private saveTimer: NodeJS.Timeout | null = null
  private writing = false
  private pendingWrite = false
  /** 退出补写后置位：阻止仍在飞行中的异步写把旧内容盖回去 */
  private frozen = false

  constructor(userDataDir: string, emitStatus: (status: NoteStatus) => void) {
    this.filePath = path.join(userDataDir, 'edge-notes-note.md')
    this.emitStatus = emitStatus
    this.migrateLegacyFile(userDataDir)
  }

  /** 从纯文本版本升级：老 .txt 直接改名为 .md，内容一字不动 */
  private migrateLegacyFile(userDataDir: string): void {
    const legacyPath = path.join(userDataDir, 'edge-notes-note.txt')
    if (existsSync(this.filePath) || !existsSync(legacyPath)) {
      return
    }
    try {
      renameSync(legacyPath, this.filePath)
      log('note-migrated', { from: 'edge-notes-note.txt', to: 'edge-notes-note.md' })
    } catch (error) {
      log('note-migrate-failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  getFilePath(): string {
    return this.filePath
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.content = raw.slice(0, MAX_NOTE_LENGTH)
      this.savedContent = this.content
      const info = await stat(this.filePath)
      this.savedAt = info.mtimeMs
      this.setStatus({ state: 'saved', savedAt: this.savedAt, message: null })
      log('note-loaded', { length: this.content.length, savedAt: this.savedAt })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.content = ''
        this.savedContent = ''
        log('note-empty', {})
        return
      }
      const message = describeError(error)
      this.setStatus({ state: 'error', savedAt: null, message })
      log('note-load-failed', { message })
    }
  }

  snapshot(): NoteSnapshot {
    return { content: this.content, savedAt: this.savedAt, status: this.status }
  }

  getStatus(): NoteStatus {
    return this.status
  }

  /** 渲染层每次输入都会调用；只更新内存并安排防抖写盘 */
  setContent(raw: string): void {
    const next = raw.slice(0, MAX_NOTE_LENGTH)
    if (next === this.content) {
      return
    }
    this.content = next
    this.setStatus({ state: 'saving', savedAt: this.savedAt, message: null })
    this.scheduleSave()
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
    const tmpPath = `${this.filePath}.tmp`

    try {
      await writeFile(tmpPath, snapshot, 'utf8')
      if (this.frozen) {
        // 已经退出补写过更新内容，这次异步写的结果作废
        await unlink(tmpPath).catch(() => undefined)
        return this.status
      }
      await rename(tmpPath, this.filePath)
      this.savedContent = snapshot
      this.savedAt = Date.now()
      log('note-saved', { length: snapshot.length, savedAt: this.savedAt })
      if (this.content === this.savedContent) {
        this.setStatus({ state: 'saved', savedAt: this.savedAt, message: null })
      } else {
        this.setStatus({ state: 'saving', savedAt: this.savedAt, message: null })
      }
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

  /** 退出前同步补写，避免退出瞬间丢掉最后几个字符 */
  flushSync(): void {
    this.frozen = true
    this.clearSaveTimer()
    if (this.content === this.savedContent) {
      return
    }
    const tmpPath = `${this.filePath}.tmp`
    try {
      writeFileSync(tmpPath, this.content, 'utf8')
      renameSync(tmpPath, this.filePath)
      this.savedContent = this.content
      this.savedAt = Date.now()
      log('note-flushed-on-quit', { length: this.content.length })
    } catch (error) {
      log('note-flush-failed', { message: describeError(error) })
    }
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

  private setStatus(next: NoteStatus): void {
    const same =
      this.status.state === next.state && this.status.message === next.message && this.status.savedAt === next.savedAt
    this.status = next
    if (!same) {
      this.emitStatus(next)
    }
  }
}

function describeError(error: unknown): string {
  const err = error as NodeJS.ErrnoException
  const code = typeof err?.code === 'string' ? err.code : ''
  const reason = REASON_BY_CODE[code] ?? '磁盘写入失败'
  return code ? `${reason}（${code}）` : reason
}
