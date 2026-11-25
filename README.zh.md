<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="Cataly character portrait: silver hair and a crimson halo">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>理解意图。读懂上下文。把工作做到底。</strong>
</p>

<p align="center">
  Cataly 是将目标落地、把工作做完的 AI 队友。告诉它你想达成什么，它会负责接下来的步骤，结合相关背景，持续推进，交付你可以核验的结果。
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=release&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="License: SUL 1.0 with a scoped MIT notice" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#从这里开始"><strong>从这里开始</strong></a> ·
  <a href="#工作方式"><strong>工作方式</strong></a> ·
  <a href="#文档"><strong>文档</strong></a> ·
  <a href="#参与贡献"><strong>参与贡献</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a><br>
  <a href="README.de.md">Deutsch</a> · <a href="README.it.md">Italiano</a> · <strong>中文</strong>
</p>

## 理念

追求的不只是遵循指令，更是作出合理判断：注意真正重要的事，串联细节，
处理工作，而不需要有人一步步管理。

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>对结果负责</h4>
      朝着目标推进，而不是逐项完成一份活动清单。
    </td>
    <td width="50%" valign="top">
      <h4>理解上下文</h4>
      兼顾对话、项目惯例、约束和用户的偏好。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>主动行动，审慎判断</h4>
      自行处理日常决策。遇到实质性的取舍，或缺少权限、需要用户判断时，再提出问题。
    </td>
    <td width="50%" valign="top">
      <h4>把工作做到底</h4>
      调查、实现、验证，并汇报实际发生的情况。有说服力的解释不能代替真正可用的结果。
    </td>
  </tr>
</table>

这就是 Cataly 构建时遵循的标准：有能力行动，有足够的细心去理解，并对结果负责。

## 工作方式

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works-light.svg">
  <img src="docs/how-it-works-light.svg" width="100%" alt="Workflow: a request arrives, the lead assigns it, a lane works and reports, and completion is checked before a result you can verify, with its evidence, comes back to you.">
</picture>

Cataly 将聊天工具中的对话连接到原生编程代理运行时和可跟踪的工作通道（lane）：

- 主会话直接处理小请求，为较长的任务提供任务说明、专用会话和明确的负责方。
- 工作日志、检查点和注册表让进度在重启后仍可查看。
- Discord 消息接收会将回复上下文和附件元数据带入工作。
- 与进程绑定的会话和审批记录保护向预期代理投递的过程。
- 完成检查可以核验具体信号，例如成功执行的命令、匹配的文件、
  已合并的拉取请求或已发布的版本。
- 可选的调度、监控器和监督机制在明确启用后支持持续工作。

实现派生自 [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)，
并以 [oh-my-pi](https://github.com/can1357/oh-my-pi) 为基础。它们的作者、许可证和源码来源
仍是本项目的一部分。

## 运行原则

Cataly 使用你提供的账号和权限工作。对外部系统产生影响的操作需要相应授权；
认为某项操作有帮助，并不意味着获得了权限。只启用你打算运行的会话、
监控器和服务。

验证有其边界。完成信号通过，只能证明该信号已满足，并不能保证每个结果。
报告应区分观察到的结果、尚存的不确定性和未执行的工作。

不要在公开补丁和报告中包含凭据、私人对话或账号数据。
遥测默认关闭。设置 `CATALY_TELEMETRY=1` 可主动开启；`DO_NOT_TRACK=1` 优先。

## 从这里开始

<table width="100%"><tr><td>

**Cataly 是一个新产品，而不是 omp-dori 的升级版**

此版本移除了所有 omp-dori 名称、herdr 和 hc 终端运行时以及 omp-ulw 覆盖层。
omp-dori 代码无法原地升级，但迁移由安装程序完成：它会把之前的 `~/.dori` 或
`~/.omp-dori` 目录中的配置、令牌和所有者资料导入新的安装目录（不会覆盖已有的
设置），然后在该目录中没有任何进程运行后删除该目录以及旧版本留下的链接和缓存
（[迁移方式](docs/releases.md#cataly-is-a-new-product-moving-from-omp-dori)）。

当前命令是 `cataly`、`cataly-harness` 和 `omp-cataly`（独立安装）。
新安装默认使用 `~/.cataly` 或 `~/.omp-cataly`。Cataly 在 macOS 和 Linux 上默认以 headless OMP 运行；
Tern 是可选的终端运行时。

</td></tr></table>

### 使用已发布的发行版

请遵循[已验证的当前发行版安装步骤](docs/releases.md#install-a-current-release)。
其中涵盖前提条件、校验和、安装、你自己的认证、显式启动，
以及选择启用的 Discord 监控器。不要用任意 `main` 安装器替代精确的发行版。

### 从源码开展工作

请先安装 git 和 Bun 1.4.4+（Linux 或 macOS），无需终端服务器；详情见
[源码版前提条件](docs/releases.md#current-source-bundle)。
Tern 是可选的终端运行时；详见 [Tern](docs/runtime.md#tern)。

请使用独立的检出目录，不要使用正在运行的安装或已冻结的用户发行版：

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" bash scripts/install-source.sh
```

源码安装器会准备与项目绑定的修改版 OMP 19.0.1；
`PATH` 中未经修改的 `omp` 不能替代它。side 模式默认使用 `~/.omp-cataly`，
保留自己的包装脚本和配置，不影响主安装 `~/.cataly`。
安装不会启动代理、聊天消息接收器或服务。

请阅读[源码安装指南](docs/releases.md#source-checkouts-for-maintainers)，
了解隔离、配置和显式启动方式。原生会话使用你自己的
提供商认证和使用额度。

<table width="100%"><tr><td>

**重要**

用户发行版的实现也支持隔离的 macOS arm64 headless 配置，但须由经过验证的发行清单
明确声明。这并不表示 macOS 发行版已经发布。Slack 和 Telegram 仍是源码版功能。

</td></tr></table>

## 文档

- [安装、支持、更新和回滚](docs/releases.md)
- [技能与操作规则](skills/cataly-mode/SKILL.md)
- [聊天工具设置](skills/cataly-mode/references/setup.md)
- [运行时适配器与会话契约](docs/runtime.md)
- [容器设置](docs/container.md)
- [调度与待办队列](docs/hourly-loop.md)
- [共享锁与通道优先级](docs/locks.md)
- [贡献指南](CONTRIBUTING.md)
- [变更日志](CHANGELOG.md)
- [许可证与源码署名](LICENSE) · [许可指南](LICENSING.md) · [修改副本声明](NOTICE)

## 参与贡献

请带上明确的目标、范围集中的修改，以及证明其有效的证据。
从[贡献指南](CONTRIBUTING.md)开始，查看
[现有议题](https://github.com/vntrevx/Cataly/issues)和
[拉取请求](https://github.com/vntrevx/Cataly/pulls)，并保留让这项修改成为必要的背景。

## 许可证

许可证依各组件的来源而定。dori-superagent 衍生材料保留
[Sustainable Use License 1.0](LICENSE)；既有 OMP 集成部分保留其
[MIT 许可证和版权声明](LICENSE.integration)。其他组件保持各自的条款。
MIT 声明并未将整个仓库改为 MIT 许可。[NOTICE](NOTICE) 记录导入的修订版本和
修改副本的署名与来源说明。
