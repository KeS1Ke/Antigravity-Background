# Antigravity Background 维护指南

## 验证回路

- 渲染、预览、持久化或设置面板改动：`node tests/background-rendering.mjs`
- 更新器、归档安全或回滚改动：`node tests/updater.mjs`（若终端已注入 `ANTIGRAVITY_LS_ADDRESS`，先在当前 shell 置空再运行隔离测试）
- 文档、HTTP 路由、环境变量、版本或运行时文件清单改动：`node tests/docs-sync.mjs`
- 本机部署与检查（先从托盘完全退出 Antigravity）：`node manage.cjs install`、`node manage.cjs status`、`node manage.cjs uninstall`

## 必须保持的不变量

1. **`installWallpaper` 零外部闭包自包含**：[sidecars/panel/runtime.mjs](sidecars/panel/runtime.mjs) 通过 `installWallpaper.toString()` 经 CDP 注入宿主页面，[sidecars/panel/renderer.mjs](sidecars/panel/renderer.mjs) 的所有运行期辅助逻辑必须留在 `installWallpaper` 函数体内。
2. **租约单调性与快速路径一致**：`shouldIgnoreLease`（[sidecars/panel/renderer.mjs](sidecars/panel/renderer.mjs)）按 `version > revision > generation > owner` 判优；变更注入协议或渲染实现时递增 `RENDERER_VERSION` / `RENDERER_REVISION`，并保持 [sidecars/panel/runtime.mjs](sidecars/panel/runtime.mjs) 的 `FAST_EVAL_PREFIX` 与租约逻辑一致。
3. **Windows 真实目录、目录锁与原子写重试**：插件安装目录 `~/.gemini/config/plugins/antigravity-ui` 必须为真实目录（[manage.cjs](manage.cjs) 的 `safeDirectory` 禁止 symlink/junction）；保持 `.antigravity-ui-update.lock` 目录锁、`updates/tx-*` 事务恢复及 `EPERM/EBUSY/EACCES` 重试（[plugin/persistence.cjs](plugin/persistence.cjs)、[sidecars/panel/store.mjs](sidecars/panel/store.mjs)、[sidecars/panel/updater.mjs](sidecars/panel/updater.mjs)）。
4. **运行时文件清单与数据保护同步**：增删运行时文件须同步更新 [manage.cjs](manage.cjs) 的 `runtimeFiles` 与 [sidecars/panel/archive.mjs](sidecars/panel/archive.mjs) 的 `RUNTIME_ROOTS` / `REQUIRED_RUNTIME_FILES`，并保持 `EXCLUDED_RUNTIME_DIRS`（`data`、`sdk`）在更新解包时不被覆盖。
5. **仅本机环回与显式保存语义**：`app.asar` 与快捷方式注入的调试开关限定 `127.0.0.1`（[plugin/persistence.cjs](plugin/persistence.cjs)）；实时预览草稿仅驻留 Sidecar 内存，仅 `POST /api/settings` 经 [sidecars/panel/store.mjs](sidecars/panel/store.mjs) 原子落盘。
6. **文档作索引、源码为单一事实来源**：配置字段、默认值与范围以 [plugin/appearance.cjs](plugin/appearance.cjs) 为准，路由与状态以 [sidecars/panel/main.mjs](sidecars/panel/main.mjs) / [sidecars/panel/updater.mjs](sidecars/panel/updater.mjs) 为准，改动后同步更新文档并运行 `node tests/docs-sync.mjs`。

## 按需阅读索引

- 变更模块边界、Sidecar HTTP API、环境变量、状态机或数据目录布局 → 读 [ARCHITECTURE.md](ARCHITECTURE.md)
- 变更用户安装/卸载流程、功能说明、常见问题或仓库目录树 → 读 [README.md](README.md)
- 排查或调整宿主 DOM/CSS 兼容规则（`[data-browser-hole]`、标题栏 `MutationObserver`、浮动滚动条裁剪、拖拽边界保护、`composer*` 历史迁移）→ 查 [docs/adr/0001-live-preview.md](docs/adr/0001-live-preview.md)
- 确认「实时预览」与「保存配置」术语边界 → 查 [GLOSSARY.md](GLOSSARY.md)
