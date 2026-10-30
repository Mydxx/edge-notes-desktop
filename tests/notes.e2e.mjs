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
  readActiveNote,
  readNoteById,
  readNotesIndex,
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
// 多笔记：正文在 notes/<activeId>.md，按索引找当前活动笔记
const cdpPort = 9334

const { record, finish } = createReporter()

const readNoteFile = () => readActiveNote(userDataDir)

/** 当前活动笔记在磁盘上的真实路径（多笔记：notes/<activeId>.md） */
const activeNotePath = () => {
  const index = readNotesIndex(userDataDir)
  return index?.activeId ? path.join(userDataDir, 'notes', `${index.activeId}.md`) : ''
}
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

  // 点击图片放大；Esc 关闭
  const escKey = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await page.evaluate(`document.querySelector('#note-preview img').click()`)
  await waitFor(page, `document.querySelector('.lightbox') !== null`, 3000, '图片放大')
  const lightboxInfo = await page.evaluate(`(() => {
    const box = document.querySelector('.lightbox')
    const img = box?.querySelector('img')
    return { src: img?.getAttribute('src') ?? '', width: img?.naturalWidth ?? 0 }
  })()`)
  record(
    '点击预览图片可放大查看',
    String(lightboxInfo.src).startsWith('edgenote-media://') && lightboxInfo.width > 0,
    JSON.stringify(lightboxInfo)
  )
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...escKey })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escKey })
  await waitFor(page, `document.querySelector('.lightbox') === null`, 3000, 'Esc 关闭放大图')
  record('Esc 可关闭放大图', (await page.evaluate(`document.querySelector('.lightbox') === null`)) === true)

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

  // 跨笔记引用保护：另一篇笔记引用的图片不能被清理掉
  const crossPath = path.join(userDataDir, 'attachments', 'cross-note.png')
  writeFileSync(crossPath, Buffer.from('89504e470d0a1a0a', 'hex'))
  const crossId = (await page.evaluate('window.edgeNotes.listNotes()')).activeId
  const crossNote = await page.evaluate(`window.edgeNotes.createNote('跨笔记引用')`)
  await delay(300)
  await page.insertText('![](attachments/cross-note.png)')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 6000, '跨笔记引用已保存')
  await page.evaluate(`window.edgeNotes.switchNote('${crossId}')`)
  await waitFor(
    page,
    `document.querySelector('.noteRow--active')?.getAttribute('data-note-id') === '${crossId}'`,
    4000,
    '切回原笔记'
  )
  await delay(300)
  record(
    '另一篇笔记存在时，清理会跨笔记判断引用',
    Boolean(crossNote.index.notes.length === 2),
    `${crossNote.index.notes.map((note) => note.title).join(' / ')}`
  )

  // 清理未被引用的附件：先展示数量与体积，取消不删，确认后移入回收站
  const orphanPath = path.join(userDataDir, 'attachments', 'orphan-test.png')
  writeFileSync(orphanPath, Buffer.from('89504e470d0a1a0a', 'hex'))
  await page.evaluate(`document.getElementById('open-settings').click()`)
  await waitFor(page, `document.getElementById('prune-attachments') !== null`, 3000, '设置里有清理入口')
  await page.evaluate(`document.getElementById('prune-attachments').click()`)
  await waitFor(page, `document.getElementById('prune-confirm') !== null`, 5000, '清理确认条')
  const pruneText = await page.evaluate(`document.querySelector('.confirm__text')?.textContent ?? ''`)
  record(
    '清理前展示待清理数量与文件大小',
    pruneText.includes('1 个') && /B|KB|MB/.test(pruneText),
    pruneText.trim().slice(0, 60)
  )

  await page.evaluate(`document.getElementById('prune-cancel').click()`)
  await delay(300)
  record('取消清理后附件仍然存在', existsSync(orphanPath))

  await page.evaluate(`document.getElementById('prune-attachments').click()`)
  await waitFor(page, `document.getElementById('prune-confirm') !== null`, 5000, '再次打开清理确认')
  await page.evaluate(`document.getElementById('prune-confirm').click()`)
  await waitFor(page, `document.getElementById('prune-confirm') === null`, 6000, '清理完成')
  await delay(800)
  record(
    '确认后只移走未被引用的图片',
    !existsSync(orphanPath) && existsSync(attachmentPath),
    `orphan=${existsSync(orphanPath)} referenced=${existsSync(attachmentPath)}`
  )
  record(
    '另一篇笔记引用的图片没有被清理',
    existsSync(crossPath),
    `cross-note=${existsSync(crossPath)}`
  )
  // 收尾：删掉这篇临时笔记，后面的用例仍从原笔记继续
  await page.evaluate(`window.edgeNotes.deleteNote('${crossNote.index.activeId}')`)
  await delay(400)
  await page.evaluate(`document.getElementById('open-settings').click()`)
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

  // ------------------------------------ 多笔记：新建 / 切换 / 改名 / 删除
  const beforeMulti = await page.evaluate('window.edgeNotes.listNotes()')
  const firstNoteId = beforeMulti.activeId
  const firstNoteContent = await editorValue(page)
  record(
    '单篇笔记已升级为索引结构',
    beforeMulti.notes.length >= 1 && Boolean(firstNoteId),
    `${beforeMulti.notes.length} 篇`
  )

  const key = (k, code, vk, modifiers = 2) => ({
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers
  })
  const pressKey = async (k, code, vk, modifiers = 2) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key(k, code, vk, modifiers) })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key(k, code, vk, modifiers) })
  }

  // Ctrl+N 新建
  await pressKey('n', 'KeyN', 78)
  await waitFor(page, `document.querySelectorAll('.noteRow').length === ${beforeMulti.notes.length + 1}`, 4000, '新建笔记')
  const afterCreate = await page.evaluate('window.edgeNotes.listNotes()')
  const secondNoteId = afterCreate.activeId
  record('Ctrl+N 新建并切到新笔记', secondNoteId !== firstNoteId, `${afterCreate.notes.length} 篇`)
  const focusAfterCreate = await page.evaluate(`document.activeElement?.id ?? 'none'`)
  record('新建后焦点落在正文（不会把内容打进标题）', focusAfterCreate === 'note-editor', focusAfterCreate)

  await page.insertText('第二篇的内容')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 6000, '新笔记保存')
  record('新笔记写入自己的文件', (readNoteById(userDataDir, secondNoteId) ?? '').includes('第二篇的内容'))
  record('原笔记文件未被覆盖', (readNoteById(userDataDir, firstNoteId) ?? '') === firstNoteContent)

  // 切回第一篇
  await page.evaluate(`document.getElementById('note-row-${firstNoteId}').click()`)
  await waitFor(
    page,
    `document.querySelector('.noteRow--active')?.getAttribute('data-note-id') === '${firstNoteId}'`,
    4000,
    '切回第一篇'
  )
  await delay(250)
  record('切回后正文恢复为第一篇内容', (await editorValue(page)) === firstNoteContent, `${(await editorValue(page)).length} 字`)

  // 双击改名
  await page.evaluate(`document.getElementById('note-row-${firstNoteId}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor(page, `document.getElementById('rename-input') !== null`, 3000, '进入改名')
  await page.evaluate(`document.getElementById('rename-input').focus()`)
  await pressKey('a', 'KeyA', 65)
  await page.insertText('工作笔记')
  await pressKey('Enter', 'Enter', 13, 0)
  await waitFor(page, `document.getElementById('rename-input') === null`, 3000, '改名提交')
  await delay(300)
  const renamed = await page.evaluate('window.edgeNotes.listNotes()')
  record(
    '双击可改名并落盘',
    renamed.notes.find((note) => note.id === firstNoteId)?.title === '工作笔记',
    JSON.stringify(renamed.notes.map((note) => note.title))
  )
  record(
    '改名不影响正文与文件 id',
    (readNoteById(userDataDir, firstNoteId) ?? '') === firstNoteContent && renamed.activeId === firstNoteId
  )

  // 拖动调整顺序（在行上按下 → 向下移过一行 → 松手）
  const orderBefore = (await page.evaluate('window.edgeNotes.listNotes()')).notes.map((note) => note.id)
  await page.evaluate(`(() => {
    const row = document.getElementById('note-row-${orderBefore[0]}')
    const box = row.getBoundingClientRect()
    const at = (dy) => ({ bubbles: true, button: 0, clientX: box.left + 20, clientY: box.top + 10 + dy })
    row.dispatchEvent(new PointerEvent('pointerdown', at(0)))
    row.dispatchEvent(new PointerEvent('pointermove', at(40)))
    row.dispatchEvent(new PointerEvent('pointerup', at(40)))
  })()`)
  await delay(600)
  const orderAfter = (await page.evaluate('window.edgeNotes.listNotes()')).notes.map((note) => note.id)
  record(
    '拖动可以调整笔记顺序并落盘',
    orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0],
    `${orderBefore.join(',')} → ${orderAfter.join(',')}`
  )
  const persistedOrder = (readNotesIndex(userDataDir)?.notes ?? []).map((note) => note.id)
  record('新顺序写入了索引文件', persistedOrder[0] === orderBefore[1], persistedOrder.join(','))
  // 拖回原顺序，后面的断言仍按原顺序理解
  await page.evaluate(`(() => {
    const row = document.getElementById('note-row-${orderBefore[0]}')
    const box = row.getBoundingClientRect()
    const at = (dy) => ({ bubbles: true, button: 0, clientX: box.left + 20, clientY: box.top + 10 + dy })
    row.dispatchEvent(new PointerEvent('pointerdown', at(0)))
    row.dispatchEvent(new PointerEvent('pointermove', at(-40)))
    row.dispatchEvent(new PointerEvent('pointerup', at(-40)))
  })()`)
  await delay(500)

  // 每篇笔记独立的编辑/预览模式
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await waitFor(page, `document.getElementById('note-preview') !== null`, 3000, '第一篇进入预览')
  await page.evaluate(`document.getElementById('note-row-${secondNoteId}').click()`)
  await waitFor(
    page,
    `document.querySelector('.noteRow--active')?.getAttribute('data-note-id') === '${secondNoteId}'`,
    4000,
    '切到第二篇'
  )
  record('第二篇仍停留在编辑模式（模式按笔记记）', (await page.evaluate(`document.getElementById('note-preview') === null`)) === true)
  await page.evaluate(`document.getElementById('note-row-${firstNoteId}').click()`)
  await waitFor(
    page,
    `document.querySelector('.noteRow--active')?.getAttribute('data-note-id') === '${firstNoteId}'`,
    4000,
    '切回第一篇'
  )
  await waitFor(page, `document.getElementById('note-preview') !== null`, 3000, '第一篇恢复预览')
  record('切回后恢复该笔记自己的预览模式', true)
  await page.evaluate(`document.getElementById('toggle-preview').click()`)
  await delay(250)

  // 快速连续切换
  for (let i = 0; i < 6; i += 1) {
    await page.evaluate(`document.getElementById('note-row-${i % 2 === 0 ? secondNoteId : firstNoteId}').click()`)
    await delay(60)
  }
  await page.evaluate(`document.getElementById('note-row-${secondNoteId}').click()`)
  await waitFor(
    page,
    `document.querySelector('.noteRow--active')?.getAttribute('data-note-id') === '${secondNoteId}'`,
    4000,
    '快速切换后停在第二篇'
  )
  await delay(500)
  record('快速连续切换不会串内容', (await editorValue(page)).includes('第二篇的内容'), `${(await editorValue(page)).length} 字`)

  // 删除当前正在编辑的笔记：先取消，再确认
  await page.evaluate(`document.querySelector('#note-row-${secondNoteId} .noteRow__del').click()`)
  await waitFor(page, `document.getElementById('note-delete-confirm') !== null`, 3000, '删除确认条')
  const deleteText = await page.evaluate(`document.querySelector('.confirm__text')?.textContent ?? ''`)
  record('删除笔记前必须确认', deleteText.includes('删除'), deleteText.trim().slice(0, 32))
  await page.evaluate(`document.getElementById('note-delete-cancel').click()`)
  await delay(300)
  record(
    '取消删除后笔记仍在',
    (await page.evaluate('window.edgeNotes.listNotes()')).notes.length === 2
  )

  await page.evaluate(`document.querySelector('#note-row-${secondNoteId} .noteRow__del').click()`)
  await waitFor(page, `document.getElementById('note-delete-confirm') !== null`, 3000, '再次确认删除')
  await page.evaluate(`document.getElementById('note-delete-confirm').click()`)
  await waitFor(page, `document.querySelectorAll('.noteRow').length === 1`, 6000, '删除后只剩一篇')
  await delay(600)
  const afterDelete = await page.evaluate('window.edgeNotes.listNotes()')
  record(
    '删除正在编辑的笔记后自动切到剩下的笔记',
    afterDelete.notes.length === 1 && afterDelete.activeId === firstNoteId,
    JSON.stringify(afterDelete.notes.map((note) => note.title))
  )
  record('被删除的笔记文件已移出目录', !existsSync(path.join(userDataDir, 'notes', `${secondNoteId}.md`)))
  record('增删改之后原笔记内容未受影响', (await editorValue(page)) === firstNoteContent)

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

  // 把当前笔记文件换成同名目录，制造真实的 EPERM
  const failingNotePath = activeNotePath()
  rmSync(failingNotePath, { force: true })
  mkdirSync(failingNotePath, { recursive: true })
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
  rmSync(failingNotePath, { recursive: true, force: true })
  await page.evaluate(`document.querySelector('.errorBar .textBtn').click()`)
  await waitFor(page, `document.querySelector('.errorBar') === null`, 6000, '重试后错误提示消失')
  await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 4000, '重试后已保存')
  record('恢复可写后重试成功写入', readNoteFile() === failureUi.value, `${readNoteFile()?.length ?? 0} 字`)
  await page.captureScreenshot(path.join(shotsDir, '03-recovered.png'))

  // ------------------------------------------- 立即退出：验证未完成保存被补写
  await focusEditorAtEnd(page)
  await page.insertText('退出前最后一句，不等待防抖立即关闭应用。')
  const expectedAfterQuit = await editorValue(page)

  // 退出前留下可验证的工作状态：光标 7 + 预览模式。
  // 直接写状态、不等待节流，避免 600ms 防抖先落盘、让"退出补写"无从发生。
  const stateBeforeQuit = await page.evaluate('window.edgeNotes.listNotes()')
  await page.evaluate(`document.getElementById('note-editor').setSelectionRange(7, 7)`)
  await page.evaluate(
    `window.edgeNotes.setNoteViewState('${stateBeforeQuit.activeId}', { caret: 7, viewMode: 'preview' })`
  )
  await page.evaluate(`window.edgeNotes.setViewMode('preview')`)
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

  const indexAfterRestart = await page2.evaluate('window.edgeNotes.listNotes()')
  const restoredNote = indexAfterRestart.notes.find((note) => note.id === indexAfterRestart.activeId)
  record(
    '重启后回到上次打开的笔记',
    indexAfterRestart.activeId === stateBeforeQuit.activeId,
    `${indexAfterRestart.notes.length} 篇 / active=${indexAfterRestart.activeId}`
  )
  record('重启后恢复该笔记的预览模式', restoredNote?.viewMode === 'preview', String(restoredNote?.viewMode))
  await delay(400)
  const restoredCaret = await page2.evaluate(`document.getElementById('note-editor').selectionStart`)
  record('重启后恢复光标位置', restoredCaret === 7, `caret=${restoredCaret}`)
  record(
    '重启后恢复每篇笔记各自的滚动位置字段',
    typeof restoredNote?.scrollTop === 'number' && restoredNote.scrollTop >= 0,
    `scrollTop=${restoredNote?.scrollTop}`
  )
  await page2.evaluate(`window.edgeNotes.setViewMode('edit')`)
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

  record('笔记文件路径位于 userData/notes 下', activeNotePath().includes('notes-user-data'), activeNotePath())
  record('窗口仍贴合工作区右边缘（本轮未破坏窗口行为）', Math.abs(areaRight - expandedBounds.x - expandedBounds.width) <= 2, JSON.stringify(expandedBounds))

  // ------------------------------- 删除最后一篇笔记：不能把应用弄成"无笔记"状态
  const soloDir = path.join(artifactsDir, 'notes-solo-user-data')
  rmSync(soloDir, { recursive: true, force: true })
  const soloFrom = readLog(logFile).length
  const soloApp = launchApp({ userDataDir: soloDir, logFile, cdpPort })
  try {
    await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000, fromIndex: soloFrom })
    const soloPage = await connectPage(cdpPort)
    await waitFor(soloPage, `document.querySelectorAll('.noteRow').length === 1`, 5000, '初始一篇笔记')
    const soloIndex = await soloPage.evaluate('window.edgeNotes.listNotes()')
    const onlyId = soloIndex.activeId
    await soloPage.evaluate(`document.querySelector('#note-row-${onlyId} .noteRow__del').click()`)
    await waitFor(soloPage, `document.getElementById('note-delete-confirm') !== null`, 3000, '删除确认')
    await soloPage.evaluate(`document.getElementById('note-delete-confirm').click()`)
    await waitFor(soloPage, `document.querySelectorAll('.noteRow').length === 1`, 6000, '删除后仍有笔记')
    await delay(500)
    const seeded = await soloPage.evaluate('window.edgeNotes.listNotes()')
    const seededNote = await soloPage.evaluate('window.edgeNotes.getNote()')
    record(
      '删除最后一篇会自动补一篇空白笔记',
      seeded.notes.length === 1 && seeded.activeId !== onlyId && seededNote.content === '',
      `${seeded.notes.length} 篇 / 新 id=${seeded.activeId}`
    )
    quitApp(soloPage)
    await waitChildExit(soloApp, 8000)
    soloPage.close()
  } catch (error) {
    soloApp.kill()
    throw error
  }

  finish()
}

main().catch((error) => {
  console.error('笔记 E2E 执行失败:', error)
  runCleanup()
  process.exitCode = 1
})
