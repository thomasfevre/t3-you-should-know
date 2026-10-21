import type { Config } from "../config.ts";
import { AnthropicBackend } from "./anthropic.ts";
import { ClaudeCliBackend } from "./claude-cli.ts";
import { OpenRouterBackend } from "./openrouter.ts";

export interface Backend {
  complete(system: string, user: string): Promise<string>;
}

export function makeBackend(cfg: Config): Backend {
  switch (cfg.backend) {
    case "claude-cli":
      return new ClaudeCliBackend(cfg.claudeBin, cfg.model);
    case "anthropic":
      return new AnthropicBackend(cfg.anthropicApiKey, cfg.model);
    case "openrouter":
      return new OpenRouterBackend(cfg.openrouterApiKey, cfg.model);
  }
}
