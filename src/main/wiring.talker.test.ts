import { describe, expect, it } from "vitest";
import { ipcChannels } from "../shared/ipc";
import { intake } from "./tasks/harness";
import { wire } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function asked() {
  const w = wire({ talker: true });
  w.send(ipcChannels.submitQuestion, { text: "what is 2 + 2?" });
  return w;
}

describe("the talker through the wiring (L12, L16)", () => {
  it("starts the talker and the intake on the same words at once", () => {
    const w = asked();
    expect(w.port.sent.map((command) => command.type)).toEqual(["question"]);
    expect(w.talkerCalls).toHaveLength(1);
    expect(JSON.stringify(w.talkerCalls[0].request.messages)).toContain(
      "what is 2 + 2?",
    );
  });

  it("speaks the talker's line and shows it on a chat card", async () => {
    const w = asked();
    w.talkerCalls[0].onText("It's ");
    w.talkerCalls[0].onText("4.");
    w.talkerCalls[0].resolve({ ok: true, text: "It's 4." });
    await flush();
    await w.playNext();
    w.port.emit(intake("t1", { route: "chat", sayBack: "two plus two" }));
    expect(w.spoken()).toEqual(["It's 4."]);
    expect(w.card("t1")).toMatchObject({
      state: "done",
      answer: { cardText: "It's 4." },
    });
    w.advance(1500);
    expect(w.syntheses.map((call) => call.input)).toEqual(["It's 4."]);
  });

  it("says nothing while the talker is silent, then its reply", async () => {
    const w = asked();
    w.advance(5000);
    expect(w.syntheses).toEqual([]);
    w.talkerCalls[0].onText("It's 4.");
    w.talkerCalls[0].resolve({ ok: true, text: "It's 4." });
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["It's 4."]);
  });
});
