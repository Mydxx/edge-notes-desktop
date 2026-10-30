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
npm run test:e2e   # 构建 + 窗口 73 项 + 笔记 33 项断言
npm run test:visual # 多宽度/多状态截图 + 布局溢出度量（14 项断言）
```

## 目录结构

```
src/main/index.ts          应用入口：窗口创建、IPC 注册与校验、生命周期、单实例
src/main/edge-dock.ts      窗口核心：几何计算、指针轮询、四态状态机、位移动画、置顶
src/main/notes-store.ts    笔记持久化：内存草稿 + 600ms 防抖 + 原子写 + 退出补写
src/main/settings-store.ts 设置持久化：逐字段校验夹紧 + 防抖 + 原子写
src/main/log.ts            结构化 JSONL 日志（EDGE_NOTES_LOG 打开，供自动化验证）
src/preload/index.ts       contextBridge 暴露的受限 API（唯一渲染层能力面）
src/shared/api.ts          IPC 契约：类型 + 通道名（主进程与 preload 共用）
src/shared/constants.ts    4px 触发条、350 默认宽度、700ms 延迟、180ms 动画等常量
src/renderer/              React 界面：紧凑头栏 + 主编辑区
scripts/dev.mjs            开发启动器（无 concurrently / wait-on 之类额外依赖）
tests/window.e2e.mjs       窗口行为端到端验证（真实鼠标 + CDP + 系统 Z 序 + 设置回退）
tests/notes.e2e.mjs        笔记功能端到端验证（真实输入 + 真实剪贴板 + 故障注入）
tests/visual.e2e.mjs       视觉验证：多宽度/空笔记/长文本/设置弹层截图 + 布局度量
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

窗口纵向覆盖主显示器 `workArea`（不压任务栏）；收起时窗口整体移出屏幕，只留 4px 在屏内。

## 数据存放

```
%APPDATA%\Edge Notes Desktop\
  edge-notes-settings.json    停靠侧、宽度、置顶、固定展开
  edge-notes-note.txt         笔记正文（UTF-8 纯文本）
```

测试运行时用 `--user-data-dir` 指向 `tests/artifacts/`，不会碰到真实数据。

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
| 06 打包与日常使用测试 | 未开始 |

界面样式统一由 `src/renderer/styles.css` 顶部的设计 Token 驱动（颜色/间距/圆角/字号/结构尺寸），组件内不写死数值。
