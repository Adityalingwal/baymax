import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../src/shared/ipc";
import {
  closePorts,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import { replyRoute, workRoute } from "./tasks/harness";
import { streamFront, wire } from "./wiring.harness";

const zone = process.env.TZ;

function asked() {
  const w = wire();
  w.send(ipcChannels.submitQuestion, { text: "what is 2 + 2?" });
  return w;
}

describe("the front call through the wiring", () => {
  it("starts one front call on the words and sends the engine nothing", () => {
    const w = asked();
    expect(w.port.sent).toEqual([]);
    expect(w.talkerCalls).toHaveLength(1);
    expect(JSON.stringify(w.talkerCalls[0].request.messages)).toContain(
      "what is 2 + 2?",
    );
  });

  it("speaks the line as it streams and adds it to the Chat list", async () => {
    const w = asked();
    await streamFront(w, replyRoute(), "It's 4.");
    await w.playNext();
    expect(w.spoken()).toEqual(["It's 4."]);
    expect(w.published.at(-1)?.chat.at(-1)?.text).toBe("It's 4.");
    w.advance(1500);
    expect(w.syntheses.map((call) => call.input)).toEqual(["It's 4."]);
  });

  it("says nothing while the front call is silent, then its line", async () => {
    const w = asked();
    w.advance(5000);
    expect(w.syntheses).toEqual([]);
    await streamFront(w, replyRoute(), "It's 4.");
    await w.playAll();
    expect(w.spoken()).toEqual(["It's 4."]);
  });
});

describe("the day the talker and the worker are told", () => {
  afterEach(() => {
    process.env.TZ = zone;
    vi.useRealTimers();
    closePorts();
  });

  it("is the same local day at 00:30 in India", async () => {
    process.env.TZ = "Asia/Kolkata";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T00:30:00+05:30"));
    const engine = startFakeEngine([unreachable], null);
    const w = wire({ port: engine.port, now: () => new Date() });
    w.send(ipcChannels.submitQuestion, { text: "will it rain?" });
    await streamFront(w, workRoute("the forecast"));
    await until("the worker's call", () => engine.requests.length > 0);
    const talkerTurn = String(
      w.talkerCalls[0].request.messages.at(-1)?.content,
    );
    expect(talkerTurn).toContain("date: Saturday, 2026-10-31\n");
    expect(String(engine.requests[0].messages[0].content)).toContain(
      "Today's date: 2026-10-31.",
    );
  });
});
