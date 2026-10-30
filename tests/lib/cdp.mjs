// 极简 CDP 客户端：通过 Chrome DevTools Protocol 驱动真实渲染进程（点击开关、读取 DOM 状态）
import { writeFileSync } from 'node:fs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function connectPage(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) {
        return await openSession(page.webSocketDebuggerUrl)
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  throw new Error(`无法连接 CDP (port ${port}): ${lastError ? lastError.message : 'no page target'}`)
}

/** 直接连到指定 target（多窗口场景：主面板 + 图片窗口） */
export async function connectTarget(wsUrl) {
  return openSession(wsUrl)
}

async function openSession(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  let nextId = 0
  const pending = new Map()

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      return
    }
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) {
      return
    }
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new Error(`${message.error.message} (${message.error.code})`))
    } else {
      entry.resolve(message.result)
    }
  })

  // 目标进程退出时 socket 会断开：必须让挂起的调用立刻失败，
  // 否则 await 会永远悬挂（退出应用、渲染进程崩溃这类场景都会踩到）。
  const failPending = (reason) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.reject(new Error(reason))
    }
  }
  socket.addEventListener('close', () => failPending('CDP 连接已关闭（目标进程可能已退出）'))
  socket.addEventListener('error', () => failPending('CDP 连接错误'))

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  await send('Runtime.enable')
  await send('Page.enable').catch(() => undefined)

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`渲染进程求值失败: ${description}`)
    }
    return result.result.value
  }

  await evaluate('document.readyState')

  return {
    evaluate,
    send,
    /** 走浏览器真实输入管线插入文本（等价于用户输入/粘贴），会触发 React onChange */
    insertText: (text) => send('Input.insertText', { text }),
    /** 把自己的窗口提到前台，保证后续真实鼠标点击落在本应用而不是别的窗口上 */
    bringToFront: () => send('Page.bringToFront'),
    /** 直接抓渲染层像素，不受桌面其它窗口遮挡影响，用于 UI 证据 */
    captureScreenshot: async (filePath) => {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(filePath, Buffer.from(result.data, 'base64'))
    },
    close: () => socket.close()
  }
}
