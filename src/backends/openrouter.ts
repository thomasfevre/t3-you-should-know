import type { Backend } from "./index.ts";

export class OpenRouterBackend implements Backend {
  private apiKey: string | undefined;
  private model: string;
  constructor(apiKey: string | undefined, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(system: string, user: string): Promise<string> {
    if (!this.apiKey) throw new Error("openrouter backend needs openrouterApiKey or OPENROUTER_API_KEY");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 800,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return String(json.choices?.[0]?.message?.content ?? "").trim();
  }
}
