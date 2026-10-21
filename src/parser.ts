export type Tag = "You should know" | "Heads up";

export interface Note {
  learn: string;
  tag: Tag;
  title: string;
  body: string;
}

export type ParseResult =
  | { kind: "none" }
  | { kind: "note"; note: Note }
  | { kind: "invalid"; reason: string };

/**
 * Parse the side agent output: either `learn: none` or
 *   learn: <line>
 *   tag: <You should know | Heads up>
 *   **<title>**
 *   <markdown body>
 * Anything that does not fit is "invalid" (treated as a miss by the daemon).
 */
export function parseOutput(raw: string): ParseResult {
  const text = stripFences(raw).trim();
  if (!text) return { kind: "invalid", reason: "empty output" };

  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => /^\s*learn\s*:/i.test(l));
  if (first < 0) return { kind: "invalid", reason: "no learn: line" };
  const learn = lines[first].replace(/^\s*learn\s*:\s*/i, "").trim();
  if (/^none\.?$/i.test(learn)) return { kind: "none" };
  if (!learn) return { kind: "invalid", reason: "empty learn line" };

  let i = first + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const tagMatch = /^\s*tag\s*:\s*(.+?)\s*$/i.exec(lines[i] ?? "");
  if (!tagMatch) return { kind: "invalid", reason: "no tag: line" };
  const tag = normalizeTag(tagMatch[1]);
  if (!tag) return { kind: "invalid", reason: `unknown tag "${tagMatch[1]}"` };
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const titleMatch = /^\s*\*\*(.+?)\*\*\s*$/.exec(lines[i] ?? "");
  if (!titleMatch) return { kind: "invalid", reason: "no bold title line" };
  const title = titleMatch[1].trim();
  const body = lines.slice(i + 1).join("\n").trim();
  if (!body) return { kind: "invalid", reason: "empty explanation" };
  return { kind: "note", note: { learn, tag, title, body } };
}

function normalizeTag(value: string): Tag | null {
  const v = value.trim().toLowerCase().replace(/[*_`]/g, "");
  if (v === "you should know") return "You should know";
  if (v === "heads up") return "Heads up";
  return null;
}

function stripFences(s: string): string {
  const m = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(s);
  return m ? m[1] : s;
}
