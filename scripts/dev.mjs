// 开发启动脚本：编译主进程/preload -> 启动 Vite dev server -> 拉起 Electron
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function buildMainProcess() {
  const tscPath = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tscPath, '-p', 'tsconfig.node.json'], {
    cwd: projectRoot,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    console.error('[dev] 主进程 TypeScript 编译失败，已中止启动')
    process.exit(result.status ?? 1)
  }
}

buildMainProcess()

const server = await createServer({ configFile: path.join(projectRoot, 'vite.config.ts') })
await server.listen()
const devServerUrl = server.resolvedUrls?.local?.[0]
if (!devServerUrl) {
  console.error('[dev] 无法获取 Vite dev server 地址')
  await server.close()
  process.exit(1)
}
server.printUrls()

const electronArgs = ['.', ...process.argv.slice(2)]
const child = spawn(electronPath, electronArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: devServerUrl
  }
})

let shuttingDown = false
const shutdown = async (code) => {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  await server.close()
  process.exit(code)
}

child.on('close', (code) => {
  void shutdown(code ?? 0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill()
  })
}
