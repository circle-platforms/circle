<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="Circle">
</p>

<h1 align="center">Circle</h1>

<p align="center">接你自己模型端点的终端编程助手。</p>

<p align="center">
  <a href="https://qingshanfeihu.github.io/circle/">文档</a> ·
  <a href="https://qingshanfeihu.github.io/circle/quickstart/">快速开始</a> ·
  <a href="https://qingshanfeihu.github.io/circle/known-issues/">已知问题</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="README.md">English</a>
</p>

---

Circle 在你指定的目录里读代码、改文件、跑命令。任何兼容 OpenAI 或 Anthropic 接口的服务或网关都能接。运行命令和改文件之前它会先问你，屏幕上一眼能看出它是在干活，还是在等你。

**Circle 还很早。** 没有操作系统级沙箱。把它用在重要的东西上之前，请先读[已知问题](https://qingshanfeihu.github.io/circle/known-issues/)和[安全使用](https://qingshanfeihu.github.io/circle/security/)。文档目前只有英文版。

## 安装

安装预编译版本。它自带 Node.js，不需要先装别的。

**macOS 和 Linux**（x64 或 arm64）：

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

**Windows**（x64 或 arm64），在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

安装器会下载适合当前平台的最新 Release，验证 SHA-256，先启动一次确认能跑，再把 `circle` 加入 PATH。macOS 和 Linux 需要 `bash`、`curl`、`tar`，以及 `sha256sum` 或 `shasum`；Windows 需要 PowerShell 5.1 或更新版本。

安装后重新打开终端，再运行 `circle`；以后用 `circle update` 升级。详见[安装与升级](https://qingshanfeihu.github.io/circle/installation/)和[发布页面](https://github.com/qingshanfeihu/circle/releases)。

**从 Circle 0.5.0 或更早版本升级？** 那些版本是 Python 写的。运行上面的安装命令即可：它会卸载 Python 版，保留你的设置、密钥、技能和会话，再装上 1.0。旧版的 `circle update` 做不了这一步。Python 扩展需要重写，见[扩展](https://qingshanfeihu.github.io/circle/extensions/)。

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

Circle 工作时可以继续打字：`enter` 会插话给正在进行的回合。空输入框连按两次 `esc` 回到对话里更早的位置，`ctrl+l` 换模型，`ctrl+f` 在对话里查找。[CLI](https://qingshanfeihu.github.io/circle/cli/) 还有给脚本和编辑器用的 JSON 事件流和 RPC 模式。

终端界面使用对话卡片、状态灯，以及跟随终端颜色的 `auto` 主题。如果终端不能报告颜色，可用 `/themes dark` 或 `/themes light` 手动指定。各信号的含义和限制见[界面说明](https://qingshanfeihu.github.io/circle/interface/)。

## 浏览器、变量和密钥

让 Circle 打开一个网页，比如你内网里某台设备的管理界面，它会像人一样用浏览器：读页面，移动指针去点击和输入，回答网页弹出的对话框。遇到证书警告，要你批准后才继续；下载、网页要的文件和登录框，它都会告诉你。终端里的浏览器是一个用全新空白配置启动的 Chrome、Edge 或 Chromium 窗口；桌面版里是你和 Circle 共用的浏览器面板，你随时可以接管。操作浏览器按站点审批，有些事始终由你决定：把文件交给网页、摄像头或位置等权限，以及用哪张客户端证书表明身份。

用 `/secrets NAME` 保存密码，桌面版在设置 → 变量里保存。模型在需要的地方写 `%NAME%`，浏览器里的输入框或其他任何工具都可以，它看不到真实值：工具运行时 Circle 才填入，返回的内容里再把它隐藏起来。`/variables NAME=value` 用同样的方式保存普通值。详见[浏览器](https://qingshanfeihu.github.io/circle/tools/#the-browser)和[按名字使用密钥](https://qingshanfeihu.github.io/circle/security/#secrets-by-name)。

## 了解更多

| | |
|---|---|
| [快速开始](https://qingshanfeihu.github.io/circle/quickstart/) | 安装、接模型、跑第一个任务 |
| [界面](https://qingshanfeihu.github.io/circle/interface/) | 灯、底色、边框各代表什么 |
| [安全使用](https://qingshanfeihu.github.io/circle/security/) | 问什么、拒什么、不保护什么 |
| [选择模型](https://qingshanfeihu.github.io/circle/models/) | 网关、切换、思考深度 |
| [浏览器](https://qingshanfeihu.github.io/circle/tools/#the-browser) | 你和 Circle 一起用的网页 |
| [Skills](https://qingshanfeihu.github.io/circle/skills/)、[自定义命令](https://qingshanfeihu.github.io/circle/custom-commands/)、[MCP](https://qingshanfeihu.github.io/circle/mcp/)、[扩展](https://qingshanfeihu.github.io/circle/extensions/) | 让 Circle 适合你 |
| [全部文档](https://qingshanfeihu.github.io/circle/) | 指南与参考 |

## 开发

Circle 用 TypeScript 编写，运行在 Node.js 24 或更新版本上。0.5.0 及之前是 Python 写的，代码在 `v0.5.0` 标签。

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
npm ci
npm run check                                    # 类型检查、测试、构建
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/code/my-project
```

推送代码不会自动发布新版本：推送 `v*` 标签时发布流程才会运行。见[发布](https://qingshanfeihu.github.io/circle/development/releasing/)。

参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，编程助手见 [AGENTS.md](AGENTS.md)，结构见[架构](https://qingshanfeihu.github.io/circle/development/architecture/)。安全问题按 [SECURITY.md](SECURITY.md) 报告。参与者请遵守[行为准则](CODE_OF_CONDUCT.md)。

## 桌面版

Circle 也有桌面版：对话、会话历史、文件和改动、审批、后台任务、模型和扩展都在一个窗口里，还有一个你和 Circle 共用的浏览器面板。每个 Release 都附有 macOS、Windows 和 Linux 的桌面版，文件名是 `circle-desktop-<版本>-<系统>-<架构>`；第一次打开的方法见[安装](docs/installation.md#the-desktop-application)。从源码运行见 [apps/desktop](apps/desktop/README.md)：

```bash
npm ci
npm --prefix apps/workbench ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop run dev
```

桌面版在自己的原生进程里运行 Circle 的交互运行时，对话、工具、审批、提问、会话和 shell 命令都走 Circle 现有的核心。在应用里填 API URL、key 和模型即可连接。它的数据目录和 `~/.circle` 分开。

## 许可

Circle 以 [MIT 许可证](LICENSE)发布。`src/data/` 里的模型目录含有来自 models.dev 的元数据，`src/prompts/` 里的许多提示词来自 OpenCode，各自适用自己的 MIT 许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
