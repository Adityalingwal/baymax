import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { askNew, counts, createHarness, findings } from "./harness";

function finishWith(h: Harness, taskId: string, urls: string[]): void {
  h.state.receive({
    type: "result",
    taskId,
    spokenLine: "Done.",
    findings: findings("Done.", urls),
  });
}

function threeTasks(): Harness {
  const h = createHarness();
  askNew(h, "hermes");
  finishWith(h, "t1", ["https://a.com/x", "javascript:alert(1)", "not a url"]);
  askNew(h, "rust");
  finishWith(h, "t2", ["https://b.com/y"]);
  askNew(h, "zig");
  return h;
}

const refusedRows = [
  { name: "another URL", taskId: "t1", url: "https://a.com/other" },
  { name: "another task's source", taskId: "t1", url: "https://b.com/y" },
  {
    name: "a listed javascript: URL",
    taskId: "t1",
    url: "javascript:alert(1)",
  },
  {
    name: "a listed string that does not parse",
    taskId: "t1",
    url: "not a url",
  },
  { name: "an unknown task", taskId: "t9", url: "https://a.com/x" },
  { name: "a task with no answer", taskId: "t3", url: "https://a.com/x" },
];

describe("open a source", () => {
  it("opens an exact read-source URL of the task and publishes nothing", () => {
    const h = threeTasks();
    const before = counts(h);
    h.state.openSource({ taskId: "t1", url: "https://a.com/x" });
    expect(h.opened).toEqual(["https://a.com/x"]);
    expect(counts(h)).toEqual(before);
  });

  it.each(refusedRows)("refuses $name and logs it", ({ taskId, url }) => {
    const h = threeTasks();
    const before = counts(h);
    const logs = h.logs.length;
    h.state.openSource({ taskId, url });
    expect(h.opened).toEqual([]);
    expect(counts(h)).toEqual(before);
    expect(h.logs.length).toBe(logs + 1);
  });

  it("keeps the allowlist when a published card is changed", () => {
    const h = threeTasks();
    h.state.displayState().tasks[0].answer?.sources.push({
      id: "s9",
      url: "https://unread.example",
      title: "unread",
    });
    h.state.openSource({ taskId: "t1", url: "https://unread.example" });
    expect(h.opened).toEqual([]);
  });

  it("logs a rejected open", async () => {
    const h = threeTasks();
    h.failOpen("no browser");
    h.state.openSource({ taskId: "t1", url: "https://a.com/x" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logs.at(-1)).toContain("no browser");
  });
});
