// Turns raw T3 turn items into a compact text transcript under a token budget.

export interface RawItem {
  type: string;
  status?: string;
  ordinal: number;
  payload: Record<string, any>;
}

export const CHARS_PER_TOKEN = 4;
const MAX_MESSAGE_CHARS = 4000;
const MAX_LINE_CHARS = 200;

/** One entry per kept item, or null when the item type is not part of the transcript. */
export function renderItem(item: RawItem): string | null {
  const p = item.payload;
  switch (item.type) {
    case "user_message":
      return text(p.text) ? `USER: ${clip(p.text, MAX_MESSAGE_CHARS)}` : null;
    case "assistant_message":
      return text(p.text) ? `ASSISTANT: ${clip(p.text, MAX_MESSAGE_CHARS)}` : null;
    case "command_execution":
      return `[command] ${oneLine(p.input)}${item.status && item.status !== "completed" ? ` (${item.status})` : ""}`;
    case "file_change":
      return `[file ${fileAction(p.diffStr)}] ${p.fileName ?? "?"}`;
    case "dynamic_tool":
      return `[tool] ${p.toolName ?? p.title ?? "?"} ${oneLine(JSON.stringify(p.input ?? {}), 100)}${
        item.status === "failed" ? " (failed)" : ""
      }`;
    case "web_search":
      return `[web search] ${oneLine((p.patterns ?? []).join(", "))}`;
    case "subagent":
      return `[subagent] ${oneLine(p.title ?? "")} (${item.status ?? "?"})`;
    case "error":
      return `[error] ${oneLine(p.title ?? p.failure?.message ?? "")}`;
    case "notification":
      return `[notification] ${oneLine(p.summary ?? "")}`;
    // reasoning, checkpoint, compaction, system_notice, run_interrupt_request: not useful here
    default:
      return null;
  }
}

/** Keep the newest items that fit the budget. Items must be sorted oldest first. */
export function buildTranscript(items: RawItem[], budgetTokens = 12000): string {
  const budget = budgetTokens * CHARS_PER_TOKEN;
  const kept: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const line = renderItem(items[i]);
    if (line === null) continue;
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.reverse().join("\n");
}

function text(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function clip(s: string, max: number): string {
  s = s.trim();
  return s.length <= max ? s : `${s.slice(0, max)}... [truncated]`;
}

function oneLine(s: unknown, max = MAX_LINE_CHARS): string {
  return clip(String(s ?? "").replace(/\s+/g, " "), max);
}

function fileAction(diffStr: unknown): string {
  if (typeof diffStr !== "string") return "change";
  try {
    const t = JSON.parse(diffStr)?.type;
    return typeof t === "string" ? t : "change";
  } catch {
    return "change";
  }
}
