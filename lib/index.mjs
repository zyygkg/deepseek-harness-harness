// deepseek-harness-harness (DSHSH) — DeepSeek Harness plugin
// 把用户原始要求变成高质量提示词，通过 BrowserSkill (bsk CLI) 驱动浏览器发送到
// 免费网页版 DeepSeek（chat.deepseek.com），等待完整回复后把「解决方法」返回给
// agent，由 agent 继续执行。
import Schema from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";

export const name = "deepseek-harness-harness";
export const inject = ["tools"];

// ---------------------------------------------------------------------------
// 默认提示词模板：{request} 会被替换为用户的原始要求。
// 这就是「API 仅基于用户要求生成提示词」的核心——用户只给要求，提示词由插件生成。
// ---------------------------------------------------------------------------
export const DEFAULT_PROMPT_TEMPLATE = [
  "你是一名资深的问题解决专家，正在为一个自动化编码代理（DeepSeek Harness）工作。",
  "代理无法与你多轮对话，所以请一次性给出完整、自包含、可直接执行的解决方案。",
  "",
  "请按以下结构输出：",
  "1. 问题分析：用两三句话说明问题本质与目标；",
  "2. 解决方案：给出分步骤的完整方案；涉及代码、命令、配置、文案时，写出可直接使用的完整内容；",
  "3. 注意事项：依赖、环境、边界条件和常见坑；",
  "4. 验证方法：如何确认方案已经生效。",
  "",
  "规则：全部用中文输出，Markdown 格式；不要反问或要求澄清——信息不足时给出合理假设并注明。",
  "",
  "【用户要求】",
  "{request}",
].join("\n");

export const Config = Schema.object({
  bskPath: Schema.string()
    .default("bsk")
    .description("Path to the bsk CLI binary (defaults to resolving `bsk` from PATH)."),
  deepseekUrl: Schema.string()
    .default("https://chat.deepseek.com/")
    .description("Web DeepSeek chat URL the plugin drives."),
  promptTemplate: Schema.string()
    .default(DEFAULT_PROMPT_TEMPLATE)
    .description("Prompt template; the {request} placeholder is replaced with the user's raw requirement."),
  pollIntervalMs: Schema.number()
    .default(1500)
    .description("Interval between completion polls (milliseconds)."),
  stablePolls: Schema.number()
    .default(3)
    .description("Consecutive unchanged-text polls required to declare the reply finished."),
  timeoutMs: Schema.number()
    .default(600000)
    .description("Total per-call timeout including waiting for the web reply (milliseconds)."),
  pageReadyTimeoutMs: Schema.number()
    .default(30000)
    .description("How long to wait for the chat input to appear after navigation (milliseconds)."),
  daemonReadyTimeoutMs: Schema.number()
    .default(10000)
    .description("How long to wait for the bsk daemon after an automatic start attempt (milliseconds)."),
  deepThink: Schema.boolean()
    .default(false)
    .description("Enable the web DeepSeek '深度思考' (deep think) toggle for new chats."),
  reuseSession: Schema.boolean()
    .default(true)
    .description("Reuse one browser session (and web chat context) across calls; false opens a fresh chat per call."),
  autoStartDaemon: Schema.boolean()
    .default(true)
    .description("Attempt to start the bsk daemon automatically when it is not running."),
});

// ---------------------------------------------------------------------------
// bsk CLI runner
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BskError extends Error {
  constructor(message, detail = undefined) {
    super(message);
    this.name = "BskError";
    this.detail = detail;
  }
}

function runBsk(bskPath, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bskPath, [...args, "--json"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new BskError(`无法启动 bsk CLI（${bskPath}）`, String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      reject(new BskError(`bsk ${args[0]} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new BskError(`无法启动 bsk CLI（${bskPath}）`, String(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const body = stdout.trim();
      if (code === 0) {
        try {
          resolve(body ? JSON.parse(body) : { ok: true });
        } catch {
          resolve({ ok: true, raw: body });
        }
      } else {
        const message = stderr.trim() || body || `exit code ${code}`;
        reject(new BskError(`bsk ${args.join(" ")} 失败：${message.slice(0, 400)}`, { code, stdout, stderr }));
      }
    });
  });
}

async function ensureDaemon(state) {
  const { runner, config } = state;
  try {
    const status = await runner.run(["status"], { timeoutMs: 15000 });
    // bsk status --json reports { pid, ws_port, ... } when the daemon is alive.
    if (status && typeof status === "object" && typeof status.pid === "number") return;
    throw new BskError("daemon status reported not-ok");
  } catch {
    // daemon not running (or status unreachable) — fall through to auto start
  }
  if (!config.autoStartDaemon) {
    throw new BskError(
      "bsk daemon 未运行。请先执行 `bsk daemon start --foreground`（或在配置中打开 autoStartDaemon 后重试）。"
    );
  }
  let started;
  try {
    const child = spawn(config.bskPath, ["daemon", "start"], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    started = true;
  } catch {
    started = false;
  }
  if (started) {
    const deadline = Date.now() + config.daemonReadyTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const status = await runner.run(["status"], { timeoutMs: 15000 });
        if (status && typeof status === "object" && typeof status.pid === "number") return;
      } catch { /* keep waiting */ }
    }
  }
  throw new BskError(
    "bsk daemon 未运行且自动启动失败。请在独立终端运行 `bsk daemon start --foreground` 后重试。"
  );
}

// ---------------------------------------------------------------------------
// DeepSeek web driver
// ---------------------------------------------------------------------------
const PROBE_EXPR = `(() => {
  const mains = document.querySelectorAll(".ds-assistant-message-main-content");
  const last = mains[mains.length - 1];
  const circle = [...document.querySelectorAll("div[role=button]")].find((b) => /circle/.test(String(b.className)));
  const d = circle && circle.querySelector("svg path") ? circle.querySelector("svg path").getAttribute("d") || "" : "";
  const isStop = d.startsWith("M2 4.88") || d.startsWith("M2 3.68");
  return JSON.stringify({
    count: mains.length,
    len: last ? last.innerText.length : 0,
    text: last ? last.innerText : "",
    isStop,
    url: location.href,
    hasTextarea: !!document.querySelector("textarea")
  });
})()`;

function parseProbe(raw) {
  if (!raw) throw new BskError("页面探测返回为空");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BskError(`页面探测结果无法解析：${String(raw).slice(0, 200)}`);
  }
  return parsed;
}

async function ensureSession(state) {
  if (state.sessionId) {
    try {
      const out = await state.runner.run(["session", "list"], { timeoutMs: 20000 });
      const sessions = Array.isArray(out) ? out : [];
      const alive = sessions.some((s) => s?.session_id === state.sessionId);
      if (alive) return { sessionId: state.sessionId, fresh: false };
    } catch {
      // fall through to a fresh start
    }
    state.sessionId = undefined;
  }
  const out = await state.runner.run(
    ["session", "start"],
    { timeoutMs: 90000 }
  );
  const sessionId = out?.session_id;
  if (!sessionId || typeof sessionId !== "string") {
    throw new BskError(`bsk session start 未返回会话 ID：${JSON.stringify(out).slice(0, 300)}`);
  }
  state.sessionId = sessionId;
  return { sessionId, fresh: true };
}

async function navigateTo(state, url) {
  await state.runner.run(
    ["navigate", "--session", state.sessionId, url],
    { timeoutMs: 90000 }
  );
}

async function waitForChatReady(state) {
  const deadline = Date.now() + state.config.pageReadyTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const value = await state.runner.run(
        ["evaluate", "--session", state.sessionId, "JSON.stringify({ta: !!document.querySelector(\"textarea\"), needsLogin: !!document.querySelector(\"input[type=password]\") || /立即登录|马上登录|sign up|log in to continue/i.test(document.body.innerText.slice(0, 1200))})"],
        { timeoutMs: 20000 }
      );
      const probe = parseProbe(value?.value ?? value);
      if (probe.ta) return;
      if (probe.needsLogin) {
        throw new BskError(
          "网页版 DeepSeek 未登录。请在浏览器窗口中登录 chat.deepseek.com（登录一次后状态会保留），然后重试。"
        );
      }
    } catch (error) {
      if (error instanceof BskError && error.message.includes("未登录")) throw error;
      // transient probe failures keep retrying
    }
  }
  throw new BskError(`等待 chat.deepseek.com 输入框出现超时（${state.config.pageReadyTimeoutMs}ms）`);
}

async function ensureDeepThink(state, wantThink) {
  if (!wantThink) return;
  const expr = `(() => {
    const btn = [...document.querySelectorAll("div[role=button], button")].find((b) => /深度思考/.test(b.textContent || ""));
    if (!btn) return JSON.stringify({ clicked: false, found: false });
    const cls = String(btn.className);
    if (/active|selected|checked/i.test(cls) || btn.getAttribute("aria-pressed") === "true") {
      return JSON.stringify({ clicked: false, already: true });
    }
    btn.click();
    return JSON.stringify({ clicked: true, found: true });
  })()`;
  const value = await state.runner.run(
    ["evaluate", "--session", state.sessionId, expr],
    { timeoutMs: 20000 }
  );
  return parseProbe(value?.value ?? value);
}

async function sendPrompt(state, prompt) {
  const sid = state.sessionId;
  await state.runner.run(
    ["fill", "--value", prompt, "--session", sid, "--selector", "textarea"],
    { timeoutMs: 60000 }
  );
  await state.runner.run(["press", "--session", sid, "Enter"], { timeoutMs: 30000 });
}

async function probePage(state) {
  const value = await state.runner.run(
    ["evaluate", "--session", state.sessionId, PROBE_EXPR],
    { timeoutMs: 20000 }
  );
  return parseProbe(value?.value ?? value);
}

async function waitForAnswer(state, startCount) {
  const { config } = state;
  let stable = 0;
  let lastLen = -1;
  let lastText = "";
  let lastUrl = "";
  let polls = 0;
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);
    let probe;
    try {
      probe = await probePage(state);
    } catch (error) {
      continue; // transient probe failure — keep waiting
    }
    polls += 1;
    if (probe.url) lastUrl = probe.url;
    if (probe.count > startCount) {
      if (!probe.isStop && probe.len > 0 && probe.len === lastLen) {
        stable += 1;
        if (stable >= config.stablePolls) {
          lastText = probe.text;
          break;
        }
      } else {
        stable = 0;
      }
      lastLen = probe.len;
    }
  }
  if (!lastText) {
    // 超时兜底：拿一次当前已生成的文本，并明确标记为不完整。
    let partial = "";
    try {
      const probe = await probePage(state);
      partial = probe.text || "";
    } catch { /* keep partial empty */ }
    if (partial) {
      return { answer: partial, url: lastUrl, complete: false, polls };
    }
    throw new BskError(`等待网页版 DeepSeek 回复超时（${config.timeoutMs}ms）`);
  }
  return { answer: lastText, url: lastUrl, complete: true, polls };
}

async function clickNewChat(state) {
  const expr = `(() => {
    const btn = [...document.querySelectorAll("div[role=button], button")].find((b) => /开启新对话/.test(b.textContent || ""));
    if (btn) { btn.click(); return JSON.stringify({ clicked: true }); }
    return JSON.stringify({ clicked: false });
  })()`;
  const value = await state.runner.run(
    ["evaluate", "--session", state.sessionId, expr],
    { timeoutMs: 20000 }
  );
  return parseProbe(value?.value ?? value);
}

// ---------------------------------------------------------------------------
// 核心求解流程（串行互斥，因为共享同一个浏览器会话与网页对话）
// ---------------------------------------------------------------------------
function buildSolve(state) {
  return async function solve(args) {
    const request = String(args?.request ?? "").trim();
    if (!request) throw new Error("request 参数不能为空：请传入用户的原始要求。");
    const config = state.config;
    const startedAt = Date.now();

    // 1. 基于用户要求生成提示词（插件的核心职责）
    const prompt = String(config.promptTemplate).replace("{request}", request);

    // 2. 确保 daemon 与会话就绪
    await ensureDaemon(state);
    const { sessionId, fresh } = await ensureSession(state);
    if (fresh || !config.reuseSession) {
      // 新会话（或要求不复用）→ 打开 DeepSeek 首页，得到干净的输入环境
      await navigateTo(state, config.deepseekUrl);
      await waitForChatReady(state);
      await ensureDeepThink(state, config.deepThink);
    } else if (args?.newChat) {
      // 复用会话但要求新对话：点击侧边栏「开启新对话」
      await clickNewChat(state);
      await sleep(1500);
      await ensureDeepThink(state, config.deepThink);
    }

    // 3. 记录发送前的回复条数（用于识别本轮新回复）
    let startCount = 0;
    try {
      const before = await probePage(state);
      startCount = before.count;
    } catch {
      // 页面探测失败：以 0 兜底，等待逻辑仍然以「出现新回复」为准。
      startCount = 0;
    }

    // 4. 发送提示词
    await sendPrompt(state, prompt);

    // 5. 等待网页版 DeepSeek 生成完整解决方法
    const { answer, url, complete, polls } = await waitForAnswer(state, startCount);
    const elapsedMs = Date.now() - startedAt;

    return {
      request,
      prompt,
      answer,
      chatUrl: url,
      complete,
      stats: {
        sessionId,
        elapsedMs,
        polls,
        answerChars: answer.length,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const resolved = {
    bskPath: config.bskPath ?? "bsk",
    deepseekUrl: config.deepseekUrl ?? "https://chat.deepseek.com/",
    promptTemplate: config.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE,
    pollIntervalMs: config.pollIntervalMs ?? 1500,
    stablePolls: config.stablePolls ?? 3,
    timeoutMs: config.timeoutMs ?? 600000,
    pageReadyTimeoutMs: config.pageReadyTimeoutMs ?? 30000,
    daemonReadyTimeoutMs: config.daemonReadyTimeoutMs ?? 10000,
    deepThink: config.deepThink ?? false,
    reuseSession: config.reuseSession ?? true,
    autoStartDaemon: config.autoStartDaemon ?? true,
  };

  const state = {
    config: resolved,
    runner: {
      run: (args, opts) => runBsk(resolved.bskPath, args, opts),
    },
    sessionId: undefined,
    chain: Promise.resolve(),
  };
  const runExclusive = (operation) => {
    const next = state.chain.then(operation, operation);
    state.chain = next.catch(() => {});
    return next;
  };

  const solve = buildSolve(state);

  const definition = {
    name: "web_deepseek_solve",
    description: [
      "把用户的原始要求交给免费网页版 DeepSeek（chat.deepseek.com，无需 API key）生成高质量解决方案，",
      "然后返回给你执行。你只需传入用户要求本身（request 参数）；插件会自动基于要求生成提示词、",
      "驱动浏览器发送、等待完整回复，并返回网页版生成的解决方法。",
      "拿到 answer 后，请继续使用你的其他工具去执行落实该方案（写文件、跑命令等）。",
      "适用场景：需要强推理/分析/方案设计，或希望用网页版模型辅助思考时。",
      "注意：调用较慢（通常 30 秒到几分钟），且同一时间只能有一个调用在跑。",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "用户的原始要求（原文即可，不要改写；插件会基于它生成高质量提示词）。",
        },
        newChat: {
          type: "boolean",
          description: "是否开一个新对话（不复用网页端历史上下文）。默认 false，复用上次对话。",
        },
      },
      required: ["request"],
      additionalProperties: false,
    },
    output: {
      // annotation-only schema：允许任意 JSON 值（solve 返回的结构化结果）。
      schema: {},
      render(_args, value) {
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return [{ type: "text", text }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: resolved.timeoutMs + 30000,
    execute(args) {
      return runExclusive(() => solve(args));
    },
  };
  console.warn(`[${name}] registering tool with output.schema=`, JSON.stringify(definition.output.schema), "params.type=", definition.parameters.type);
  const unregisterTool = ctx.tools.register(definition);

  // 浏览器会话生命周期：插件卸载时关闭自己创建的会话。
  ctx.effect(() => {
    return () => {
      unregisterTool?.();
      if (state.sessionId) {
        runBsk(resolved.bskPath, ["session", "stop", state.sessionId], { timeoutMs: 30000 })
          .catch(() => {});
      }
    };
  });

  // 启动探测：仅记录诊断信息，不阻塞加载。
  runBsk(resolved.bskPath, ["status"], { timeoutMs: 10000 })
    .then(
      () => {},
      (error) => console.warn(`[${name}] bsk 探测失败（${error?.message ?? error}）；工具调用时将给出安装指引。`),
    );
}
