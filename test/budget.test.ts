import { describe, it, expect } from "vitest";
import { callsToday, tryConsumeCall } from "../src/moderation/budget.js";
import { memCounters } from "./helpers.js";

const DAY1 = new Date("2026-10-20T10:00:00Z");
const DAY2 = new Date("2026-10-21T00:00:01Z");

describe("tryConsumeCall", () => {
  it("allows calls up to the daily limit, then refuses", async () => {
    const c = memCounters();
    expect(await tryConsumeCall(c, 2, DAY1)).toBe(true);
    expect(await tryConsumeCall(c, 2, DAY1)).toBe(true);
    expect(await tryConsumeCall(c, 2, DAY1)).toBe(false);
  });

  it("resets at UTC midnight", async () => {
    const c = memCounters();
    await tryConsumeCall(c, 1, DAY1);
    expect(await tryConsumeCall(c, 1, DAY1)).toBe(false);
    expect(await tryConsumeCall(c, 1, DAY2)).toBe(true);
  });

  it("treats 0 as unlimited", async () => {
    const c = memCounters();
    for (let i = 0; i < 50; i++) expect(await tryConsumeCall(c, 0, DAY1)).toBe(true);
    expect(await callsToday(c, DAY1)).toBe(50);
  });
});
