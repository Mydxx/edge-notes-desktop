// 第 06 轮：Windows 桌面集成验证（系统托盘 / 隐藏与退出 / 开机启动 / 二次启动唤出）
// 用法：npm run build && node tests/desktop.e2e.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { connectPage } from './lib/cdp.mjs'
import { readLog, waitForEvent } from './lib/logfile.mjs'
import {
  artifactsDir,
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

const shotsDir = path.join(artifactsDir, 'desktop-shots')
const userDataDir = path.join(artifactsDir, 'desktop-user-data')
const logFile = path.join(artifactsDir, 'desktop.jsonl')
const cdpPort = 9339

const { record, finish } = createReporter()

async function main() {
  ensureBuild()
  rmSync(logFile, { force: true })
  resetArtifacts([shotsDir, userDataDir])
  mkdirSync(shotsDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const metrics = JSON.parse(ps('metrics'))
  const edgeX = metrics.workingArea.x + metrics.workingArea.width - 2
  const midY = Math.floor((metrics.workingArea.y + metrics.workingArea.height) / 2)
  ps('move', '-X', '200', '-Y', '200', '-Wait', '200')

  const app = launchApp({ userDataDir, logFile, cdpPort })
  try {
    await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000 })
    const page = await connectPage(cdpPort)

    // ---------------------------------------------------------- 一、系统托盘
    await delay(400)
    const records = readLog(logFile)
    const trayCreated = records.find((item) => item.event === 'tray-created')
    const trayMenu = records.filter((item) => item.event === 'tray-menu-built').at(-1)
    record('托盘图标创建成功且图标非空', Boolean(trayCreated) && trayCreated.empty === false, JSON.stringify(trayCreated?.size ?? null))
    record(
      '托盘菜单包含显示/隐藏、固定展开、设置、退出',
      Boolean(trayMenu) &&
        trayMenu.items.includes('隐藏笔记栏') &&
        trayMenu.items.includes('固定展开') &&
        trayMenu.items.includes('设置…') &&
        trayMenu.items.includes('退出 Edge Notes'),
      JSON.stringify(trayMenu?.items)
    )

    const iconFile = path.join(process.cwd(), 'assets', 'tray.png')
    record('托盘图标来自项目内 assets 目录', existsSync(iconFile), iconFile)

    // ------------------------------------------------ 二、隐藏（不等于收起）
    await expandByHover(page, edgeX, midY)
    await page.evaluate(`document.getElementById('note-editor').focus()`)
    await page.insertText('隐藏到托盘前的测试内容')
    await waitState(page, (state) => state.runtime.expanded === true, 4000)

    const hideFrom = readLog(logFile).length
    await page.evaluate(`document.getElementById('hide-panel').click()`)
    const hiddenState = await waitState(page, (state) => state.runtime.hidden === true, 4000)
    record('点关闭按钮隐藏到托盘（进程仍在）', hiddenState.runtime.hidden === true && app.exitCode === null)
    const hideRecords = readLog(logFile).slice(hideFrom)
    record('隐藏动作有日志可追溯', hideRecords.some((item) => item.event === 'hidden-changed' && item.hidden === true))

    // 隐藏期间贴屏幕边缘不应唤出，否则"隐藏"没有意义
    const idleFrom = readLog(logFile).length
    ps('move', '-X', String(edgeX), '-Y', String(midY), '-Wait', '1600')
    const idleState = await page.evaluate('window.edgeNotes.getState()')
    const idleRecords = readLog(logFile).slice(idleFrom)
    record('隐藏期间鼠标贴边不会唤出面板', idleState.runtime.hidden === true && idleState.runtime.phase === 'collapsed', idleState.runtime.phase)
    record('隐藏期间没有产生展开事件', !idleRecords.some((item) => item.event === 'expand-start'))

    // 隐藏不丢内容：既要内存里有，也要真的落盘
    const noteWhileHidden = await page.evaluate('window.edgeNotes.getNote()')
    await delay(900)
    const noteFilePath = path.join(userDataDir, 'edge-notes-note.md')
    const onDisk = existsSync(noteFilePath) ? readFileSync(noteFilePath, 'utf8') : ''
    record('隐藏期间内容仍在内存', noteWhileHidden.content.includes('隐藏到托盘前的测试内容'), `${noteWhileHidden.content.length} 字`)
    record('隐藏期间内容已落盘', onDisk.includes('隐藏到托盘前的测试内容'), `${onDisk.length} 字`)

    // ------------------------- 二-2、系统关闭（Alt+F4 / WM_CLOSE）也只隐藏
    await page.evaluate('window.edgeNotes.setHidden(false)')
    await waitState(page, (state) => state.runtime.hidden === false, 5000)
    await delay(600)
    const closeFrom = readLog(logFile).length
    const closeInfo = ps('close-window', '-PanelPid', String(app.pid))
    await delay(800)
    const afterClose = await page.evaluate('window.edgeNotes.getState()').catch(() => null)
    const closeRecords = readLog(logFile).slice(closeFrom)
    record('系统关闭（WM_CLOSE）被拦截为隐藏', closeRecords.some((item) => item.event === 'close-intercepted'), closeInfo)
    record('系统关闭后进程仍存活且面板已隐藏', app.exitCode === null && afterClose?.runtime.hidden === true, `hidden=${afterClose?.runtime.hidden}`)

    // ------------------------------------------- 三、从托盘恢复 + 自动收起
    await page.evaluate('window.edgeNotes.setHidden(false)')
    const restored = await waitState(page, (state) => state.runtime.hidden === false && state.runtime.phase === 'expanded', 6000)
    record('从托盘恢复后面板自动滑出', restored.runtime.phase === 'expanded', restored.runtime.phase)
    await page.evaluate(`(() => { const el = document.activeElement; if (el && el.blur) el.blur() })()`)
    const collapsedAfterRestore = await waitCollapsed(page)
    record('恢复后自动收起逻辑未被破坏', collapsedAfterRestore.runtime.phase === 'collapsed', collapsedAfterRestore.runtime.phase)
    await page.captureScreenshot(path.join(shotsDir, '01-restored.png'))

    // ------------------------------------------------------ 四、开机启动
    // 未打包时 Windows 启动项不可用（实测 Electron 回读与注册表不一致），应用必须如实报告"不支持"
    const loginBefore = await page.evaluate('window.edgeNotes.getLoginItemState()')
    record(
      '未打包时明确报告开机启动不可用',
      loginBefore.supported === false && typeof loginBefore.enabled === 'boolean' && typeof loginBefore.active === 'boolean',
      JSON.stringify(loginBefore)
    )
    record(
      '不可用时给出可读原因（不伪造成功）',
      typeof loginBefore.message === 'string' && /开发模式|打包/.test(loginBefore.message),
      String(loginBefore.message)
    )

    let loginError = null
    try {
      await page.evaluate('window.edgeNotes.setLaunchAtLogin(true)')
    } catch (error) {
      loginError = error instanceof Error ? error.message : String(error)
    }
    record('尝试开启会被拒绝并说明原因', loginError !== null && /开发模式|打包/.test(loginError), String(loginError).slice(0, 60))

    const afterLoginAttempt = await page.evaluate('window.edgeNotes.getState()')
    record(
      '被拒绝后不会留下假的"已开启"',
      afterLoginAttempt.settings.launchAtLogin === false,
      String(afterLoginAttempt.settings.launchAtLogin)
    )

    // --------------------------------------- 五、二次启动唤出（含隐藏态）
    await page.evaluate('window.edgeNotes.setHidden(true)')
    await waitState(page, (state) => state.runtime.hidden === true, 4000)
    const secondFrom = readLog(logFile).length
    const second = launchApp({ userDataDir, logFile, cdpPort: cdpPort + 1 })
    const secondExited = await waitChildExit(second, 15000)
    record('二次启动的实例立即退出（单实例锁生效）', secondExited)
    const secondRecords = readLog(logFile).slice(secondFrom)
    record('二次启动会唤出已隐藏的面板', secondRecords.some((item) => item.event === 'second-instance'))
    const afterSecond = await waitState(page, (state) => state.runtime.hidden === false, 6000)
    record('唤出后面板处于可见状态', afterSecond.runtime.hidden === false, afterSecond.runtime.phase)

    // ---------------------------------------------------- 六、退出与清理
    await page.evaluate(`(() => { const el = document.activeElement; if (el && el.blur) el.blur() })()`)
    await expandByHover(page, edgeX, midY)
    await page.bringToFront()
    await page.evaluate(`document.getElementById('open-settings').click()`)
    await waitFor(page, `document.getElementById('quit-app') !== null`, 3000, '设置里有退出入口')
    record('设置面板提供明确的退出入口', (await page.evaluate(`!!document.getElementById('quit-app')`)) === true)

    const quitFrom = readLog(logFile).length
    await page.evaluate(`document.getElementById('quit-app').click()`)
    const exited = await waitChildExit(app, 10000)
    record('从设置面板退出后进程正常结束', exited)
    const quitRecords = readLog(logFile).slice(quitFrom)
    record('退出时先落盘再清理', quitRecords.some((item) => item.event === 'before-quit'))
    record('退出时销毁托盘', quitRecords.some((item) => item.event === 'tray-destroyed'))
    page.close()

    // 退出后不应有残留的 electron 进程（按 user-data 目录精确统计，避免误伤其它实例）
    await delay(600)
    const instanceInfo = ps('count-instances', '-TextFile', userDataDir)
    const leftoverCount = Number(instanceInfo.split(' ')[1])
    record('退出后无残留实例', leftoverCount === 0 && app.exitCode !== null, `${instanceInfo} exitCode=${app.exitCode}`)

    // ------------------------------- 七、数据目录迁移（含重启后真正生效）
    const pointerFile = path.join(artifactsDir, 'desktop-pointer.json')
    const migrateTarget = path.join(artifactsDir, 'desktop-migrated')
    rmSync(pointerFile, { force: true })
    rmSync(migrateTarget, { recursive: true, force: true })

    const envWithPointer = { EDGE_NOTES_POINTER: pointerFile }
    const app2From = readLog(logFile).length
    const app2 = launchApp({ userDataDir, logFile, cdpPort, extraEnv: envWithPointer })
    try {
      await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000, fromIndex: app2From })
      const page2 = await connectPage(cdpPort)
      await waitFor(page2, `document.getElementById('note-editor') !== null`, 5000, '编辑器就绪')
      const dirBefore = await page2.evaluate('window.edgeNotes.getDataDir()')
      record(
        '迁移前使用的是命令行指定的数据目录',
        path.resolve(dirBefore.current) === path.resolve(userDataDir),
        dirBefore.current
      )

      await page2.evaluate(`document.getElementById('note-editor').focus()`)
      await page2.insertText('迁移前的内容')
      await delay(900)

      // 造一个附件，验证改数据目录时图片会一起搬走
      const sourceAttachments = path.join(userDataDir, 'attachments')
      mkdirSync(sourceAttachments, { recursive: true })
      writeFileSync(path.join(sourceAttachments, 'probe.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

      const migrated = await page2.evaluate(`window.edgeNotes.setDataDir(${JSON.stringify(migrateTarget)})`)
      const noteInTarget = path.join(migrateTarget, 'edge-notes-note.md')
      const settingsInTarget = path.join(migrateTarget, 'edge-notes-settings.json')
      record(
        '迁移后新目录里数据齐全',
        existsSync(noteInTarget) && existsSync(settingsInTarget) && readFileSync(noteInTarget, 'utf8').includes('迁移前的内容'),
        JSON.stringify(migrated.copied)
      )
      const migratedAttachment = path.join(migrateTarget, 'attachments', 'probe.png')
      record(
        '迁移会连同 attachments 一起搬走（图片链接不会失效）',
        existsSync(migratedAttachment) && readFileSync(migratedAttachment).length === 8,
        migratedAttachment
      )
      // 逐文件 SHA-256 比对：内容必须完全一致，而不只是"大小差不多"
      const sha = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex')
      const pairs = [
        ['edge-notes-note.md'],
        ['edge-notes-settings.json'],
        [path.join('attachments', 'probe.png')]
      ]
      const hashesOk = pairs.every(([relative]) => {
        const src = path.join(userDataDir, relative)
        const dest = path.join(migrateTarget, relative)
        return existsSync(src) && existsSync(dest) && sha(src) === sha(dest)
      })
      record('迁移后逐文件 SHA-256 一致', hashesOk, `${pairs.length} 个文件`)

      const pointerRaw = existsSync(pointerFile) ? JSON.parse(readFileSync(pointerFile, 'utf8')) : null
      record('迁移后写入指针文件（指向新目录）', pointerRaw?.dataDir === migrateTarget, JSON.stringify(pointerRaw))
      record('迁移结果要求重启生效', migrated.requiresRestart === true)

      // 二次迁移到已有数据的目录应被拒绝（防止覆盖别人/自己的笔记）
      let duplicateError = null
      try {
        await page2.evaluate(`window.edgeNotes.setDataDir(${JSON.stringify(migrateTarget)})`)
      } catch (error) {
        duplicateError = error instanceof Error ? error.message : String(error)
      }
      record('目标目录已有数据时拒绝覆盖', duplicateError !== null && duplicateError.length > 0, String(duplicateError).slice(0, 60))

      // 目标是一个文件而不是目录：迁移必须失败，且原数据与指针都不能被动过
      const badTarget = path.join(artifactsDir, 'desktop-not-a-dir.txt')
      writeFileSync(badTarget, 'not a directory', 'utf8')
      const noteBefore = readFileSync(path.join(userDataDir, 'edge-notes-note.md'), 'utf8')
      let invalidTargetError = null
      try {
        await page2.evaluate(`window.edgeNotes.setDataDir(${JSON.stringify(badTarget)})`)
      } catch (error) {
        invalidTargetError = error instanceof Error ? error.message : String(error)
      }
      record(
        '目标路径非法时迁移失败并说明原因',
        invalidTargetError !== null && /迁移失败|路径|目录/.test(invalidTargetError),
        String(invalidTargetError).slice(0, 70)
      )
      record(
        '迁移失败不破坏原数据与指针',
        readFileSync(path.join(userDataDir, 'edge-notes-note.md'), 'utf8') === noteBefore &&
          (existsSync(pointerFile) ? JSON.parse(readFileSync(pointerFile, 'utf8')).dataDir : null) === migrateTarget,
        `note=${noteBefore.length} 字`
      )

      quitApp(page2)
      await waitChildExit(app2, 10000)
      page2.close()
    } catch (error) {
      app2.kill()
      throw error
    }

    // 重启：指针文件应让应用直接使用新目录，且笔记还在
    const restartFrom = readLog(logFile).length
    const app3 = launchApp({ userDataDir, logFile, cdpPort, extraEnv: envWithPointer })
    try {
      await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000, fromIndex: restartFrom })
      const restartRecords = readLog(logFile).slice(restartFrom)
      const ready = restartRecords.find((item) => item.event === 'app-ready')
      record(
        '重启后按指针使用新的数据目录',
        ready?.userData === migrateTarget,
        `${ready?.userData ?? 'unknown'}`
      )
      const page3 = await connectPage(cdpPort)
      const note = await page3.evaluate('window.edgeNotes.getNote()')
      record('新目录里的笔记可直接读回', note.content.includes('迁移前的内容'), `${note.content.length} 字`)
      quitApp(page3)
      await waitChildExit(app3, 10000)
      page3.close()
    } catch (error) {
      app3.kill()
      throw error
    }

    // ------------------------------- 八、旧版纯文本笔记（.txt）升级到 .md
    const legacyDir = path.join(artifactsDir, 'desktop-legacy')
    rmSync(legacyDir, { recursive: true, force: true })
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, 'edge-notes-note.txt'), '# 旧版纯文本\n这段内容必须原样保留', 'utf8')
    const legacyFrom = readLog(logFile).length
    const legacyApp = launchApp({ userDataDir: legacyDir, logFile, cdpPort })
    try {
      await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000, fromIndex: legacyFrom })
      const legacyPage = await connectPage(cdpPort)
      await waitFor(legacyPage, `document.getElementById('note-editor') !== null`, 5000, '编辑器就绪')
      const legacyNote = await legacyPage.evaluate('window.edgeNotes.getNote()')
      record(
        '旧版 .txt 笔记自动迁移为 .md 且内容不变',
        legacyNote.content.includes('这段内容必须原样保留') &&
          existsSync(path.join(legacyDir, 'edge-notes-note.md')) &&
          !existsSync(path.join(legacyDir, 'edge-notes-note.txt')),
        `${legacyNote.content.length} 字`
      )
      quitApp(legacyPage)
      await waitChildExit(legacyApp, 10000)
      legacyPage.close()
    } catch (error) {
      legacyApp.kill()
      throw error
    }

    finish()
  } catch (error) {
    app.kill()
    throw error
  }
}

main().catch((error) => {
  console.error('桌面集成验证执行失败:', error)
  runCleanup()
  process.exitCode = 1
})
