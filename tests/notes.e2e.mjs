// 笔记功能端到端验证：真实输入（CDP Input.insertText 走浏览器输入管线）、真实落盘、真实退出/重启、
// 真实故障注入（把笔记文件换成同名目录使写入失败）。
// 用法：npm run build && node tests/notes.e2e.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { connectPage } from './lib/cdp.mjs'
import { readLog, waitForEvent } from './lib/logfile.mjs'
import {
  artifactsDir,
  clickAndWait,
  createReporter,
  delay,
  ensureBuild,
  expandByHover,
  launchApp,
  ps,
  quitApp,
  resetArtifacts,
  runCleanup,
  waitChildExit,
  waitCollapsed,
  waitFor,
  waitState
} from './lib/harness.mjs'

const shotsDir = path.join(artifactsDir, 'notes-shots')
const userDataDir = path.join(artifactsDir, 'notes-user-data')
const logFile = path.join(artifactsDir, 'notes.jsonl')
const noteFile = path.join(userDataDir, 'edge-notes-note.md')
const cdpPort = 9334

const { record, finish } = createReporter()

const readNoteFile = () => (existsSync(noteFile) ? readFileSync(noteFile, 'utf8') : null)
const statusText = (page) => page.evaluate(`document.querySelector('#save-status')?.textContent ?? ''`)
const editorValue = (page) => page.evaluate(`document.getElementById('note-editor').value`)

async function openPanel(page, metrics) {
  const edgeX = metrics.workingArea.x + metrics.workingArea.width - 2
  const midY = Math.floor((metrics.workingArea.y + metrics.workingArea.height) / 2)
  await expandByHover(page, edgeX, midY)
  // 桌面上可能存在其它同样贴边置顶的窗口，先把本窗口提到前台，确保真实鼠标点击落在本应用上
  await page.bringToFront()
  // bringToFront 会让 Chromium 把焦点恢复到编辑框；后面需要"未聚焦"的前提，这里先清掉
  await page.evaluate(`(() => { const el = document.activeElement; if (el && typeof el.blur === 'function') { el.blur() } })()`)
  await delay(250)
}

/** 用真实鼠标点进编辑区（验证点击链路与焦点）；桌面上可能有其它置顶窗口，允许有限次重试 */
async function clickIntoEditor(page, panelBounds, scale) {
  const rect = await page.evaluate(`(() => {
    const el = document.getElementById('note-editor')
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + Math.min(60, r.height / 2) }
  })()`)
  const x = Math.round((panelBounds.x + rect.x) * scale)
  const y = Math.round((panelBounds.y + rect.y) * scale)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.bringToFront()
    await delay(350)
    ps('click', '-X', String(x), '-Y', String(y))
    try {
      await waitFor(page, `document.activeElement?.id === 'note-editor'`, 1500, '编辑器获得焦点')
      return
    } catch {
      const diagnostic = await page.evaluate(`({
        hasFocus: document.hasFocus(),
        active: document.activeElement?.id ?? document.activeElement?.tagName ?? 'none'
      })`)
      console.log(`[click] 第 ${attempt} 次点击未命中编辑区: ${JSON.stringify(diagnostic)}`)
    }
  }
  throw new Error('真实鼠标点击未能让编辑器获得焦点（可能被其它置顶窗口遮挡）')
}

/** 直接聚焦编辑区并把光标放到末尾，保证后续输入是追加而不是插入中间 */
async function focusEditorAtEnd(page) {
  await page.evaluate(`(() => {
    const el = document.getElementById('note-editor')
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })()`)
  await waitFor(page, `document.activeElement?.id === 'note-editor'`, 3000, '编辑器获得焦点')
}

async function main() {
  ensureBuild()

  rmSync(logFile, { force: true })
  resetArtifacts([shotsDir, userDataDir])
  mkdirSync(shotsDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const metrics = JSON.parse(ps('metrics'))
  ps('move', '-X', '200', '-Y', '200', '-Wait', '200')

  // ------------------------------------------------------------ 启动 + 展开
  let app = launchApp({ userDataDir, logFile, cdpPort })
  const started = (await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000 })).record
  const area = started.workArea
  const areaRight = area.x + area.width
  const scale = started.scaleFactor
  const page = await connectPage(cdpPort)

  const emptySnapshot = await page.evaluate('window.edgeNotes.getNote()')
  record('首次启动笔记为空', emptySnapshot.content === '', JSON.stringify(emptySnapshot.status))
  record('首次启动不显示保存失败', emptySnapshot.status.state !== 'error', emptySnapshot.status.state)

  await openPanel(page, metrics)
  const expandedBounds = readLog(logFile).filter((item) => item.event === 'expanded').at(-1).bounds
  await clickIntoEditor(page, expandedBounds, scale)
  record('真实鼠标点击可进入编辑区', (await page.evaluate('document.activeElement?.id')) === 'note-editor')

  // ------------------------------------------------- 输入：中文 / 换行 / 标点
  const firstText = '第一行：中文、标点（括号）与 English words!\n第二行 a+b = c，换行正常。\n第三行结尾。'
  const typingFrom = readLog(logFile).length
  await page.insertText(firstText)
  await waitFor(page, `document.getElementById('note-editor').value.length === ${firstText.length}`, 3000, '文本进入编辑区')
  record('输入后编辑区内容正确', (await editorValue(page)) === firstText, `${firstText.length} 字`)
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 6000, '已保存状态')
  record('输入后显示「已保存」', (await statusText(page)) === '已保存')
  record('中文/换行/标点原样落盘', readNoteFile() === firstText, `${readNoteFile()?.length ?? 0} 字`)
  const statusEvents = readLog(logFile).slice(typingFrom).filter((item) => item.event === 'note-status')
  const statusFlow = statusEvents.map((item) => item.state).join('→')
  record('保存状态经历 保存中 → 已保存', statusFlow.includes('saving') && statusFlow.endsWith('saved'), statusFlow)
  await page.captureScreenshot(path.join(shotsDir, '01-editor.png'))

  // ------------------------------------------------- 粘贴：真实剪贴板 + 真实 Ctrl+V
  const pasted = '粘贴内容：\n\t缩进行  \n带空格结尾   \nEND'
  const clipboardBackup = path.join(artifactsDir, 'clipboard-backup.txt')
  const clipboardPayload = path.join(artifactsDir, 'clipboard-paste.txt')
  ps('clipboard-save', '-TextFile', clipboardBackup)
  writeFileSync(clipboardPayload, pasted, 'utf8')
  ps('clipboard-set', '-TextFile', clipboardPayload)
  await focusEditorAtEnd(page)
  const ctrlV = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrlV })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlV })
  await waitFor(
    page,
    `document.getElementById('note-editor').value.length === ${(firstText + pasted).length}`,
    5000,
    '剪贴板内容进入编辑区'
  )
  record('真实剪贴板 Ctrl+V 粘贴成功', (await editorValue(page)) === firstText + pasted)
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 6000, '粘贴后已保存')
  record('粘贴内容（含制表符与行尾空格）正确落盘', readNoteFile() === firstText + pasted)
  ps('clipboard-restore', '-TextFile', clipboardBackup)

  // ------------------------------------------------------ 快速连续输入大量文本
  const fastFrom = readLog(logFile).length
  const chunks = Array.from({ length: 14 }, (_, index) => `快速输入第${index + 1}段：abcdefghij0123456789；`)
  for (const chunk of chunks) {
    await page.insertText(chunk)
    await delay(25)
  }
  const fullText = firstText + pasted + chunks.join('')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 8000, '快速输入后已保存')
  record('快速连续输入的最后内容被保存', readNoteFile() === fullText, `文件 ${readNoteFile()?.length ?? 0} 字 / 期望 ${fullText.length} 字`)
  const fastSaves = readLog(logFile).slice(fastFrom).filter((item) => item.event === 'note-saved')
  record('频繁输入按防抖合并写盘', fastSaves.length >= 1 && fastSaves.length <= 4, `14 次输入产生 ${fastSaves.length} 次写盘`)

  // --------------------------------- 展开/收起、置顶切换都不丢内容
  const valueBefore = await editorValue(page)
  await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === false)
  await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === true)
  await delay(300)
  await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === false)
  await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === true)
  await delay(250)
  const afterToggles = await page.evaluate('window.edgeNotes.getState()')
  // 此刻编辑器仍持有焦点，按需求 8 不应自动收起
  record('编辑中切换置顶/固定展开不会意外收起', afterToggles.runtime.phase === 'expanded', afterToggles.runtime.phase)
  const valueAfter = await editorValue(page)
  record('展开收起与置顶切换不丢内容', valueAfter === valueBefore && valueAfter === fullText, `${valueAfter.length} 字`)
  record('切换期间磁盘内容未变', readNoteFile() === fullText)

  // ------------------------------------------- 编辑器聚焦时鼠标离开不收起
  await openPanel(page, metrics)
  await clickIntoEditor(page, expandedBounds, scale)
  const focusFrom = readLog(logFile).length
  ps('move', '-X', '200', '-Y', '300', '-Wait', '1700')
  const stillOpen = await page.evaluate('window.edgeNotes.getState()')
  const focusRecords = readLog(logFile).slice(focusFrom)
  record('编辑器聚焦时鼠标离开不会收起', stillOpen.runtime.phase === 'expanded', stillOpen.runtime.phase)
  record('聚焦期间没有产生收起动画', !focusRecords.some((item) => item.event === 'collapse-start'))

  // 点击标题栏（非编辑区）让编辑器失焦，随后应正常延迟收起
  const headerY = Math.round((expandedBounds.y + 18) * scale)
  const headerX = Math.round((expandedBounds.x + 40) * scale)
  ps('click', '-X', String(headerX), '-Y', String(headerY))
  await waitFor(page, `document.activeElement?.id !== 'note-editor'`, 3000, '编辑器失焦')
  const blurredState = await waitCollapsed(page)
  record('编辑器失焦后恢复正常自动收起', blurredState.runtime.phase === 'collapsed', blurredState.runtime.phase)

  // -------------------------------------- Markdown 预览 / XSS / 图片粘贴
  await openPanel(page, metrics)
  await clickIntoEditor(page, expandedBounds, scale)
  await focusEditorAtEnd(page)
  await page.insertText('\n# 标题一级\n\n**粗体** 与 `行内代码`\n\n- 项目一\n- 项目二\n\n> 引用一句\n')
  await delay(400)

  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await waitFor(page, `document.querySelector('#note-preview') !== null`, 3000, '进入预览模式')
  const previewInfo = await page.evaluate(`(() => {
    const root = document.querySelector('#note-preview')
    if (!root) return null
    return {
      h1: root.querySelector('h1')?.textContent ?? '',
      strong: root.querySelector('strong')?.textContent ?? '',
      code: root.querySelector('code')?.textContent ?? '',
      items: root.querySelectorAll('li').length,
      quote: root.querySelector('blockquote')?.textContent?.trim() ?? '',
      editorHidden: getComputedStyle(document.getElementById('note-editor')).display === 'none'
    }
  })()`)
  record(
    'Markdown 预览渲染标题/粗体/行内代码/列表/引用',
    previewInfo?.h1 === '标题一级' &&
      previewInfo.strong === '粗体' &&
      previewInfo.code === '行内代码' &&
      previewInfo.items === 2 &&
      previewInfo.quote === '引用一句' &&
      previewInfo.editorHidden === true,
    JSON.stringify(previewInfo)
  )
  await page.captureScreenshot(path.join(shotsDir, '05-markdown-preview.png'))

  // XSS：笔记内容是不可信输入，预览必须净化
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await delay(200)
  await focusEditorAtEnd(page)
  await page.insertText('\n<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>\n')
  await delay(300)
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await waitFor(page, `document.querySelector('#note-preview') !== null`, 3000, '再次进入预览')
  const xssInfo = await page.evaluate(`(() => ({
    scripts: document.querySelectorAll('#note-preview script').length,
    onerror: document.querySelectorAll('#note-preview [onerror]').length,
    flagged: window.__xss === undefined ? 'clean' : String(window.__xss)
  }))()`)
  record(
    '预览对笔记内容做了 XSS 净化',
    xssInfo.scripts === 0 && xssInfo.onerror === 0 && xssInfo.flagged === 'clean',
    JSON.stringify(xssInfo)
  )

  // 剪贴板图片：真实 Ctrl+V 粘贴 → 附件落盘 → 预览里能加载
  ps('clipboard-save', '-TextFile', clipboardBackup)
  ps('clipboard-set-image', '-Width', '72', '-Height', '48')
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await delay(200)
  await clickIntoEditor(page, expandedBounds, scale)
  await focusEditorAtEnd(page)
  const ctrlVImage = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrlVImage })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlVImage })
  await waitFor(page, `document.getElementById('note-editor').value.includes('](attachments/')`, 6000, '图片引用写入正文')
  const mdWithImage = await editorValue(page)
  const attachmentMatch = /\]\((attachments\/[^)]+)\)/.exec(mdWithImage)
  const attachmentPath = attachmentMatch ? path.join(userDataDir, attachmentMatch[1]) : ''
  record('粘贴图片后正文写入 attachments 引用', Boolean(attachmentMatch) && existsSync(attachmentPath), attachmentMatch?.[1] ?? '无')
  record('附件确实写到了磁盘', existsSync(attachmentPath) && readFileSync(attachmentPath).length > 100, `${existsSync(attachmentPath) ? readFileSync(attachmentPath).length : 0} bytes`)

  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 8000, '图片引用已保存')
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await waitFor(
    page,
    `(() => { const img = document.querySelector('#note-preview img'); return img !== null && img.complete && img.naturalWidth > 0 })()`,
    6000,
    '预览里图片解码完成'
  )
  const imageInfo = await page.evaluate(`(() => {
    const img = document.querySelector('#note-preview img')
    if (!img) return null
    return { src: img.getAttribute('src'), width: img.naturalWidth, complete: img.complete }
  })()`)
  record(
    '预览通过自定义协议加载附件图片',
    Boolean(imageInfo) && String(imageInfo.src).startsWith('edgenote-media://') && imageInfo.width > 0,
    JSON.stringify(imageInfo)
  )
  await page.captureScreenshot(path.join(shotsDir, '06-image-preview.png'))
  ps('clipboard-restore', '-TextFile', clipboardBackup)

  // 自定义协议只允许附件目录下的单层文件，任何 ../ 必须被拒绝
  const traversalFrom = readLog(logFile).length
  const traversalResult = await page.evaluate(`new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve('loaded')
    img.onerror = () => resolve('blocked')
    img.src = 'edgenote-media://local/attachments/..%2F..%2Fedge-notes-note.md'
    setTimeout(() => resolve('timeout'), 2500)
  })`)
  const traversalLog = readLog(logFile).slice(traversalFrom)
  record(
    '附件协议拒绝目录穿越',
    traversalResult === 'blocked' && traversalLog.some((item) => item.event === 'attachment-denied'),
    `${traversalResult} / denied=${traversalLog.filter((item) => item.event === 'attachment-denied').length}`
  )

  // 外链图片一律不加载（应用不联网）
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await delay(200)
  await focusEditorAtEnd(page)
  await page.insertText('\n![](https://example.com/remote.png)\n')
  await delay(300)
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await waitFor(page, `document.querySelector('#note-preview') !== null`, 3000, '外链场景预览')
  const remoteInfo = await page.evaluate(`(() => ({
    blocked: document.querySelectorAll('#note-preview .preview__blocked').length,
    remoteImgs: document.querySelectorAll('#note-preview img[src^="http"]').length
  }))()`)
  record('外链图片被阻止加载', remoteInfo.blocked >= 1 && remoteInfo.remoteImgs === 0, JSON.stringify(remoteInfo))
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await delay(200)

  // Ctrl+E 双向切换；视图模式要持久化到设置里
  await page.evaluate(`window.edgeNotes.setViewMode('edit')`)
  await waitFor(page, `document.getElementById('note-preview') === null`, 3000, '先回到编辑态')
  const ctrlE = { key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69, modifiers: 2 }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrlE })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlE })
  await waitFor(page, `document.getElementById('note-preview') !== null`, 3000, 'Ctrl+E 进入预览')
  const modePreview = (await page.evaluate('window.edgeNotes.getState()')).settings.viewMode
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrlE })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlE })
  await waitFor(page, `document.getElementById('note-preview') === null`, 3000, 'Ctrl+E 回到编辑')
  const modeAfter = (await page.evaluate('window.edgeNotes.getState()')).settings.viewMode
  record(
    'Ctrl+E 在编辑/预览间双向切换并写入设置',
    modePreview === 'preview' && modeAfter === 'edit',
    `${modePreview} → ${modeAfter}`
  )

  // 附件被删掉后，预览要给出可读提示而不是破图标
  if (attachmentPath) {
    rmSync(attachmentPath, { force: true })
  }
  await page.evaluate(`window.edgeNotes.setViewMode('preview')`)
  await waitFor(
    page,
    `[...document.querySelectorAll('#note-preview .preview__blocked')].some((el) => el.textContent.includes('图片缺失'))`,
    6000,
    '缺图提示'
  )
  const missingText = await page.evaluate(
    `[...document.querySelectorAll('#note-preview .preview__blocked')].map((el) => el.textContent).join('|')`
  )
  record('附件丢失时预览提示「图片缺失」', missingText.includes('图片缺失'), missingText.slice(0, 48))
  await page.evaluate(`window.edgeNotes.setViewMode('edit')`)
  await delay(200)

  // ------------------------------------------------------------ 清空 + 取消
  await openPanel(page, metrics)
  const contentBeforeClear = await editorValue(page)
  await page.evaluate(`document.getElementById('clear-note').click()`)
  await waitFor(page, `document.querySelector('.confirm') !== null`, 2000, '清空确认条')
  const confirmText = await page.evaluate(`document.querySelector('.confirm__text')?.textContent ?? ''`)
  record('点击清空后弹出确认', confirmText.includes('清空'), confirmText)
  await page.evaluate(`document.getElementById('clear-cancel').click()`)
  await delay(250)
  const afterCancel = await page.evaluate(`({
    confirm: document.querySelector('.confirm') !== null,
    value: document.getElementById('note-editor').value
  })`)
  record('取消清空后内容保持不变', afterCancel.confirm === false && afterCancel.value === contentBeforeClear)
  record('取消清空后磁盘内容保持不变', readNoteFile() === contentBeforeClear)

  await page.evaluate(`document.getElementById('clear-note').click()`)
  await waitFor(page, `document.querySelector('.confirm') !== null`, 2000, '清空确认条')
  await page.evaluate(`document.getElementById('clear-confirm').click()`)
  await waitFor(page, `document.getElementById('note-editor').value === ''`, 3000, '编辑区已清空')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 3000, '清空后已保存')
  record('确认清空后编辑区与磁盘都为空', (await editorValue(page)) === '' && readNoteFile() === '')

  // ----------------------------------------------- 保存失败提示（真实故障注入）
  await focusEditorAtEnd(page)
  await page.insertText('故障注入前的正常内容')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 6000, '故障前的保存')
  const beforeFailure = await editorValue(page)

  rmSync(noteFile, { force: true })
  mkdirSync(noteFile, { recursive: true })
  await page.insertText('——这段文字在保存失败时必须保留在编辑区——')
  await waitFor(page, `document.querySelector('.errorBar') !== null`, 8000, '保存失败提示')
  const failureUi = await page.evaluate(`({
    errorText: document.querySelector('.errorBar__text')?.textContent ?? '',
    status: document.querySelector('#save-status')?.textContent ?? '',
    value: document.getElementById('note-editor').value
  })`)
  record('保存失败时界面明确提示', failureUi.status === '保存失败' && failureUi.errorText.includes('保存失败'), failureUi.errorText)
  record('保存失败时内容仍保留在编辑区', failureUi.value === `${beforeFailure}——这段文字在保存失败时必须保留在编辑区——`, `${failureUi.value.length} 字`)
  const failureSnapshot = await page.evaluate('window.edgeNotes.getNote()')
  record('保存失败状态由主进程真实上报', failureSnapshot.status.state === 'error', String(failureSnapshot.status.message))
  await page.captureScreenshot(path.join(shotsDir, '02-save-failed.png'))

  // 恢复可写后重试
  rmSync(noteFile, { recursive: true, force: true })
  await page.evaluate(`document.querySelector('.errorBar .textBtn').click()`)
  await waitFor(page, `document.querySelector('.errorBar') === null`, 6000, '重试后错误提示消失')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 4000, '重试后已保存')
  record('恢复可写后重试成功写入', readNoteFile() === failureUi.value, `${readNoteFile()?.length ?? 0} 字`)
  await page.captureScreenshot(path.join(shotsDir, '03-recovered.png'))

  // ------------------------------------------- 立即退出：验证未完成保存被补写
  await focusEditorAtEnd(page)
  await page.insertText('退出前最后一句，不等待防抖立即关闭应用。')
  const expectedAfterQuit = await editorValue(page)
  const quitFrom = readLog(logFile).length
  quitApp(page)
  const exited = await waitChildExit(app, 8000)
  record('点击关闭按钮退出应用', exited)
  const quitRecords = readLog(logFile).slice(quitFrom)
  record('退出时补写了未落盘内容', quitRecords.some((item) => item.event === 'note-flushed-on-quit'), 'note-flushed-on-quit')
  record('退出后磁盘内容包含最后一句话', readNoteFile() === expectedAfterQuit, `${readNoteFile()?.length ?? 0} 字`)
  page.close()

  // ------------------------------------------------------------- 重启后恢复
  const beforeRestart = readLog(logFile).length
  app = launchApp({ userDataDir, logFile, cdpPort })
  await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000, fromIndex: beforeRestart })
  const page2 = await connectPage(cdpPort)
  const reopened = await page2.evaluate('window.edgeNotes.getNote()')
  record('重启后笔记内容完整恢复', reopened.content === expectedAfterQuit, `${reopened.content.length} 字`)
  await openPanel(page2, metrics)
  record('重启后编辑区显示上次内容', (await editorValue(page2)) === expectedAfterQuit)
  record('重启后显示已保存状态', (await statusText(page2)) === '已保存')
  await page2.captureScreenshot(path.join(shotsDir, '04-restored.png'))

  // ------------------------------------------------------- 收尾：清空并退出
  await page2.evaluate(`document.getElementById('clear-note').click()`)
  await waitFor(page2, `document.querySelector('.confirm') !== null`, 2000, '清空确认条')
  await page2.evaluate(`document.getElementById('clear-confirm').click()`)
  await waitFor(page2, `document.querySelector('#save-status')?.textContent === '已保存'`, 4000, '收尾清空')
  quitApp(page2)
  await waitChildExit(app, 8000)
  page2.close()

  record('笔记文件路径位于 userData 下', noteFile.includes('notes-user-data'), noteFile)
  record('窗口仍贴合工作区右边缘（本轮未破坏窗口行为）', Math.abs(areaRight - expandedBounds.x - expandedBounds.width) <= 2, JSON.stringify(expandedBounds))

  finish()
}

main().catch((error) => {
  console.error('笔记 E2E 执行失败:', error)
  runCleanup()
  process.exitCode = 1
})
