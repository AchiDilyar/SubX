# SubX 公测候选说明（0.1.0-dev.1）

> 状态：**功能冻结，候选准备中，尚未发布**。本文用于汇总当前可用范围、验证证据、已知问题和发布前检查项。

## 1. 当前可用范围

- macOS（Apple Silicon）与 Windows x64 的 Electron 桌面应用
- SRT / ASS / WebVTT 导入、编辑、导出；SSA v4 样式导入
- 多轨时间轴：拖拽、裁剪、分割、框选、吸附、链接双语字幕
- 自动保存与崩溃恢复；撤销/重做与内存上限
- Chromium 可访问性开启，辅助技术可读取字幕正文与时间字段
- QC：CPS、时长、空行/空正文、行尾空格、重叠、标点；批量修复
- 文本工具：大小写、首字母/句首、空格清理；系统英文拼写检查
- 时间码：毫秒/非丢帧/丢帧；帧率比例转换（保持链接）
- 校对进度：已校对 n/m、只看待校对、标记已校对/待校对
- 批量编辑：多选统一时长/平移/样式/共享字号
- 导出：单轨、双语合并、全部可见轨道批量导出、编码/换行预设
- 字体检查：列出样式引用但系统缺失的字体
- 视频合成：内置 FFmpeg/FFprobe，H.264/HEVC，字幕烧录

## 2. 验证证据

| 项目 | 结果 |
| --- | --- |
| 单元测试 | 83/83 通过 |
| 桌面回归 | 396 条 PASS（macOS 本机） |
| macOS 打包 | npm run package 成功，打包后启动打开 demo 工程 |
| 发布包静态检查 | npm run release:check 通过：入口/asar/FFmpeg/字体图标/版本/签名；最新 asar b6fc389d… |
| 发布清单 | npm run release:manifest 生成 out/release-manifest.json（版本/commit/文件 SHA-256） |
| Windows CI | run 45312344996 双 job 成功；最新 RC run 45331832949 双 job 成功 |
| Windows 安装器 | Squirrel 安装包构建；内置 FFmpeg H.264 编码、HKCU .subx 关联、卸载清理检查通过 |
| 5000 块性能 | 滚动 p95 18.2ms、缩放 17.6ms、可见节点 8–66、堆 6.8MB |

## 3. 已知问题（发布前需确认）

用户向发布说明见 [RELEASE-NOTES.md](RELEASE-NOTES.md)；最终截图巡检见 [FINAL-UI-SWEEP.md](FINAL-UI-SWEEP.md)。

1. **Windows 真实桌面启动未验收**：CI 为无桌面会话，Squirrel 启动器立即返回 0；需 Windows 实机从开始菜单启动并检查窗口/字幕渲染。
2. **拼写检查样例验收未自动化**：已接入 Electron en-US 词典与右键建议，但“英文 20 条样例”尚未形成自动断言；词典语言暂固定 en-US。
3. **5000 块滚动 p95 18.2ms**：略高于 16.7ms 目标；当前记录为基线，未继续拆分标尺/波形绘制。
4. **时间码非丢帧显示**沿用应用既有 HH:MM:SS.FF；标准冒号格式未作为默认。
5. **SSA v4 样式字段**按原值保留，未做 SSA→ASS Alignment 语义重映射。
6. **窄宽度标签栏**仍可能截断标签文字，依赖溢出菜单。
7. **安装包签名/公证**未完成：macOS Developer ID/公证、Windows 证书签名需发布前配置。
8. **DMG/Windows 安装程序**未在本轮生成：按项目约定，需用户明确发起首版候选后执行。

## 4. 发布前检查清单

- [ ] Windows 实机安装/启动/合成/双击 .subx/卸载验收
- [ ] macOS DMG 挂载安装与 Gatekeeper/公证检查
- [ ] Windows 安装包签名与 SmartScreen 检查
- [ ] 双平台安装后核心流程回归（打开、编辑、保存、导出、合成）
- [ ] 已知问题清单与发布说明确认
- [ ] 安装包 SHA-256 与版本号核对
- [ ] GitHub Release 资产上传与下载复核

## 5. 构建与验证

```bash
npm ci
npm test
npm run test:desktop
npm run fetch:ffmpeg
npm run package
npm run release:check
npm run release:manifest
# Windows 安装程序（在 Windows 或 CI 执行）
npm run make -- --platform=win32 --arch=x64
```

macOS 本地验证只从 out/SubX-darwin-arm64/SubX.app 启动，不安装到「应用程序」；DMG 与 Windows 安装程序仅在用户明确发起首版候选后生成。

## 6. 支持范围

- macOS：Apple Silicon（Electron 45）
- Windows：x64（CI 构建/安装器检查；实机启动待复核）
- 工程格式：.subx v1；字幕：SRT / ASS / SSA v4 / WebVTT
