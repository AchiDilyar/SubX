# UI 图标规范

所有界面图标统一使用本目录下的 SVG，不再新增 PNG 图标。

- 渲染层通过 `<use href="#i-*">` 声明语义，CSS 用 `mask-image` 指向对应 SVG。
- 当前 49 个 `#i-*` 语义名对应 49 个 SVG 别名；另保留新图标集的 69 个原始 SVG。
- 新增图标步骤：复制 SVG 到本目录 → 在 `workspace.css` 增加 mask 映射 → 在 `main.mjs` 的 `iconFiles` 白名单登记 → 更新桌面 smoke 的图标加载检查。
- 品牌字标、应用图标（`textLOGO.png`、`SubXIcon.png`、`.icns`/`.ico`）不属于 UI 图标集，保留原有格式。
- 本目录图标由用户提供；公开发布前需确认原始图标集许可证，并在 README/关于页标注来源。
