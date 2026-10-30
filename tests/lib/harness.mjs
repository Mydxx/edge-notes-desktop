// 验证脚本共用的启动/断言/驱动工具
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const artifactsDir = path.join(root, 'tests', 'artifacts')
export const uiScript = path.join(root, 'tests', 'lib', 'ui.ps1')

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createReporter() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`)
  }
  const finish = () => {
    const failed = results.filter((item) => !item.ok)
    console.log('')
    console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
    if (failed.length > 0) {
      for (const item of failed) {
        console.log(`  FAIL ${item.name} ${item.detail}`)
      }
      process.exitCode = 1
    }
    return failed.length === 0
  }
  return { record, finish }
}

/** 调用 PowerShell 驱动脚本：真实鼠标、截图、像素探针 */
export function ps(...args) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uiScript, ...args], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`ui.ps1 ${args[0]} 执行失败: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

export function ensureBuild() {
  if (!existsSync(path.join(root, 'dist', 'renderer', 'index.html'))) {
    throw new Error('缺少构建产物，请先执行 npm run build')
  }
}

export function resetArtifacts(paths) {
  for (const target of paths) {
    rmSync(target, { recursive: true, force: true })
  }
  mkdirSync(artifactsDir, { recursive: true })
}

export function launchApp({ userDataDir, logFile, cdpPort, extraArgs = [] }) {
  const child = spawn(
    electronPath,
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`, ...extraArgs],
    {
      cwd: root,
      env: { ...process.env, EDGE_NOTES_LOG: logFile, EDGE_NOTES_SILENT: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stdout.write(`[app!] ${chunk}`))
  return child
}

export function waitChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function waitState(page, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate('window.edgeNotes.getState()')
    if (predicate(state)) {
      return state
    }
    await delay(80)
  }
  throw new Error(`状态未在 ${timeoutMs}ms 内达到预期`)
}

export async function clickAndWait(page, id, predicate, timeoutMs = 4000) {
  await page.evaluate(`document.getElementById('${id}').click()`)
  return waitState(page, predicate, timeoutMs)
}

/** 轮询直到渲染层表达式返回真值 */
export async function waitFor(page, expression, timeoutMs = 5000, label = '') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) {
      return true
    }
    await delay(100)
  }
  throw new Error(`渲染层条件未在 ${timeoutMs}ms 内满足: ${label || expression}`)
}

/** 把指针停到触发条上直到面板确实展开（真人同时在用机器时，指针会被物理鼠标带离） */
export async function expandByHover(page, x, y, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ps('move', '-X', String(x), '-Y', String(y), '-Wait', '700')
    try {
      return await waitState(page, (state) => state.runtime.phase === 'expanded', 3000)
    } catch {
      console.log(`[hover] 第 ${attempt} 次未被触发展开（可能有人在动鼠标），重试`)
    }
  }
  throw new Error('指针停在触发条上仍未能展开面板')
}

/** 把指针移开直到面板确实收起 */
export async function waitCollapsed(page, parkX = 200, parkY = 300, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ps('move', '-X', String(parkX), '-Y', String(parkY), '-Wait', '1000')
    const state = await page.evaluate('window.edgeNotes.getState()')
    if (state.runtime.phase === 'collapsed') {
      return state
    }
  }
  return page.evaluate('window.edgeNotes.getState()')
}

export function runCleanup() {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests', 'lib', 'cleanup.ps1')], {
    encoding: 'utf8'
  })
}
