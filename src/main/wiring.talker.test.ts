import { describe, expect, it } from "vitest";
import { ipcChannels } from "../shared/ipc";
import { chat } from "./tasks/harness";
import { streamFront, wire } from "./wiring.harness";

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

  it("speaks the line as it streams and shows it on a chat card", async () => {
    const w = asked();
    await streamFront(w, chat(), "It's 4.");
    await w.playNext();
    expect(w.spoken()).toEqual(["It's 4."]);
    expect(w.card("t1")).toMatchObject({
      state: "done",
      answer: { cardText: "It's 4." },
    });
    w.advance(1500);
    expect(w.syntheses.map((call) => call.input)).toEqual(["It's 4."]);
  });

  it("says nothing while the front call is silent, then its line", async () => {
    const w = asked();
    w.advance(5000);
    expect(w.syntheses).toEqual([]);
    await streamFront(w, chat(), "It's 4.");
    await w.playAll();
    expect(w.spoken()).toEqual(["It's 4."]);
  });
});
