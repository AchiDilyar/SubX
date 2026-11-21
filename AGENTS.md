# SubX 项目开发指引

## 每轮使用 oil-dev-skills

在 SubX 中，每轮涉及开发的对话都必须使用 [oil-dev-skills](https://github.com/oil-oil/oil-dev-skills)。在开始工作前，根据本轮任务选择并读取对应的 `SKILL.md`，在对话中说明选用的 Skill，再按其流程执行。后续追问、需求调整、继续实施与验收也适用。如果一轮包含多个阶段，在进入下一阶段时读取对应的 Skill。

| 本轮任务 | 使用的 Skill |
| --- | --- |
| 梳理仓库、定位实现入口、追踪调用链 | `oil-explore` |
| 规划或实施功能、重构、已知原因的小修 | `oil-plan` |
| 需要将边界明确的工作委派给其他 Agent | `oil-delegate` |
| 审查代码变更及其验证结果 | `oil-code-review` |
| 排查原因未明的缺陷并修复 | `oil-bug-fix` |
| 维护项目规范、文档、测试分层、分支与工作树 | `oil-govern` |

优先从宿主的技能目录加载。本机的共享安装路径为 `~/.agents/skills/<skill-name>/SKILL.md`。遇到 Skill 缺失或辅助脚本无法运行时，说明具体原因，并按已安装的指引完成可执行的步骤。

## 项目入口

[PLAN.md](PLAN.md) 是 SubX 的开发主文档，包含产品范围、Electron 技术路线、Windows 和 macOS 的开发、发布及实机验收要求。

## 本地验证约定

- 打包验证只用 `npm run package` 产出仓库内 `out/SubX-darwin-arm64/SubX.app`，从 `out/` 直接启动；不安装到「应用程序」，不复制或改名成别的 `.app` 做测试。
- 一次只打开一个窗口或实例，验证完立即退出，并确认没有残留进程。
- DMG 与 Windows 安装程序由用户在首版候选前明确发起。细节见 PLAN.md「开发协作」一节。
