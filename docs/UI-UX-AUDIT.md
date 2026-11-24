# SubX UI/UX 截图审计

- 日期：2026-11-23
- 范围：主工作区、四个配置标签、时间轴、全部菜单、全部 dialog 与 popover、空态/缺失媒体/窄窗口
- 方法：Electron 开发实例（1290×888 逻辑像素，2× Retina 截图）+ CDP 状态驱动 + macOS 辅助功能树；窄检查器 255px、窄窗口 1024×700
- 截图归档：`out/ui-audit/shots/`（审计前）、`out/ui-audit/clips/`（弹窗特写）、`out/ui-audit/after/` 与 `out/ui-audit/final/`（本轮修复后）
- 代码证据：`src/renderer/index.html`、`workspace.css`、`workspace.mjs`；只读代码审计由三个子 Agent 并行完成
- 说明：文中行号以 2026-11-23 当前工作区为准；后续改动若行号漂移，以函数名、选择器名与截图为准

## 1. 结论摘要

整体设计语言已经成型：深色中性灰面板、8px 面板圆角、6px 控件圆角、蓝色主色 `#173E76`、橙色字幕块、等宽时间码、紧凑桌面密度。工程态工作区、菜单、样式编辑器、合成视频弹窗的完成度较高，80 个单测与 394 条桌面 PASS 提供了良好的回归保护。

本轮截图审计暴露的主要问题不是“不好看”，而是三类可用性缺口：

1. **首次使用没有入口**：空工作区的预览区只有居中的 SubX 字标，时间轴空提示因“始终有 2 条 starter 轨道”而永不出现，打开视频按钮被放在 `display:none` 的隐藏节点池里。
2. **关键状态不可见**：待校对入口同样藏在隐藏节点池；标尺、缩放条、字幕块没有键盘焦点环；错误与普通提示共用同一种状态栏颜色；选中字幕只靠 1.34:1 的红框。
3. **专业字幕工作流缺反馈**：选中字幕时看不到时长、语速、链接状态；样式预览文字会被面板右侧裁掉；缺失媒体只能看到一行“原视频不可用”，没有恢复入口。

第 1 轮修复 12 项（见 §4），其中 4 项属于公测阻断级；第 2 轮新增整体平移与查找替换（见 §3.8）；第 3 轮新增自动保存与崩溃恢复（见 §3.11）；第 4 轮新增双语合并导出（见 §3.10）；第 5 轮新增质量检查（见 §3.12）；第 6 轮新增文本工具（见 §3.13）；第 7 轮新增 WebVTT 导入/导出（见 §3.14）；第 8 轮新增编码/换行与 SSA v4（见 §3.15）；第 16 轮新增时间码格式（见 §3.16）；第 17 轮帧率转换已在第 52 轮按用户要求移除；第 18 轮新增批量导出与预设（见 §3.18）；第 19 轮新增工程字体检查（见 §3.19）；第 20 轮记录 5000 块性能基线（见 §3.20）；第 21 轮新增拼写检查（见 §3.21）；第 22 轮新增校对进度（见 §3.22）；第 24 轮新增批量编辑（见 §3.23）。剩余问题按 P0/P1/P2 列入 §5，并同步到 `docs/PUBLIC-BETA-PLAN.md`。

## 2. 截图覆盖

| 界面 | 状态 | 截图 |
| --- | --- | --- |
| 空工作区 | 无媒体、2 条 starter 轨道 | `final/04-empty-workspace.png` |
| 工程工作区 | 3 轨 14 条字幕、链接、绑定、标记、双语 | `final/01-project-workspace.png` |
| 字幕编辑 | 选中字幕 + 草稿表单 | `final/02-cue-panel.png` |
| 样式管理 | 列表 | `final/01-project-workspace.png` 右侧 |
| 样式编辑器 | 实时预览 + 22 个字段 | `final/03-style-editor.png` |
| 项目设置 | 渐入渐出、水印开关与参数 | `shots/12-settings-tab.png`、`13`、`14` |
| 待打轴 | 空态与 8 行进度 | `shots/15-script-tab-empty.png`、`shots/15` |
| 时间轴 | 空态、工程态、窄窗口、密集块 | `final/04`、`final/01`、`shots/29-narrow-window.png` |
| 顶部菜单 | 文件/编辑/导出/关于 | `shots/02-file-menu.png` ~ `05-about-menu.png` |
| 关于/快捷键/最近工程 | 弹窗 | `clips/about-dialog.png`、`shortcuts-dialog.png`、`recent-dialog.png` |
| 空白视频/导入文稿 | 弹窗与双语模式 | `clips/blank-video-dialog.png`、`script-dialog.png`、`shots/11-script-dialog-bilingual.png` |
| 导出字幕/合成视频 | 弹窗 | `clips/export-dialog.png`、`composition-dialog.png` |
| 拆分双语 | 预览与异常条目 | `clips/split-dialog.png` |
| 工程变更/退出确认 | 弹窗 | `clips/project-change-dialog.png`、`quit-dialog.png` |
| 缺失媒体/无法播放 | 恢复入口 | `final/06-missing-media.png` |
| 崩溃恢复 | 自动保存恢复对话框 | `round3/01-recovery-dialog.png`、`round3/04-inline-draft-recovered.png` |
| 双语合并导出 | 导出对话框合并选项与示例 | `round4/01-merge-export.png` |
| 质量检查 | QC 标签、阈值、问题列表与批量修复 | `round5/01-qc-panel.png` |
| 合成视频 | 源信息、码率、HDR/转 SDR、音频模式 | `round52/02-hdr-composition-checkbox.png` |
| 文本工具 | 批量大小写与空格清理 | `round6/01-text-tools.png` |
| WebVTT | 导出对话框 WebVTT 选项 | `round7/01-vtt-export.png` |
| 编码/换行 | 导出对话框编码与换行选择 | `round8/01-export-encoding.png` |
| 时间码 | 项目设置时间码格式 | `round16/01-timecode-settings.png` |
| 批量导出 | 全部轨道导出与预设 | `round18/01-batch-export.png` |
| 字体检查 | 工程字体缺失弹窗 | `round19/01-font-check.png` |
| 5000 块时间轴 | 密集时间轴与可见节点 | `round20/01-dense-timeline.png` |
| 拼写检查 | 校对开关与系统词典说明 | `round21/01-spellcheck-settings.png` |
| 校对进度 | 已校对计数与只看待校对 | `round22/01-review-progress.png` |
| 批量编辑 | 多选后的时长/平移/样式弹窗 | `round24/01-batch-edit.png` |
| 窄检查器 | 255px，标签溢出 | `final/05-narrow-inspector.png`、`shots/40-tabs-overflow.png` |
| 字幕正文编辑器 | 浮层、字数、错误行 | `shots/22-cue-inline-editor.png` |
| 时间轴右键菜单 | 字幕块 / 空白区 | `shots/37-cue-context-menu.png`、`23-timeline-cue-menu.png` |

未逐张截图的界面（由代码审计与桌面 smoke 覆盖）：

- 字幕导入检查弹窗：依赖系统文件选择器，截图需要先替换原生 dialog；smoke 的 `srt-import-dialog` 断言覆盖了有效/无效条目与按钮状态。
- 合成视频进行中/失败：需要真实 FFmpeg 长任务；smoke 覆盖进度、取消与错误文案。
- 最近工程空态、标签溢出菜单、cue 样式菜单：代码路径与交互已核对，样式复用已有弹窗/菜单。
- macOS 原生菜单栏：通过辅助功能树确认四个菜单组与「编辑」仅撤销/重做，未单独截图。

## 3. 逐界面观察

### 3.1 空工作区

- 预览区只有居中的字标，没有任何主行动按钮；用户必须自己发现「文件」菜单。`index.html:123-126`（修复前）。
- 时间轴空提示 `#empty-timeline` 的显示条件是 `rows.length > 0`，而新工程固定有 2 条 starter 轨道，所以提示永远不显示。`workspace.mjs:1005`（修复前）。
- 「打开视频」按钮 `#open-media` 被搬进 `.tool-stash { display:none }`，空态没有重新定位入口。`workspace.css:213`、`index.html:240`（修复前）。
- 状态栏只有一种灰色，无法区分“就绪”“已保存”“失败”。

修复后：预览底部出现「开始制作字幕」引导卡（打开视频 / 导入字幕 / 添加空白视频 / 打开工程），时间轴出现「还没有字幕」提示卡，状态栏加入语义色点。见 `final/04-empty-workspace.png`。

### 3.2 工程工作区

- 3 轨 14 条字幕的层次清楚：轨道头 124px、行高 32px、块内正文直接可读、链接图标与绑定圆点可见。
- 字幕块正文 `#f7f8fa` 对 `#a8621a` 的对比度为 **4.46:1**，12px 正常字重下略低于 4.5:1；播放中文字 `#ffc46b` 仅 **3.02:1**；隐藏轨道 `opacity:.3` 后约 **1.8:1**。
- 选中态只有 `#ff3b30` 红框，对橙色块 **1.34:1**，且 `z-index:1` 低于跨轨拖动块的 2。
- 待校对入口不可见（见 §3.1）。
- 样式列表在 373px 检查器内会把字体名截成「Noto San...」，有 title 提示但不可一眼读完；窄容器下用容器查询重排为两行，可用。

修复后：正文改纯白（4.74:1）；播放中保持白色正文，用琥珀色边框与内描边区分（不靠降低文字对比度）；隐藏轨道透明度提到 .55；选中态增加白色外环；待校对按钮移到时间轴工具栏右侧。见 `final/01-project-workspace.png`。

### 3.3 字幕编辑

- 表单结构清楚：正文、开始/结束时间、样式、删除/应用。
- 缺少字幕工作最常用的即时信息：时长、语速（CPS）、所在轨道、链接状态。用户必须自己算。
- 默认样式选项显示为「默认」，与项目里的「默认样式」名称混淆。

修复后：新增元信息行「轨道 S2 · 时长 3.00 秒 · 语速 3.7 字/秒 · 11 字 · 链接 已链接」，语速超过 17 字/秒或时长不足 1 秒时变琥珀色；默认选项改为「项目默认样式」。见 `final/02-cue-panel.png`。

### 3.4 样式编辑器

- 字段分组完整（字形、描边与阴影、位置与对齐、缩放与旋转），实时预览有效。
- 预览文字在 40px 字号、`white-space:nowrap`、`overflow:hidden` 下会被右侧裁掉，例如「SubX字幕样式预览Aa」只剩「…Aa」的一半。`workspace.css:648`（修复前）。
- 保存/删除/返回的层级清楚；删除样式有二次确认。

修复后：`applyStylePreview` 按容器宽度等比缩放预览文字，长文案和大字号都完整显示。见 `final/03-style-editor.png`。

### 3.5 菜单与弹窗

- 四个一级菜单、二级图标、快捷键标注完整；键盘 ↑↓/←→/Home/End/Esc 可用。
- 菜单项 focus 只靠 `#3d3d3d` 背景（对 `#242424` 1.43:1），键盘用户难以判断焦点。
- 关于、快捷键、空白视频、导入文稿、拆分双语、合成视频、退出确认的版式一致；拆分预览与合成设置信息密度偏高但可读。
- 「最近工程」是唯一没有 `aria-labelledby` 的 dialog。

修复后：菜单项增加 2px 焦点环；最近工程补标题关联；导出/合成/拆分弹窗保持不变，待后续统一表单密度。见 `clips/`。

### 3.6 时间轴

- 标尺、轨道头、播放头、缩放条的视觉节奏统一；缩放条把柄的抓取态清楚。
- 标尺与缩放条可聚焦但没有焦点样式（全局 `:focus{outline:none}`）。
- 框选矩形 `z-index:4` 高于吸顶轨道头的 3，横向滚动后可能盖住轨道头。
- 缩放条把柄 12px、轨道增删按钮 22px、分隔条 6px，均低于 24px 命中目标建议。
- 空态提示不可达（见 §3.1）。

修复后：标尺、缩放条、轨道名、字幕块都有 2px 焦点环；框选矩形降到 z-index 2；空态提示可见。见 `final/04`、`shots/40-tabs-overflow.png`。

### 3.7 缺失媒体与错误

- 预览中央显示「原视频不可用」，但没有恢复按钮；打开视频按钮仍在隐藏节点池。
- 视频解码失败只把提示写进状态栏，预览区显示「视频无法播放」，同样没有重新选择入口。
- 状态栏错误与普通提示同色，且没有 `aria-live`。

修复后：缺失媒体/解码失败时，预览底部引导卡切换为「重新定位视频 / 重新选择视频」主按钮 + 导入字幕，并隐藏空白视频/打开工程；状态栏按 success/warn/error 着色并保留文本。见 `final/06-missing-media.png`。

### 3.8 整体平移与查找替换（第 2 轮新增）

- 编辑菜单新增「整体平移…」与「查找与替换…（⌘F）」。
- 整体平移对话框：偏移方式（按时间 / 按帧）、范围（当前轨道 / 选中字幕 / 全部轨道）、偏移量、实时摘要（条数、实际偏移、钳制说明、跨轨链接对端不会移动）。负值按范围内最早起点整体钳制，保持相对时间与链接时间差；按时间模式严格毫秒，按帧模式按整帧偏移。截图：`out/ui-audit/round2/01-shift-dialog.png`、钳制示例 `out/ui-audit/round2/07-shift-clamp.png`。
- 查找替换浮层：非模态，可一边定位一边操作时间轴；支持当前轨道/全部轨道/选中字幕、区分大小写、正则、忽略 ASS 标签；摘要显示第 N / 总数与轨道、时间；替换当前 / 全部替换一次撤销。截图：`out/ui-audit/round2/06-find-panel-anchored.png`。
- 首版浮层放在右上会盖住配置区标签；已改为固定在预览左上角，并把 z-index 降到菜单之下，打开菜单时不会被浮层挡住。
- 已知限制：正则匹配不跨越 ASS 覆盖块；「忽略 ASS 标签」只对 ASS 轨道生效；查找结果在工程切换时清空。

### 3.9 窄窗口与响应式

- 1024×700 与 255px 检查器下没有硬溢出；标签栏出现「…」翻页按钮，4 个标签可通过弹出菜单访问。
- 标签栏只有 click 绑定，没有方向键与 roving tabindex。
- 空工作区引导卡在 760px 以下高度会隐藏说明文字，避免压住字标。

修复后：标签栏支持 ←/→/Home/End，选中标签为唯一 Tab 停靠点；255px 下引导卡与设置卡片仍可用。见 `final/05-narrow-inspector.png`。

### 3.10 双语合并导出（第 4 轮新增）

- 导出对话框在检测到当前轨道有链接字幕时显示「合并上下轨为双行字幕」：显示与哪条轨道、多少对链接；勾选后显示首条示例、链接对数、单边条数与无重叠数量。截图：`out/ui-audit/round4/01-merge-export.png`。
- 规则：上轨在前、时间取交集；无重叠按上轨时间并计数；未链接字幕保留单行。ASS 导出时 ASS 轨道取上轨样式，纯文本轨道使用项目默认样式；SRT 导出自动去掉 ASS 覆盖标签，同时保留纯文本里的花括号与反斜杠。
- 已知限制：只合并链接数最多的那一条对端轨道；多条对端轨道需要分次导出；合并结果不写回工程。

### 3.26 合成视频面板（第 52 轮重构）

- 源信息列出容器、分辨率、帧率、色彩空间、HDR 类型（HDR10/HDR10+/Dolby Vision/HLG）和音轨格式（AAC/DTS/TrueHD/E-AC-3 等）。
- 移除分辨率/帧率转换；视频码率通过滑块 + 数值输入自定义（Mbps）。
- 输出默认沿用源视频容器（MP4/MOV/MKV）；音频可选重编码 AAC 或直接复制音频流。
- HDR 源自动提示并切到 HEVC；可勾选「转 SDR」输出 BT.709，不勾选保留 10-bit HDR 标记。
- 截图：`out/ui-audit/round52/02-hdr-composition-checkbox.png`。
- 已知限制：WebM 源暂不直接输出 WebM；音频复制是否成功取决于目标容器是否支持源音频编码。

### 3.25 SVG 图标体系（第 44 轮新增）

- UI 图标全部切换为 SVG mask，删除 `src/assets/icons/*.png`（49 个旧 PNG）。
- 新图标集 69 个原始 SVG 全部落入 `src/assets/icons/`，52 个 `#i-*` 语义名使用 SVG 别名。
- 渲染链路：`<use href="#i-*">` → CSS `mask-image: url(icons/*.svg)`；颜色继续跟随 `currentColor`。
- 52 个内联 `<symbol>` 的路径也已替换为新 SVG 内容，避免旧图标路径残留。
- 打包验证：`app.asar` 内 `subx://app/assets/icons/play.svg` 可加载，桌面 smoke 394 条 PASS。
- 截图：`out/ui-audit/round44/01-svg-icons.png`、`round44/02-packaged-svg-icons.png`；52 个语义图标画廊见 `round45/01-icon-gallery.png`，69 个原始 SVG 总览见 `round46/01-icon-library.png`；菜单/关于/快捷键复核见 `round47/01-file-menu.png`、`02-edit-menu.png`、`03-export-menu.png`、`04-about-dialog.png`、`05-shortcuts.png`。
- 规范：`src/assets/icons/README.md`；品牌字标/应用图标不属于 UI 图标集。

### 3.24 辅助功能可访问性（第 36 轮新增）

- 应用 ready 后显式开启 Chromium 可访问性（`app.setAccessibilitySupportEnabled(true)`，Linux 除外）。
- 验证：CUA 辅助功能树可读取字幕正文 `AXTextArea`、开始/结束时间 `AXTextField` 及其值。
- 目的：VoiceOver / Windows 辅助技术能读取渲染层控件，而不只窗口外壳。
- 已知限制：原生右键拼写菜单在 headless 自动化中仍不可稳定触发。

### 3.23 批量编辑（第 24 轮新增）

- 编辑菜单新增「批量编辑…」：多选后统一时长、整体平移、应用样式、修改共享字号。
- 字号修改会提示引用该样式的字幕总数；负向平移按最早起点钳制；一次撤销。
- 截图：`out/ui-audit/round24/01-batch-edit.png`。
- 已知限制：50 条大样本未单独压测；批量样式只改引用样式字段，不复制样式。

### 3.22 校对进度（第 22 轮新增）

- 时间轴顶部显示「已校对 n/m」，眼睛按钮切换「只看待校对」。
- 字幕编辑面板提供「标为已校对/待校对」；拆分异常标记也会计入进度。
- `reviewed` 写入工程 JSON，保存重开保留。
- 截图：`out/ui-audit/round22/01-review-progress.png`。
- 已知限制：筛选只影响时间轴可见块，不改变进度统计；批量标记尚未做。

### 3.21 拼写检查（第 21 轮新增）

- 项目设置新增「拼写检查」开关，默认开启；字幕正文与内联编辑器启用 Electron 原生 spellcheck（en-US）。
- 右键拼写错误显示系统建议，支持「添加到词典」；中文默认不检查。
- 截图：`out/ui-audit/round21/01-spellcheck-settings.png`。
- 已知限制：英文 20 条样例的自动化验收未做；词典语言目前固定 en-US，尚未做多语言选择。

### 3.20 5000 块时间轴性能（第 20 轮新增）

- 5000 条两轨、416KB 工程：滚动 p95 18.2ms（优化前 20.1ms，最大 40.2ms → 20.3ms），缩放 p95 17.6ms。
- 可见字幕节点 8–66，DOM 约 1.2k，JS 堆 6.8MB。
- 滚动监听改为 requestAnimationFrame 合并，避免同一帧重复 renderViewport。
- 截图：`out/ui-audit/round20/01-dense-timeline.png`。
- 已知限制：p95 仍略高于 16.7ms；后续可继续拆分标尺/波形绘制或做更细粒度虚拟化。

### 3.19 工程字体检查（第 19 轮新增）

- 项目设置新增「检查工程字体」：读取系统字体族，列出样式引用但缺失的字体与样式名。
- macOS 使用 `system_profiler SPFontsDataType -json`，Windows 读取字体注册表；结果在主进程缓存。
- 缺失字体提示预览会回退到系统字体，不阻止导出。
- 截图：`out/ui-audit/round19/01-font-check.png`。
- 已知限制：只检查字体族名；样式名/字重不匹配可能仍需人工确认。

### 3.18 批量导出与导出预设（第 18 轮新增）

- 导出对话框新增「导出全部可见轨道」：选择目标文件夹后每轨一个文件，自动处理重名。
- 新增导出预设：Windows（UTF-8 BOM + CRLF）、GB18030（CRLF）、网页（UTF-8 + LF）；仍可自定义编码/换行。
- 批量导出支持 SRT / ASS / VTT，单轨与合并导出不受影响。
- 截图：`out/ui-audit/round18/01-batch-export.png`。
- 已知限制：批量导出不生成 ZIP；目标文件夹需可写。

### 3.17 帧率转换（第 17 轮新增，第 52 轮移除）

- 该功能已按用户要求从编辑菜单、弹窗和代码中删除，避免与视频合成/时间码职责混淆。
- 历史截图：`out/ui-audit/round17/01-retime-dialog.png`。

### 3.16 时间码格式（第 16 轮新增）

- 项目设置新增「预览时间码」：非丢帧沿用应用既有 `HH:MM:SS.FF`、丢帧 `HH:MM:SS;FF`、毫秒 `HH:MM:SS.mmm`。
- 丢帧仅对 29.97 / 59.94 生效，其他帧率按非丢帧显示；选择随工程保存并校验。
- 截图：`out/ui-audit/round16/01-timecode-settings.png`。
- 已知限制：本轮只改预览时间码显示，字幕表单仍用毫秒；帧率比例缩放尚未实现。

### 3.15 编码、换行与 SSA v4（第 8 轮新增）

- 导出对话框新增编码（UTF-8 / UTF-8 BOM / UTF-16LE / GB18030）与换行（LF / CRLF）选择；单轨与合并导出都生效，状态栏显示非默认选项。
- 导入字幕自动识别 UTF-8、UTF-16 BOM、GB18030；截断的 UTF-16 会拒绝并提示另存为 UTF-8。
- SSA `[V4 Styles]` 可导入样式与事件；导出仍写 ASS v4+。
- 截图：`out/ui-audit/round8/01-export-encoding.png`。
- 已知限制：GB18030 导出依赖 iconv-lite；SSA v4 的 Alignment 等旧字段按原值保留，未做 ASS 语义重映射。

### 3.14 WebVTT 导入/导出（第 7 轮新增）

- 导入字幕支持 `.vtt`：解析 WEBVTT 头、cue 标识/设置行、`HH:MM:SS.mmm` 与 `MM:SS.mmm`；导入时去除 `<i>/<b>/<c>/<v>` 标签并解码常见实体。
- 导出对话框新增 WebVTT；合并上下轨也支持 VTT；SRT↔VTT 往返文本/时间一致。
- 截图：`out/ui-audit/round7/01-vtt-export.png`。
- 已知限制：暂不保留 VTT 的 cue 设置与内联样式；GBK/GB18030 导入与导出编码/换行选项仍待做。

### 3.13 文本工具（第 6 轮新增）

- 配置区新增「文本工具」标签：范围（当前轨道/选中字幕/全部轨道）、全部大写/小写、首字母/句首大写、去行尾空格、去首尾空格、合并多余空格。
- ASS 覆盖块默认不参与变换；批量操作一次撤销；有未应用草稿或内联编辑时拒绝执行。
- 截图：`out/ui-audit/round6/01-text-tools.png`。
- 已知限制：拼写检查尚未实现；中文大小写无变化属预期；首字母大写按 Unicode 字母处理，专有名词需人工复核。

### 3.12 质量检查（第 5 轮新增）

- 配置区新增「质量检查」标签：汇总 CPS、最短/最长时长、空正文、空行、行尾空格、同轨重叠、行尾标点；标签上显示问题数。
- 问题行包含类型徽标、可读原因、轨道与时间；点击定位到字幕并保持 QC 标签，便于连续校对。
- 阈值行可调语速上限、最短/最长秒数，随工程保存；批量修复提供去行尾空格、延长过短、拆分过长。所有修复跳过锁定轨道；延长跳过链接/绑定；拆分跳过 ASS/打轴/链接/绑定；去空格只跳过锁定轨道。
- 截图：`out/ui-audit/round5/01-qc-panel.png`；255px 窄检查器见 `out/ui-audit/round5/02-qc-narrow.png`。
- 已知限制：问题列表最多渲染 200 条；CPS 按去除空白后的字符数计算，不区分中英文；空正文会被标记，若是有意占位需手动忽略。

### 3.11 自动保存与崩溃恢复（第 3 轮新增）

- 启动时发现自动保存会弹出「恢复未保存的工程？」：显示保存时间与原文件名，提供「丢弃 / 恢复」。截图：`out/ui-audit/round3/01-recovery-dialog.png`。
- 恢复后工程标题显示「原文件名（恢复） ●」，状态栏提示「已恢复自动保存的工程，请另存为」；cue 表单草稿、样式草稿与内联编辑器草稿一并恢复。截图：`out/ui-audit/round3/04-inline-draft-recovered.png`。
- 自动保存写入 5 秒防抖，覆盖字幕编辑、草稿、内联编辑器、视频/空白视频切换与 J/K 打轴；保存、丢弃、切换工程时清理；撤销回到已保存状态会立即清理，避免留下已撤销的旧版本。恢复对话框默认聚焦「恢复」，减少误点「丢弃」。
- 性能：两轨 5000 条、425KB 工程实测 structuredClone 1.9ms + IPC/写盘 11ms，总计 12.9ms，低于 50ms 目标。
- 手工验证：编辑后 6.5 秒生成 autosave；SIGKILL 后重启恢复两类草稿；保存与退出丢弃后文件消失。
- 已知限制：恢复后没有原工程句柄，保存必须另存为；自动保存文件固定单槽（单窗口应用）。

## 4. 本轮已修复

| ID | 问题 | 修复 | 证据 |
| --- | --- | --- | --- |
| UX-01 | 空工作区无主行动入口 | 预览引导卡 + 时间轴空提示 + 4 个入口 | `index.html:123-137`、`workspace.mjs:539-560`、`workspace.css:168-182` |
| UX-02 | 待校对入口不可见 | 移入时间轴工具栏右侧，保留「待校对 N」文本 | `index.html:245`、`workspace.css:253-255` |
| UX-03 | 键盘焦点不可见 | 焦点环令牌 `#8ab4f8`；标尺/缩放条/轨道名/字幕块/菜单项补齐 | `workspace.css:84-92`、`285-287` |
| UX-04 | 缺失媒体无恢复入口 | 引导卡按 none/missing/error 切换文案与主按钮 | `workspace.mjs:539-560` |
| UX-05 | 状态栏无错误/成功区分 | `status(message, tone)` + 语义色点 + aria-atomic | `workspace.mjs:171-180`、`workspace.css:400-408` |
| UX-06 | 字幕块对比度不足 | 正文纯白、播放态白字 + 琥珀边框、隐藏轨 .55 | `workspace.css:304-334` |
| UX-07 | 选中态对比度低 | 白色外环 + z-index 2 | `workspace.css:318-319` |
| UX-08 | 样式预览被裁切 | 按容器宽度等比缩放 | `workspace.mjs:1956-2010` |
| UX-09 | 字幕编辑缺时长/语速/链接 | 新增元信息行与实时更新 | `index.html:216-221`、`workspace.mjs:1763-1800` |
| UX-10 | 标签栏键盘不可达 | roving tabindex + ←/→/Home/End | `workspace.mjs:1633-1645`、`1667-1681` |
| UX-11 | 滚动条样式缺失 | 全局细滚动条 | `workspace.css:44-49` |
| UX-12 | 框选矩形盖住轨道头 | z-index 4 → 2 | `workspace.css:346` |

第 2 轮新增（编辑工作流）：

| ID | 能力 | 实现 | 证据 |
| --- | --- | --- | --- |
| UX-13 | 整体平移缺失 | 编辑菜单 + 对话框 + `shiftTiming/clampShiftDelta` 纯函数 | `index.html` 编辑菜单、`workspace.mjs` 整体平移段、`core/project.mjs` |
| UX-14 | 查找替换缺失 | 编辑菜单 + 非模态浮层 + `core/text.mjs` | `index.html` find-panel、`workspace.mjs` 查找段、`core/text.mjs` |

回归：`npm test` 80/80 通过；`npm run test:desktop` 394 条 PASS（第 2 轮新增整体平移/查找替换的菜单与行为断言，见 `scripts/desktop-smoke/scenario.mjs`）。

## 5. 剩余问题清单

### P0（公测阻断）

| ID | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| UX-P0-01 | 禁用控件没有原因说明；锁定轨道后按钮直接 disabled，点击不到，状态栏提示永远不触发 | 用户不知道为什么不能操作 | tooltip 增加 disabled 原因；锁定轨道时在轨道头显示原因；批量禁用时提供“解锁”入口 |
| UX-P0-02 | 破坏性操作确认策略不一致：删除字幕/轨道/清空正文无确认，删除样式有确认 | 误操作只能靠撤销，公测用户可能不熟悉 | 统一为“可撤销操作不弹确认，但状态栏明确提示可撤销”；对不可撤销操作才确认 |
| UX-P0-03 | 无加载态/进度反馈（除合成视频） | 打开大工程、导入字幕、保存时像卡死 | 状态栏加载态 + 关键按钮 busy + 合成以外的长任务进度 |
| UX-P0-04 | 无视频时仍可进入全屏预览，得到黑屏 | 首次使用容易困惑 | 全屏按钮在无画面时禁用，或全屏内显示空态与“打开视频” |

### P1（公测必备）

| ID | 问题 | 建议 |
| --- | --- | --- |
| UX-P1-01 | 菜单/工具栏/检查器的焦点与 hover 状态仍有 4 种禁用透明度（.42/.5/.4/.45） | 统一 `--opacity-disabled:.45` |
| UX-P1-02 | 面板边框 `#333` 对 `#1a1a1a` 1.38:1，控件边框约 1.8:1 | 引入 `--border-subtle/strong/control`，输入框边框提到 3:1 |
| UX-P1-03 | 命中目标 <24px：新增样式 22px、分隔条 6px、缩放把柄 12px、复选框 15px | 伪元素扩大热区；图标按钮最小 24px |
| UX-P1-04 | 129 个硬编码色值、17 种 gap、9 种字号 | 按 `docs/PUBLIC-BETA-PLAN.md` 的令牌表迁移，加 stylelint 防回潮 |
| UX-P1-05 | 样式列表字体名截断，缺少“当前字幕使用哪个样式”的指示 | 字体名加 title/省略号；样式行显示引用数 |
| UX-P1-06 | 无拖放导入（视频/字幕/工程） | 预览区与时间轴支持 drop，给可接受类型提示 |
| UX-P1-07 | 字幕块只显示单行，多行正文在块内不可见 | hover tooltip 已显示全文；考虑块内两行或角标 |
| UX-P1-08 | 最近工程/导入检查/拆分预览的列表密度与滚动条不统一 | 统一列表行高、滚动条、空态 |
| UX-P1-09 | 关于/快捷键/导入文稿弹窗信息层级偏平 | 统一 dialog 标题、说明、操作区三段式 |
| UX-P1-10 | 深色主题缺少系统高对比度/减少透明度适配 | 支持 `prefers-contrast` 与 `forced-colors` 的最小降级 |

### P2（公测后）

- 快捷键自定义与冲突检测
- 主题/强调色配置（当前仅深色）
- 窗口布局持久化（面板宽度/时间轴高度已部分持久化）
- 最近工程清理与置顶
- 多语言 UI
- 通知中心/操作历史面板
- 拖放时间轴排序轨道

## 6. 设计令牌建议

本轮已加入：

```css
--focus-ring: #8ab4f8;
--accent-state: #2f6fbe;
--accent-text: #cfe6ff;
--danger: #ff8b80;
--warning: #e8b46b;
--success: #79cfba;
--cue-text: #ffffff;
--cue-playing: #ffb04a;
--scrollbar-thumb: #4a4a4a;
--appbar-h: 43px;
```

下一步建议补齐并全量替换：

```css
--surface-app:#101010; --surface-panel:#1a1a1a; --surface-heading:#202020;
--surface-inset:#141414; --surface-row:#1f1f1f; --surface-popup:#242424;
--surface-control:#292929; --surface-hover:#2f2f2f; --surface-active:#343434;
--border-subtle:#333333; --border-strong:#4a4d54; --border-control:#6a6a6a;
--text-body:#e2e2e2; --text-strong:#f2f4f7; --text-muted:#abafb6;
--text-subtle:#8f959d; --text-disabled:#7a7a7a;
--selection:#8ab4f8; --playhead:#ff3b30;
--opacity-disabled:.45;
--z-headings:3; --z-popover:30; --z-appbar:90; --z-tooltip:1000;
```

对比度实测（修复前 → 修复后）：

| 元素 | 修复前 | 修复后 |
| --- | --- | --- |
| 字幕正文 | 4.46:1 | 4.74:1（纯白） |
| 播放中字幕 | 3.02:1 | 4.74:1（白字 + 琥珀边框） |
| 隐藏轨道字幕 | ≈1.8:1 | ≈3.2:1（.55） |
| 选中字幕边框 | 1.34:1 | 白环 + 红框，双通道 |
| 菜单焦点 | 1.43:1 背景 | 2px #8ab4f8 焦点环 |
| 面板边框 | 1.38:1 | 待迁移到 --border-subtle/strong |
| 控件边框 | ≈1.8:1 | 待迁移到 #6a6a6a（3.22:1） |

## 7. 验收方式

- 截图回归：空态、工程态、字幕编辑、样式编辑器、缺失媒体、255px 检查器、1024×700 共 7 张基准图（`out/ui-audit/final/`）。
- 桌面 smoke：394 条 PASS；第 1 轮调整 4 条既有断言、新增 4 条覆盖；第 2 轮新增编辑菜单、整体平移、查找替换与 ⌘F；第 4 轮新增双语合并导出（含实际写文件与双行校验）；第 5 轮新增质量检查标签页；第 6 轮新增文本工具标签页；第 7 轮新增 WebVTT 导入/导出；第 8 轮新增编码/换行与 SSA v4。
- 单元测试：80/80（新增 `test/text.test.mjs` 7 条、`test/timing.test.mjs` 3 条、`test/merge.test.mjs` 9 条、`test/qc.test.mjs` 5 条、`test/text-tools.test.mjs` 4 条、`test/vtt.test.mjs` 3 条、`test/encoding.test.mjs` 3 条、`test/ssa.test.mjs` 1 条、`test/windows-association.test.mjs` 3 条、`test/timecode.test.mjs` 5 条、`test/fonts.test.mjs` 2 条、`test/review.test.mjs` 2 条、`test/batch-edit.test.mjs` 2 条）。
- 崩溃恢复手工验证：编辑后 6.5 秒生成 autosave；SIGKILL 主进程后重启弹出恢复对话框；恢复 cue 表单草稿与内联编辑器草稿；保存/退出丢弃后 autosave 消失。
- 桌面 smoke：394 条 PASS（含撤销/重做、保存、退出丢弃路径），exit 0。
- 后续每轮 UI 改动至少覆盖：空态、工程态、错误态、窄窗口四类截图，并跑一次桌面 smoke。
