import { describe, expect, it } from "vitest";
import { parseOutput } from "../src/parser.ts";

const NOTE = `learn: The job writes to a dev database that production reads.
tag: Heads up
**Production reads from the dev database**
- The build reads **dev_db**.
- If the job stops, nothing alerts.`;

describe("parseOutput", () => {
  it("parses learn: none", () => {
    expect(parseOutput("learn: none")).toEqual({ kind: "none" });
    expect(parseOutput("  Learn: None.\n")).toEqual({ kind: "none" });
  });

  it("parses a full note", () => {
    const r = parseOutput(NOTE);
    expect(r.kind).toBe("note");
    if (r.kind !== "note") return;
    expect(r.note.tag).toBe("Heads up");
    expect(r.note.title).toBe("Production reads from the dev database");
    expect(r.note.learn).toMatch(/^The job writes/);
    expect(r.note.body).toContain("- If the job stops");
  });

  it("accepts a code fence and mixed-case tag", () => {
    const r = parseOutput("```\n" + NOTE.replace("Heads up", "you should know") + "\n```");
    expect(r.kind === "note" && r.note.tag).toBe("You should know");
  });

  it("rejects malformed output", () => {
    expect(parseOutput("").kind).toBe("invalid");
    expect(parseOutput("hello").kind).toBe("invalid");
    expect(parseOutput("learn: x.\ntag: Nope\n**T**\nbody").kind).toBe("invalid");
    expect(parseOutput("learn: x.\ntag: Heads up\nno bold title\nbody").kind).toBe("invalid");
    expect(parseOutput("learn: x.\ntag: Heads up\n**T**\n").kind).toBe("invalid");
  });

  it("rejects output longer than the T3 tool accepts", () => {
    const long = "x".repeat(600);
    expect(parseOutput(`learn: ${long}\ntag: Heads up\n**T**\nbody`)).toMatchObject({ kind: "invalid", reason: "learn line too long" });
    expect(parseOutput(`learn: L.\ntag: Heads up\n**${"t".repeat(201)}**\nbody`)).toMatchObject({ kind: "invalid", reason: "title too long" });
    expect(parseOutput(`learn: L.\ntag: Heads up\n**T**\n${"b".repeat(20_001)}`)).toMatchObject({ kind: "invalid", reason: "explanation too long" });
  });
});
