import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface T3Runtime {
  pid: number;
  host: string;
  port: number;
  origin: string;
}

/** Read `server-runtime.json` (written by the running T3 server). Null when the server is not running. */
export function readRuntime(userdataDir: string): T3Runtime | null {
  try {
    const r = JSON.parse(readFileSync(join(userdataDir, "server-runtime.json"), "utf8"));
    return { pid: r.pid, host: r.host, port: r.port, origin: r.origin };
  } catch {
    return null;
  }
}
