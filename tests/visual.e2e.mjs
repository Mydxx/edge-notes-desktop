// 视觉验证：在多种宽度 / 内容状态下截图，并度量布局是否溢出。
// 用法：npm run build && node tests/visual.e2e.mjs
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { connectPage } from './lib/cdp.mjs'
import { waitForEvent } from './lib/logfile.mjs'
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
  waitState
} from './lib/harness.mjs'

const shotsDir = path.join(artifactsDir, 'visual')
const userDataDir = path.join(artifactsDir, 'visual-user-data')
const logFile = path.join(artifactsDir, 'visual.jsonl')
const cdpPort = 9337

const { record, finish } = createReporter()

const LONG_TEXT = [
  '今天先把窗口行为的边界想清楚：屏幕右边缘留 4px，鼠标贴上去就滑出，离开 0.7 秒再收。',
  '',
  '一、为什么要留一条窄边',
  '完全隐藏窗口之后，操作系统里就没有可以接收鼠标事件的区域了，只能靠全局鼠标钩子。留 4px 是一条更便宜、更稳的路。',
  '',
  '二、长英文与长链接的换行',
  'https://example.com/a/very/long/path/that/should/wrap/instead/of/overflowing/the/panel/width/abcdefghijklmnopqrstuvwxyz0123456789',
  '',
  '三、标点与混排：中文，English，数字 1234567890，符号 !@#$%^&*()，还有「引号」和（括号）。',
  '',
  '四、缩进',
  '\t这是一个制表符缩进的行。',
  '    这是四个空格缩进的行。',
  '',
  '最后一行用于确认滚动条出现时不会遮挡文字。'
].join('\n')

async function main() {
  ensureBuild()
  rmSync(logFile, { force: true })
  resetArtifacts([shotsDir, userDataDir])
  mkdirSync(shotsDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const metrics = JSON.parse(ps('metrics'))
  ps('move', '-X', '200', '-Y', '200', '-Wait', '200')

  const app = launchApp({ userDataDir, logFile, cdpPort })
  try {
    const started = (await waitForEvent(logFile, 'dock-started', { timeoutMs: 40000 })).record
    const area = started.workArea
    const areaRight = area.x + area.width
    const edgeX = metrics.workingArea.x + metrics.workingArea.width - 2
    const midY = Math.floor((metrics.workingArea.y + metrics.workingArea.height) / 2)

    const page = await connectPage(cdpPort)
    const setWidth = async (width) => {
      await page.evaluate(`window.edgeNotes.setWidth(${width})`)
      await delay(400)
    }
    const layout = () =>
      page.evaluate(`(() => {
        const panel = document.querySelector('.panel')
        const bar = document.querySelector('.bar')
        const editor = document.getElementById('note-editor')
        const foot = document.querySelector('.foot')
        return {
          panelW: panel.clientWidth,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          barOverflow: bar.scrollWidth - bar.clientWidth,
          footOverflow: foot.scrollWidth - foot.clientWidth,
          editorW: editor.clientWidth,
          editorH: editor.clientHeight,
          editorScrollOverflow: editor.scrollWidth - editor.clientWidth,
          viewportH: window.innerHeight,
          barH: bar.clientHeight,
          footH: foot.clientHeight
        }
      })()`)
    const shot = async (name) => {
      await page.captureScreenshot(path.join(shotsDir, `${name}.png`))
      console.log(`[shot] ${name}.png`)
    }

    // 1. 空白笔记 @ 默认宽度
    await setWidth(350)
    await expandByHover(page, edgeX, midY)
    await page.bringToFront()
    await page.evaluate(`(() => { const el = document.activeElement; if (el && el.blur) el.blur() })()`)
    await page.evaluate('window.edgeNotes.saveNoteNow("")')
    await page.evaluate(`(() => { const el = document.getElementById('note-editor'); el.value = '' })()`)
    await delay(300)
    await shot('01-empty-350')

    const emptyLayout = await layout()
    record('默认宽度：面板宽约 350', Math.abs(emptyLayout.panelW - 350) <= 4, `${emptyLayout.panelW}px`)
    record('默认宽度：编辑区占据主要空间', emptyLayout.editorH / emptyLayout.viewportH > 0.85, `${Math.round((emptyLayout.editorH / emptyLayout.viewportH) * 100)}%`)
    record('默认宽度：无横向溢出', emptyLayout.overflowX === 0 && emptyLayout.barOverflow <= 0 && emptyLayout.footOverflow <= 0, JSON.stringify(emptyLayout))

    // 浅色主题的"质感"要能被量化：不是纯白底，且正文对比度达标
    // 逐色测量对比度（WCAG 相对亮度），浅色两套主题都要过 AA
    const measureContrast = () =>
      page.evaluate(`(() => {
        const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
        const lum = (rgb) => {
          const f = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
          return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
        }
        const ratio = (a, b) => { const x = [lum(a), lum(b)].sort((m, n) => n - m); return Number(((x[0] + 0.05) / (x[1] + 0.05)).toFixed(2)) }
        // CSS 变量是 #rrggbb，必须让浏览器解析成 rgb() 才能算亮度
        const pick = (name) => {
          const probe = document.createElement('div')
          probe.style.color = 'var(' + name + ')'
          document.body.appendChild(probe)
          const color = parse(getComputedStyle(probe).color)
          probe.remove()
          return color
        }
        const bg = parse(getComputedStyle(document.body).backgroundColor)
        return {
          bg: getComputedStyle(document.body).backgroundColor,
          text: ratio(pick('--color-text'), bg),
          dim: ratio(pick('--color-text-dim'), bg),
          muted: ratio(pick('--color-text-muted'), bg),
          accent: ratio(pick('--color-accent'), bg),
          placeholder: ratio(pick('--color-placeholder'), bg)
        }
      })()`)

    const lightContrast = await measureContrast()
    record('浅色主题不是纯白底（暖米白）', lightContrast.bg !== 'rgb(255, 255, 255)', lightContrast.bg)
    record('浅色：正文对比度 ≥ 4.5', lightContrast.text >= 4.5, `ratio=${lightContrast.text}`)
    record('浅色：次要文字对比度 ≥ 4.5（WCAG AA）', lightContrast.dim >= 4.5 && lightContrast.muted >= 4.5, `dim=${lightContrast.dim} muted=${lightContrast.muted}`)
    record('浅色：强调色对比度 ≥ 4.5', lightContrast.accent >= 4.5, `ratio=${lightContrast.accent}`)
    record('浅色：占位文字 ≥ 3（不刺眼但可辨认）', lightContrast.placeholder >= 3, `ratio=${lightContrast.placeholder}`)

    // 三块面与选中态：色值必须与设计一致，且导航↔编辑区只差一档亮度（不出现突兀色块）
    const design = await page.evaluate(`(() => {
      const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
      const lum = (rgb) => {
        const f = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
      }
      const ratio = (a, b) => { const x = [lum(a), lum(b)].sort((m, n) => n - m); return Number(((x[0] + 0.05) / (x[1] + 0.05)).toFixed(2)) }
      const pick = (name) => {
        const probe = document.createElement('div')
        probe.style.color = 'var(' + name + ')'
        document.body.appendChild(probe)
        const color = parse(getComputedStyle(probe).color)
        probe.remove()
        return color
      }
      const nav = document.getElementById('notes-nav')
      const activeRow = document.querySelector('.noteRow--active')
      return {
        navBg: getComputedStyle(nav).backgroundColor,
        editorBg: getComputedStyle(document.getElementById('note-editor')).backgroundColor,
        activeBg: activeRow ? getComputedStyle(activeRow).backgroundColor : '',
        activeColor: activeRow ? getComputedStyle(activeRow).color : '',
        navVsEditor: ratio(pick('--color-nav-bg'), pick('--color-editor-bg')),
        activeText: ratio(pick('--color-note-active-text'), pick('--color-note-active-bg')),
        navWidth: Math.round(nav.getBoundingClientRect().width)
      }
    })()`)
    record('导航底色为 #EEE8DD', design.navBg === 'rgb(238, 232, 221)', design.navBg)
    record('编辑区底色为 #FDFAF5', design.editorBg === 'rgb(253, 250, 245)', design.editorBg)
    record('选中笔记底色 #FDFAF5 / 文字 #39342D', design.activeBg === 'rgb(253, 250, 245)' && design.activeColor === 'rgb(57, 52, 45)', `${design.activeBg} / ${design.activeColor}`)
    record('导航与编辑区只差一档亮度（低对比，不突兀）', design.navVsEditor > 1 && design.navVsEditor < 1.2, `ratio=${design.navVsEditor}`)
    record('选中笔记文字对比度 ≥ 4.5', design.activeText >= 4.5, `ratio=${design.activeText}`)
    record('展开态导航宽度 148px', design.navWidth === 148, `${design.navWidth}px`)

    // 2. 长文本 @ 默认宽度
    await page.evaluate(`document.getElementById('note-editor').focus()`)
    await page.insertText(LONG_TEXT)
    await waitState(page, (state) => state.settings.width === 350, 3000)
    await delay(700)
    await shot('02-longtext-350')
    const longLayout = await layout()
    record('长文本：无横向溢出（换行正常）', longLayout.editorScrollOverflow <= 0, `scrollOverflow=${longLayout.editorScrollOverflow}`)

    // 3. 最小宽度
    await setWidth(280)
    await delay(300)
    await shot('03-narrow-280')
    const narrowLayout = await layout()
    record('最小宽度：面板宽约 280', Math.abs(narrowLayout.panelW - 280) <= 4, `${narrowLayout.panelW}px`)
    record('最小宽度：头栏/底栏不溢出', narrowLayout.barOverflow <= 0 && narrowLayout.footOverflow <= 0, JSON.stringify({ bar: narrowLayout.barOverflow, foot: narrowLayout.footOverflow }))
    record('最小宽度：编辑区仍占主要空间', narrowLayout.editorH / narrowLayout.viewportH > 0.83, `${Math.round((narrowLayout.editorH / narrowLayout.viewportH) * 100)}%`)
    record('最小宽度：正文宽度可用', narrowLayout.editorW >= 230, `${narrowLayout.editorW}px`)

    // 4. 较大宽度
    await setWidth(600)
    await delay(300)
    await shot('04-wide-600')
    const wideLayout = await layout()
    record('较大宽度：面板宽约 600', Math.abs(wideLayout.panelW - 600) <= 4, `${wideLayout.panelW}px`)
    record('较大宽度：无横向溢出', wideLayout.overflowX === 0 && wideLayout.barOverflow <= 0, JSON.stringify({ overflowX: wideLayout.overflowX }))

    // 5. 设置弹层（默认宽度下）
    await setWidth(350)
    await page.evaluate(`document.getElementById('open-settings').click()`)
    await delay(250)
    await shot('05-settings')
    const popover = await page.evaluate(`(() => {
      const el = document.querySelector('.settings')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { width: r.width, right: r.right, panelW: document.querySelector('.panel').clientWidth }
    })()`)
    record('设置弹层不溢出面板', Boolean(popover) && popover.right <= popover.panelW, JSON.stringify(popover))
    await page.evaluate(`document.getElementById('open-settings').click()`)
    await delay(150)

    // 5-2. 主题与字号
    await page.evaluate(`window.edgeNotes.setTheme('dark')`)
    await delay(350)
    await shot('09-dark-350')
    const darkApplied = await page.evaluate(`document.documentElement.dataset.theme`)
    record('深色主题可切换并生效', darkApplied === 'dark', String(darkApplied))
    const darkContrast = await measureContrast()
    record(
      '深色：正文与次要文字对比度 ≥ 4.5（WCAG AA）',
      darkContrast.text >= 4.5 && darkContrast.dim >= 4.5 && darkContrast.muted >= 4.5,
      `text=${darkContrast.text} dim=${darkContrast.dim} muted=${darkContrast.muted}`
    )

    // 深色主题不受暖色改造影响：导航/编辑区仍是原面板底色，选中态仍是低饱和蓝
    const darkDesign = await page.evaluate(`(() => {
      const nav = document.getElementById('notes-nav')
      const row = document.querySelector('.noteRow--active')
      return {
        navBg: getComputedStyle(nav).backgroundColor,
        editorBg: getComputedStyle(document.getElementById('note-editor')).backgroundColor,
        panelBg: getComputedStyle(document.querySelector('.panel')).backgroundColor,
        activeBg: row ? getComputedStyle(row).backgroundColor : ''
      }
    })()`)
    record(
      '深色：导航与编辑区仍是面板底色（未被浅色配色污染）',
      darkDesign.navBg === darkDesign.panelBg && darkDesign.editorBg === darkDesign.panelBg,
      `${darkDesign.navBg} / ${darkDesign.panelBg}`
    )
    record('深色：选中态仍为低饱和蓝底', darkDesign.activeBg === 'rgba(59, 130, 246, 0.16)', darkDesign.activeBg)

    await page.evaluate(`window.edgeNotes.setFontSize('large')`)
    await delay(350)
    await shot('10-dark-large-font')
    const largeFont = await page.evaluate(`parseFloat(getComputedStyle(document.getElementById('note-editor')).fontSize)`)
    record('大字号生效', largeFont >= 15.5, `${largeFont}px`)
    await page.evaluate(`window.edgeNotes.setFontSize('normal')`)
    await page.evaluate(`window.edgeNotes.setTheme('light')`)
    await delay(300)

    // 6. 固定展开 + 置顶（两个状态都点亮）
    await page.evaluate('window.edgeNotes.setPinnedOpen(true)')
    await page.evaluate('window.edgeNotes.setAlwaysOnTop(true)')
    await delay(400)
    await shot('06-pinned-topmost')
    const toggles = await page.evaluate(`({
      pinned: document.getElementById('toggle-pinned')?.getAttribute('aria-pressed'),
      topmost: document.getElementById('toggle-always-on-top')?.getAttribute('aria-pressed')
    })`)
    record('固定展开与置顶状态在界面上可见', toggles.pinned === 'true' && toggles.topmost === 'true', JSON.stringify(toggles))

    // 7. 清空确认条
    await page.evaluate(`document.getElementById('clear-note').click()`)
    await delay(250)
    await shot('07-confirm-clear')
    record('清空确认条可见', (await page.evaluate(`!!document.querySelector('.confirm')`)) === true)
    await page.evaluate(`document.getElementById('clear-cancel').click()`)
    await delay(200)

    // 8. 收起态：截图屏幕右缘的触发条
    // 收起导航：只缩窄，不换底色（避免突然出现一块深色竖条）
    await page.evaluate(`document.getElementById('toggle-nav').click()`)
    await delay(400)
    const collapsedNav = await page.evaluate(`(() => {
      const nav = document.getElementById('notes-nav')
      return {
        width: Math.round(nav.getBoundingClientRect().width),
        bg: getComputedStyle(nav).backgroundColor,
        labelHidden: document.querySelector('.notesNav__label') === null
      }
    })()`)
    record('收起态导航宽 40px 且保持同一底色', collapsedNav.width === 40 && collapsedNav.bg === 'rgb(238, 232, 221)', JSON.stringify(collapsedNav))
    record('收起态隐藏文字标签、只留首字', collapsedNav.labelHidden === true)
    await page.captureScreenshot(path.join(shotsDir, '09-nav-collapsed.png'))
    await page.evaluate(`document.getElementById('toggle-nav').click()`)
    await delay(300)

    await page.evaluate('window.edgeNotes.setPinnedOpen(false)')
    // 编辑框聚焦会按设计抑制自动收起，截图前必须先失焦
    await page.evaluate(`(() => { const el = document.activeElement; if (el && el.blur) el.blur() })()`)
    ps('move', '-X', '200', '-Y', '200', '-Wait', '1500')
    const collapsedState = await page.evaluate('window.edgeNotes.getState()')
    record('隐藏态：面板确实收起', collapsedState.runtime.phase === 'collapsed', collapsedState.runtime.phase)
    ps('shot', '-OutDir', shotsDir, '-Name', '08-collapsed-strip', '-Prefix', '')
    console.log(`[shot] 屏幕右缘触发条宽度: ${ps('strip', '-Image', path.join(shotsDir, '08-collapsed-strip.png'))}`)

    // 收尾：清空内容并退出
    await page.evaluate('window.edgeNotes.saveNoteNow("")')
    quitApp(page)
    await waitChildExit(app, 8000)
    page.close()
  } catch (error) {
    app.kill()
    throw error
  }

  finish()
}

main().catch((error) => {
  console.error('视觉验证执行失败:', error)
  runCleanup()
  process.exitCode = 1
})
