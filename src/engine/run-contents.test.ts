import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentsFn } from "../providers/page-contents";
import {
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  verdictReply,
  workerAnswer,
} from "./run.harness";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRuns();
});

const oneCited = {
  cardText: "Hermes runs a loop [s1].",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};

const steps = () => [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }, { read: pageUrl("missing") }]),
  workerAnswer(oneCited),
  verdictReply(),
];

describe("runTask page reads in tests", () => {
  it("send every read to the fake Exa Contents and never to the real fetch", async () => {
    const realFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("a test reached the real network"));
    const run = await startRun(steps(), [hits(pageUrl("one"))]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    expect([...run.contentsAsked].sort()).toEqual(
      [pageUrl("missing"), pageUrl("one")].sort(),
    );
    expect(realFetch).not.toHaveBeenCalled();
  });
});

const exaText = "Exa read this page with its own crawler. ".repeat(8);

describe("runTask with Exa Contents", () => {
  it("gives the worker Exa's text and reads nothing itself", async () => {
    const contents: ContentsFn = async () => ({
      ok: true,
      title: "Hermes from Exa",
      text: exaText,
    });
    const run = await startRun(steps().slice(1), [], undefined, contents);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({
      type: "result",
      findings: {
        sources: [{ id: "s1", url: pageUrl("one"), title: "Hermes from Exa" }],
      },
    });
    const results = JSON.stringify(run.requests[1].messages[2].content);
    expect(results).toContain("Exa read this page with its own crawler.");
    expect(run.network.targets).toHaveLength(0);
  });
});
