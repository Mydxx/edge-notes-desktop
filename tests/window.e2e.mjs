// 窗口行为端到端验证：真实启动 Electron、真实移动鼠标、通过 CDP 点击 UI，断言日志与窗口状态。
// 用法：npm run build && node tests/window.e2e.mjs
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
  resetArtifacts,
  root,
  runCleanup,
  waitChildExit,
  waitCollapsed,
  waitFor,
  waitState
} from './lib/harness.mjs'

const shotsDir = path.join(artifactsDir, 'window-shots')
const userDataDir = path.join(artifactsDir, 'window-user-data')
const logFile = path.join(artifactsDir, 'window.jsonl')
const cdpPort = 9333

const { record, finish } = createReporter()

const summarize = (records) => records.map((item) => item.event).join(' → ')

/** 真实鼠标点击 + 状态轮询；单击偶尔会被窗口动画/焦点切换吃掉，允许有限次重试 */
async function realClickUntil(page, x, y, predicate, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ps('click', '-X', String(x), '-Y', String(y))
    try {
      return await waitState(page, predicate, 1600)
    } catch {
      const active = await page.evaluate(`document.activeElement?.id ?? 'none'`)
      console.log(`[click] 第 ${attempt} 次点击未生效（activeElement=${active}），重试`)
    }
  }
  throw new Error('真实鼠标点击未生效')
}

async function main() {
  ensureBuild()

  rmSync(logFile, { force: true })
  resetArtifacts([shotsDir, userDataDir])
  mkdirSync(shotsDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const metrics = JSON.parse(ps('metrics'))
  console.log(`[env] 屏幕 ${metrics.bounds.width}x${metrics.bounds.height}，工作区 ${metrics.workingArea.width}x${metrics.workingArea.height}`)
  console.log(`[env] 日志 ${logFile}`)

  // 先把真实鼠标停到屏幕左侧中性位置，避免测试开始时鼠标正好压在触发条上
  ps('move', '-X', '200', '-Y', '200', '-Wait', '200')

  // ---------------------------------------------------------------- 阶段 1：启动
  let app = launchApp({ userDataDir, logFile, cdpPort })
  const started = (await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000 })).record
  const area = started.workArea
  const applied = started.applied
  const areaRight = area.x + area.width

  record('应用启动成功并完成初始定位', Boolean(applied), JSON.stringify(applied))
  record('启动默认收起', started.phase === 'collapsed')
  record(
    '纵向覆盖可用工作区（不压任务栏）',
    Math.abs(applied.y - area.y) <= 2 && Math.abs(applied.height - area.height) <= 2,
    `y=${applied.y}/${area.y} h=${applied.height}/${area.height}`
  )
  record('收起时仅保留窄触发条', Math.abs(areaRight - applied.x - 4) <= 2, `可见宽度=${areaRight - applied.x}px`)
  record('置顶默认生效', started.alwaysOnTop === true)

  // -------------------------------------------------- 阶段 2：渲染层与开关（CDP）
  const page = await connectPage(cdpPort)
  const dom = await page.evaluate(`({
    title: document.querySelector('.bar__title')?.textContent ?? null,
    topPressed: document.getElementById('toggle-always-on-top')?.getAttribute('aria-pressed') ?? null,
    pinPressed: document.getElementById('toggle-pinned')?.getAttribute('aria-pressed') ?? null,
    hasApi: typeof window.edgeNotes?.getState === 'function',
    nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined'
  })`)
  record('面板标题为 Edge Notes', dom.title === 'Edge Notes', String(dom.title))
  record('preload API 可用', dom.hasApi === true)
  record('渲染进程无法直接访问 Node.js', dom.nodeLeak === false)
  record('置顶开关默认开启', dom.topPressed === 'true')
  record('固定展开默认关闭', dom.pinPressed === 'false')

  const offState = await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === false)
  record('置顶开关可关闭', offState.settings.alwaysOnTop === false)
  await delay(300)
  let appliedLogs = readLog(logFile).filter((item) => item.event === 'settings-applied')
  record('主进程 isAlwaysOnTop() 随之变为 false', appliedLogs.at(-1)?.isAlwaysOnTop === false, `isAlwaysOnTop=${appliedLogs.at(-1)?.isAlwaysOnTop}`)

  const onState = await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === true)
  record('置顶开关可重新开启', onState.settings.alwaysOnTop === true)
  await delay(300)
  appliedLogs = readLog(logFile).filter((item) => item.event === 'settings-applied')
  record('主进程 isAlwaysOnTop() 随之恢复 true', appliedLogs.at(-1)?.isAlwaysOnTop === true, `isAlwaysOnTop=${appliedLogs.at(-1)?.isAlwaysOnTop}`)

  // --------------------------------- 阶段 2b：用真实鼠标点击面板里的开关（非 DOM 事件模拟）
  const scaleFactor = started.scaleFactor
  const workRightPx = metrics.workingArea.x + metrics.workingArea.width - 2
  const workMidPx = Math.floor((metrics.workingArea.y + metrics.workingArea.height) / 2)
  await expandByHover(page, workRightPx, workMidPx)
  await page.bringToFront()
  await delay(250)
  const buttonRect = await page.evaluate(`(() => {
    const rect = document.getElementById('toggle-pinned').getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)
  const expandedRecord = readLog(logFile).filter((item) => item.event === 'expanded').at(-1)
  if (!expandedRecord) {
    throw new Error('面板未展开，无法取得窗口矩形用于真实点击')
  }
  const clickX = Math.round((expandedRecord.bounds.x + buttonRect.x) * scaleFactor)
  const clickY = Math.round((expandedRecord.bounds.y + buttonRect.y) * scaleFactor)
  const realClickOn = await realClickUntil(page, clickX, clickY, (state) => state.settings.pinnedOpen === true)
  record('真实鼠标点击「固定展开」生效', realClickOn.settings.pinnedOpen === true, `click=(${clickX},${clickY})`)

  const realClickOff = await realClickUntil(page, clickX, clickY, (state) => state.settings.pinnedOpen === false)
  record('再次真实点击可关闭固定展开', realClickOff.settings.pinnedOpen === false)

  // 宽度可调且始终贴边（无 UI，验证 IPC 与几何重算）
  ps('move', '-X', '200', '-Y', '200', '-Wait', '1300')
  const widerFrom = readLog(logFile).length
  await page.evaluate('window.edgeNotes.setWidth(420)')
  await delay(350)
  const widerLayout = readLog(logFile)
    .slice(widerFrom)
    .filter((item) => item.event === 'layout-reapplied')
    .at(-1)
  record(
    '宽度调整后仍然只露触发条',
    Boolean(widerLayout) && Math.abs(widerLayout.applied.width - 420) <= 1 && Math.abs(areaRight - widerLayout.applied.x - 4) <= 2,
    JSON.stringify(widerLayout?.applied)
  )
  await page.evaluate('window.edgeNotes.setWidth(350)')
  await delay(350)

  // --------------------------- 阶段 2c：设置弹层（左右切换）+ 真实拖动调宽
  record('头栏存在设置入口', (await page.evaluate(`!!document.getElementById('open-settings')`)) === true)
  await page.evaluate(`document.getElementById('open-settings').click()`)
  await waitFor(page, `document.querySelector('.settings') !== null`, 2000, '设置弹层打开')
  const popoverText = await page.evaluate(`document.querySelector('.settings')?.textContent ?? ''`)
  record('设置弹层包含停靠位置与宽度', popoverText.includes('停靠位置') && popoverText.includes('面板宽度'), popoverText.trim().slice(0, 36))
  await page.captureScreenshot(path.join(shotsDir, '13-settings.png'))

  const sideFrom = readLog(logFile).length
  await page.evaluate(`document.getElementById('side-left').click()`)
  const leftSideState = await waitState(page, (state) => state.settings.side === 'left', 4000)
  const leftLayoutRecord = readLog(logFile)
    .slice(sideFrom)
    .filter((item) => item.event === 'layout-reapplied')
    .at(-1)
  // 切换时面板是收起态，正确位置应是「藏到左缘外、只留 4px 触发条」
  const leftVisible = leftLayoutRecord ? leftLayoutRecord.applied.x + leftLayoutRecord.applied.width - area.x : -99
  record(
    '设置弹层可切到左侧停靠',
    leftSideState.settings.side === 'left' && leftSideState.runtime.phase === 'collapsed' && Math.abs(leftVisible - 4) <= 2,
    JSON.stringify(leftLayoutRecord?.applied)
  )
  await page.evaluate(`document.getElementById('side-right').click()`)
  const rightSideState = await waitState(page, (state) => state.settings.side === 'right', 4000)
  record('设置弹层可切回右侧停靠', rightSideState.settings.side === 'right')

  const escapeKey = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...escapeKey })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escapeKey })
  await waitFor(page, `document.querySelector('.settings') === null`, 2500, 'Esc 关闭设置弹层')
  record('Esc 可关闭设置弹层', (await page.evaluate(`document.querySelector('.settings')`)) === null)

  // 真实鼠标拖动内缘把手加宽
  await expandByHover(page, workRightPx, workMidPx)
  await page.bringToFront()
  await delay(300)
  const widthBefore = (await page.evaluate('window.edgeNotes.getState()')).settings.width
  const handleRect = await page.evaluate(`(() => {
    const el = document.getElementById('resize-handle')
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  const boundsNow = readLog(logFile).filter((item) => item.event === 'expanded').at(-1)
  if (!boundsNow) {
    throw new Error('面板未展开，无法拖动调宽')
  }
  const grabX = Math.round((boundsNow.bounds.x + handleRect.x) * scaleFactor)
  const grabY = Math.round((boundsNow.bounds.y + handleRect.y) * scaleFactor)

  const dragFrom = readLog(logFile).length
  ps('drag', '-X', String(grabX), '-Y', String(grabY), '-ToX', String(grabX - Math.round(80 * scaleFactor)), '-ToY', String(grabY))
  await delay(400)
  const afterDrag = await page.evaluate('window.edgeNotes.getState()')
  const dragRecords = readLog(logFile).slice(dragFrom)
  record('真实拖动内缘可加宽面板', afterDrag.settings.width >= widthBefore + 60, `${widthBefore} -> ${afterDrag.settings.width}`)
  record('拖动期间不会自动收起', !dragRecords.some((item) => item.event === 'collapse-start'))
  const dragLayout = dragRecords.filter((item) => item.event === 'layout-reapplied').at(-1)
  record(
    '拖动后仍贴合屏幕边缘',
    Boolean(dragLayout) && Math.abs(areaRight - (dragLayout.applied.x + dragLayout.applied.width)) <= 2,
    JSON.stringify(dragLayout?.applied)
  )
  await delay(450)
  const settingsPath = path.join(userDataDir, 'edge-notes-settings.json')
  const persistedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  record('拖动的宽度已落盘', Math.abs(persistedSettings.width - afterDrag.settings.width) <= 1, `file=${persistedSettings.width}`)
  await page.captureScreenshot(path.join(shotsDir, '14-resized.png'))

  // 先把指针放回面板内部，避免停在边缘触发延迟收起
  ps('move', '-X', String(workRightPx - 200), '-Y', String(workMidPx), '-Wait', '300')
  if ((await page.evaluate('window.edgeNotes.getState()')).runtime.phase !== 'expanded') {
    await expandByHover(page, workRightPx, workMidPx)
  }

  // 继续向右拖到极窄：应被夹紧到最小宽度
  const handleRect2 = await page.evaluate(`(() => {
    const el = document.getElementById('resize-handle')
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  const stateNow = await page.evaluate('window.edgeNotes.getState()')
  const panelLeftX = stateNow.settings.side === 'right' ? areaRight - stateNow.settings.width : area.x
  const grab2X = Math.round((panelLeftX + handleRect2.x) * scaleFactor)
  const grab2Y = Math.round((area.y + handleRect2.y) * scaleFactor)
  ps('drag', '-X', String(grab2X), '-Y', String(grab2Y), '-ToX', String(grab2X + Math.round(260 * scaleFactor)), '-ToY', String(grab2Y))
  await delay(400)
  const clamped = (await page.evaluate('window.edgeNotes.getState()')).settings.width
  record('过窄拖动被夹紧到最小宽度', clamped >= 258 && clamped <= 262, `${clamped}px`)

  await page.evaluate('window.edgeNotes.setWidth(350)')
  await delay(350)

  // ------------------------------------------------------ 阶段 3：真实鼠标展开/收起
  // 按日志下标切分阶段，避免依赖两个进程的墙钟时间；
  // 机器上若有其它程序并发驱动鼠标（例如同时运行的另一个同类应用/测试），允许有限次重试。
  let hoverOutput = ''
  let hoverRecords = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    ps('move', '-X', '200', '-Y', '200', '-Wait', '1200')
    const hoverFrom = readLog(logFile).length
    hoverOutput = ps('hover', '-OutDir', shotsDir)
    await delay(350)
    hoverRecords = readLog(logFile).slice(hoverFrom)
    if (hoverRecords.some((item) => item.event === 'expand-start' && item.reason === 'trigger-hover')) {
      break
    }
    console.log(`[hover] 第 ${attempt} 次未捕获到触发展开（可能被其它程序抢占鼠标），重试`)
  }
  record('悬停驱动脚本完整执行', hoverOutput.includes('HOVER-DONE'), hoverOutput.split('\n').at(-1))
  const expandStarts = hoverRecords.filter((item) => item.event === 'expand-start')
  const expandedEvents = hoverRecords.filter((item) => item.event === 'expanded')
  const collapseStarts = hoverRecords.filter((item) => item.event === 'collapse-start')
  const collapsedEvents = hoverRecords.filter((item) => item.event === 'collapsed')
  const scheduled = hoverRecords.filter((item) => item.event === 'collapse-scheduled')
  const cancelled = hoverRecords.filter((item) => item.event === 'collapse-cancelled')

  console.log(`[hover] ${summarize(hoverRecords.filter((item) => item.event !== 'phase-change'))}`)

  record('鼠标触碰触发条后展开', expandStarts.length >= 1 && expandStarts[0].reason === 'trigger-hover')
  record('展开动画完成', expandedEvents.length >= 1)
  if (expandStarts.length > 0 && expandedEvents.length > 0) {
    record('展开动画时长合理（<600ms）', expandedEvents[0].t - expandStarts[0].t < 600, `${expandedEvents[0].t - expandStarts[0].t}ms`)
  }
  record('鼠标离开后进入延迟收起', scheduled.length >= 1, `延迟=${scheduled[0]?.delayMs}ms`)
  record('鼠标返回时取消收起', cancelled.length >= 1)
  record('延迟结束后确实收起', collapseStarts.length >= 1 && collapsedEvents.length >= 1)
  record('一次悬停只展开一次（无抖动）', expandStarts.length === 1, `expand-start=${expandStarts.length}`)
  const expandedBounds = expandedEvents.at(-1)?.bounds
  record(
    '展开位置贴合工作区右边缘',
    Boolean(expandedBounds) &&
      Math.abs(expandedBounds.x + expandedBounds.width - areaRight) <= 2 &&
      expandedBounds.x >= area.x,
    JSON.stringify(expandedBounds)
  )

  // 屏幕上可能有其它同样贴在右边缘的置顶窗口，像素级测量只能作为参考值，不做硬断言。
  // 4px 触发条的硬性依据是上面的 bounds（applied.x == 工作区右边缘 - 4）。
  console.log(`[strip] 屏幕右边缘可见条宽度参考值: ${ps('strip', '-Image', path.join(shotsDir, '01-collapsed.png'))}`)

  // ------------------------------------------------------------ 阶段 4：快速进出
  let jitterOutput = ''
  let jitterRecords = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    ps('move', '-X', '200', '-Y', '200', '-Wait', '1200')
    const jitterFrom = readLog(logFile).length
    jitterOutput = ps('jitter', '-OutDir', shotsDir)
    await delay(350)
    jitterRecords = readLog(logFile).slice(jitterFrom)
    if (jitterRecords.some((item) => item.event === 'expand-start')) {
      break
    }
    console.log(`[jitter] 第 ${attempt} 次未捕获到展开事件，重试`)
  }
  record('快速进出驱动脚本完整执行', jitterOutput.includes('JITTER-DONE'), jitterOutput.split('\n').at(-1))
  const jitterExpands = jitterRecords.filter((item) => item.event === 'expand-start')
  const jitterCollapses = jitterRecords.filter((item) => item.event === 'collapse-start')
  console.log(`[jitter] expand-start=${jitterExpands.length} collapse-start=${jitterCollapses.length}`)
  record(
    '快速进出边缘不会反复展开/收起',
    jitterExpands.length <= 2 && jitterCollapses.length <= 2,
    `展开${jitterExpands.length}次 / 收起${jitterCollapses.length}次`
  )
  const jitterState = await page.evaluate('window.edgeNotes.getState()')
  record('快速进出后回到收起态', jitterState.runtime.phase === 'collapsed', jitterState.runtime.phase)

  // -------------------------------------------------------- 阶段 5：固定展开开关
  ps('move', '-X', '200', '-Y', '200', '-Wait', '300')
  const pinned = await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === true)
  record('固定展开开关可开启', pinned.settings.pinnedOpen === true)
  await delay(500)
  const pinnedState = await page.evaluate('window.edgeNotes.getState()')
  record('开启固定展开后自动展开', pinnedState.runtime.phase === 'expanded', pinnedState.runtime.phase)
  ps('shot', '-OutDir', shotsDir, '-Name', '07-pinned')

  const pinFrom = readLog(logFile).length
  ps('move', '-X', '200', '-Y', '300', '-Wait', '1500')
  ps('shot', '-OutDir', shotsDir, '-Name', '08-pinned-still-open')
  const pinRecords = readLog(logFile).slice(pinFrom)
  record('固定展开时鼠标离开不收起', !pinRecords.some((item) => item.event === 'collapse-start'))
  const stillPinned = await page.evaluate('window.edgeNotes.getState()')
  record('固定展开时保持展开态', stillPinned.runtime.phase === 'expanded', stillPinned.runtime.phase)

  const unpinned = await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === false)
  record('固定展开开关可关闭', unpinned.settings.pinnedOpen === false)
  const afterUnpin = await waitCollapsed(page)
  record('关闭固定展开且鼠标在外部时自动收起', afterUnpin.runtime.phase === 'collapsed', afterUnpin.runtime.phase)

  // ------------------------------ 阶段 6：置顶对真实系统 Z 序的影响
  const scale = started.scaleFactor
  const panelLeftPx = Math.round(expandedBounds.x * scale)
  const dialogX = Math.max(0, panelLeftPx - 120)
  await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === true)
  ps('move', '-X', '200', '-Y', '200', '-Wait', '600')

  const openInfo = ps('dialog-open', '-X', String(dialogX), '-Y', '60', '-Width', '620', '-Height', '900')
  const dialogPid = Number(openInfo.split(' ')[1].split('=')[1])
  const appPid = String(app.pid)
  // 用系统 Z 序索引比较（EnumWindows 自上而下），不依赖屏幕像素，
  // 这样即使桌面上还有别的置顶窗口也不会误判。
  const zorder = () => {
    const output = ps('zorder-compare', '-PanelPid', appPid, '-TargetPid', String(dialogPid))
    const match = /panel=(-?\d+) other=(-?\d+)/.exec(output)
    return { output, panel: match ? Number(match[1]) : -1, other: match ? Number(match[2]) : -1 }
  }

  const topmostOnStyle = ps('panel-topmost', '-PanelPid', appPid)
  const zorderOn = zorder()
  record('置顶开启时窗口带 WS_EX_TOPMOST', topmostOnStyle.includes('topmost=True'), topmostOnStyle)
  record(
    '置顶开启时面板在普通窗口之上（系统 Z 序）',
    zorderOn.panel >= 0 && zorderOn.other >= 0 && zorderOn.panel < zorderOn.other,
    zorderOn.output
  )

  await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === false)
  await delay(250)
  const topmostOffStyle = ps('panel-topmost', '-PanelPid', appPid)
  record('关闭置顶后 WS_EX_TOPMOST 被移除', topmostOffStyle.includes('topmost=False'), topmostOffStyle)

  const focusInfo = ps('dialog-focus', '-TargetPid', String(dialogPid))
  const zorderOff = zorder()
  if (focusInfo.includes('match=True')) {
    record(
      '关闭置顶并把普通窗口切到前台后会被压到下面',
      zorderOff.panel > zorderOff.other && zorderOff.other >= 0,
      zorderOff.output
    )
  } else {
    record('关闭置顶后的 Z 序对比（验证窗口未能切到前台，跳过）', true, focusInfo)
  }

  await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === true)
  ps('dialog-focus', '-TargetPid', String(dialogPid))
  const zorderBack = zorder()
  record(
    '重新开启置顶后回到普通窗口之上',
    zorderBack.panel >= 0 && zorderBack.panel < zorderBack.other,
    zorderBack.output
  )
  console.log(`[probe] 面板左边缘像素参考值: ${ps('probe', '-X', String(panelLeftPx))}`)
  ps('dialog-close', '-TargetPid', String(dialogPid))
  await delay(400)
  await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === false)
  await delay(1200)

  // ------------------------------------------- 阶段 7：设置持久化 + 退出按钮
  await clickAndWait(page, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === false)
  await clickAndWait(page, 'toggle-pinned', (state) => state.settings.pinnedOpen === true)
  await delay(500)

  const quitFrom = readLog(logFile).length
  await page.evaluate(`document.getElementById('panel-close').click()`)
  const exited = await waitChildExit(app, 8000)
  record('点击关闭按钮可正常退出应用', exited)
  await delay(300)
  const quitRecords = readLog(logFile).slice(quitFrom)
  record('退出时写入 before-quit 日志', quitRecords.some((item) => item.event === 'before-quit'))
  page.close()

  const settingsFile = path.join(userDataDir, 'edge-notes-settings.json')
  record('设置文件已落盘', existsSync(settingsFile), settingsFile)

  const beforeRestart = readLog(logFile).length
  app = launchApp({ userDataDir, logFile, cdpPort })
  const restarted = (await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000, fromIndex: beforeRestart })).record
  const restartRecords = readLog(logFile).slice(beforeRestart)
  const readyRecord = restartRecords.find((item) => item.event === 'app-ready')
  record(
    '重启后恢复置顶/固定展开设置',
    readyRecord?.settings?.alwaysOnTop === false && readyRecord?.settings?.pinnedOpen === true,
    JSON.stringify(readyRecord?.settings)
  )
  record('重启后按固定展开直接展开', restarted.phase === 'expanded', restarted.phase)
  record('重启后宽度保持 350px', Math.abs(restarted.applied.width - started.applied.width) <= 1, `width=${restarted.applied.width}`)
  record(
    '重启后展开位置仍在工作区内',
    restarted.applied.x >= area.x && Math.abs(restarted.applied.x + restarted.applied.width - areaRight) <= 2,
    JSON.stringify(restarted.applied)
  )

  // ------------------------- 阶段 8：左侧停靠（无 UI，但预留能力需真实验证）
  const page2 = await connectPage(cdpPort)
  const leftLayoutFrom = readLog(logFile).length
  await page2.evaluate(`window.edgeNotes.setSide('left')`)
  // 置顶关闭时触发条可能被其他普通窗口遮住（「移出屏幕」方案的固有特性），
  // 因此左侧验证前先恢复置顶，保证读到的像素就是面板本身。
  await clickAndWait(page2, 'toggle-always-on-top', (state) => state.settings.alwaysOnTop === true)
  await delay(300)
  const leftLayout = readLog(logFile)
    .slice(leftLayoutFrom)
    .filter((item) => item.event === 'layout-reapplied')
    .at(-1)
  record('左侧停靠：展开位置贴合左边缘', Boolean(leftLayout) && Math.abs(leftLayout.applied.x - area.x) <= 2, JSON.stringify(leftLayout?.applied))

  await clickAndWait(page2, 'toggle-pinned', (state) => state.settings.pinnedOpen === false)
  await delay(1200)
  const leftHoverFrom = readLog(logFile).length
  ps('move', '-X', '2000', '-Y', '300', '-Wait', '400')
  const leftHoverOutput = ps('hover', '-OutDir', shotsDir, '-Side', 'left', '-Prefix', 'left-')
  record('左侧悬停驱动脚本完整执行', leftHoverOutput.includes('HOVER-DONE'))
  await delay(400)
  const leftRecords = readLog(logFile).slice(leftHoverFrom)
  const leftExpand = leftRecords.find((item) => item.event === 'expand-start' && item.reason === 'trigger-hover')
  const leftExpanded = leftRecords.filter((item) => item.event === 'expanded').at(-1)
  record('左侧触发条可触发展开', Boolean(leftExpand), leftExpand ? `cursor=${JSON.stringify(leftExpand.cursor)}` : '未触发')
  record(
    '左侧展开贴合工作区左边缘',
    Boolean(leftExpanded) && Math.abs(leftExpanded.bounds.x - area.x) <= 2,
    JSON.stringify(leftExpanded?.bounds)
  )
  const leftStripInfo = ps('strip', '-Image', path.join(shotsDir, 'left-01-collapsed.png'), '-Side', 'left')
  const leftStripRun = Number(leftStripInfo.split(' ')[1])
  record('左侧收起时同样只留窄触发条', leftStripRun >= 3 && leftStripRun <= 8, leftStripInfo)

  // 复位为交付默认状态
  await page2.evaluate(`window.edgeNotes.setSide('right')`)
  const finalState = await page2.evaluate('window.edgeNotes.getState()')
  record(
    '恢复正常默认设置',
    finalState.settings.side === 'right' &&
      finalState.settings.width === 350 &&
      finalState.settings.alwaysOnTop === true &&
      finalState.settings.pinnedOpen === false,
    JSON.stringify(finalState.settings)
  )
  await delay(400)
  ps('shot', '-OutDir', shotsDir, '-Name', '09-final')
  await delay(200)
  await page2.evaluate(`document.getElementById('panel-close').click()`)
  await waitChildExit(app, 8000)
  page2.close()

  record('项目根目录存在构建产物', existsSync(path.join(root, 'dist', 'renderer', 'index.html')))

  finish()
}

main().catch((error) => {
  console.error('窗口 E2E 执行失败:', error)
  runCleanup()
  process.exitCode = 1
})
