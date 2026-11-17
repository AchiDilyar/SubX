# SubX

面向 SRT 和 ASS 的桌面字幕编辑器。首发 macOS，后续支持 Windows。两端共用仅深色的工作区。

当前是 Qt Quick / C++ 开发环境验证阶段。入口程序打开一个深色窗口。产品范围和技术验收见 [首版规划](PLAN.md)。

## 本地构建

安装 CMake 3.21 或更新版本、Qt 6.8 或更新版本（含 Qt Quick），以及对应平台的 C++ 工具链。macOS 使用 Apple Clang，Windows 请选择与 Qt 安装包匹配的编译工具链。

将 `Qt6_DIR` 指向 Qt 安装目录下包含 `Qt6Config.cmake` 的目录，再运行：

```sh
cmake -S . -B build -DQt6_DIR="<Qt 安装目录>/lib/cmake/Qt6"
cmake --build build --config Debug
```

macOS 打开构建目录下的 `SubX.app`。Windows 运行构建目录下的 `SubX.exe`，多配置生成器通常将产物放在 `build/Debug`。

## 协作

- `main` 保持可构建。功能和修复通过独立分支与 PR 合入。
- 在 GitHub Issue 记录需求、实现边界和可复现的验收步骤。
- PR 说明实际验证过的平台和操作。涉及界面时附截图，涉及字幕格式时附可公开共享的复现样例。
