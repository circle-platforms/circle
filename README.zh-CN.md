<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="Circle">
</p>

<h1 align="center">Circle</h1>

<p align="center">接你自己模型端点的编程助手，在终端里用，也可以用它自己的窗口。</p>

<p align="center">
  <a href="https://circle-platforms.github.io/circle/">文档</a> ·
  <a href="https://circle-platforms.github.io/circle/quickstart/">快速开始</a> ·
  <a href="https://circle-platforms.github.io/circle/known-issues/">已知问题</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="README.md">English</a>
</p>

---

Circle 在你指定的目录里读代码、改文件、跑命令。任何兼容 OpenAI 或 Anthropic 接口的服务或网关都能接。运行命令和改文件之前它会先问你，屏幕上一眼能看出它是在干活，还是在等你。终端里的 Circle 和桌面应用是同一个助手。

**Circle 还很早。** 没有操作系统级沙箱。把它用在重要的东西上之前，请先读[已知问题](https://circle-platforms.github.io/circle/known-issues/)和[安全使用](https://circle-platforms.github.io/circle/security/)。文档目前只有英文版。

## 安装

安装预编译版本。它自带 Node.js，不需要先装别的。

**macOS 和 Linux**（x64 或 arm64）：

```bash
curl -fsSL https://raw.githubusercontent.com/circle-platforms/circle/main/install.sh | bash
```

**Windows**（x64 或 arm64），在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/circle-platforms/circle/main/install.ps1 | iex
```

安装器会下载适合当前平台的最新 Release，验证 SHA-256，先启动一次确认能跑，再把 `circle` 加入 PATH。macOS 和 Linux 需要 `bash`、`curl`、`tar`，以及 `sha256sum` 或 `shasum`；Windows 需要 PowerShell 5.1 或更新版本。

安装后重新打开终端，再运行 `circle`；以后用 `circle update` 升级，用 `circle uninstall` 卸载（加 `--purge` 会同时删除数据文件夹）。详见[安装与升级](https://circle-platforms.github.io/circle/installation/)和[发布页面](https://github.com/circle-platforms/circle/releases)。

## 桌面应用

每个发布包里还有 Circle 的桌面应用：同一个助手，自己一个窗口，还有一个你和 Circle 共用的浏览器面板。窗口里有什么，见[桌面应用](https://circle-platforms.github.io/circle/desktop/)（英文）。它自带运行所需的全部文件，不使用 `circle` 命令。设置、密钥和会话放在它自己的数据目录里，和 `~/.circle` 分开。

| 系统 | 文件 |
|---|---|
| macOS，Apple 芯片 | `circle-desktop-<version>-darwin-arm64.dmg` |
| macOS，Intel | `circle-desktop-<version>-darwin-x64.dmg` |
| Windows x64 | `circle-desktop-<version>-windows-x64.msi` |
| Linux x64 | `circle-desktop-<version>-linux-x64.tar.gz` |

文件在[发布页面](https://github.com/circle-platforms/circle/releases)。它不是 Apple 或 Microsoft 签名的，第一次打开需要你确认。Windows 安装器把它装到 `C:\Program Files\Circle`，并加到开始菜单。Linux 上沙箱助手要先做一次需要 root 的设置。步骤见[安装与升级](https://circle-platforms.github.io/circle/installation/#the-desktop-application)。

macOS 和 Windows 上它可以自己更新：设置 → 关于 → 立即检查，然后更新并重启。Linux 上「立即检查」会打开发布页面，文件夹要自己替换。1.2.0 及更早的版本不会自己更新。

窗口第一次打开时跟随系统语言，可以是英文或简体中文。终端界面仍是英文。从源码运行见 [apps/desktop](apps/desktop/README.md)。

## 运行

```bash
cd ~/code/my-project
circle
```

第一次会让你填 base URL、key 和模型，然后确认信任这个目录。之后输入任务按 `enter` 即可。输入 `/` 看命令，输入 `?` 看快捷键。

```bash
circle "修好失败的测试"                   # 带着第一句话启动
circle -c                                # 接着这个目录里上一次的对话
circle -r                                # 从列表里挑一个对话
circle -p "总结 README.md"               # 一次提问，答案写到 stdout
git diff | circle -p "审一下这个改动"
```

Circle 工作时可以继续打字：`enter` 会插话给正在进行的回合。空输入框连按两次 `esc` 回到对话里更早的位置，`ctrl+l` 换模型，`ctrl+f` 在对话里查找。[CLI](https://circle-platforms.github.io/circle/cli/) 还有给脚本和编辑器用的 JSON 事件流和 RPC 模式。

终端界面使用对话卡片、状态灯，以及跟随终端颜色的 `auto` 主题。如果终端不能报告颜色，可用 `/themes dark` 或 `/themes light` 手动指定。各信号的含义和限制见[界面说明](https://circle-platforms.github.io/circle/interface/)。

## 浏览器、设备终端、变量和密钥

让 Circle 打开一个网页，比如你内网里某台设备的管理界面，它会像人一样用浏览器：读页面，移动指针去点击和输入，回答网页弹出的对话框。遇到证书警告，要你批准后才继续；下载、网页要的文件和登录框，它都会告诉你。终端里的浏览器是一个用全新空白配置启动的 Chrome、Edge 或 Chromium 窗口；桌面版里是你和 Circle 共用的浏览器面板，你随时可以接管。操作浏览器按站点审批，有些事始终由你决定：把文件交给网页、摄像头或位置等权限，以及用哪张客户端证书表明身份。

让 Circle 连接你管理的设备——交换机、路由器或服务器控制台——它会打开一个 SSH 或 Telnet 终端，像你使用 SecureCRT 那样操作它：读设备的回答，输入你批准的命令，按设备逐个审批，主机密钥由你确认信任，密码只以 `%NAME%` 秘密引用。终端界面里设备画面是一页你随时可以接管自己输入的页面；桌面版里是你和 Circle 共用的终端面板。`/terminals` 列出打开的控制台和你保存的会话。详见[设备终端](https://circle-platforms.github.io/circle/tools/#device-terminals)。

用 `/secrets NAME` 保存密码，桌面版在设置 → 变量里保存。模型在需要的地方写 `%NAME%`，浏览器里的输入框或其他任何工具都可以，它看不到真实值：工具运行时 Circle 才填入，返回的内容里再把它隐藏起来。`/variables NAME=value` 用同样的方式保存普通值。详见[浏览器](https://circle-platforms.github.io/circle/tools/#the-browser)和[按名字使用密钥](https://circle-platforms.github.io/circle/security/#secrets-by-name)。

## 了解更多

| | |
|---|---|
| [快速开始](https://circle-platforms.github.io/circle/quickstart/) | 安装、接模型、跑第一个任务 |
| [界面](https://circle-platforms.github.io/circle/interface/) | 灯、底色、边框各代表什么 |
| [安全使用](https://circle-platforms.github.io/circle/security/) | 问什么、拒什么、不保护什么 |
| [选择模型](https://circle-platforms.github.io/circle/models/) | 网关、切换、思考深度 |
| [浏览器](https://circle-platforms.github.io/circle/tools/#the-browser) | 你和 Circle 一起用的网页 |
| [设备终端](https://circle-platforms.github.io/circle/tools/#device-terminals) | 你和 Circle 一起操作的 SSH、Telnet 控制台 |
| [Skills](https://circle-platforms.github.io/circle/skills/)、[自定义命令](https://circle-platforms.github.io/circle/custom-commands/)、[MCP](https://circle-platforms.github.io/circle/mcp/)、[扩展](https://circle-platforms.github.io/circle/extensions/) | 让 Circle 适合你 |
| [桌面应用](https://circle-platforms.github.io/circle/desktop/) | 同一个助手，自己一个窗口 |
| [全部文档](https://circle-platforms.github.io/circle/) | 指南与参考 |

## 开发

Circle 用 TypeScript 编写，运行在 Node.js 24 或更新版本上。

```bash
git clone https://github.com/circle-platforms/circle
cd circle
npm ci
npm run check                                    # 类型检查、测试、构建
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/code/my-project
```

推送代码不会自动发布新版本：推送 `v*` 标签时发布流程才会运行。见[发布](https://circle-platforms.github.io/circle/development/releasing/)。

参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，编程助手见 [AGENTS.md](AGENTS.md)，结构见[架构](https://circle-platforms.github.io/circle/development/architecture/)。安全问题按 [SECURITY.md](SECURITY.md) 报告。参与者请遵守[行为准则](CODE_OF_CONDUCT.md)。

Circle 是三个仓库之一。[circle-hub](https://github.com/circle-platforms/circle-hub) 是 Circle 登录的团队 hub，[circle-packs](https://github.com/circle-platforms/circle-packs) 是装在 hub 上的技能包和产品线包。三者彼此的要求见[兼容矩阵](https://github.com/circle-platforms/circle-hub/blob/main/docs/compatibility.md)。

## 许可

Circle 以 [Apache License 2.0](LICENSE) 发布。[NOTICE](NOTICE) 写明著作权人，并保留商标：本开源许可仅授予代码与相关文档的使用权，未经明确书面许可，不授予任何使用 Circle、Circle Hub 或相关商标、Logo 及服务标识的权利。[docs/design/README.md](docs/design/README.md) 列出的架构与设计规范按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权，引用、借鉴须保留署名并注明原始出处链接。1.2.1 及之前的版本以 MIT 许可证发布。`src/data/` 里的模型目录含有来自 models.dev 的元数据，`src/prompts/` 里的许多提示词来自 OpenCode，各自适用自己的 MIT 许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。贡献按 [CONTRIBUTING.md](CONTRIBUTING.md#contributor-terms) 的贡献者条款接受。
