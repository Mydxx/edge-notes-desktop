# Edge Notes — 项目状态

> 每轮结束更新本文件。优先级：正确性 > 稳定性 > 易用性 > 视觉效果 > 额外功能。
> 原则：只有实际实现并通过验收的功能，才标记为完成。

## 一、基本信息

| 项 | 值 |
|---|---|
| 版本 | 0.3.0 |
| 路径 | `D:\AI-tools\AI开发目录\projects\edge-notes`（目录名待 IDE 释放句柄后改为 `edge-notes-desktop`） |
| 包名 / 应用名 | `edge-notes-desktop` / `Edge Notes Desktop` |
| 技术栈 | Electron 45.1.0 + React 19.3.1 + TypeScript 7.0.2 + Vite 8.3.5，无 UI 库、无状态管理库 |
| 数据目录 | `%APPDATA%\Edge Notes Desktop\`（`edge-notes-settings.json`、`edge-notes-note.txt`） |
| 测试 | 窗口 64 项 + 笔记 33 项断言（真实鼠标 / CDP / 系统 Z 序 / 真实剪贴板 / 故障注入） |

## 二、轮次进度

| 轮次 | 内容 | 状态 |
|---|---|---|
| 01 | 初始化项目（结构、构建、类型检查、基础窗口、README、忽略规则） | ✅ 功能完成；`代码检查(ESLint)`、本文件、Git 仓库于本轮补齐 |
| 02 | 桌面边缘窗口系统（定位/触发条/展开收起/置顶/固定展开） | ✅ 完成并实测 |
| 03 | 本地笔记与自动保存（编辑器/原子写/防抖/清空确认/失败提示） | ✅ 完成并实测 |
| — | 必要设置（左右切换、宽度拖动）—— 规格中属于"第一版功能 3/10"，提前实现 | ✅ 完成并实测 |
| 04 | UI 精修（统一间距字号、多宽度长文本、空笔记、窄宽度控件不挤压） | ⬜ 未开始 |
| 05 | 打包（Windows 安装包/便携版）与日常使用测试 | ⬜ 未开始 |

## 三、第 01 轮验收对照

| 验收项 | 结果 | 依据 |
|---|---|---|
| 开发环境可以启动 | ✅ | `npm run dev` 实测启动（Vite 5199 + Electron） |
| Electron 窗口可以正常显示 | ✅ | `dock-started` 日志含实际 `getBounds()` |
| React 页面可以正常渲染 | ✅ | CDP 读到 `.bar__title` = "Edge Notes"、`#note-editor` 存在 |
| TypeScript 检查通过 | ✅ | `npm run typecheck`（两套 tsconfig）0 error |
| 生产构建成功 | ✅ | `npm run build` → `dist/renderer` + `dist-electron` |
| README 中的命令经过实际验证 | ✅ | dev / build / start / typecheck / test:e2e 均实际执行 |
| 没有已知的严重启动错误 | ✅ | `did-fail-load` / `render-process-gone` 均有日志钩子，运行期无触发 |
| 安全边界 | ✅ | `contextIsolation: true`、`nodeIntegration: false`、preload 白名单 9 个方法、IPC 校验 sender 与参数类型 |
| Git 忽略规则 | ✅ | `.gitignore` 覆盖 node_modules / dist / dist-electron / tests/artifacts |
| 代码检查 | ⬜ | **未配置 ESLint**（需安装依赖，待批准） |
| Git 管理 | ✅ | 本轮 `git init` 并建立基线提交 |

## 四、第 02 轮验收对照

| 验收项 | 结果 | 依据（均为真实运行） |
|---|---|---|
| 右侧触发条可以展开窗口 | ✅ | 真实 `SetCursorPos` 到屏幕右缘 → `expand-start(trigger-hover) → expanded` |
| 鼠标离开后可以正常收起 | ✅ | `collapse-scheduled(700ms)` → 约 705ms 后 `collapse-start → collapsed` |
| 鼠标返回时可以取消收起 | ✅ | `collapse-cancelled(pointer-inside)`，面板保持展开 |
| 快速进出时没有明显抖动 | ✅ | 8 次 70ms 级进出：1 次展开 + 1 次收起 |
| 置顶开关真实有效 | ✅ | `WS_EX_TOPMOST` 位翻转 + 系统 Z 序索引比较（`panel=14 < other=33`，关闭后 `panel=33 > other=32`） |
| 固定展开开关真实有效 | ✅ | 开启后鼠标离开 1.5s 仍 `expanded`；关闭后 700ms 收起 |
| 窗口不应意外跑到屏幕之外 | ✅ | 收起 `x = 工作区右缘 - 4`，展开 `x + width = 工作区右缘`；`y`/`height` 取 `workArea` |
| 代码中不存在未清理的重复计时器 | ✅ | 轮询 1 个 `setInterval` + 收起 1 个 `setTimeout` + 动画 1 个链式 `setTimeout`；`dispose()` 全部清理并有 `disposed` 守卫 |
| 实际运行应用验证了窗口行为 | ✅ | 每轮 `npm run test:e2e` 真实启动并驱动鼠标 |
| 已记录尚未解决的平台限制 | ✅ | 见本文件第八节 |

### 与规格的两处实现差异（有意为之，已记录）

1. **状态机命名**：规格建议 `hidden / showing / visible / hiding / pinned_open`。实际实现为
   `collapsed / expanding / expanded / collapsing`，并把"固定展开"、"编辑器聚焦"、"拖动调宽"做成三个**独立的抑制标志**而不是状态。
   原因：三者可以任意叠加（例如边拖宽度边固定展开），做成状态会导致状态爆炸；作为标志更简单且互不干扰。语义与规格等价。
2. **指针检测方式**：没有使用渲染层的 `pointerenter/pointerleave`，而是主进程每 40ms 读取
   `screen.getCursorScreenPoint()` 并做几何命中判定。原因：窗口有 346px 在屏幕外，且窗口可能失焦或被遮挡，
   DOM 事件在这些情况下不可靠；这样也不需要全局鼠标钩子或原生依赖。
   **实测开销**：收起态下 4 个 Electron 进程 10 秒共 0.063s CPU（折合单核 0.63%、整机 0.04%）。

## 五、第 03 轮验收对照

| 验收项 | 结果 | 依据 |
|---|---|---|
| 输入文本后可以自动保存 | ✅ | 输入 → 600ms 防抖 → `note-saved` → 文件内容逐字一致 |
| 重启应用后可以恢复笔记 | ✅ | 退出后重启，`getNote` 与编辑区均恢复 |
| 中文输入和粘贴正常 | ✅ | 中文/标点/换行逐字落盘；**真实剪贴板 + 真实 Ctrl+V** 粘贴（含制表符、行尾空格） |
| 连续快速输入不会丢失末尾内容 | ✅ | 14 段快速输入 → 磁盘内容与期望 490 字完全一致 |
| 保存失败时有明确提示 | ✅ | 把笔记文件换成同名目录制造真实 EPERM：头栏红字 + 错误条 + 重试，正文保留 |
| 清空操作支持取消 | ✅ | 取消后编辑区与磁盘均未变；确认后两边都为空 |
| 窗口展开、收起和置顶不会丢失内容 | ✅ | 4 次切换后编辑区与磁盘内容均未变 |
| 笔记内容没有被发送到网络 | ✅ | 代码中无 `net` / `fetch` / `http` 调用；渲染层 CSP 限制 `connect-src 'self'` 与本地 dev ws |
| 相关测试通过 | ✅ | 33 项断言全绿 |

### 实现要点

- 每次输入都通过 IPC 把全文送进主进程内存（渲染层不自行防抖），因此退出瞬间也不丢字；
- 主进程 600ms 防抖 + `临时文件 + rename` 原子替换 + 写入串行化；
- 退出 `before-quit` 同步补写，并置 `frozen` 标记丢弃仍在飞行中的异步写，避免旧内容盖回新内容；
- 保存失败抛出中文原因（`没有写入权限（EPERM）` 等），界面显示并提供重试；正文从不清空。

## 六、实际执行的验证记录

```
npm run typecheck   → 0 error
npm run build       → 通过（dist/renderer + dist-electron）
npm run test:window → 64 项断言全绿
npm run test:notes  → 33 项断言全绿
npm run test:e2e    → 构建 + 上述两套，97 项全绿
```

证据产物：`tests/artifacts/window-shots/`（窗口各阶段截图、设置弹层、拖动后宽度）、
`tests/artifacts/notes-shots/`（编辑器、保存失败、恢复后、重启恢复）。

## 七、开发中发现并修复的缺陷

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 收起定时器触发瞬间鼠标刚好回到面板，面板"收一半又弹回" | 定时器只管 fires，不再核对指针 | 定时器回调里再核对一次指针，在面板内就放弃本次收起 |
| 2 | 拖完宽度松手，0.7 秒后面板自己收起 | 宽度取整后指针常停在内缘外 1~7px，被判为"离开" | 面板命中区内缘额外放宽 6px（触发条仍是 2px） |
| 3 | 与另一个同名 Electron 应用共用 userData 与单实例锁，一方启动另一方直接退出 | 包名相同 | 显式 `app.setName('Edge Notes Desktop')` 并改包名 |
| 4 | 退出瞬间可能被仍在飞行中的异步写覆盖最新内容 | 同步补写与异步写竞争 | `frozen` 标记让异步写让位 |
| 5 | 真实鼠标 E2E 偶发失败（真人同时在用机器 / 焦点抢占） | 物理动作被抢占 | 物理动作带有限次重试，状态判定仍为硬断言；阶段切分改按日志下标 |

## 八、未完成 / 已知限制

1. **ESLint 未配置**（第 01 轮遗留，需批准的依赖安装）。
2. **目录名未改**：`Rename-Item` 因 IDE 持有目录句柄被拒；关闭 IDE 后一条命令即可改为 `edge-notes-desktop`。
3. **150% 缩放下的 1 物理像素**：工作区在 DIP 下为 1018.67，窗口高取整为 1019/1020，底边可能多 1 物理像素压在任务栏上沿。未用取巧手段绕过。
4. **多显示器 / 分辨率切换未实测**：本机单屏。已实现 `display-added/removed/metrics-changed` 重贴边，但无实测证据；面板固定停靠主显示器，未持久化 `displayId`。
5. **`sandbox: false`**：preload 引用了共享模块，未打包成单文件；`contextIsolation` 与受限 IPC 仍生效。
6. **IME 组合输入未单独实测**：文本插入走的是浏览器输入管线，未专门验证中文输入法组合态。
7. **开机启动未实现**：需写 `HKCU\...\Run`，属于系统级改动，留待第 05 轮确认后处理。
8. **4px 触发条会拦截屏幕边缘该处 4px 的点击**（"移出屏幕"方案的固有代价）。

## 九、下一轮计划（04 UI 精修）

- 统一字号/间距/图标尺寸，检查 260 / 350 / 600 三种宽度下的长文本、空笔记、控件不挤压正文；
- 窄宽度下头栏按钮的取舍（是否需要把"清空/退出"收进设置弹层）；
- 空状态、超长单行、滚动条视觉；
- 不引入新依赖、不改窗口行为逻辑。
