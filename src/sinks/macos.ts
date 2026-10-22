import { execFile } from "node:child_process";
import type { Note } from "../parser.ts";
import type { DeliverResult, Sink } from "./index.ts";

/** Native notification via osascript, for testing before the T3 patch exists. */
export class MacosSink implements Sink {
  deliver(_threadId: string, threadTitle: string, note: Note, _clientRequestId: string): Promise<DeliverResult> {
    // Values go through argv, not through the script text, so quotes in model output cannot break out.
    const script =
      "on run argv\n display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)\nend run";
    return new Promise((resolve) => {
      execFile("osascript", ["-e", script, note.learn, note.tag, threadTitle], (err) => resolve({ delivered: !err }));
    });
  }
}
