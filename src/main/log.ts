import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const logFilePath = process.env.EDGE_NOTES_LOG ?? ''
const silent = process.env.EDGE_NOTES_SILENT === '1'

if (logFilePath) {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true })
  } catch {
    // 日志目录不可用时仅退化为控制台输出
  }
}

/**
 * 结构化运行日志。默认写控制台，设置 EDGE_NOTES_LOG 后追加 JSONL 文件，
 * 用于无人工干预的窗口行为验证。
 */
export function log(event: string, data: Record<string, unknown> = {}): void {
  const record = { t: Date.now(), event, ...data }
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // 忽略日志写入失败，不影响应用运行
    }
  }
  if (!silent) {
    console.log(`[edge-notes] ${event}`, data)
  }
}
