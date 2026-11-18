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
  - **外部磁盘变更感知**：`SettingsStore` 新增 `reloadIfChanged()`（经内部操作队列串行比对 `mtimeMs`/`size` 并按需重载），`main.mjs` 的 `syncStore()` 在 `runtime` `style()` 回调及全部 `/api/*` 路由前调用，外部改写 `settings.json` 时清理过期 `draft` 并于 `GET /api/settings` 同步推送宿主窗口。
  - **同源多面板同步**：`app.js` 使用 `BroadcastChannel('antigravity-ui-panel-sync')`（按 `tabId` 忽略自发消息）在 `changed()` 与预览/还原/保存响应后广播状态，图片未变时省略 `image` 仅传 `imageHash`（接收端按本地缓存、`sha256Hex` 或按需 `syncFromServer()` 补齐），更新状态并直接 `render()` 避免回环请求；同时监听 `visibilitychange`（`!document.hidden`）与 `focus`，在无在途操作（`!saving && !previewInFlight && !previewQueued && !busy && !previewTimer && !syncInFlight`）时刷新宿主主题并调用 `syncFromServer()` 同步最新状态。

## 6. 侧边栏原生视图（`[data-browser-hole]`）切换时的主内容区堆叠隔离（`renderer` `version = 14`）

- 当右侧边栏切换至包含 `[data-browser-hole]` 的原生视图标签页时，Antigravity 会沿祖先链向 `body` / `html` 写入 `data-has-browser-hole="true"`（以及 `data-has-three-layer-browser-hole="true"` / `data-split-transition`），触发宿主在 `[data-main-content-body]` 上设置 `clip-path` 与 `box-shadow`，并在三层分栏 `[data-split-fill-edge]:not([data-has-browser-hole="true"])` 上设置 `clip-path: inset(0%)`。由于主内容区祖先保持 `z-index: auto`，非 `none` 的 `clip-path` 会建立根级 `z-index: 0` 层叠上下文与 Backdrop Root，将内部 `z-index: 1001/1002` 的对话区、用户气泡、输入框及 Overview 面板压入 `#antigravity-ui-background`（`z-index: 1000`）之下。
- `renderer` `version = 14` 在 `layout.replaceSync(...)` 追加两条规则，清除非 hole `[data-main-content-body]` 的 `clip-path` 与 `box-shadow`，并清除非 hole 且非 `[data-split-overlaid="true"]` 的 `[data-split-fill-edge]` 的 `clip-path`：
  - `[data-main-content-body]:not([data-has-browser-hole="true"]) { clip-path:none !important;box-shadow:none !important; }`
  - `[data-split-fill-edge]:not([data-has-browser-hole="true"]):not([data-split-overlaid="true"]) { clip-path:none !important; }`
  既防止侧边栏原生视图切换导致主对话区跌入壁纸层下方，又保留显式 `[data-has-browser-hole="true"]` / `[data-split-overlaid="true"]` 元素的原生裁切与阴影语义。
