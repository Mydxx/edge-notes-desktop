// 临时探针：验证单篇 → 多篇迁移 + 导航渲染
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectPage } from './lib/cdp.mjs'
import { readLog, waitForEvent } from './lib/logfile.mjs'
import { artifactsDir, delay, launchApp, ps, quitApp, waitChildExit } from './lib/harness.mjs'

const userDataDir = path.join(artifactsDir, 'multi-probe')
const logFile = path.join(artifactsDir, 'multi-probe.jsonl')
rmSync(userDataDir, { recursive: true, force: true })
rmSync(logFile, { force: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(path.join(userDataDir, 'edge-notes-note.md'), '# 我的旧笔记\n\n这是单篇时代的内容\n', 'utf8')

const app = launchApp({ userDataDir, logFile, cdpPort: 9350 })
try {
  await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000 })
  const page = await connectPage(9350)
  const ready = readLog(logFile).find((r) => r.event === 'app-ready')
  console.log('app-ready:', JSON.stringify({ notesCount: ready.notesCount, warning: ready.migrationWarning, dir: ready.notesDir }))
  console.log('migrated event:', JSON.stringify(readLog(logFile).find((r) => r.event === 'note-migrated-single')))
  console.log('notes:', JSON.stringify(await page.evaluate('window.edgeNotes.listNotes()')))
  console.log('note:', JSON.stringify(await page.evaluate('window.edgeNotes.getNote().then((n) => n.content)')))
  await delay(300)
  console.log('nav rows:', await page.evaluate(`document.querySelectorAll('.noteRow').length`))
  await page.captureScreenshot(path.join(artifactsDir, 'multi-probe.png'))

  // 再建两篇，看看多行效果
  await page.evaluate(`document.getElementById('new-note').click()`)
  await delay(400)
  await page.insertText('第二篇内容')
  await page.evaluate(`document.getElementById('new-note').click()`)
  await delay(400)
  await delay(300)
  await page.captureScreenshot(path.join(artifactsDir, 'multi-3notes.png'))
  console.log('notes now:', JSON.stringify((await page.evaluate('window.edgeNotes.listNotes()')).notes.map((n) => n.title)))

  // 收起导航
  await page.evaluate(`document.getElementById('toggle-nav').click()`)
  await delay(400)
  const navWidth = await page.evaluate(`document.getElementById('notes-nav').getBoundingClientRect().width`)
  console.log('collapsed nav width:', navWidth)
  await page.captureScreenshot(path.join(artifactsDir, 'multi-collapsed.png'))
  quitApp(page)
  await waitChildExit(app, 8000)
} catch (error) {
  console.error('probe failed:', error)
  app.kill()
}
