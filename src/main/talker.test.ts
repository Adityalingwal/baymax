import { describe, expect, it } from "vitest";
import {
  createHarness,
  finished,
  flush,
  frontRequest,
  lastUserText,
} from "./talker.harness";

const decide = (input: unknown) => ({ name: "decide", input });

const turns = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "Hello!" },
] as const;

describe("the front call's request", () => {
  it("asks Fable 5.1 at low effort with the decide tool, no thinking and no tool choice", () => {
    const h = createHarness();
    h.talker.talk(frontRequest({ history: [...turns] }));
    const [{ request }] = h.calls;
    expect(request).toMatchObject({
      model: "claude-fable-5-1",
      max_tokens: 2048,
      output_config: { effort: "low" },
      tools: [{ name: "decide" }],
    });
    expect(request.thinking).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.system).toContain("Then call the decide tool once");
  });

  it("asks decide for a one-line goal, not a brief", () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    const { request } = h.calls[0];
    const [tool] = request.tools ?? [];
    expect(tool).toMatchObject({
      input_schema: {
        required: [
          "route",
          "topic",
          "parentTaskId",
          "answerTo",
          "choices",
          "goal",
        ],
        properties: { goal: { type: ["string", "null"] } },
      },
    });
    expect(tool).not.toHaveProperty("input_schema.properties.brief");
    const system = String(request.system);
    expect(system).toContain(
      "goal, for newTask and followUp: one sentence naming what the user wants to know",
    );
    expect(system).toContain(
      "A separate step turns it into the research brief",
    );
    expect(system).not.toContain("resultShape");
    expect(system).not.toContain("brief, for newTask");
  });
});

describe("the front call's instructions", () => {
  it("carry the prompt rules from the live tests: a bare greeting, an open question, an answer already written", () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    const system = String(h.calls[0].request.system);
    expect(system).toContain(
      "A greeting gets a short greeting back, and the line ends there.",
    );
    expect(system).toContain(
      'there is no request yet, such as "can you help me with a task?"',
    );
    expect(system).toContain(
      "a question whose answer is already written in an earlier answer in this conversation",
    );
    expect(system).toContain("Never invent a task id or a question id.");
  });

  it("sends the history as real turns before the current one, with the cache mark on the last history turn", () => {
    const h = createHarness();
    h.talker.talk(frontRequest({ history: [...turns] }));
    const { messages } = h.calls[0].request;
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello!",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: expect.stringContaining("<words>") },
    ]);
  });

  it("sends only the current turn, with no cache mark, when there is no history", () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    expect(h.calls[0].request.messages).toHaveLength(1);
    expect(JSON.stringify(h.calls[0].request)).not.toContain("cache_control");
  });
});

describe("the front call's data blocks", () => {
  it("carries every id and card fact the instructions refer to", () => {
    const h = createHarness();
    h.talker.talk(
      frontRequest({
        recent: [
          {
            taskId: "t0",
            state: "done",
            question: "headphones under 30k",
            answer: "Three picks.",
            cardText: "Sennheiser 24,990 | Sony 26,990",
          },
        ],
        tasks: [
          { taskId: "t1", state: "running", words: "hermes", topic: "Hermes" },
        ],
        waiting: {
          taskId: "t3",
          words: "find me a laptop",
          question: {
            questionId: "t3:question",
            text: "For what use?",
            choices: ["Office", "Gaming"],
          },
        },
      }),
    );
    const text = lastUserText(h.calls[0].request);
    for (const fact of [
      "<words>\nwill it rain in Delhi tomorrow?\n</words>",
      "task t0 (done): question: headphones under 30k | answer: Three picks.",
      "card: Sennheiser 24,990 | Sony 26,990",
      "task t1 (running): hermes | topic: Hermes",
      "task id: t3",
      "question id: t3:question",
      "request: find me a laptop",
      "question: For what use?",
      "- Office",
      "- Gaming",
    ]) {
      expect(text).toContain(fact);
    }
    h.talker.talk(frontRequest({ attemptId: "t4#1", taskId: "t4" }));
    expect(lastUserText(h.calls[1].request)).toContain(
      "<waiting_question>\nnone\n</waiting_question>",
    );
  });
});

describe("the front call's line and decision", () => {
  it("streams the line into speech, ends it when the tool starts, and drops text after it", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    expect(h.lines).toEqual([{ taskId: "t2", kind: "talk", parts: [] }]);
    h.calls[0].onText("I'll check ");
    h.calls[0].onText("the forecast.");
    expect(h.lines[0].parts).toEqual(["I'll check ", "the forecast."]);
    h.calls[0].onToolStart();
    expect(h.lines[0].parts.at(-1)).toBe("<end>");
    h.calls[0].onText("Anything else?");
    const input = { route: "newTask" };
    h.calls[0].resolve(finished("I'll check the forecast.", [decide(input)]));
    await flush();
    expect(h.lines[0].parts).toEqual(["I'll check ", "the forecast.", "<end>"]);
    expect(h.replies).toEqual([
      {
        taskId: "t2",
        attemptId: "t2#1",
        reply: {
          kind: "said",
          text: "I'll check the forecast.",
          decision: input,
        },
      },
    ]);
    expect(h.logs).toEqual([
      "talker front call done (in 10, out 5, cache read 7)",
    ]);
  });

  it("hands main a null decision when no tool came", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].resolve(finished("It's 4.", [], "end_turn"));
    await flush();
    expect(h.lines[0].parts).toEqual(["<end>"]);
    expect(h.replies[0].reply).toEqual({
      kind: "said",
      text: "It's 4.",
      decision: null,
    });
  });
});
