import { describe, expect, it } from "vitest";
import { errorKey, errorSignature, normalizeError, StuckDetector } from "../src/stuck.js";

describe("normalizeError", () => {
  it("removes volatile noise", () => {
    const a = normalizeError(
      "\x1b[31mFAIL\x1b[0m src/a.test.ts (123 ms)\n2026-01-02T03:04:05.678Z Error at 0x7ffd1234 in /tmp/vitest-abc/x.js:10:5 pid 4242",
    );
    expect(a).not.toContain("\x1b");
    expect(a).not.toMatch(/123 ms|2026-01-02|0x7ffd|abc|:10:5|4242/);
    expect(a).toContain("FAIL src/a.test.ts");
  });
});

describe("errorSignature", () => {
  it("is equal for the same failure with different timings/paths/line numbers", () => {
    const a = "FAIL src/sum.test.ts > sum (5ms)\nAssertionError: expected 3 to be 4\n at src/sum.ts:10:3\nTests 1 failed | 4 passed\nDuration 1.23s";
    const b = "FAIL src/sum.test.ts > sum (7ms)\nAssertionError: expected 3 to be 4\n at src/sum.ts:12:9\nTests 1 failed | 4 passed\nDuration 2.01s";
    expect(errorSignature(a)).toBe(errorSignature(b));
  });

  it("differs for different failures", () => {
    expect(errorSignature("TypeError: x is not a function")).not.toBe(
      errorSignature("ReferenceError: y is not defined"),
    );
    expect(errorSignature("AssertionError: expected 3 to be 4")).not.toBe(
      errorSignature("AssertionError: expected 5 to be 4"),
    );
  });

  it("focuses on error lines and ignores progress noise", () => {
    const a = "compiling 1/10\ncompiling 2/10\nerror TS2322: Type 'string' is not assignable to type 'number'.";
    const b = "compiling 1/12\nerror TS2322: Type 'string' is not assignable to type 'number'.\ndone";
    expect(errorKey(a)).toBe(errorKey(b));
  });
});

describe("StuckDetector", () => {
  it("fires after N identical consecutive signatures", () => {
    const d = new StuckDetector(3);
    expect(d.record("a")).toBe(false);
    expect(d.record("a")).toBe(false);
    expect(d.record("a")).toBe(true);
  });

  it("does not fire when errors change", () => {
    const d = new StuckDetector(3);
    expect(d.record("a")).toBe(false);
    expect(d.record("b")).toBe(false);
    expect(d.record("a")).toBe(false);
    expect(d.record("a")).toBe(false);
    expect(d.record("a")).toBe(true);
  });

  it("can be seeded (resume) and reset (progress)", () => {
    const d = new StuckDetector(3, ["x", "x"]);
    expect(d.isStuck()).toBe(false);
    d.reset();
    expect(d.record("x")).toBe(false);
    expect(new StuckDetector(3, ["x", "x"]).record("x")).toBe(true);
  });
});
