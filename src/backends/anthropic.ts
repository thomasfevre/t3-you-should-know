import type { Backend } from "./index.ts";

export class AnthropicBackend implements Backend {
  private apiKey: string | undefined;
  private model: string;
  constructor(apiKey: string | undefined, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(system: string, user: string): Promise<string> {
    if (!this.apiKey) throw new Error("anthropic backend needs anthropicApiKey or ANTHROPIC_API_KEY");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  }
}
