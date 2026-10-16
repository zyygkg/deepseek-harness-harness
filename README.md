# deepseek harⁿess

<sub>aka **DSHSH** · a harness that harnesses your harness · harness 的 harness · 你的 harness 的 harness</sub>

```text
⚠️ 递归警告
本插件需要一个 harness 才能 harness harness。
如果你没有 harness，请先 harness 一个 harness。
若报错 harness not found，说明你的 harness 还不够 harness。
```

把用户原始要求交给免费网页版 DeepSeek 求解，再返回给 DSH agent 执行 —— **无需 API key**。
插件通过 BrowserSkill（bsk CLI + daemon）驱动本机已登录的浏览器，在 chat.deepseek.com 上完成
真实交互：生成提示词 → 填入并发送 → 等待流式回复完成 → 提取全文。

## 名字怎么读

没人问，但我要讲。

| 写法 | 读法 | 用在哪 |
| --- | --- | --- |
| `deepseek-harness-harness` | deepseek harness harness | npm 包名 / GitHub 仓库名（唯一合法形态：npm 与 GitHub 都不允许空格、撇号和上标） |
| **DSHSH** | 「迪-艾斯-艾尺-艾斯-艾尺」；熟人可直接读「嘶——」 | 聊天、issue 标题、日常称呼 |
| `deepseek harⁿess` | deepseek harness 的 n 次方 | 封面、群聊吹牛（Unicode 上标，包名里用不了） |
| `DSH²` | 「DSH 平方」 | 数学好的朋友 |
| `harness ⊃ harness ⊃ harness` | —— | 哲学讨论 |

> 顺带一提，**DSHSH** 也可以读成 **D**eep**S**eek **H**arness **SH**ell ——
> 给你本来就很强的 harness，再套一层 shell。反正怎么念都对。

## 工作流程

```
用户要求 ──► web_deepseek_solve(request) ──► 插件生成高质量提示词
                                              │  驱动浏览器发送到 chat.deepseek.com
                                              │  等待回复完成并提取全文
                                              ▼
                                       网页版 DeepSeek 的「解决方法」
                                              │
                                              ▼
                              DSH agent 拿到 answer 继续执行落实
```

- **输入只有一个参数**：`request` —— 用户原始要求（API 仅基于用户要求工作）。
- 提示词由插件内置模板自动生成（结构化的「问题分析 → 解决方案 → 注意事项 → 验证方法」输出要求），
  模板可在配置中覆盖（`promptTemplate`，占位符 `{request}`）。
- 返回 `{ request, prompt, answer, chatUrl, complete, stats }`，agent 读取 `answer` 后用其他工具执行。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `web_deepseek_solve` | `request`（必填）、`newChat`（可选） | 一次「发要求 → 取解答」的完整调用，同一时间只允许一个调用 |

## 依赖

本插件的唯一运行时依赖是 **BrowserSkill 的 bsk CLI + daemon**（通过 `node:child_process` 调用），
不需要 API key，也不依赖 browser-skill 的 DSH 插件包。

- **BrowserSkill 仓库（CLI + 浏览器扩展，必需）**：https://github.com/Tencent/BrowserSkill
  - CLI 一键安装脚本见该仓库 README，安装后位于 `~/.local/bin/bsk`（Windows：`%USERPROFILE%\.local\bin\bsk.exe`）
  - 浏览器需安装其扩展并与 daemon 连接（`bsk status` 的 `browsers` 列表能看到实例）
  - 可选的 DSH 工具插件（与本插件无关，仅当同时想把 browser_* 工具暴露给模型时安装）：
    npm 包 **`@wxg-prc-cpg/browser-skill-dsh-plugin`**
- 浏览器已登录 chat.deepseek.com（登录一次后状态保留；未登录时工具会返回明确错误）
- 主机能访问 chat.deepseek.com

## 安装前检查清单（逐项确认，避免「缺少依赖」类报错）

1. **bsk CLI 可用**：`bsk --version` 有输出。
2. **bsk daemon 运行中**：`bsk status --json` 返回 `pid`，且 `browsers` 列表有已连接的浏览器实例。
   - daemon 是前台常驻进程，必须持久运行：`bsk daemon start --foreground`
   - ⚠️ 在 DSH 的沙箱子进程里执行 `bsk daemon start`（后台化模式）会失败
     （Windows Job Object 禁止 breakaway，报 `拒绝访问 (os error 5)`）——请在**独立终端**
     运行，或注册登录计划任务（见下文），或保持插件 `autoStartDaemon: true`（由 DSH 主进程拉起；
     部分环境可能失败，失败时工具会给出明确提示）。
3. **浏览器已登录 chat.deepseek.com**：在 bsk 打开的浏览器窗口人工登录一次即可。
4. DSH 版本：已在 **0.2.0-rc.2（desktop profile）** 验证。插件手写标准 JSON Schema 注册工具，
   不依赖 `defineTool`（其 0.2.0-rc.2 的 schema 编译器不接受旧插件惯用的 `{type:'json'}` 写法），
   理论上兼容 0.1.5-rc.3+，但未逐一验证。

### Windows 下让 daemon 常驻（登录计划任务，重启机器后自动拉起）

```bat
:: 保存为 C:\bsk-tasks\start-daemon.bat（注意：不要放在 .bsk 这类点号开头的目录里，
:: schtasks 引用点目录中的文件会报 0x80070002）
"C:\Users\<用户名>\.local\bin\bsk.exe" daemon start --foreground >> C:\bsk-tasks\daemon.log 2>&1
```

```bat
schtasks /Create /TN "BSK Daemon" /TR "C:\bsk-tasks\start-daemon.bat" /SC ONLOGON /F
schtasks /Run /TN "BSK Daemon"
```

## 安装

### 方式 A：npm 包（发布后）

在 DeepSeek Harness 的插件管理中 `install_bundle`，目标填包名：

```
install_bundle target: deepseek-harness-harness
```

### 方式 B：本地目录 / GitHub clone

克隆仓库后，通过 DeepSeek Harness 的插件管理安装本地目录：

```
install_bundle 目标: file:D:/path/to/deepseek-harness-harness
```

> ⚠️ 安装是 pnpm 的**快照复制**：之后修改插件代码，必须同步覆盖
> `profiles/<profile>/node_modules/deepseek-harness-harness/` 中的副本，然后**重启 DeepSeek Harness 应用**
> 才会加载新代码（`set_bundle` 热应用不清 ESM 模块缓存）。
> 重复 `install_bundle` 同一目标会报 `ambiguous-install`：先 `remove_bundle` 再装。

### 2. 在 profile 的 cordis.patch.yml 中配置（所有字段都有默认值）

```yaml
- id: webdeepseek
  name: deepseek-harness-harness
  config:
    bskPath: 'C:\Users\<用户名>\.local\bin\bsk.exe'   # bsk CLI 绝对路径（推荐）
    deepseekUrl: 'https://chat.deepseek.com/'
    pollIntervalMs: 1500        # 完成检测轮询间隔
    stablePolls: 3              # 连续 N 次文本不变即判定回复完成
    timeoutMs: 600000           # 单次调用总超时（含等待网页回复）
    pageReadyTimeoutMs: 30000   # 等待输入框出现
    reuseSession: true          # 复用浏览器会话与网页对话上下文
    autoStartDaemon: true       # daemon 未运行时尝试自动启动
    deepThink: false            # 新对话时是否点开「深度思考」
    promptTemplate: '...'       # 覆盖内置提示词模板（{request} 占位符）
```

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `bskPath` | `bsk` | bsk CLI 路径（DSH 进程 PATH 不含 ~/.local/bin，建议写绝对路径） |
| `deepseekUrl` | `https://chat.deepseek.com/` | 网页版地址 |
| `promptTemplate` | 内置中文模板 | 提示词模板，`{request}` 替换为用户要求 |
| `pollIntervalMs` | `1500` | 完成检测轮询间隔（毫秒） |
| `stablePolls` | `3` | 回复文本连续不变 N 次判定完成 |
| `timeoutMs` | `600000` | 单次调用总超时（毫秒） |
| `pageReadyTimeoutMs` | `30000` | 导航后等待输入框出现（毫秒） |
| `daemonReadyTimeoutMs` | `10000` | 自动启动 daemon 后等待就绪（毫秒） |
| `deepThink` | `false` | 新对话时是否启用「深度思考」 |
| `reuseSession` | `true` | 复用浏览器会话；false 每次打开新对话 |
| `autoStartDaemon` | `true` | daemon 未运行时尝试自动启动 |

## 完成检测原理

发送后轮询页面 DOM：

1. 新回复出现（`.ds-assistant-message-main-content` 数量增加）；
2. 发送按钮不再是「停止」图标（生成中为停止方块，完成后为发送箭头）；
3. 回复文本长度连续 `stablePolls` 次轮询不变。

三个条件同时满足即判定完成，提取最后一条回复全文。超时兜底返回已生成的部分文本并标记 `complete: false`。

## 限制与说明

- 依赖网页版 UI 结构（`.ds-assistant-message-main-content` 等选择器），DeepSeek 改版后可能需要更新选择器（集中在 `PROBE_EXPR` 常量）。
- 单会话串行：共享同一浏览器会话与网页对话，同一时间只执行一个调用。
- 网页版偶发的验证码/风控需要人工在浏览器窗口处理（登录态、验证通过后重试即可）。
- bsk daemon 是前台常驻进程；建议用登录计划任务常驻（见上文），插件也会在 `autoStartDaemon: true` 时尝试自动拉起。

## GitHub 建库 / 发布注意事项

- `package.json` 已配好 `files`（lib、cordis.patch.yml、README.md）与 `dsh.bundle.patch`（指向 cordis.patch.yml），`npm pack --dry-run` 可预览发布内容；记得补 LICENSE（package.json 声明 MIT）。
- 发布 npm 时走 npmjs registry（`publishConfig.access` 建议显式声明）；无 scope 包名存在被抢注风险，可考虑 `@your-scope/deepseek-harness-harness`（DSH 的 `install_bundle` 对 scope 包名无限制，注意 cordis.patch.yml 里的 `name` 必须与发布包名一致）。
- 本插件 peer 依赖仅 `@deepseek-ai/schemastery`（optional）：任何安装环境都不会因缺 peer 而拒绝安装；`@deepseek-ai/dsh-tools`/`@deepseek-ai/cordis` 由 DSH 运行时提供，不要把它们写进 dependencies。
- 当前版本已在 DSH 0.2.0-rc.2 验证；若未来 DSH 升级导致激活失败，先看插件管理日志里的 `application: failed` 诊断（常见为 schema/模块缓存两类问题，处理方式见上文）。
