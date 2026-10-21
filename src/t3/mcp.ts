// MCP client for the local T3 server (<origin>/mcp).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const NOTIFY_TOOL = "t3_thread_notify";

export interface NotifyArgs {
  threadId: string;
  summary: string;
  title?: string;
  body?: string;
  tag?: string;
  agent: string;
  clientRequestId: string;
}

export type NotifyResult =
  | { ok: true; notificationId?: string }
  | { ok: false; reason: "tool_missing" | "unauthorized" | "error"; detail: string };

export class T3Mcp {
  private client: Client | null = null;
  private origin: string;
  private token: string | undefined;
  constructor(origin: string, token?: string) {
    this.origin = origin;
    this.token = token;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(`${this.origin}/mcp`), {
      requestInit: this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined,
    });
    const client = new Client({ name: "t3-you-should-know", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async listToolNames(): Promise<string[]> {
    const c = await this.connect();
    return (await c.listTools()).tools.map((t) => t.name);
  }

  /** Call `t3_thread_notify`. Absence of the tool (T3 patch not landed) is reported, not thrown. */
  async notify(args: NotifyArgs): Promise<NotifyResult> {
    try {
      const names = await this.listToolNames();
      if (!names.includes(NOTIFY_TOOL)) {
        return { ok: false, reason: "tool_missing", detail: `${NOTIFY_TOOL} not offered by this T3 server` };
      }
      const c = await this.connect();
      const res: any = await c.callTool({ name: NOTIFY_TOOL, arguments: { ...args } });
      if (res.isError) {
        return { ok: false, reason: /unknown tool/i.test(JSON.stringify(res.content)) ? "tool_missing" : "error", detail: JSON.stringify(res.content) };
      }
      const id = res.structuredContent?.notificationId;
      return { ok: true, notificationId: typeof id === "string" ? id : undefined };
    } catch (e: any) {
      this.client = null;
      const msg = String(e?.message ?? e);
      const unauthorized = /401|unauthori[sz]ed|invalid_mcp_credential/i.test(msg);
      return { ok: false, reason: unauthorized ? "unauthorized" : "error", detail: msg };
    }
  }
}
