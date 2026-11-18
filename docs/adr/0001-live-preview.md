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
  - `WallpaperRuntime` 优先复用健康 CDP 连接（仅在启动、1500ms 周期心跳、空连接或失败时重发现），按连接记录 `lastImageHash` 按需省略 `image`，主窗口重载等场景丢失缓存时 `renderer` 返回 `'NEED_IMAGE'` 触发自动补发一次完整图片。
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
