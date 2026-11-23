<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="SubX：多轨字幕编辑器">
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0--dev.1-f4a447?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-6b7280?style=flat-square">
  <img alt="electron" src="https://img.shields.io/badge/Electron-45-47848F?style=flat-square&logo=electron&logoColor=white">
  <img alt="node" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white">
</p>

<h1 align="center">SubX</h1>

<p align="center">
  面向字幕工作的桌面编辑器：在一条多轨时间轴上编排 SRT / ASS 字幕，实时预览，校对双语，并直接合成带字幕的视频。
</p>

<p align="center">
  <strong>0.1.0-dev</strong> · 开发预览版，尚未发布正式版本
</p>

<p align="center">
  <img src="./assets/readme/workspace.png" width="100%" alt="SubX 工作区：多轨字幕时间轴、视频预览与样式管理">
</p>

## 功能

- **多轨时间轴**：拖拽、裁剪、分割、框选与吸附，同一条轨道内的重叠字幕也能清楚区分。
- **SRT / ASS**：导入、编辑、导出；ASS 样式与内联标签尽量保持原样。
- **实时预览**：基于 libass 的字幕渲染，编辑样式时即时查看效果。
- **双语校对**：上下轨链接、待校对标记与快速定位。
- **样式管理**：项目内样式名称唯一，支持字体、颜色、描边、阴影、对齐等字段。
- **视频合成**：把字幕烧录进视频，内置 FFmpeg / FFprobe 的下载与打包支持。
- **桌面体验**：macOS / Windows，深色界面，工程保存为 `.subx` 文件。

## 快速开始

需要 Node.js 22.13 或更高版本。

```bash
git clone https://github.com/AchiDilyar/SubX.git
cd SubX
npm install
npm start
```

首次合成视频前，下载内置的 FFmpeg / FFprobe：

```bash
npm run fetch:ffmpeg
```

打包应用：

```bash
npm run package   # 输出到 out/
npm run make -- --platform=win32 --arch=x64   # Windows 安装程序
```

## 开发

```bash
npm test              # 单元测试
npm run test:desktop  # Electron 桌面回归
```

## 说明

- 项目仍在快速迭代，接口和工程格式可能变化。
- 预览优先使用本机字体；缺少字体时回退到内置的 Noto Sans SC。
- 字幕渲染基于 [@jellyfin/libass-wasm](https://github.com/jellyfin/libass-wasm)。

## 致谢

Electron · libass · FFmpeg
