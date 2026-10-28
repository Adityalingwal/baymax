import { describe, expect, it } from "vitest";
import { failureLine } from "./lines";
import { askNew, createHarness, intake } from "./harness";
import type { Harness } from "./harness";

const chat = (taskId: string) =>
  intake(taskId, { route: "chat", sayBack: "thanks" });
const said = (text: string) => ({ kind: "said", text }) as const;
const answerOf = (text: string) => ({
  cardText: text,
  sources: [],
  openPoints: [],
});

type Row = { name: string; order: (h: Harness) => void };

const orders: Row[] = [
  {
    name: "the intake first, then the talker",
    order: (h) => {
      h.state.receive(chat("t1"));
      expect(h.card("t1")?.state).toBe("thinking");
      h.state.talkerReplied("t1", said("You're welcome!"));
    },
  },
  {
    name: "the talker first, then the intake",
    order: (h) => {
      h.state.talkerReplied("t1", said("You're welcome!"));
      expect(h.card("t1")?.state).toBe("thinking");
      h.state.receive(chat("t1"));
    },
  },
];

describe("the chat route (L16)", () => {
  it.each(orders)(
    "$name: the thinking card becomes a done card showing the talker's line, with no worker and no extra line",
    ({ order }) => {
      const h = createHarness();
      h.state.ask("thanks!", null, null);
      order(h);
      expect(h.card("t1")).toMatchObject({
        state: "done",
        sayBack: "thanks",
        line: null,
        answer: answerOf("You're welcome!"),
      });
      expect(h.sent.map((command) => command.type)).toEqual(["question"]);
      expect(h.said).toEqual([]);
      expect(h.talked.map((request) => request.kind)).toEqual(["reply"]);
    },
  );

  it("keeps the line as the answer the next question's record carries", () => {
    const h = createHarness();
    h.state.ask("thanks!", null, null);
    h.state.receive(chat("t1"));
    h.state.talkerReplied("t1", said("You're welcome!"));
    h.state.ask("and the weather?", null, null);
    expect(h.sent.at(-1)).toMatchObject({
      recent: [{ taskId: "t1", answer: "You're welcome!" }],
    });
  });
});

describe("the chat route when the talker fails or is not needed", () => {
  it("ends the card incomplete with the fixed line said when the talker failed", () => {
    const h = createHarness();
    h.state.ask("thanks!", null, null);
    h.state.talkerReplied("t1", { kind: "failed", failure: "keyRejected" });
    h.state.receive(chat("t1"));
    expect(h.card("t1")).toMatchObject({
      state: "incomplete",
      line: failureLine("keyRejected"),
    });
    expect(h.said).toEqual([
      { taskId: "t1", text: failureLine("keyRejected"), kind: "failure" },
    ]);
  });

  it("changes nothing for a task that is not chat, and drops a second reply", () => {
    const h = createHarness();
    askNew(h, "hermes");
    const published = h.published.length;
    h.state.talkerReplied("t1", said("I'll look into Hermes."));
    h.state.talkerReplied("t1", said("again"));
    expect(h.published).toHaveLength(published);
    expect(h.card("t1")?.state).toBe("running");
    expect(h.logs.at(-1)).toBe("dropped: talker reply for t1");
  });
});

describe("the talker starts with the intake (L12)", () => {
  it("asks the talker in the same step that sends the words to the intake", () => {
    const h = createHarness();
    h.state.ask("will it rain tomorrow?", "u1", null);
    expect(h.timeline).toEqual([
      "publish",
      "send question t1",
      "talk reply t1",
    ]);
    expect(h.talked[0]).toMatchObject({
      kind: "reply",
      taskId: "t1",
      utteranceId: "u1",
      words: "will it rain tomorrow?",
    });
  });
});
