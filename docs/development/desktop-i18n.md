---
parent: Development
nav_order: 7
---

# Desktop interface language

The desktop application shows its interface in English or Simplified Chinese. The terminal stays English whatever `LANG`, `LC_ALL` or `LANGUAGE` says. The desktop runs Circle's core as its runtime and starts it with `CIRCLE_DESKTOP_RUNTIME_HOME`, and in Chinese with `LANG` and `LANGUAGE` in Chinese. Only there do the few messages the window shows as the core wrote them follow that language: `/hub`'s words (`src/hub_text.ts`), and the database-busy and missing-API-key errors (`desktopText` in `src/locale.ts`). Everything else the window says is its own `t('…')`.

The first start follows the system language: any Chinese system language gives Chinese, everything else English. Settings → appearance → language changes it (follow system, English, 简体中文). The choice is kept in the window's local storage. Menus, system dialogs and notifications follow the window: the renderer tells the main process its language.

Checks and the packaged-app tests run with a test profile, and then the window is English on any machine. `CIRCLE_WORKBENCH_LANGUAGE` (for example `en-US` or `zh-CN`) sets the language for a run.

## How a text is translated

`/hub` in the terminal uses the same idea in `src/hub_text.ts` (`hubText`). It reads `LANGUAGE`, then `LC_ALL`, then `LC_MESSAGES`, then `LANG`, and skips `C` and `POSIX`. The first other tag decides: one that starts with `zh` selects Simplified Chinese, and anything else stays English. The choice is read when the line is made. Commands, ids, paths and the server's own status words stay as they are. `/hub reconcile` prints a heading line, then the explanation.

English is the key. In the renderer (`apps/workbench/src`):

```ts
import { t, tn } from '../i18n';

t('allow once');
t('allow “{prefix}” commands', { prefix });
tn(count, '{n} file', '{n} files');
```

Each English text has its Chinese in one of the files under `apps/workbench/src/i18n/zh-CN/`, one per area of the source. The main process keeps its few words in `apps/desktop/src/native-text.ts`.

- Keep the text a string literal at the call. `apps/workbench/test/i18n.test.ts` scans the sources for `t('…')` and `tn(n, '…', '…')` and fails when one has no translation, when a translation loses a `{placeholder}`, or when two areas translate the same English differently.
- Translate interface words only. What the model, a tool, a file or a command says stays as it is, and so do tool names (`edit_file`), commands, model ids, paths, keys and code.
- A text shown only in the preview runtime (`runtime.mode !== 'live'`) may stay English; the preview is development tooling.
- English interface words stay short and lowercase, as in the terminal. Chinese ones are short too: no full stop after a label, full-width punctuation in sentences.
- Dates use the interface language (`dateLocale()`).

## Words

| English | 中文 |
|---|---|
| session | 会话 |
| workspace | 工作区 |
| folder | 文件夹 |
| model | 模型 |
| thinking, thinking depth | 思考，思考深度 |
| context | 上下文 |
| compact | 压缩 |
| approval, approve | 审批，批准 |
| allow, reject | 允许，拒绝 |
| manual / accept edits / plan / auto | 手动 / 自动接受编辑 / 计划 / 自动 |
| read-only | 只读 |
| request | 请求 |
| tool, tool call | 工具，工具调用 |
| command (shell) | 命令 |
| slash command, prompt command | 斜杠命令，提示命令 |
| skill | 技能 |
| hook | 钩子 |
| extension | 扩展 |
| MCP server | MCP 服务器 |
| job | 任务 |
| subagent, agent | 子代理，代理 |
| steering | 插话 |
| follow-up | 追加消息 |
| queue, queued | 队列，排队中 |
| fork, clone | 分叉，克隆 |
| branch, tree | 分支，会话树 |
| label (checkpoint) | 标签 |
| export, import, share | 导出，导入，分享 |
| trust, trusted | 信任，已信任 |
| settings | 设置 |
| theme | 主题 |
| connection, endpoint | 连接，端点 |
| API key | API 密钥 |
| secret | 密钥 |
| token | token |
| cost | 费用 |
| cache | 缓存 |
| diff, change | 差异，改动 |
| inspector | 检查器 |
| panel | 面板 |
| attach, attachment | 附加，附件 |
| draft | 草稿 |
| shortcut, key binding | 快捷键，按键绑定 |
| runtime | 运行时 |

The home composer calls a folder a project (项目). Its trust prompt uses the same word: 项目信任, 信任项目, 项目已信任. Opening a folder on disk says 文件夹. Other workspace words stay 工作区.

The sidebar's recent list is 最近. A row shows only the session title. Hovering or focusing it shows the folder, when there is one, then how long ago (刚刚, 分钟前, 小时前, 天前) and the full time. Choosing no project on the home composer is 不选择项目.
