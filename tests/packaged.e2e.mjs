// 第 06 轮：打包产物冒烟验证（跑的是 win-unpacked 里的真实 exe，而不是开发模式）
// 用法：npm run dist:dir && node tests/packaged.e2e.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { connectPage } from './lib/cdp.mjs'
import { readLog, waitForEvent } from './lib/logfile.mjs'
import {
  artifactsDir,
  createReporter,
  delay,
  noteFilePath,
  readNotesIndex,
  resetArtifacts,
  waitFor
} from './lib/harness.mjs'

const outputsDir = 'D:\\AI-tools\\AI开发目录\\outputs\\edge-notes'
const exePath = path.join(outputsDir, 'win-unpacked', 'Edge Notes Desktop.exe')
const userDataDir = path.join(artifactsDir, 'packaged-user-data')
const logFile = path.join(artifactsDir, 'packaged.jsonl')
const cdpPort = 9361
const lnkPath = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
  'Edge Notes Desktop.lnk'
)
const lnkBackup = `${lnkPath}.packaged-test-backup`

const { record, finish } = createReporter()

async function main() {
  if (!existsSync(exePath)) {
    throw new Error(`找不到打包产物：${exePath}（先执行 npm run dist:dir）`)
  }
  resetArtifacts([userDataDir])
  mkdirSync(userDataDir, { recursive: true })
  rmSync(logFile, { force: true })

  // 开机启动的快捷方式会被测试改动：先备份用户的，跑完还原
  rmSync(lnkBackup, { force: true })
  const hadLnk = existsSync(lnkPath)
  if (hadLnk) {
    spawnSync('powershell', ['-NoProfile', '-Command', `Move-Item -LiteralPath '${lnkPath}' '${lnkBackup}' -Force`], {
      encoding: 'utf8'
    })
  }

  const env = {
    ...process.env,
    EDGE_NOTES_LOG: logFile,
    EDGE_NOTES_DATA_DIR: userDataDir,
    EDGE_NOTES_SILENT: '1'
  }
  // 父进程带着 NODE_OPTIONS 会让打包版每次启动都打一行 Electron 报错，与产品无关
  delete env.NODE_OPTIONS
  const app = spawn(exePath, [`--remote-debugging-port=${cdpPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
  app.stderr.on('data', (chunk) => process.stdout.write(`[app!] ${chunk}`))

  try {
    await waitForEvent(logFile, 'app-ready', { timeoutMs: 60000 })
    const ready = readLog(logFile).find((item) => item.event === 'app-ready')
    record('打包后的 exe 能正常启动并完成就绪', Boolean(ready), JSON.stringify(ready?.settings?.pinnedOpen))

    const page = await connectPage(cdpPort)
    await waitFor(page, `document.getElementById('note-editor') !== null`, 8000, '编辑器就绪')
    const state = await page.evaluate('window.edgeNotes.getState()')
    record('渲染层加载正常（编辑器与状态机都在）', Boolean(state?.settings), `phase=${state?.runtime?.phase}`)
    // 证明跑的确实是打包后的可执行文件，而不是开发模式的 electron.exe
    const processPath = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Name 'Edge Notes Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`],
      { encoding: 'utf8' }
    )
    const runningPath = (processPath.stdout ?? '').trim()
    record(
      '运行的是打包后的可执行文件',
      path.resolve(runningPath).toLowerCase() === path.resolve(exePath).toLowerCase(),
      runningPath
    )

    // 数据目录：显式指定时以它为准，不污染用户真实笔记
    const dirInfo = await page.evaluate('window.edgeNotes.getDataDir()')
    record('数据目录按指定路径生效', path.resolve(dirInfo.current) === path.resolve(userDataDir), dirInfo.current)

    // 写一条笔记，确认打包后仍然"文件名=标签"且真的落盘
    await page.evaluate(`document.getElementById('note-editor').focus()`)
    await page.insertText('打包版冒烟测试内容')
    await waitFor(page, `document.querySelector('#save-status')?.textContent === '已保存'`, 8000, '打包版保存')
    const index = readNotesIndex(userDataDir)
    const filePath = noteFilePath(userDataDir, index, index?.activeId)
    record(
      '打包版保存成功且文件名就是标签',
      existsSync(filePath) && readFileSync(filePath, 'utf8').includes('打包版冒烟测试内容'),
      path.basename(filePath)
    )

    // 开机启动：打包后必须指向安装的 exe，而不是 electron.exe
    const loginEnabled = await page.evaluate('window.edgeNotes.setLaunchAtLogin(true)')
    record('打包版可以开启开机启动', loginEnabled.settings.launchAtLogin === true, String(loginEnabled.settings.launchAtLogin))
    const targetResult = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath}').TargetPath`],
      { encoding: 'utf8' }
    )
    const target = (targetResult.stdout ?? '').trim()
    record('开机启动指向打包后的 exe（不再是 node_modules 里的 electron）', /Edge Notes Desktop\.exe$/i.test(target), target)
    const loginDisabled = await page.evaluate('window.edgeNotes.setLaunchAtLogin(false)')
    record(
      '打包版可以关闭开机启动且快捷方式被移除',
      loginDisabled.settings.launchAtLogin === false && !existsSync(lnkPath)
    )

    // 退出：走应用自己的退出入口，确认进程干净结束
    void page.send('Runtime.evaluate', { expression: 'window.edgeNotes.quit()' }).catch(() => undefined)
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000)
      app.once('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    record('从应用内退出后进程正常结束', exited, `exitCode=${app.exitCode}`)
    await delay(500)
    const stillRunning = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Name 'Edge Notes Desktop' -ErrorAction SilentlyContinue | Measure-Object).Count`],
      { encoding: 'utf8' }
    )
    record('退出后没有残留进程', (stillRunning.stdout ?? '').trim() === '0', (stillRunning.stdout ?? '').trim())
  } finally {
    if (app.exitCode === null) {
      app.kill()
    }
    rmSync(lnkPath, { force: true })
    if (hadLnk) {
      spawnSync('powershell', ['-NoProfile', '-Command', `Move-Item -LiteralPath '${lnkBackup}' '${lnkPath}' -Force`], {
        encoding: 'utf8'
      })
    }
    rmSync(lnkBackup, { force: true })
  }

  // ------------------------------------------ 二、便携版：数据跟着 exe 走
  const portableExe = readdirSync(outputsDir)
    .filter((name) => /-portable\.exe$/i.test(name))
    .map((name) => path.join(outputsDir, name))
    .sort()
    .pop()
  record('找到便携版产物', Boolean(portableExe), String(portableExe))
  if (portableExe) {
    const portableDataDir = path.join(outputsDir, 'Edge Notes Data')
    rmSync(portableDataDir, { recursive: true, force: true })
    const portableLog = path.join(artifactsDir, 'portable.jsonl')
    rmSync(portableLog, { force: true })
    const portableEnv = { ...process.env, EDGE_NOTES_LOG: portableLog, EDGE_NOTES_SILENT: '1' }
    delete portableEnv.EDGE_NOTES_DATA_DIR
    delete portableEnv.EDGE_NOTES_POINTER
    delete portableEnv.NODE_OPTIONS
    const portable = spawn(portableExe, [`--remote-debugging-port=${cdpPort + 1}`], {
      env: portableEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    try {
      await waitForEvent(portableLog, 'app-ready', { timeoutMs: 180000 })
      const selected = readLog(portableLog)
        .filter((item) => item.event === 'data-dir-selected')
        .pop()
      record(
        '便携版把数据放在 exe 旁边（不碰本机其他目录）',
        selected?.source === 'portable' && path.resolve(selected.dir) === path.resolve(portableDataDir),
        `${selected?.source} → ${selected?.dir}`
      )
      record('便携版数据目录已创建', existsSync(portableDataDir), portableDataDir)
      const portablePage = await connectPage(cdpPort + 1)
      await waitFor(portablePage, `document.getElementById('note-editor') !== null`, 15000, '便携版编辑器就绪')
      record('便携版界面正常加载', true)
      void portablePage.send('Runtime.evaluate', { expression: 'window.edgeNotes.quit()' }).catch(() => undefined)
      const portableClosed = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 25000)
        portable.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      record('便携版可以从应用内正常退出', portableClosed)
    } finally {
      if (portable.exitCode === null) {
        portable.kill()
      }
      await delay(600)
      rmSync(portableDataDir, { recursive: true, force: true })
    }
  }

  finish()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
