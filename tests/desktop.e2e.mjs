// 第 06 轮：Windows 桌面集成验证（系统托盘 / 隐藏与退出 / 开机启动 / 二次启动唤出）
// 用法：npm run build && node tests/desktop.e2e.mjs
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
    const noteFilePath = path.join(userDataDir, 'edge-notes-note.txt')
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
    const loginBefore = await page.evaluate('window.edgeNotes.getLoginItemState()')
    record('能读到开机启动真实状态', typeof loginBefore.enabled === 'boolean', JSON.stringify(loginBefore))
    let loginApplied = null
    let loginError = null
    try {
      await page.evaluate('window.edgeNotes.setLaunchAtLogin(true)')
      loginApplied = await page.evaluate('window.edgeNotes.getLoginItemState()')
      const stateAfter = await page.evaluate('window.edgeNotes.getState()')
      record('开启开机启动后系统回读为已启用', loginApplied.enabled === true, JSON.stringify(loginApplied))
      record('设置文件里的 launchAtLogin 与实际一致', stateAfter.settings.launchAtLogin === true)
    } catch (error) {
      loginError = error instanceof Error ? error.message : String(error)
    }
    if (loginError) {
      record('开机启动失败时明确报错（不伪造成功）', loginError.length > 0, loginError)
    }
    // 无论成功失败都恢复为关闭，避免给用户留下启动项
    try {
      await page.evaluate('window.edgeNotes.setLaunchAtLogin(false)')
      const loginOff = await page.evaluate('window.edgeNotes.getLoginItemState()')
      record('关闭开机启动后系统回读为未启用', loginOff.enabled === false, JSON.stringify(loginOff))
    } catch (error) {
      record('关闭开机启动失败时明确报错', error instanceof Error, error instanceof Error ? error.message : String(error))
    }

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
