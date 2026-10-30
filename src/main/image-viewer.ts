import { BrowserWindow, nativeTheme, screen } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { log } from './log'

let viewer: BrowserWindow | null = null

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[ch] ?? ch
  })
}

/**
 * 图片放大：用独立窗口放在屏幕上，而不是缩在 350px 的面板里。
 * 面板是常驻窄条，任何"面板内放大"都不可能看清截图里的细节。
 */
export function openImageViewer(imageUrl: string, label: string): boolean {
  if (viewer && !viewer.isDestroyed()) {
    viewer.close()
    viewer = null
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.round(area.width * 0.86)
  const height = Math.round(area.height * 0.86)
  const dark = nativeTheme.shouldUseDarkColors
  const backdrop = dark ? '#1b1a18' : '#26231e'
  const caption = dark ? '#b8ad9e' : '#d8cec0'

  const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: ${backdrop}; overflow: hidden; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: zoom-out; }
  /* 默认"适应窗口"：小图会被放大到屏幕尺寸，大图等比缩到窗口内 */
  img {
    width: 92%;
    height: 84%;
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 24px 60px rgba(0,0,0,.55);
    cursor: zoom-in;
  }
  body.actual img {
    width: auto;
    height: auto;
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
  body.actual { overflow: auto; justify-content: flex-start; padding: 12px 0; }
  .hint { margin-top: 14px; color: ${caption}; font: 12px/1.6 "Microsoft YaHei UI", system-ui, sans-serif; user-select: none; }
</style>
<body>
  <img src="${escapeHtml(imageUrl)}" alt="">
  <div class="hint">${escapeHtml(label)} · 点击图片切换原始尺寸 · 点击背景或 Esc 关闭</div>
  <script>
    document.body.addEventListener('click', (event) => {
      if (event.target && event.target.tagName === 'IMG') {
        document.body.classList.toggle('actual')
        return
      }
      window.close()
    })
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.close() })
  </script>
</body>`

  viewer = new BrowserWindow({
    width,
    height,
    center: true,
    frame: false,
    show: false,
    resizable: true,
    skipTaskbar: true,
    // 面板本身是置顶的，大图必须压在它上面，否则会被挡掉一角
    alwaysOnTop: true,
    backgroundColor: backdrop,
    title: label,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  viewer.once('ready-to-show', () => viewer?.show())
  viewer.on('closed', () => {
    viewer = null
    log('image-viewer-closed', {})
  })
  // 主进程兜底处理 Esc：即使页面脚本被拦也能关掉
  viewer.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      viewer?.close()
    }
  })
  void viewer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  log('image-viewer-opened', { label, width, height })
  return true
}

export function isImageViewerOpen(): boolean {
  return Boolean(viewer && !viewer.isDestroyed())
}

export function closeImageViewer(): void {
  if (viewer && !viewer.isDestroyed()) {
    viewer.close()
  }
  viewer = null
}

/** 供测试/日志确认图片确实存在且大小合理（避免"窗口打开了但图是空的"） */
export function describeImage(filePath: string): { bytes: number } | null {
  try {
    return { bytes: statSync(filePath).size }
  } catch {
    return null
  }
}

export function readImageHeader(filePath: string): string {
  try {
    return readFileSync(filePath).subarray(0, 12).toString('hex')
  } catch {
    return ''
  }
}
