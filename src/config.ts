import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  userdataDir: string;
  backend: "claude-cli" | "anthropic" | "openrouter";
  model: string;
  /** Path of the `claude` binary for the claude-cli backend. */
  claudeBin: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  sink: "t3" | "macos" | "stdout";
  /** Bearer token for the T3 MCP endpoint (see README). */
  t3Token?: string;
  transcriptBudgetTokens: number;
  pollIntervalMs: number;
  /** Skip turns that added fewer than this many transcript items. */
  minNewItems: number;
  /** At most one note per thread per this many minutes. */
  minMinutesBetweenNotes: number;
  /** Analyse subagent child threads too (ids starting "thread:provider:"). Off by default. */
  includeSubagentThreads: boolean;
  language?: string;
  statePath: string;
}

export const CONFIG_PATH = join(homedir(), ".config", "t3-you-should-know", "config.json");

export function defaults(): Config {
  return {
    userdataDir: join(homedir(), ".t3", "userdata"),
    backend: "claude-cli",
    model: "claude-haiku-5-5",
    claudeBin: join(homedir(), ".local", "bin", "claude"),
    sink: "t3",
    transcriptBudgetTokens: 12000,
    pollIntervalMs: 3000,
    minNewItems: 4,
    minMinutesBetweenNotes: 10,
    includeSubagentThreads: false,
    statePath: join(homedir(), ".local", "state", "t3-you-should-know", "state.json"),
  };
}

export function loadConfig(path = CONFIG_PATH, env = process.env): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // no config file: defaults apply
  }
  const cfg = { ...defaults(), ...file };
  cfg.anthropicApiKey ??= env.ANTHROPIC_API_KEY;
  cfg.openrouterApiKey ??= env.OPENROUTER_API_KEY;
  cfg.t3Token ??= env.T3_YSK_TOKEN;
  return cfg;
}
