# UI 图标规范

所有界面图标统一使用本目录下的 SVG，不再新增 PNG 图标。

- 渲染层通过 `<use href="#i-*">` 声明语义，CSS 用 `mask-image` 指向对应 SVG。
- 当前 49 个 `#i-*` 语义名对应 49 个 SVG 别名；另保留新图标集的 69 个原始 SVG。
- 新增图标步骤：复制 SVG 到本目录 → 在 `workspace.css` 增加 mask 映射 → 在 `main.mjs` 的 `iconFiles` 白名单登记 → 更新桌面 smoke 的图标加载检查。
- 品牌字标、应用图标（`textLOGO.png`、`SubXIcon.png`、`.icns`/`.ico`）不属于 UI 图标集，保留原有格式。
- 本目录图标由用户提供；已初步核对为 Hugeicons Stroke Rounded（MIT），公开发布前仍需维护者复核并标注来源。
## 来源与许可

- 文件名、命名规则与 Hugeicons **Stroke Rounded** 图标集一致。
- Hugeicons 官方图标页说明 Stroke Rounded 图标采用 **MIT License**，可用于个人和商业项目。
- 来源：[hugeicons.com](https://hugeicons.com/)；许可说明：[hugeicons.com/license](https://hugeicons.com/license)。
- 公开发布前由项目维护者再次复核该许可，并保留本说明与链接。
