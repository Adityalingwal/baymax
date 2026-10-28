import { afterEach, describe, expect, it } from "vitest";
import { htmlPage, sendRoute } from "./plugs/research/fake-network";
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

afterEach(closeRuns);

const oneCited = {
  cardText: "Hermes runs a loop.",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};
const thin = { status: "sourcesThin", cardText: "Little found.", claims: [] };

const readEntries = (entries: { event: string }[]) =>
  entries.filter((entry) => entry.event === "toolCall");
const cardEntries = (entries: { event: string }[]) =>
  entries.filter((entry) => entry.event === "cardSources");

describe("runTask dev log hosts", () => {
  it("logs the asked host, the source id and the kept host of a read page", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer(oneCited),
      verdictReply(),
    ]);
    run.port.send(runTask());
    await run.ended();
    expect(readEntries(run.entries)).toEqual([
      expect.objectContaining({
        tool: "read",
        outcome: "ok",
        host: "example.test",
        sourceId: "s1",
        keptHost: "example.test",
      }),
    ]);
  });

  it("logs the rule of a refused read and calls no reader", async () => {
    const run = await startRun([
      toolUseReply([{ read: "https://api.exa.ai/contents" }]),
      workerAnswer(thin),
      workerAnswer(thin),
    ]);
    run.port.send(runTask());
    await run.ended();
    expect(readEntries(run.entries)).toEqual([
      expect.objectContaining({
        tool: "read",
        outcome: "refused",
        host: "api.exa.ai",
        rule: "blockedHost",
      }),
    ]);
    expect(run.contentsAsked).toEqual([]);
  });
});

describe("runTask dev log cardSources", () => {
  it("logs one cardSources with the ids and hosts of the card's sources", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }, { read: pageUrl("two") }]),
      workerAnswer(),
      verdictReply(),
    ]);
    run.port.send(runTask());
    await run.ended();
    expect(cardEntries(run.entries)).toEqual([
      {
        event: "cardSources",
        taskId: "task-1",
        sourceIds: "s1,s2",
        hosts: "example.test,example.test",
      },
    ]);
  });

  it("logs an empty cardSources when the findings have no sources", async () => {
    const run = await startRun([workerAnswer(thin), workerAnswer(thin)]);
    run.port.send(runTask());
    await run.ended();
    expect(run.events[run.events.length - 1]).toMatchObject({
      type: "incomplete",
    });
    expect(cardEntries(run.entries)).toEqual([
      { event: "cardSources", taskId: "task-1", sourceIds: "", hosts: "" },
    ]);
  });

  it("logs no cardSources for a cancelled run", async () => {
    const run = await startRun(["waitForAbort"]);
    run.port.send(runTask());
    await run.settle();
    run.port.send({ type: "cancel", taskId: "task-1" });
    await run.ended();
    expect(cardEntries(run.entries)).toEqual([]);
  });
});

describe("runTask dev log privacy", () => {
  it("logs null for a host that does not parse", async () => {
    const run = await startRun([
      toolUseReply([{ read: "not a url" }]),
      workerAnswer(thin),
      workerAnswer(thin),
    ]);
    run.port.send(runTask());
    await run.ended();
    expect(readEntries(run.entries)).toEqual([
      expect.objectContaining({ host: null, rule: "scheme" }),
    ]);
  });

  it("never logs a path or a query of a URL", async () => {
    const secret = "/secret-path?q=user+words";
    const run = await startRun(
      [
        toolUseReply([{ search: "hermes" }]),
        toolUseReply([
          { read: `${pageUrl("one")}?q=user+words` },
          { read: `https://api.exa.ai${secret}` },
          { read: `https://elsewhere.test${secret}` },
        ]),
        workerAnswer(oneCited),
        verdictReply(),
      ],
      [hits(`https://elsewhere.test${secret}`)],
    );
    run.network.route(
      "/one?q=user+words",
      sendRoute({
        headers: { "Content-Type": "text/html" },
        body: htmlPage(
          "Page one",
          `<p>${"Plain words to keep. ".repeat(20)}</p>`,
        ),
      }),
    );
    run.port.send(runTask());
    await run.ended();
    const logged = JSON.stringify(run.entries);
    expect(logged).toContain('"sourceId":"s1"');
    expect(logged).toContain("elsewhere.test");
    for (const leak of ["secret-path", "user", "words", "?q="]) {
      expect(logged).not.toContain(leak);
    }
  });
});
