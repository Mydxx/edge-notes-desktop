import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { shell } from 'electron'
import path from 'node:path'
import type { AttachmentFile } from '../shared/api'
import { log } from './log'

/** 附件目录名，同时是 Markdown 里的相对路径前缀 */
export const ATTACHMENT_DIR = 'attachments'

/** 单张图片上限：普通截图/照片足够，同时避免误粘贴大文件把磁盘写爆 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** 只接受这几种位图；SVG 可以带脚本，第一版直接拒收 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

export function attachmentsDir(userDataDir: string): string {
  return path.join(userDataDir, ATTACHMENT_DIR)
}

export interface SavedAttachment {
  /** 写进 Markdown 的相对路径，例如 attachments/img-xxx.png */
  relative: string
  bytes: number
}

/** 把剪贴板里的图片写到附件目录，返回可嵌入 Markdown 的相对路径 */
export function saveAttachment(userDataDir: string, bytes: Uint8Array, mime: string): SavedAttachment {
  const extension = EXTENSION_BY_MIME[mime]
  if (!extension) {
    throw new Error(`不支持的图片格式：${mime || '未知'}`)
  }
  if (bytes.byteLength === 0) {
    throw new Error('图片内容为空')
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`图片超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB 上限`)
  }

  const dir = attachmentsDir(userDataDir)
  mkdirSync(dir, { recursive: true })
  const name = `img-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.${extension}`
  writeFileSync(path.join(dir, name), bytes)
  log('attachment-saved', { name, bytes: bytes.byteLength, mime })
  return { relative: `${ATTACHMENT_DIR}/${name}`, bytes: bytes.byteLength }
}

/**
 * 自定义协议 edgenote-media://local/attachments/<file> 的路径解析。
 * 只允许附件目录下的单层文件名，任何 `..`、子目录、非白名单字符一律拒绝。
 */
export function resolveAttachmentUrl(userDataDir: string, requestUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 2 || segments[0] !== ATTACHMENT_DIR) {
    return null
  }
  let name: string
  try {
    name = decodeURIComponent(segments[1])
  } catch {
    return null
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
    return null
  }
  return path.join(attachmentsDir(userDataDir), name)
}

/** 列出附件目录下的文件（只认附件协议允许的文件名） */
export function listAttachments(userDataDir: string): AttachmentFile[] {
  const dir = attachmentsDir(userDataDir)
  if (!existsSync(dir)) {
    return []
  }
  const files: AttachmentFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) {
      continue
    }
    files.push({
      relative: `${ATTACHMENT_DIR}/${entry.name}`,
      name: entry.name,
      bytes: statSync(path.join(dir, entry.name)).size
    })
  }
  return files
}

/**
 * 把指定附件移入回收站（可还原），而不是直接删除。
 * 调用方必须已经让用户确认，并且只传"当前正文没有引用"的文件。
 */
export async function trashAttachments(
  userDataDir: string,
  relatives: string[]
): Promise<{ trashed: number; failed: string[] }> {
  const failed: string[] = []
  let trashed = 0
  for (const relative of relatives) {
    const target = resolveAttachmentUrl(userDataDir, `edgenote-media://local/${relative}`)
    if (!target || !existsSync(target)) {
      failed.push(relative)
      continue
    }
    try {
      await shell.trashItem(target)
      trashed += 1
    } catch (error) {
      log('attachment-trash-failed', { relative, message: error instanceof Error ? error.message : String(error) })
      failed.push(relative)
    }
  }
  log('attachments-trashed', { trashed, failed: failed.length })
  return { trashed, failed }
}

/** 判断 Markdown 里的相对路径在附件目录中是否真的存在 */
export function attachmentExists(userDataDir: string, relative: string): boolean {
  const target = resolveAttachmentUrl(userDataDir, `edgenote-media://local/${relative}`)
  return target !== null && existsSync(target)
}

export function mimeForAttachment(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}
