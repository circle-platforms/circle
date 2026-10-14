# Circle issues：两端修复与验收

2026-10-14。基线 main `992cc77`，Circle core 1.5.0；工作分支 `codex/issue-two-end-fixes`。
工作目录 `/Users/qingshanfeihu/.codex/worktrees/issue-two-end-fixes/circle`。原有未提交 checkout 未修改。复现与验收阶段没有提交或推送；验收完成后，用户授权更新 issue 和 PR。没有发版、安装到 Applications 或使用真实 Circle 数据。

## 环境与范围

- 本机：macOS arm64，测试驱动 Node 24.19.0、Electron 44.7.0；终端浏览器使用独立 Chrome profile。
- 桌面开发应用版本字段为 0.1.0，打包应用版本为 1.5.0；两者使用相同的本轮 Circle core。实际打包运行版本见 `network-native/packaged/receipt.json`。
- 全部使用临时 `CIRCLE_HOME`、`CIRCLE_WORKBENCH_DATA_DIR`、工作区、ScriptedModel、localhost HTTP/HTTPS/CONNECT。没有使用真实 Circle 数据、付费模型或 B/C/D/E 生产服务。
- 系统剪贴板验收只在 macOS 执行。原 pasteboard 的所有 items/types/Data 只留在 Swift 助手内存中，结束后逐项验证恢复；任何无法完整保留的类型都会使测试拒绝覆盖。
- 测试通过表示下述合成场景通过，不表示原报告的所有平台和现场原因都已重现。发布后另在一次性 Windows CI 验证了根检查、observer 与真实 per-machine MSI 正常更新，详见下文；Windows Terminal/IME/用户机器现场和 Linux 原生桌面仍未实测。

## 已实施的变化

1. EOF 越界读取成为正常工具结果，可按提示重试；两端检查下一模型请求及重启后的历史。
2. 复用 PR #61 的模型发现与预设来源实现，修复 Anthropic 完整分页和 Together 数组兼容；在线失败不退回假列表，基址、协议、认证与编辑的 model id 均检查实际请求。
3. CLI 与 desktop worker 共用启动网络初始化。保留默认 CA，合并附加信任，传递子进程 trust/proxy；显示实际来源和配置问题，搜索保留两个主机的分类诊断并脱敏。
4. 下载事件延迟不再返回普通 Loaded。新增两适配的真实坐标点击，使用当前截图的 CSS 坐标，一次审批、证书页保护、过期拒绝、明确不录制。额外审查补了 hover 后目标复核及主文档/frame/shadow 内部滚动的同步失效检查。
5. 桌面页面自关闭使用稳定 WebContents、幂等清理和状态推送；地址草稿区分初次绑定、标签/会话切换及迟到导航结果。
6. 两端完成计划隐藏并只通知一次；恢复/导入不重复通知，plan-exit 仍可审阅。Alt+P、方向键和 Esc 使用独立计划焦点。子代理活动取实际工具事件，审批等待优先。
7. 复用 PR #59，切回已经加载且等待审批的 runtime 只移动 active 指针。过期/错误会话回答拒绝；批准后检查真实文件与下一请求。
8. 桌面工作区和会话菜单支持归档/恢复等管理。归档使用专属元数据，保留文件和核心历史，重启可恢复。运行、审批和后台工作阻止归档及删除，批量归档整体拒绝；归档后不能改变原分支、标签或会话模式。
9. Windows 更新首先补独立观察器、阶段日志、身份核对、限定进程清理及失败上传。尚未确定 MSI 挂起根因，不能宣称 #45 已修复。
10. 图片及本地扩展集成验收复用已有实现。生产服务保持后续范围。

## 15 个未关闭 issue 的交付矩阵

“通过”仅针对本列说明的路径。TUI 的 SessionApp 测试检查真实 runtime 和副作用，绘制/终端硬件输入与真实 OS 输入分开标注。

| Issue | TUI | 桌面开发版 | 桌面打包版 | OS 与剩余限制 |
| --- | --- | --- | --- | --- |
| [#21 EOF](https://github.com/circle-platforms/circle/issues/21) | SessionApp offset 2/120/0、下一请求、持久历史通过 | 原生 worker 相同场景、重启历史通过 | 原生相同场景见 session-management receipt | macOS；Windows 未实测 |
| [#60 模型连接](https://github.com/circle-platforms/circle/issues/60) | setup 与 /login：两协议预设→编辑→真实 SDK；503/cycle 保留原配置通过 | 原生第 21 项选择/保存/真实 SDK、次页 503、取消后旧连接通过 | connection-issues receipt 单独记录 | 本地网关；原生表单 cursor-cycle 未单独驱动，共享探测和 TUI 已覆盖 |
| [#3 信任](https://github.com/circle-platforms/circle/issues/3) | CLI 真 TLS、双 CA/CONNECT、子进程继承通过 | 原生 Electron→worker→两个 CA 的实际 SDK/代理通过 | 原生相同 TLS 场景通过 | 不修改系统 trust；第三方程序须支持所用 trust 环境变量 |
| [#52 搜索](https://github.com/circle-platforms/circle/issues/52) | 真实失败工具结果到下一请求和持久历史通过 | 原生 worker 实际 websearch 两主机失败→下一 SDK 请求通过 | network-native receipt 单独记录 | 保留诊断的修复已验证；原用户截图无法确定底层现场原因 |
| [#51 非语义点击](https://github.com/circle-platforms/circle/issues/51) | 真实 Chrome 坐标/审批/副作用、frame/shadow、hover/scroll 保护通过 | Electron adapter 和原生动态 gateway 通过 | 原生动态 gateway 见 5 checks receipt | 跨域 frame 坐标拒绝；坐标不录制 |
| [#44 下载](https://github.com/circle-platforms/circle/issues/44) | 实际 CDP isDownload 和 1600ms 延迟事件：红→绿，保留/丢弃通过 | 原生下载/审批/清理通过 | 原生相同流程通过 | macOS 重排证明事件时序问题；原 Windows 现场仍待验 |
| [#54 自关闭](https://github.com/circle-platforms/circle/issues/54) | Chrome popup 自关闭、状态、随后导航、cookie 通过 | 原崩溃红→绿，原生 cleanup/状态/后续导航通过 | browser-live 自关闭回归通过 | macOS；其它 OS 待验 |
| [#55 地址](https://github.com/circle-platforms/circle/issues/55) | 独立 Chrome 导航、失败和标签恢复回归通过 | 标签/草稿回归，初次 state race 已修，原生失败→新/旧标签通过 | browser-live 与 desktop receipt 记录最终结果 | 迟到结果拒绝；第一轮包验收暴露初次绑定 race 后已重包 |
| [#5 计划](https://github.com/circle-platforms/circle/issues/5) | 完成、重开、恢复、真实 plan-exit、焦点/重映射通过 | 原生 Alt+P 真焦点、箭头/Esc、中文两主题、一条通知通过 | UI issues 6 checks 通过 | 忙碌时间精度保持；Windows Terminal 硬件按键未验 |
| [#22 子代理](https://github.com/circle-platforms/circle/issues/22) | tool-only 真实事件与审批等待优先通过 | 原生 child Bash/审批/文件/parent 下一请求通过 | 相同 UI issues 场景通过 | 文本是实际 activity，工具内容不翻译 |
| [#9 图片](https://github.com/circle-platforms/circle/issues/9) | 两次真实 osascript→SessionApp 粘贴、删 first、发送、恢复字节通过 | 实际 Meta+V 两图→删 first→网关 PNG→恢复通过 | 最终剪贴板独立 receipt 记录 | macOS 实际 OS；TUI 绘制 stub，不声称真实终端模拟；Windows/Linux 待验 |
| [#57 会话审批](https://github.com/circle-platforms/circle/issues/57) | 单 runtime 的拒绝切换/取消/恢复回归通过；无桌面同构工作区切换 | 原生侧栏往返、错误回答拒绝、批准文件和模型请求通过 | session-management 相同路径通过 | PR #59 复用；branch 的 busy 保护仍保留 |
| [#56 管理](https://github.com/circle-platforms/circle/issues/56) | 共享 CheckpointStore 历史保留/恢复验证；桌面元数据不影响 TUI | 菜单、批量忙碌拒绝、只读、恢复、删除、真重启通过 | session-management 9 checks 通过 | 原生 Finder 启动在测试 profile 中抑制；桥只接受已知 workspace id |
| [#45 Windows 更新](https://github.com/circle-platforms/circle/issues/45) | 隔离安装/升级失败/旧版本保留的根回归通过 | 本机 observer/#43 9/9；Windows CI 原生 observer 9/9 | 一次性 Windows CI 真实 MSI 1.5.0→1.5.1 六检查通过 | **原间歇性 MSI 挂起尚未复现或确定根因**；用户 Windows 实机与真正 hang 的 dump/thread 证据仍待验 |
| [#25 集成](https://github.com/circle-platforms/circle/issues/25) | 核心工具/审批/取消/历史/扩展回归通过 | live runtime 与本地 extension 原生检查通过 | live 22 checks、extensions 6 checks 通过 | B/C/D/E 生产服务继续后续 |

## 已关闭 13 项

[#7](https://github.com/circle-platforms/circle/issues/7)、[#11](https://github.com/circle-platforms/circle/issues/11)、[#13](https://github.com/circle-platforms/circle/issues/13)、[#14](https://github.com/circle-platforms/circle/issues/14)、[#15](https://github.com/circle-platforms/circle/issues/15)、[#16](https://github.com/circle-platforms/circle/issues/16)、[#17](https://github.com/circle-platforms/circle/issues/17)、[#18](https://github.com/circle-platforms/circle/issues/18)、[#23](https://github.com/circle-platforms/circle/issues/23)、[#37](https://github.com/circle-platforms/circle/issues/37)、[#43](https://github.com/circle-platforms/circle/issues/43)、[#53](https://github.com/circle-platforms/circle/issues/53)、[#58](https://github.com/circle-platforms/circle/issues/58) 已逐项核对，见 [closed-issues.md](closed-issues.md)。

#53 是拆分到 #54/#55；#58 是重复 #57，均不能以 closed 状态代替验证。#11/#13/#14/#15 等原 Windows 视觉、IME、性能现场仍无本轮 Windows 硬件证据。共享回归测试与本机原生结果按其实际范围记录。

## 最终执行记录

- 根 `npm run check`：**542 项，540 passed、0 failed、2 Windows-only skipped**，包括类型检查与 build。最后新增的 TUI 待审批 `/resume` 和 `/continue` 回归也已进入整套测试：拒绝切换仍保留同一审批，批准后检查文件字节与下一请求，再恢复旧会话。
- 桌面单元最初 **45/45**，CI 启动诊断补一项后本机全套 **46/46**；桌面 runtime/updater/browser-warning：**56/56**；Workbench：**38/38**。
- 最新开发版：browser lifecycle 四组通过；坐标 gateway **5 checks**；session-management/EOF **9 checks**；network-native **4 checks**；connection **3 checks**；UI **6 checks**；系统剪贴板 **6 checks**。其它开发基础 native/live/interface/extensions 检查也已运行，具体 scope 见各 receipt。
- 最终打包版：基础桌面 **11 checks**；live **22**；browser-live **22**；坐标 **5**；UI **6**；归档/EOF **9**；network **4**；connection **3**；interface **50 checks / 41 commands**；extensions **6**；真实系统剪贴板 **6**，全部通过。browser-page/lifecycle 两个自建 main 的开发 shell 在打包模式明确跳过，打包证明来自实际 browser-live 与坐标 gateway。
- Root/Workbench/Desktop 格式检查与 `git diff --check` 通过。打包生成 macOS app、DMG，完成 ad-hoc 签名与校验；既有 CJS import.meta、icon format 和 hdiutil deprecation 为非失败警告。

## 发布后的 Windows CI

修复测试子程序的 Windows file URL 导入，并在 observer native 调用中关闭 stdin、保留 Windows 启动环境和加入有界 trace 后，revision `38027513b892fbc45eb7c729cd42ea29c76c99e0` 的真实 Windows runner 通过：

- [Windows Check](https://github.com/circle-platforms/circle/actions/runs/38531942867/job/115745635347)：542 total、534 passed、0 failed、8 平台 skips，build 通过。
- [Windows desktop/MSI](https://github.com/circle-platforms/circle/actions/runs/38531942729/job/115745638770)：runtime 56 total、55 passed、1 macOS-only skip；observer/#43 9/9；打包、MSI 构建/校验、真实安装更新六检查通过。
- [Windows 构建包](https://github.com/circle-platforms/circle/actions/runs/38531942729/artifacts/11878578973)：最终 source build 的 x64 app/MSI，保持开发验收用途，未发布 release。

正常更新成功不证明原 #45 间歇故障已修复。成功 harness 清理了 scratch，因此没有 update-evidence artifact/dump 可下载；本次依赖已保存的 job 日志。真正停滞时仍须先留存 process/thread、app/MSI 与阶段证据。桌面手动交互、Windows Terminal/IME/字体/用户机器的下载和剪贴板验收继续由报告人执行。

## 证据索引

- [browser-issues.md](browser-issues.md)：红基线、CDP/Electron 适配与范围。
- [network-issues.md](network-issues.md)、`network-native/{development,packaged}/receipt.json`：网络源、握手、搜索诊断。
- [ui-issues.md](ui-issues.md)、`ui-issues/{development,packaged}/receipt.json`、`connection-issues/{development,packaged}/receipt.json`：计划/活动/连接原生路径。
- `session-management/{development,packaged}/receipt.json`：归档、真实副作用、EOF 和重启。
- [clipboard/README.md](clipboard/README.md)、`clipboard/{development,packaged}/receipt.json`：真实系统剪贴板与持久图片字节。
- [update-issues.md](update-issues.md)：Windows 诊断实现、8 项本机观察器测试和剩余原生证据。
- [review.md](review.md)：额外审阅复现的四项缺口与修复复核。
- `validation/`：完整检查、格式、打包日志；桌面 `apps/desktop/artifacts/` 保留原生截图与 receipts。
