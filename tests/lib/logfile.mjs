// JSONL 运行日志读取与等待工具
import { existsSync, readFileSync } from 'node:fs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function readLog(filePath) {
  if (!existsSync(filePath)) {
    return []
  }
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export async function waitForEvent(filePath, event, { timeoutMs = 20000, fromIndex = 0 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = readLog(filePath)
    for (let index = fromIndex; index < records.length; index += 1) {
      if (records[index].event === event) {
        return { record: records[index], index }
      }
    }
    await delay(120)
  }
  throw new Error(`等待日志事件超时: ${event}`)
}

export function events(records, event) {
  return records.filter((record) => record.event === event)
}

export function firstEventAfter(records, event, afterTime) {
  return records.find((record) => record.event === event && record.t > afterTime)
}
