import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * /video/walkthrough.mp4 was once referenced but never committed, and the SPA rewrite answered it with index.html, so
 * the player was dead while every other check passed. This pins the real file: an MP4, a sane size, matching captions.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "video");

describe("walkthrough video asset", () => {
  it("is a real MP4 (ftyp box), not an HTML fallback, and small enough to ship in the repo", () => {
    const file = join(dir, "walkthrough.mp4");
    const head = readFileSync(file).subarray(0, 12);
    expect(head.subarray(4, 8).toString("latin1")).toBe("ftyp");
    const bytes = statSync(file).size;
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(25_000_000);
  });

  it("has captions and a transcript beside it", () => {
    expect(readFileSync(join(dir, "captions.vtt"), "utf8").startsWith("WEBVTT")).toBe(true);
    expect(statSync(join(dir, "transcript.txt")).size).toBeGreaterThan(1000);
  });
});
