# Edge Notes Desktop

桌面边缘笔记栏。真正的 Electron 原生无边框窗口，平时缩在屏幕边缘只留 4px 触发条，鼠标贴边滑出，离开 700ms 自动收起。

- 机器身份：包名 `edge-notes-desktop`，应用名 `Edge Notes Desktop`（userData 与单实例锁都基于它，避免与其它 Electron 应用冲突）
- 技术栈：Electron 45 + React 19 + TypeScript 7 + Vite 8，无额外 UI 库、无状态管理库

## 快速开始

```powershell
npm install
npm run dev        # 编译主进程 + 起 Vite(5199) + 拉起 Electron
npm run build      # tsc 编译主进程/preload + vite 构建渲染层
npm start          # 构建后以产物方式启动（file:// 加载）
npm run typecheck  # 两套 tsconfig 类型检查
npm run test:e2e   # 构建 + 窗口 79 + 笔记 33 + 桌面集成 25 项断言
npm run test:visual # 多宽度/多状态截图 + 布局溢出度量（14 项断言）
npm run gen:icon   # 重新生成 assets/tray.png 与 @2x（图标脚本在仓库内）
```

## 常驻与退出

- 面板上的 `−`、或 Alt+F4 / 系统关闭窗口：**隐藏到托盘**（窗口整体消失，贴屏幕边缘不会再唤出）。
- 托盘图标左键单击：隐藏 ⇄ 显示（显示后会滑出面板，之后照常按延迟收起）。
- 托盘菜单：显示/隐藏、固定展开（勾选）、设置…、退出 Edge Notes。
- 真正退出只有两条路：托盘菜单「退出 Edge Notes」、设置面板底部「退出 Edge Notes」。
- 开机启动默认关闭，开关在设置面板里；写入后立刻回读系统状态，系统没接受就直接报错，不会记假状态。

## 目录结构

```
src/main/index.ts          应用入口：窗口创建、IPC 注册与校验、生命周期、单实例、托盘接线
src/main/edge-dock.ts      窗口核心：几何计算、指针轮询、四态状态机、位移动画、置顶、隐藏
src/main/tray.ts           系统托盘：图标、菜单（显示/隐藏、固定展开、设置、退出）、tooltip
src/main/login-item.ts     开机启动：HKCU Run 写入 + 系统回读校验 + 启动时对齐
src/main/notes-store.ts    笔记持久化：内存草稿 + 600ms 防抖 + 原子写 + 退出补写
src/main/settings-store.ts 设置持久化：逐字段校验夹紧 + 防抖 + 原子写
src/main/log.ts            结构化 JSONL 日志（EDGE_NOTES_LOG 打开，供自动化验证）
assets/tray.png|@2x.png    托盘图标（由 scripts/gen-tray-icon.ps1 生成，入库）
src/preload/index.ts       contextBridge 暴露的受限 API（唯一渲染层能力面）
src/shared/api.ts          IPC 契约：类型 + 通道名（主进程与 preload 共用）
src/shared/constants.ts    4px 触发条、350 默认宽度、700ms 延迟、180ms 动画等常量
src/renderer/              React 界面：紧凑头栏 + 主编辑区
scripts/dev.mjs            开发启动器（无 concurrently / wait-on 之类额外依赖）
tests/window.e2e.mjs       窗口行为端到端验证（真实鼠标 + CDP + 系统 Z 序 + 设置回退）
tests/notes.e2e.mjs        笔记功能端到端验证（真实输入 + 真实剪贴板 + 故障注入）
tests/visual.e2e.mjs       视觉验证：多宽度/空笔记/长文本/设置弹层截图 + 布局度量
tests/desktop.e2e.mjs      桌面集成：托盘、隐藏/恢复、退出清理、开机启动往返、二次启动唤出
tests/lib/                 CDP 客户端、日志读取、PowerShell 驱动脚本、清理脚本
```

## 窗口行为参数

| 参数 | 值 | 位置 |
|---|---|---|
| 触发条宽度 | 4 DIP | `constants.ts: TRIGGER_WIDTH` |
| 面板宽度 | 默认 350，可拖 280–600（并按工作区宽 - 120 二次夹紧） | `constants.ts` / `settings-store.ts` |
| 收起延迟 | 三档 300 / 700 / 1200ms，默认 700 | `constants.ts: COLLAPSE_DELAY_OPTIONS` |
| 展开/收起动画 | 180ms，16ms 帧，easeOutCubic | `edge-dock.ts` |
| 切边过渡 | 220ms 平移（仅可见态；拖动调宽不走动画） | `edge-dock.ts` |
| 指针轮询间隔 | 40ms（主进程，实测收起态整机 CPU 0.04%） | `constants.ts: CURSOR_POLL_MS` |
| 主题 | 浅色（默认）/ 深色 / 跟随系统 | `settings.theme` |
| 正文字号 | 小 13 / 标准 14.5 / 大 16（行高 1.72–1.75） | `styles.css: [data-font]` |

窗口纵向覆盖主显示器 `workArea`（不压任务栏）；收起时窗口整体移出屏幕，只留 4px 在屏内。

## 数据存放

**默认不落 C 盘**：首次运行若检测到非系统盘（D:、E: …），数据直接放到 `<盘>:\Edge Notes Data\`；没有可用数据盘时才回落到 `%APPDATA%\Edge Notes Desktop\`。

```
<数据目录>\
  edge-notes-settings.json    停靠侧、宽度、置顶、固定展开、主题、字号、开机启动
  edge-notes-note.md          笔记正文（UTF-8 Markdown 源文；旧版 .txt 启动时自动改名）
  attachments\                粘贴进来的图片（png/jpg/gif/webp，单张 ≤ 10 MB）
```

主题：浅色为**暖米白纸感**（底色 `#f7f3ec`，不纯白）＋低饱和墨蓝强调色，深色沿用暗色方案；字号三档。
实测对比度（`test:visual` 里有断言）：浅色 正文 13.4:1 / 次要 5.5:1 / 强调 4.9:1；深色 正文 15.2:1 / 次要 7.0:1 —— 均达 WCAG AA 4.5:1。

笔记是 **Markdown**：头栏的眼睛图标（或 **Ctrl+E**）在「编辑源码 / 预览」之间切换，模式会记进设置、重启沿用。直接 `Ctrl+V` 粘贴截图会把图片落到 `attachments\`，并在光标处插入 `![](attachments/xxx.png)`；预览用自定义协议 `edgenote-media://local/attachments/<file>` 读取，**只允许附件目录下的单层文件**（`../` 一律拒绝）。外链图片不加载（应用不联网），HTML 经 DOMPurify 净化（`<script>`/`onerror` 会被剔除）。

- 目录位置记录在指针文件 `%APPDATA%\Edge Notes Desktop\data-location.json` 里（**始终在默认位置**，否则改了目录下次就找不到数据）。
- 设置面板「数据目录 → 更改…」可以迁移到任意目录：复制（**笔记 + `attachments` 整目录**）→ 逐文件校验 → 写指针 → 自动重启；目标目录已有数据时**直接拒绝**，不覆盖。
- 图片全部是本地资源：笔记里写相对路径 `attachments/xxx.png`，附件跟着数据目录走，换盘/搬家不会出现失效链接；附件被删时预览显示「图片缺失：xxx」而不是破图标。
- 预览里点图片可放大（Esc 或点击任意处关闭）。
- 设置里「图片附件 → 清理…」会先统计**未被正文引用**的图片数量与体积，确认后**移入回收站**（可还原），取消则一个都不动。
- 数据迁移用 **SHA-256 逐文件校验 + 文件数量核对**，失败会回滚已写入的文件且不改指针；原始数据始终只读。
- 测试运行时用 `--user-data-dir` 指向 `tests/artifacts/`，不会碰到真实数据。

## 安全边界

`contextIsolation: true`、`nodeIntegration: false`、拒绝新窗口与任意外部跳转、CSP；渲染层只能调用 preload 白名单里的方法，主进程对每个 IPC 校验 sender 与参数类型。

## 测试说明

E2E 会**真实移动鼠标、真实点击、真实读写剪贴板**，因此：

- 需要桌面未锁屏；运行期间请不要动鼠标（断言带有限次重试，但剧烈抢鼠标仍会失败）；
- 阶段切分按日志下标而不是墙钟时间，避免两个进程时钟/启动抖动导致的错位；
- 置顶验证用系统 Z 序索引（`EnumWindows`）与 `WS_EX_TOPMOST` 位，不依赖屏幕像素。

## 当前进度

| 轮次 | 状态 |
|---|---|
| 01 初始化项目 | ✅ |
| 02 桌面边缘窗口系统 | ✅（窗口 73 项断言） |
| 03 本地笔记与自动保存 | ✅（笔记 33 项断言） |
| 04 面板设置与窗口交互（左右切换 / 宽度 280–600 / 收起延迟三档） | ✅ |
| 05 UI 与视觉精修（设计 Token、头栏收敛、底栏状态、焦点环） | ✅（视觉 14 项断言 + 9 组截图） |
| 06 桌面集成（托盘、隐藏/退出、开机启动） | ✅（桌面集成 32 项断言） |
| 06·5 体验修复（浅色主题、字号档位、字体栈、数据目录外置） | ✅（共 163 项断言） |
| 06·6 Markdown 预览 + 图片粘贴（方案 B） | ✅（共 171 项断言） |
| 07 打包与日常使用测试 | 未开始 |

界面样式统一由 `src/renderer/styles.css` 顶部的设计 Token 驱动（颜色/间距/圆角/字号/结构尺寸），组件内不写死数值。
