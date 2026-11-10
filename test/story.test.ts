import { describe, expect, it } from "vitest";
import {
  parseStoryDoc,
  parseStoryGap,
  STORY_GAP_SCHEMA,
  storyGapCheckPrompt,
  storyUpdatePrompt,
  storyWritePrompt,
} from "../src/prompts.js";
import { extractAcceptanceSection, titleFromPrompt } from "../src/tasks.js";
import { makeTask } from "./helpers/fakes.js";

describe("titleFromPrompt", () => {
  it("takes the first line, truncated", () => {
    expect(titleFromPrompt("Add dark mode\nmore detail below")).toBe("Add dark mode");
    expect(titleFromPrompt("  spaced  \n")).toBe("spaced");
    const long = "x".repeat(100);
    const t = titleFromPrompt(long);
    expect(t.length).toBe(80);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("extractAcceptanceSection", () => {
  it("pulls bullets and numbered items from an Acceptance heading at any level", () => {
    expect(extractAcceptanceSection("## Acceptance criteria\n- a\n- b\n1. c\n")).toEqual(["a", "b", "c"]);
    expect(extractAcceptanceSection("### Acceptance\n- [ ] x\n- [x] y\n")).toEqual(["x", "y"]);
  });

  it("returns [] when there is no such section", () => {
    expect(extractAcceptanceSection("just some text")).toEqual([]);
  });

  it("stops at the next heading", () => {
    expect(extractAcceptanceSection("## Acceptance\n- a\n## Notes\n- not this\n")).toEqual(["a"]);
  });
});

describe("parseStoryDoc", () => {
  it("extracts title, body and acceptance from the analyst's expected shape", () => {
    const doc = ["# My Story", "", "Some context.", "More context.", "", "## Acceptance criteria", "- does X", "- does Y", ""].join("\n");
    expect(parseStoryDoc(doc)).toEqual({
      title: "My Story",
      description: "Some context.\nMore context.",
      acceptance: ["does X", "does Y"],
    });
  });

  it("tolerates a missing title or missing acceptance section", () => {
    expect(parseStoryDoc("Just a description, no heading.")).toEqual({
      description: "Just a description, no heading.",
      acceptance: [],
    });
    const titleOnly = parseStoryDoc("# Title only\n\nbody\n");
    expect(titleOnly.title).toBe("Title only");
    expect(titleOnly.acceptance).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const doc = "# T\r\n\r\nbody\r\n\r\n## Acceptance criteria\r\n- a\r\n";
    expect(parseStoryDoc(doc)).toEqual({ title: "T", description: "body", acceptance: ["a"] });
  });

  it("never throws on empty or malformed input", () => {
    expect(parseStoryDoc("")).toEqual({ description: "", acceptance: [] });
    expect(() => parseStoryDoc("####### too many hashes\nAcceptance")).not.toThrow();
  });
});

describe("story prompts", () => {
  const task = makeTask({ files: ["src/x.ts"] });
  const docPath = "docs/stories/t1.md";

  it("storyWritePrompt names the file and includes the ask and file hints", () => {
    const p = storyWritePrompt(task, "Make X faster", docPath);
    expect(p).toContain("Make X faster");
    expect(p).toContain(docPath);
    expect(p).toContain("src/x.ts");
    expect(p).toMatch(/does not exist yet/);
  });

  it("storyGapCheckPrompt includes the existing doc and the new ask, and asks for a verdict without editing", () => {
    const p = storyGapCheckPrompt("# Old\n\n## Acceptance criteria\n- a\n", "also needs b", docPath);
    expect(p).toContain("- a");
    expect(p).toContain("also needs b");
    expect(p).toMatch(/Do not edit the file/);
  });

  it("storyUpdatePrompt lists what's missing and tells the analyst to keep existing content", () => {
    const p = storyUpdatePrompt("# Old\n\n## Acceptance criteria\n- a\n", ["needs b", "needs c"], "ask", docPath);
    expect(p).toContain("- needs b");
    expect(p).toContain("- needs c");
    expect(p).toMatch(/Keep everything already in the file/);
  });
});

describe("STORY_GAP_SCHEMA / parseStoryGap", () => {
  it("has the expected shape", () => {
    expect(STORY_GAP_SCHEMA.required).toEqual(["covered", "missing"]);
    expect(STORY_GAP_SCHEMA.properties.covered.type).toBe("boolean");
  });

  it("accepts structured output or a JSON object embedded in text", () => {
    expect(parseStoryGap({ covered: true, missing: [] }, "")).toEqual({ covered: true, missing: [] });
    expect(parseStoryGap({ covered: false, missing: ["x"], summary: "s" }, "")).toEqual({
      covered: false,
      missing: ["x"],
      summary: "s",
    });
    expect(parseStoryGap(undefined, 'noise {"covered":true,"missing":["y"]} noise')).toEqual({
      covered: true,
      missing: ["y"],
    });
  });

  it("returns undefined for unusable input", () => {
    expect(parseStoryGap({ missing: [] }, "")).toBeUndefined();
    expect(parseStoryGap(undefined, "no json here")).toBeUndefined();
    expect(parseStoryGap(null, "")).toBeUndefined();
  });
});
