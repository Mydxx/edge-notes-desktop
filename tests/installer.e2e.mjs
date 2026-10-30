// 第 06 轮：安装 / 卸载实测（跑真实的 NSIS 安装包）
// 用法：npm run dist:win && node tests/installer.e2e.mjs
//
// 说明：安装目录故意放在 D 盘的临时目录（ASCII 路径，避免中文路径干扰 NSIS 参数解析），
// 跑完必定卸载并清理，绝不在系统里留东西。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { artifactsDir, createReporter, delay } from './lib/harness.mjs'

const outputsDir = 'D:\\AI-tools\\AI开发目录\\outputs\\edge-notes'
const installDir = 'D:\\EdgeNotesInstallTest'
const uninstallKeyRoot = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const desktopShortcut = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'Edge Notes.lnk')
const startMenuShortcut = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Edge Notes.lnk'
)

const { record, finish } = createReporter()

function runInstaller(exePath, extraArgs) {
  const result = spawnSync(exePath, extraArgs, { encoding: 'utf8', windowsHide: true, timeout: 300000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** NSIS 卸载器会先启动自己再删除目录，必须轮询等待 */
async function waitGone(target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(target)) {
      return true
    }
    await delay(400)
  }
  return !existsSync(target)
}

/** NSIS 的卸载项是 GUID 键名，只能靠 DisplayName 认领 */
function uninstallKeys() {
  const result = spawnSync('reg', ['query', uninstallKeyRoot, '/s', '/v', 'DisplayName'], { encoding: 'utf8' })
  if (result.status !== 0) {
    return []
  }
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes('DisplayName'))
    .filter((line) => /edge\s*notes/i.test(line))
    .map((line) => line.trim())
}

async function main() {
  const setup = readdirSync(outputsDir)
    .filter((name) => /-setup\.exe$/i.test(name))
    .map((name) => path.join(outputsDir, name))
    .sort()
    .pop()
  if (!setup) {
    throw new Error(`找不到安装包：${outputsDir}`)
  }
  record('找到安装包产物', true, path.basename(setup))

  // 上一次跑崩了可能留下安装目录，先清干净
  rmSync(installDir, { recursive: true, force: true })

  // ---------------------------------------------------------------- 安装
  const install = runInstaller(setup, ['/S', `/D=${installDir}`])
  const installedExe = path.join(installDir, 'Edge Notes Desktop.exe')
  const uninstaller = path.join(installDir, 'Uninstall Edge Notes Desktop.exe')
  record('静默安装进程正常结束', install.status === 0, `status=${install.status}`)
  record('安装目录里有应用本体', existsSync(installedExe), installedExe)
  record('安装目录里有卸载器', existsSync(uninstaller), uninstaller)
  record('创建了桌面快捷方式', existsSync(desktopShortcut), desktopShortcut)
  record('创建了开始菜单快捷方式', existsSync(startMenuShortcut), startMenuShortcut)
  record('写入了卸载信息（可在"应用和功能"里看到）', uninstallKeys().length > 0, uninstallKeys().join(' | '))

  // -------------------------------------------------- 安装后的程序能正常启动
  const logFile = path.join(artifactsDir, 'installed.jsonl')
  rmSync(logFile, { force: true })
  const dataDir = path.join(artifactsDir, 'installed-user-data')
  rmSync(dataDir, { recursive: true, force: true })
  // 必须真的建出来：EDGE_NOTES_DATA_DIR 只在目录存在时才生效，
  // 否则程序会回落到用户真实数据目录（这是本测试第一次失败的原因）
  mkdirSync(dataDir, { recursive: true })
  const launchEnv = {
    ...process.env,
    EDGE_NOTES_LOG: logFile,
    EDGE_NOTES_DATA_DIR: dataDir,
    EDGE_NOTES_SILENT: '1'
  }
  delete launchEnv.NODE_OPTIONS
  const started = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$p = Start-Process -FilePath '${installedExe}' -PassThru; Start-Sleep -Seconds 12; $alive = -not $p.HasExited; $alive`
    ],
    { encoding: 'utf8', env: launchEnv }
  )
  // 上面只负责"启动并观察"，真正的就绪证据看日志
  const logText = existsSync(logFile) ? readFileSafe(logFile) : ''
  record('安装后的程序能启动', (started.stdout ?? '').includes('True'), (started.stdout ?? '').trim())
  record('安装后的程序完成初始化（app-ready 已写入日志）', logText.includes('app-ready'), `${logText.split(/\r?\n/).length} 行日志`)
  record(
    '安装后的程序读的是指定数据目录',
    logText.includes('data-dir-selected') && logText.includes(dataDir.replace(/\\/g, '\\\\')),
    dataDir
  )

  // 关掉它，避免占用安装目录导致卸载失败
  spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-Process -Name 'Edge Notes Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force`],
    { encoding: 'utf8' }
  )
  await delay(1500)

  // ---------------------------------------------------------------- 卸载
  const uninstall = runInstaller(uninstaller, ['/S'])
  record('静默卸载进程正常结束', uninstall.status === 0, `status=${uninstall.status}`)
  record('安装目录被删除', await waitGone(installDir), installDir)
  record('桌面快捷方式被移除', await waitGone(desktopShortcut, 15000), desktopShortcut)
  record('开始菜单快捷方式被移除', await waitGone(startMenuShortcut, 15000), startMenuShortcut)
  record('卸载信息被清理', uninstallKeys().length === 0, uninstallKeys().join(' | '))
  const leftover = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Process -Name 'Edge Notes Desktop' -ErrorAction SilentlyContinue | Measure-Object).Count`],
    { encoding: 'utf8' }
  )
  record('卸载后没有残留进程', (leftover.stdout ?? '').trim() === '0', (leftover.stdout ?? '').trim())

  // 测试自己产生的数据目录也清掉（用户真实数据不在这里）
  rmSync(dataDir, { recursive: true, force: true })

  finish()
}

function readFileSafe(target) {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return ''
  }
}

main().catch((error) => {
  console.error(error)
  finish()
  process.exitCode = 1
})
