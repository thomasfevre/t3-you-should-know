import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "./index.ts";

/**
 * One-shot `claude -p`: uses the user's Claude subscription, no API key.
 * Flags keep it side-effect free: no tools, no settings/CLAUDE.md, no skills, no MCP,
 * no session file. It runs in an empty temp dir so no project history is touched either.
 */
export class ClaudeCliBackend implements Backend {
  private cwd = mkdtempSync(join(tmpdir(), "t3-ysk-"));

  private bin: string;
  private model: string;
  constructor(bin: string, model: string) {
    this.bin = bin;
    this.model = model;
  }

  complete(system: string, user: string): Promise<string> {
    const args = [
      "-p",
      "--model", this.model,
      "--no-session-persistence",
      "--tools", "",
      "--setting-sources", "",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--system-prompt", system,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`claude exited with ${code}: ${err.trim() || out.trim()}`));
      });
      child.stdin.end(user); // prompt on stdin: no argument length limit
    });
  }
}
