import { expect, it } from "vitest";
import { skipTurns } from "../src/backoff.ts";

it("follows 0,0,0,1,2,4,8,16 and caps at 16", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7].map(skipTurns)).toEqual([0, 0, 0, 1, 2, 4, 8, 16]);
  expect(skipTurns(8)).toBe(16);
  expect(skipTurns(100)).toBe(16);
});
