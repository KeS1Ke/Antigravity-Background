# 实时预览与保存配置分离

日期：2026-11-18
状态：已采纳

用户选择调整时实时预览，点击「保存设置」才写入磁盘长期保存；自动落盘会改变既有保存语义。

## 1. 预览草稿生命周期与「还原」入口

- 预览草稿（`draft`）保存在 Sidecar 内存中，`GET /api/settings` 返回当前活动配置（`draft || saved`）及 `hasDraft`，**不再清除**未保存草稿。切换对话、收起侧栏或面板 iframe 重载时，设置页自动回填内存预览草稿并启用「还原」按钮，避免实时预览静默丢失。
- 用户点击「还原」（`POST /api/preview/discard`）可显式清空 `draft` 并恢复磁盘已保存配置与主窗口外观；点击「保存设置」（`POST /api/settings`）持久化成功后同样清除 `draft`。若预览状态与 `saved` 完全一致，后端自动清空 `draft`。

## 2. 低延迟合帧与 `imageHash` 增量缓存

- 前端将连续输入合帧窗口收敛为 **16ms**，并在请求在途（`previewInFlight`）时合并后续变更为待发标记，待当前请求完成后立即提交最新一帧、跳过中间过时帧；保存操作通过串行队列等待在途预览完成并在并发拖动时保持状态同步。
- 前后端与宿主渲染器围绕图片 SHA-256 摘要 `imageHash` 做轻量增量缓存：
  - 前端 `POST /api/preview` 与 `POST /api/settings` 在图片未变化时省略 `image` 仅传 `imageHash`；若后端缓存未命中返回 `409 IMAGE_CACHE_MISS`，前端自动携带完整 `image` 重试一次。
  - `WallpaperRuntime` 优先复用健康 CDP 连接（初始重发现采用渐进退避并在成功附加后保持 1500ms 周期心跳，详见 §16），按连接记录 `lastImageHash` 按需省略 `image`，主窗口重载等场景丢失缓存时 `renderer` 返回 `'NEED_IMAGE'` 触发自动补发一次完整图片。
  - 运行时合并并发 `update()` 并在异步读取配置后核对 `generation`，防止旧配置配新 `generation`；多目标更新按 target 隔离异常，并在 `renderer` 缓存 `titlebar` 颜色以避免拖动时重复阻塞 `setTitleBarOverlay`。

## 3. 无图 / 0% 壁纸透明度与总开关语义

- 当总开关 `enabled` 为 `true` 但未选图、移除图片或壁纸不透明度为 `0%`（`!css`）时，主窗口仅移除 `#antigravity-ui-background` 壁纸层并清理 `--ag-ui-image`，保留并持续更新 `layout` 样式表，使侧边栏与输入框的底色、透明度、模糊与配色调整依然实时生效。
- 仅当 `enabled` 为 `false` 时完整销毁壁纸与表面图层、还原标题栏，并保持 `empty: true` 的 `generation/owner` 租约占位，防止备用 sidecar 心跳恢复旧配置。

## 4. 设置页主题本地即时预览

- `#theme` 切换在面板本地立即更新 `data-theme` 并同步至内存 `draft`（支持重载保留与「还原」），初始化及 `theme-change` 时也会从根元素 CSS 变量回读宿主背景色以兼容隐藏 iframe 与 `color(srgb ...)` 等色彩格式。
- 当本次预览仅 `theme` 变化且运行时无待刷新状态（`!runtime.dirty`）时，后端跳过 `runtime.update(true)`，不空跑主窗口 CDP；嵌入宿主时（`data-embedded="true"`）透明化 `body` 与 `footer` 背景以避免与侧栏底色产生双重透明度叠加。

## 5. 0.3.8 架构演进：多表面协同、全变体统一与跨窗口同步

- **单张「对话框与面板」设置卡与 `overviewSync` 可选同步**：
  - `plugin/appearance.cjs` 在 `surfaceControls` 中新增 `bubbleOpacity`/`bubbleBlur`/`overviewOpacity`/`overviewBlur`，将表面颜色校验扩展至 `composer*`、`bubble*`、`overview*` 共 6 项，并新增 `bubbleCover`、`overviewSync`（默认 `true`）与 `overviewCover`。当 `overviewSync === true` 时，`normalize()` 与前端同步将 `bubbleCover`、`bubbleOpacity`、`bubbleBlur`、`bubbleOuterColor`、`bubbleInnerColor` 镜像至对应 `overview*` 字段；关闭同步后两者独立保存与渲染。
  - `sidecars/panel/index.html` 与 `app.js` 在右列「侧边栏」与「输入框」之间合并单张「对话框与面板」`<details class="card">`（全页共 7 张卡片、13 个滑块），通过 `#overview-sync` 控制 `#dialog-target-switch` 显隐，按 `activeDialogTarget`（`'bubble'` / `'overview'`）复用同一套 5 项控件（`#dialog-cover`、`#dialogOuterColor`、`#dialogInnerColor`、`#wallpaper-dialogOpacity`、`#wallpaper-dialogBlur`），并在 16:9 `#preview` 中新增 `.sample-bubble` 与 `.sample-overview` 联动示意（`!enabled` 时同步回退原生默认底色与 `0px` 模糊）。
- **跨会话输入框统一、用户气泡全变体与 Overview 面板层级提升（`renderer` `version = 13`）**：
  - **新建页与多形态输入框统一**：并列提升 `.relative.z-10:has([data-testid="agent-input-box"])` 与新建页 `HOME_VIEW` 外层 Flex 子项 `.z-\[1\]:has([data-testid="agent-input-box"])` 至 `z-index: 1001 !important`，消除 `z-index: 1` 层叠上下文将新建页输入框压在 `#antigravity-ui-background`（`1000`）下方的问题；对含直接子元素 `> [data-testid="input-box-bottom-toolbar"]` 的 `toolbarPlacement="top"` 形态由 `.surface-composer` 统一承载底色、模糊与 `1px inset` 边框，并将其内层 `.surface-composer-card` 置透明、去模糊与 `box-shadow: none !important`，普通形态则将填充与模糊置于 `.surface-composer-card` 并清除原生阴影，消除双层边框与顶部工具条透底分裂。
  - **用户气泡全变体与滚动 Backdrop Root 消解**：统一匹配 `.agy-user-bubble-frame`（透明底 + `1px inset` 外框）与 `.agy-user-bubble`（填充 + 模糊 + `box-shadow: none !important`），覆盖常规气泡、`pending` 脉冲气泡、全宽卡片气泡及无 `data-testid="user-message-bubble"` 的 `Proceeded` 变体；对 `[data-testid="autoscroll-viewport"]` 强制 `isolation: auto !important; position: relative; z-index: 1001 !important;`，并在 `bubbleCover && bubbleBlur > 0` 时移除 `mask-image`/`-webkit-mask-image`，防止 Chromium 因滚动渐隐遮罩创建 Backdrop Root 而阻断气泡背景模糊（`bubbleBlur === 0` 或关闭底色时保留原生 `mask-image`）。
  - **Overview 面板层级与独立外观**：将 `[data-testid="overview-panel-overlay-backdrop"]` 与 `[data-testid="overview-panel-host-overlay"]`、`[data-testid="overview-panel-host-gutter"]`、`[data-testid="overview-panel-host-sibling"]`、`[data-testid="battle-overview-dropdown"]` 抬升至 `z-index: 1002 !important`（高于壁纸 `1000` 与对话/输入框 `1001`，低于右上角工具条 `1003`），并应用 `overview*` 填充、模糊与 `border-color`。
- **多窗口主动发现、`settings.json` 外部重载与多面板同步**：
  - **多窗口发现与并发推送**：`WallpaperRuntime` 记录 `lastDiscoveryAt`，`apply()` 按 `discover || this.connections.size === 0 || (Date.now() - this.lastDiscoveryAt >= 250)` 在交互预览期间以 250ms 节流窗口自动发现新窗口，并在 `POST /api/settings` 与 `POST /api/preview/discard` 时强制 `discover = true` 立即发现；`applyKeys` 通过去重后的 `Promise.all` 并发推送至所有窗口并保持单目标异常隔离。
  - **外部磁盘变更感知**：Sidecar 的心跳与设置 API 共用一条队列，在读取配置、修改草稿和更新宿主之间保持顺序。`SettingsStore.reloadIfChanged()` 按 `mtimeMs` 和文件大小判断是否重载。有效的外部修改会清理过期草稿，下一次设置页同步会激活宿主更新。损坏的文件保留最近一次有效设置（首次启动时使用默认值），可从面板保存完整配置来修复。
  - **渲染器升级**：`version` 表示租约协议，`revision` 表示渲染实现。修订号 19 继续使用协议 18，使旧 Sidecar 能按同一租约规则让步。接管时若宿主需要完整图片，当前图层会保留到图片抵达。
  - **同源多面板同步**：`app.js` 使用 `BroadcastChannel('antigravity-ui-panel-sync')`（按 `tabId` 忽略自发消息）在 `changed()` 与预览/还原/保存响应后广播状态，图片未变时省略 `image` 仅传 `imageHash`（接收端按本地缓存、`sha256Hex` 或按需 `syncFromServer()` 补齐），更新状态并直接 `render()` 避免回环请求；同时监听 `visibilitychange`（`!document.hidden`）与 `focus`，在无在途操作（`!saving && !previewInFlight && !previewQueued && !busy && !previewTimer && !syncInFlight`）时刷新宿主主题并调用 `syncFromServer()` 同步最新状态。

## 6. 侧边栏原生视图（`[data-browser-hole]`）切换时的主内容区堆叠隔离（`renderer` `version = 14`）

- 当右侧边栏切换至包含 `[data-browser-hole]` 的原生视图标签页时，Antigravity 会沿祖先链向 `body` / `html` 写入 `data-has-browser-hole="true"`（以及 `data-has-three-layer-browser-hole="true"` / `data-split-transition`），触发宿主在 `[data-main-content-body]` 上设置 `clip-path` 与 `box-shadow`，并在三层分栏 `[data-split-fill-edge]:not([data-has-browser-hole="true"])` 上设置 `clip-path: inset(0%)`。由于主内容区祖先保持 `z-index: auto`，非 `none` 的 `clip-path` 会建立根级 `z-index: 0` 层叠上下文与 Backdrop Root，将内部 `z-index: 1001/1002` 的对话区、用户气泡、输入框及 Overview 面板压入 `#antigravity-ui-background`（`z-index: 1000`）之下。
- `renderer` `version = 14` 在 `layout.replaceSync(...)` 追加两条规则，清除非 hole `[data-main-content-body]` 的 `clip-path` 与 `box-shadow`，并清除非 hole 且非 `[data-split-overlaid="true"]` 的 `[data-split-fill-edge]` 的 `clip-path`：
  - `[data-main-content-body]:not([data-has-browser-hole="true"]) { clip-path:none !important;box-shadow:none !important; }`
  - `[data-split-fill-edge]:not([data-has-browser-hole="true"]):not([data-split-overlaid="true"]) { clip-path:none !important; }`
  既防止侧边栏原生视图切换导致主对话区跌入壁纸层下方，又保留显式 `[data-has-browser-hole="true"]` / `[data-split-overlaid="true"]` 元素的原生裁切与阴影语义。

## 7. 宿主主题重算覆盖 `titleBarOverlay` 防护（`renderer` `version = 15`）

- Antigravity 在语言服务配置下发、主题预设初始化或对比度/主题切换时，会重算 `document.documentElement.style` 并同步调用 `window.electronNative.setTitleBarOverlay({ color: F7b("--sidebar"), symbolColor: F7b("--foreground") })`，把原生右上角窗口控制栏（`136×30px`）重新涂成不透明底色（如 `#444343`）。仅在前端内存中永久缓存 `activeState.titlebar` 会导致后续 1500ms 心跳误判状态一致而长期残留深色矩形。
- `renderer` `version = 15` 在 `state` 上维护 `hasCss` 与 `titlebarAt`：
  - 通过 `MutationObserver` 监听 `document.documentElement` 的 `style`、`class`、`data-theme` 变更，在 `state.hasCss` 为真时于微任务中立即调用 `syncTitlebar(true)` 将 `titleBarOverlay` 恢复为 `#00000000`；在 `dispose()` 时断开监听。
  - 将常规 `syncTitlebar()` 的缓存有效期收窄为 `1000ms`：16ms 滑块连续拖动期间仍走缓存不阻塞 IPC，同时每次 1500ms 周期心跳可自动重申透明标题栏，兜底非 DOM 属性触发的宿主覆盖。

## 8. 分栏拖拽分隔条层级提升（`renderer` `version = 16`）

- 将对话滚动区 `[data-testid="autoscroll-viewport"]` 与右侧栏内容区 `[data-side-panel-body]` 抬升至 `z-index: 1001`（及 Sidecar 容器 `1002`）后，原生 `z-index: 30` 的 `[data-split-sash]`（含左侧边栏与右侧边栏 8px 宽拖拽手柄 `[data-sash-handle]`）以及 `z-index: 46` 的分栏条 `[data-testid="tiling-splitter"]` 与左边缘高亮指示线会被遮挡，导致无法通过鼠标拖拽调整侧边栏宽度。
- `renderer` `version = 16` 将 `[data-split-sash]` 与 `[data-testid="tiling-splitter"]` 抬升至 `z-index: 1003 !important`，并将 `[data-main-content-body]::before` 等左边缘悬停跟踪高亮提升至 `z-index: 1002 !important`，在不影响两侧面板显示的前提下恢复左右侧边栏与分栏拖拽交互。

## 9. 颜色标准化、浏览器孔洞透明化与主题变更监听过滤（`renderer` `version = 17`）

- **标题栏控制区颜色标准化**：`normalizeColor` / `shellColors` 将 `color(srgb ...)` 转换为标准 `rgb(...)`（`0..255` 整数）后再传给 `setTitleBarOverlay`，保证关闭壁纸（`!hasCss`）或卸载（`dispose()`）时在强对比度等 `color-mix` 主题下正确还原不透明底色。
- **浏览器孔洞与分隔条背景透明**：为侧栏表面规则补充 `:not([data-has-browser-hole="true"])` 并显式声明 `[data-side-panel-body][data-has-browser-hole="true"]` 透明且无 `backdrop-filter`，同时置空 `z-index: 1003` 的 `[data-split-sash]`/`[data-testid="tiling-splitter"]` 背景，避免内置浏览器降级或开启孔洞时被底色、模糊或实心分割线遮挡。
- **主题签名过滤与冗余校验精简**：`MutationObserver` 同时监听 `documentElement` 与 `body`（含 `data-agy-theme`），仅在 `themeSignature()` 实际变化时调用 `syncTitlebar(true)` 过滤 `style.transition` 等过渡噪音；`main.mjs` 移除 `resolveImage` 中针对 `SidecarApp` 必然保证为对象的冗余非对象守卫；`app.js` 缓存 `hostThemeColor` 并直接解析 `rgb`/`color(srgb ...)` 替代每次新建 `<canvas>`。

## 10. 交互式背景拖拽预览、边界保护与真实窗口几何同步（`renderer` `version = 18`）

- **全铺边界保护**：`plugin/appearance.cjs` 的 `wallpaperStyle()` 对非 `tile` 模式启用 `effectiveScale = Math.max(100, scale)`；`sidecars/panel/app.js` 同步将非 `tile` 模式下 `#wallpaper-scale` 滑块下限及滚轮下限锁定为 `100%`，防止缩放小于界面造成未覆盖边界；`x`/`y` 拖拽计算（`dragSpan(stage)`）按 `fill`/`stretch`/`fit`/`tile` 实时可移动余量 `dx = w - s * w0`、`dy = h - s * h0` 线性映射并严格钳制于 `[0%, 100%]`，超出界面部分可在边界内自由平移、贴边即止。
- **仅弹窗可拖拽与宿主 1:1 几何对齐**：顶部 `#preview` 仅作只读等比预览（避免滚动/浏览时误触拖动），交互式拖拽与滚轮缩放收敛在「壁纸调整 → 打开预览」弹出的 `#drag-preview-modal` 内；`renderer` `version = 18` 与 `runtime.mjs` 采集真实宿主窗口 `width`/`height`、标题栏高度、左栏与右栏宽度占比并随 `runtime.health.layout` 下发，预览画布按真实窗口比例、`outline` 无框挤压与真实分栏占比渲染，确保预览裁剪与主界面完全一致。

## 11. 交互控件与浮层堆叠修复（`renderer` `version = 18` / `revision = 20`）

- **对话区内部控件恢复**：`[data-testid="autoscroll-viewport"]` 抬升至 `z-index: 1001` 后，与其同处 `[data-testid="conversation-view"]` 或 `AutoScroll` 容器内的原生叠层控件会跌落到 `1001` 之下。`revision = 20` 将 `[data-testid="conversation-view"] > .pointer-events-none.inset-y-0.left-0:has([data-testid="conversation-navigator"])`、`[data-testid="conversation-navigator"]` 与查找栏 `.sticky.top-0:has([data-testid="find-bar-match-count"])` 抬升至 `1002`，并将同级在后的 `[data-testid="overlay-scrollbar"]`、`.agy-scroll-bottom` 与 `[data-testid="bottom-terminal-panel-resize-handle"]` 抬升至 `1001`（既位于 `autoscroll-viewport` 之上，又低于 `overview-panel` `1002` 与面板本体），恢复左侧圆点进度条点击跳转、悬浮滚动条拖拽、回到底部按钮与终端上边缘拖拽调高。
- **侧栏收起 Peek、窄窗抽屉、分叉对比视图与浮窗对齐**：将 `.agy-inset-shell > .absolute.left-0.top-0`、`[data-testid="sidebar-peek-hot-zone"]`、`[data-testid="sidebar-split"] [data-split-sized]:has([data-peek-surface="open"])`、`[data-testid="sidebar-popover-backdrop"]` 及紧邻 `[role="dialog"]`、以及语音模式 `.fixed.z-40:has([data-testid="voice-dock-composer"])` 抬升至 `1003`；重置 `[data-main-content-body] [data-split-sized]:not(:has([data-peek-surface]))` 为 `z-index: auto !important` 并抬升分叉对比关闭按钮至 `1002`；在 `[data-side-panel-maximized]` 与 `[data-split-overlaid="true"]` 时将 `[data-side-panel-strip]`（及最大化 `[data-side-panel-body]`）抬升至 `1002`，并抬升 `.selection-popup`、`[data-comment-bubble-popover="true"]`、`[data-testid="pdf-selected-annotation-popover"]`、`[data-testid="comment-box"].absolute` 至 `1002` 及低层级浮动滚动条（`style*="z-index: 51"`）至 `1001`，同时保留左侧栏、常规标签条、底部终端本体与非对话窗格的全窗壁纸透出行为。

## 12. 工作状态框等内嵌容器浮动滚动条视口裁剪（`renderer` `version = 18` / `revision = 21`）

- **问题成因**：对话流中的可滚动工作状态框（`maxHeight: 500px` 的 `.bleed-contain.overflow-y-auto` 等非 `AutoScroll` 容器）使用宿主全局 `bRb`（`aRb`）在 `document.body` 下以 `position: fixed` 挂载 `[data-overlay-scrollbar-track]`，其 `top` / `height` 直接取容器自身 `getBoundingClientRect()`；当工作状态框随对话滚动部分移出 `[data-testid="autoscroll-viewport"]` 上下边界时，叠加插件对 `autoscroll-viewport` 抬升至 `z-index: 1001` 引发 `aRb` 计算 `z-index: 1002`，导致该浮动滚动条直接凸出覆盖会话头部栏、标题菜单栏或底部输入框。
- **裁剪方案**：在 `renderer` 修订号 `21` 中为挂载于 `body > [data-overlay-scrollbar-track]` 的浮动滚动条建立 `trackOwners` 几何反查与祖先裁剪链计算（按实际 CSS 包含块与 `overflow` 非 `visible` 祖先交集求取可视区域，通过 `clip-path: inset(...)` 对超出视口部分做视觉与指针命中双重裁剪），随 `MutationObserver`、`scroll` 捕获与 `resize` 实时同步，并在 `dispose()` 时清除残留 `clip-path` 与监听，同时保持会话框内部区域的正常拖拽滚动体验。

## 13. 跨重启持久化与缺少调试端口自修复（`plugin/persistence.cjs`）

- **问题成因**：Electron 仅在具备 `--remote-debugging-port` 启动参数时写入 `DevToolsActivePort`；桌面 `AntigravityLauncher.exe` 快捷方式、`antigravity://` 协议拉起或应用内自重启若未携带该参数，`dist/main.js` 会主动删除旧的 `DevToolsActivePort`，导致已保存的 `settings.json` 无法在重启后自动渲染到主窗口，并在侧栏暴露原始 `ENOENT` 路径报错。
- **双保险持久化与自修复设计**：
  - 新增共享模块 `plugin/persistence.cjs`：`manage.cjs install` 在保留已有 `restoreLegacy` 旧补丁迁移的前提下，为桌面/开始菜单/任务栏中的 Antigravity 快捷方式（含透传参数的 `AntigravityLauncher.exe` 快捷方式）幂等补齐 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` 并持久化备份原始参数；同时在 `resources/app.asar` 的 `dist/main.js` 模块加载早期（`app.whenReady()` 前）注入仅限本机 `127.0.0.1` 的 `app.commandLine.appendSwitch` 启动开关及 `dist/antigravity-ui/persist.json` + SHA-256 备份，`uninstall` 时校验哈希并无损恢复 `app.asar` 与快捷方式。
  - `runtime.mjs` 将 `DevToolsActivePort` 缺失（`ENOENT`）归类为 `errorCode: 'MISSING_DEVTOOLS_PORT'` 并输出清晰中文说明；`main.mjs` 提供 `POST /api/repair-shortcuts`，设置页仅在检测到 `MISSING_DEVTOOLS_PORT` 时于底栏展示「修复快捷方式」按钮，帮助用户在不重启前先修复快捷方式并明确提示重启即可恢复。

## 14. 分层级感精简绑定与侧栏对齐修复（`renderer` `version = 18` / `revision = 23`）

- **左右侧边栏去分层与接缝/对齐修复（`plugin/appearance.cjs`、`sidecars/panel/renderer.mjs`）**：
  - 去除左侧边栏（`leftSidebar*`）与右侧面板（`sidebar*`）的「原版分层级感」与外内双色控件，恢复单层纯色/透明与毛玻璃定制（保留 `Cover`、`Opacity`、`Blur`）。
  - 左侧边栏宿主 `.h-full.w-full.flex.flex-col.bg-sidebar` 设置 `box-shadow: none !important` 且移除列表内卡框线，消除菜单栏下方顶部横竖内阴影接缝；仅透明化嵌套 `.bg-sidebar` 与 `.agy-row-actions::before`。
  - 右侧面板移除外层 `.browser-hole-ancestor` 的背景、模糊与 `z-index` 提升，保持 `[data-side-panel-strip]` 与主界面顶部文件栏齐平且无缝隙，仅对 `[data-side-panel-body]:not([data-has-browser-hole="true"])` 施加底色与模糊（`box-shadow: none !important`、无圆角内嵌框）。
- **输入框与对话框效果绑定，Overview 面板完全解耦（`renderer` `revision = 23`）**：
  - 移除 `overviewSync`、顶部 `#dialog-target-switch` 切换栏及 `overviewLayered`。`plugin/appearance.cjs` 中由 `composer*`（`composerCover`、`composerLayered`、`composerOpacity`、`composerBlur`、`composerOuterColor`、`composerInnerColor`）唯一驱动，并在 `normalize()` 中实时镜像写入对应 `bubble*` 字段（由 `appearance.surfaceConfig(settings)` 下发给宿主渲染器），确保输入框（`.surface-composer` / `.surface-composer-card`）与用户气泡（`.agy-user-bubble-frame` / `.agy-user-bubble`）始终同步保持一致的双层或扁平质感与配色，从不同步到 Overview 面板。
  - 拆出独立扁平 **「Overview 面板」** 设置卡（`overviewCover`、`overviewOuterColor`、`overviewInnerColor`、`overviewOpacity`、`overviewBlur`），保留外框颜色与内部填充，移除 `box-shadow` 立体卡片层叠，完全独立于输入框与对话框。
- **双列设置页均衡布局与实时预览（`index.html`、`styles.css`、`app.js`）**：
  - 左列放置「图片布局」「壁纸调整」「设置页主题」，右列放置「左侧边栏」「右侧面板」「输入框与对话框」「Overview 面板」（全页 8 张 `<details>` 卡片、15 根滑块）；顶部 16:9 `#preview` 与弹窗 `#drag-preview-stage` 同步反映扁平左右栏、对齐文件标签条、同步输入框/气泡分层以及独立扁平 Overview 面板。

## 15. 输入框与用户气泡共用设置（`renderer` `revision = 24`）

`normalize()`、设置写盘和 `surfaceConfig()` 统一使用 `composer*` 字段。旧配置缺少对应 `composer*` 字段时，仍会读取合法的 `bubble*` 值完成迁移。渲染器从同一组设置派生输入框和用户气泡的样式，Overview 面板仍使用独立的 `overview*` 字段。模糊值为 0 时，宿主底层使用 `backdrop-filter: none`。

## 16. 启动/首次附加性能优化与健壮性加固（`renderer` `revision = 25`）

- **冷启动与首次附加加速（`97ff25e`）**：
  - `main.mjs` 改为按需懒加载 `updater.mjs` 与 `persistence.cjs`（仅在检测到 `updates/tx-*` 中断事务或面板调用更新/修复接口时载入），启动时并行预读静态资源、`loadSdk` 与 `syncStore({ initial: true })`，并缓存 `config.json` 的 `stat` 签名避免心跳重复读盘解析。
  - `sdk.mjs` 将嵌入式 SDK/Preload 提取从整文件读取改为 4MB 分块 + 64KB 重叠流式扫描，大幅降低大体积可执行文件的冷启动内存峰值。
  - `runtime.mjs` 将 `runtime.start()` 提前至 `app.run()` 之前并采用 `[150, 250, 400, 600, 1000, 1500]ms` 自适应附加退避（附加成功后恢复 `1500ms` 心跳）；稳态心跳命中同版本 `RENDERER_KEY` 时走 `FAST_EVAL_PREFIX` 轻量求值路径，避免重复投递完整 `installWallpaper` 源码与大图。
  - `plugin/appearance.cjs` 为 `DATA_IMAGE_RE` 增加最多 4 张图片的校验结果缓存 `verifiedImages`；`app.js` 新增 `ensureTileEdgeColor()` 仅在 `tile` 模式下按需执行边缘取色，跳过默认 `fit` 模式的首屏 Canvas 开销。
- **审查加固与边界修复**：
  - `main.mjs` 对启动并发 Promise、HTTP `/api/update*` 路由与 `app.run()` 失败路径补齐异常捕获及 `runtime.stop()` 清理，并统一使用 `AG_UI_HOME` 派生隔离配置路径；`runtime.mjs` 改为 tick 完成后再调度下次退避，并在 `stop()` 中对在途操作和 disable 求值施加超时上界。
  - `updater.mjs` 与 `archive.mjs` 保持“正式 Release 优先于同版本 `main` 提交”的更新策略，将 `inspectTargetEligibility()` 纳入 `initializeLocalInfo()` 异常边界，为 `ensureParentDir`、事务恢复路径及 `CONIN$`/`CONOUT$` 补齐校验，并将删除操作纳入 Windows 文件占用重试。
  - `manage.cjs` 与 `persistence.cjs` 持久化自定义安装目录路径以支持无参卸载还原、补全卸载回滚 `app.asar` 对称补偿、对 `replaceAtomic` 增加 Windows 重试并原子写入备份，且仅在全部快捷方式写回确认成功后才清理备份。
  - `app.js` 将 `render()` 布局读取移至样式写入前（仅在宿主比例变化时重读）、补全 `img.onerror` 提示与 `syncQueued` 忙时补跑机制，并区分边缘取色 2D 上下文不可用与透明图片结果。

## 17. 原生浏览器孔洞激活时的停靠左侧栏底层画布还原（`renderer` `version = 18` / `revision = 26`）

- **问题成因**：右侧边栏激活包含 `[data-browser-hole]` 的原生视图后，宿主在祖先链（含 `.agy-inset-shell.browser-hole-ancestor`）上写入 `data-has-browser-hole="true"` 并将其背景置透明，再由顶栏 `[data-testid="title-menu-bar"]`、`[data-main-content-header]` 与 `[data-side-panel-strip]` 各自补涂 `var(--shell-canvas)`。插件此前将停靠左侧栏外层容器 `[data-testid="sidebar-split"] > :first-child` 直接抬升至 `z-index: 1001` 且透明化/半透明化内层 `.bg-sidebar`，导致壁纸层（`z-index: 1000`）下方的左侧栏区域失去 `var(--shell-canvas)` 承托而透出更暗的窗口底色，在左侧栏顶部与菜单栏、会话头交界处形成明显暗色断层。
- **修复方案**：`revision = 26` 保持停靠左侧栏外层容器 `z-index: auto !important`（不建立层叠上下文），仅将内层 `[data-split-sized]`（或无 `[data-split-sized]` 时的 `.bg-sidebar`）抬升至 `z-index: 1001 !important`；同时在 `body[data-has-browser-hole="true"]` 生效时为非孔洞停靠左侧栏外层容器补涂 `background-color: var(--shell-canvas, var(--sidebar, var(--background))) !important` 与 `1px` 右侧分隔条补色阴影（位于壁纸层下方），使左侧栏与顶栏、会话头在开启浏览器孔洞前后像素级一致。
