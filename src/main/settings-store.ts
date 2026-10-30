import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CollapseDelay, DockSide, EdgeNotesSettings, FontScale, ThemeMode } from '../shared/api'
import {
  COLLAPSE_DELAY_DEFAULT,
  COLLAPSE_DELAY_OPTIONS,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN
} from '../shared/constants'

export const DEFAULT_SETTINGS: EdgeNotesSettings = {
  side: 'right',
  width: PANEL_WIDTH_DEFAULT,
  alwaysOnTop: true,
  pinnedOpen: false,
  collapseDelay: COLLAPSE_DELAY_DEFAULT,
  launchAtLogin: false,
  theme: 'light',
  fontSize: 'normal'
}

/**
 * 设置持久化：userData/edge-notes-settings.json。
 * 写入采用「临时文件 + rename」避免半截文件；读入时逐字段校验并夹紧取值范围，
 * 文件损坏、字段缺失或类型不符都安全回退到默认值，不阻断启动。
 */
export class SettingsStore {
  private readonly filePath: string
  private data: EdgeNotesSettings
  private saveTimer: NodeJS.Timeout | null = null

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'edge-notes-settings.json')
    this.data = this.readFromDisk()
  }

  getPath(): string {
    return this.filePath
  }

  get(): EdgeNotesSettings {
    return { ...this.data }
  }

  update(patch: Partial<EdgeNotesSettings>): EdgeNotesSettings {
    this.data = sanitizeSettings({ ...this.data, ...patch })
    this.scheduleSave()
    return this.get()
  }

  /** 退出前同步落盘 */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.writeToDisk()
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.writeToDisk()
    }, 150)
  }

  private writeToDisk(): void {
    try {
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, this.filePath)
    } catch {
      // 写入失败不应崩溃退出；下次变更会再次尝试
    }
  }

  private readFromDisk(): EdgeNotesSettings {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(raw as Record<string, unknown>) })
      }
    } catch {
      // 文件缺失 / JSON 损坏 / 读取失败：一律回落到默认值
    }
    return { ...DEFAULT_SETTINGS }
  }
}

/** 逐字段校验：不认识的值一律取默认，绝不把非法值传进窗口逻辑 */
export function sanitizeSettings(input: Record<string, unknown>): EdgeNotesSettings {
  const side: DockSide = input.side === 'left' ? 'left' : 'right'

  const rawWidth = typeof input.width === 'number' && Number.isFinite(input.width) ? input.width : PANEL_WIDTH_DEFAULT
  const width = Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(rawWidth)))

  const rawDelay = typeof input.collapseDelay === 'number' ? input.collapseDelay : COLLAPSE_DELAY_DEFAULT
  const collapseDelay = (COLLAPSE_DELAY_OPTIONS as readonly number[]).includes(rawDelay)
    ? (rawDelay as CollapseDelay)
    : COLLAPSE_DELAY_DEFAULT

  const theme: ThemeMode =
    input.theme === 'dark' || input.theme === 'system' || input.theme === 'light' ? input.theme : DEFAULT_SETTINGS.theme
  const fontSize: FontScale =
    input.fontSize === 'small' || input.fontSize === 'large' || input.fontSize === 'normal'
      ? input.fontSize
      : DEFAULT_SETTINGS.fontSize

  return {
    side,
    width,
    collapseDelay,
    theme,
    fontSize,
    alwaysOnTop: input.alwaysOnTop !== false,
    pinnedOpen: input.pinnedOpen === true,
    launchAtLogin: input.launchAtLogin === true
  }
}
