# omp-dori

一个 Dori，融合三个项目的理念：

1. [dori-superagent](https://github.com/sisyphuslabs/dori-superagent) — 通过聊天工具承接并负责各项任务，以证据协调工作。
2. [oh-my-pi](https://github.com/can1357/oh-my-pi) — 原生编程代理运行时与工具。
3. [omp-ulw](https://github.com/dbc-hbin/omp-ulw) — 严谨、以成果为导向的工作流。

omp-dori 是经修改的 OMP 移植版，可将聊天工具中的请求转为有明确负责方的编程代理工作通道（lane），并附上完成证据进行汇报。

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [中文](README.zh.md)

## 功能概览

- 为耗时较长的任务建立专属任务说明、代理会话和可跟踪的通道；小请求由主会话直接处理。
- 保持统一的对话出口：各通道向主会话汇报，由主会话在原请求的讨论串中回复。
- 投递前检查运行中代理的身份、输入栏和审批状态；会话忙碌或状态未知时，暂存消息或将其加入队列。
- 要求提供完成证据，并检查当前的完成信号，例如已合并的 PR、已发布的版本、成功执行的命令或符合条件的文件。
- 将工作日志、通道检查点和注册表保存在磁盘上，供 `dori boot` 在重启后检查。
- 保留经验和待办队列，提供可选的每小时调度，以及主机状态和任务停滞监控，以支持持续工作。

## 从请求到完成

```mermaid
flowchart TD
    request["通过聊天发送请求"] --> route{"是小任务吗？"}
    route -->|是| direct["Dori 直接处理"]
    route -->|否| lane["建立任务说明和专用工作通道"]
    direct --> verify{"结果和完成证据已验证？"}
    lane --> verify
    verify -->|是| report["在原讨论串中汇报结果"]
    verify -->|否| resolve["修正问题或询问用户"]
    resolve --> verify
```

## 受支持的预览版

**`v0.1.2` 是面向 Linux x64 + herdr + Discord 的 GitHub 预发行版。** Bun **1.4.4** 和原生 OMP **18.18.8** 是经过测试的基准，也是最低版本要求。更新的版本和其他 Linux 发行版并不自动视为已验证。

macOS 和 hc 有 CI 覆盖，源码中也保留了适配器，但不属于受支持的用户预览版实际运行环境。Slack 和 Telegram 仍是源码版功能。这一范围并不表示已开展独立的外部用户 beta 测试，也不表示所有提供商和使用界面都已完成验证。

## 入门

1. 将 git、Bun 1.4.4+、原生 OMP 18.18.8+ 和 herdr 加入 `PATH`。安装器会检查这些工具，但不会安装或升级它们。
2. 按照[已验证的精确版本安装步骤](docs/releases.md#install-the-exact-preview)，核验项目的正式仓库、标签和全部四个资源文件，再以明确的 `--version v0.1.2` 参数运行已下载的安装器。启动器位于 `~/.dori/bin/dori`；将 `~/.dori/bin` 加入 `PATH`。
3. 配置自己的 `~/.dori/config.json`，设置 `runtime: "herdr"`、工作区路径、带提供商标识的模型和聊天工具钩子。既有配置、认证信息、工作和会话均会保留。使用自己的 OMP 提供商账号和 Discord 机器人。
4. 按照[认证与手动启动](docs/releases.md#your-authentication-and-explicit-startup)，安装 herdr 的 OMP 集成，配置机器人的频道权限和 Message Content Intent，设置所有者及频道 ID，然后在 herdr 中启动 `omp --dori-role dori`，并说“Dori mode”。
5. 显式启用原生监控器以[接收 Discord 所有者消息](docs/releases.md#discord-owner-intake)。将令牌保存在自己拥有、权限为 0600 的文件中，且仅在监控器子进程内读取。等到 `INBOUND_READY` 后，再以所有者身份发送一条新消息。[在线状态](docs/releases.md#discord-online-presence)需要另行启用的独立监控器。

安装**不会启动任何东西**：代理、接收进程、监视进程、在线状态进程、服务、调度框架或推理请求均不会启动。恢复既有 Dori 会话时，可能会恢复其记录的监控器；全新安装不会创建监控器。

### 更新与回滚

使用 `dori update check --version v0.1.2`、`dori update install --version v0.1.2`、`dori update status` 和 `dori update rollback`。只要仍有正在运行的 Dori，即使处于空闲状态，激活也会暂缓；请安排停止运行后的维护时段。回滚需要经过验证且仍保留的上一版本。详见[更新选项与恢复](docs/releases.md#updates-and-rollback)。

### 与现有 Dori 并存的源码安装

维护者使用独立的普通检出目录，按[源码安装指南](docs/releases.md#source-checkouts-for-maintainers)运行 `scripts/install-source.sh`。side 模式使用独立的主目录、包装脚本和技能，不影响主 Dori 安装。用户发行版管理的主目录受到保护，防止源码安装写入。已安装的用户发行版请保持冻结，不作修改。

安装后的 `dori` 是聊天与通道管理 CLI。完整调度框架仍可通过 `dori harness <args>`，或在源码检出目录中通过 `bun src/cli.ts <args>` 使用。启动调度框架会创建真实会话和循环，并使用与技能侧相互独立的注册表和完成协议。维护者通过 [`dori upstream`](skills/dori-mode/references/scripts.md#staged-dori-updates)更新源码，与用户发行版更新分开处理。

## OMP session contract

主会话和当值会话使用 `omp --dori-role dori`；工作通道和内置审查器使用 `--dori-role lane`。Dori 扩展处理器按角色启用，普通 OMP 会话保持不变。角色会在会话恢复后保留，绑定进程的原生会话与审批记录会保护输入投递。原生目标及已记录的监控器运行意图通过会话状态持久保存；恢复所属的 Dori 会话时，会恢复其记录的监控器。用户发行版保留与清单绑定的 omp-ulw 固定版本及按角色限定的导入。源码版 primary 模式可全局加载 omp-ulw，而 side 模式将其限制在自己的包装脚本中。详见[运行时约定](docs/runtime.md)。

## 文档

- [发布、安装、支持、更新和回滚](docs/releases.md)
- [Dori 技能与操作规则](skills/dori-mode/SKILL.md) · [设置参考](skills/dori-mode/references/setup.md)
- [运行时适配器与会话约定](docs/runtime.md)
- [维护者容器构建指南](docs/container.md) · [每小时循环与待办队列](docs/hourly-loop.md)
- [贡献指南](CONTRIBUTING.md) · [变更日志](CHANGELOG.md) · [修改副本声明](NOTICE)

## 限制、隐私与许可证

Dori 使用你提供的账号和权限运行。对外部系统的操作仍需所有者授权；完成检查只证明配置的信号已满足，并不保证每项结果都正确。请仅启用你打算运行的会话和监控器。AI 会话消耗你自己的提供商配额。

可选遥测可通过 `DORI_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 关闭。公开报告中请勿包含凭据或私有会话、项目数据。

上游代码仍适用 [Sustainable Use License 1.0](LICENSE)：允许自身内部业务用途及非商业、个人用途，并附有分发和声明保留条件。既有 OMP 集成声明保留在 [LICENSE.omp-dori](LICENSE.omp-dori) 中；这并未将上游代码重新许可为 MIT。[NOTICE](NOTICE) 记录了修改副本和来源署名。omp-ulw 及其他第三方组件保留各自的许可证。
