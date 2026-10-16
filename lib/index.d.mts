import type { Context } from "@deepseek-ai/cordis";

export declare const name: "deepseek-harness-harness";
export declare const inject: ["tools"];

export interface WebDeepseekConfig {
  bskPath?: string;
  deepseekUrl?: string;
  promptTemplate?: string;
  pollIntervalMs?: number;
  stablePolls?: number;
  timeoutMs?: number;
  pageReadyTimeoutMs?: number;
  daemonReadyTimeoutMs?: number;
  deepThink?: boolean;
  reuseSession?: boolean;
  autoStartDaemon?: boolean;
}

export interface WebDeepseekResult {
  request: string;
  prompt: string;
  answer: string;
  chatUrl: string;
  complete: boolean;
  stats: {
    sessionId: string;
    elapsedMs: number;
    polls: number;
    answerChars: number;
  };
}

export declare const Config: unknown;
export declare const DEFAULT_PROMPT_TEMPLATE: string;
export declare function apply(ctx: Context, config?: WebDeepseekConfig): void;
