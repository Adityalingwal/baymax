import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ClarifyingReply } from "../../shared/cards";
import type {
  IntakeOutcome,
  RecentExchange,
  WorkerBrief,
} from "../../shared/engine";
import { userWordsFor } from "./intake-prompt";
import type { IntakeCommand } from "./intake-prompt";

const orNull = (schema: object) => ({ anyOf: [{ type: "null" }, schema] });

const text = { type: "string" };

const briefSchema = {
  type: "object",
  properties: { goal: text, resultShape: text, sources: text, limits: text },
  required: ["goal", "resultShape", "sources", "limits"],
  additionalProperties: false,
};

const clarifySchema = {
  type: "object",
  properties: { text, choices: { type: "array", items: text } },
  required: ["text", "choices"],
  additionalProperties: false,
};

const replySchema = {
  type: "object",
  properties: { choiceIndex: orNull({ type: "integer" }), text: orNull(text) },
  required: ["choiceIndex", "text"],
  additionalProperties: false,
};

// sayBack comes first so the say-back is the first thing the model writes.
export const questionSchema = {
  type: "object",
  properties: {
    sayBack: text,
    route: {
      type: "string",
      enum: [
        "newTask",
        "followUp",
        "answer",
        "clarify",
        "chat",
        "outsideResearch",
      ],
    },
    parentTaskId: orNull(text),
    startLine: orNull(text),
    brief: orNull(briefSchema),
    clarify: orNull(clarifySchema),
    reply: orNull(replySchema),
  },
  required: [
    "sayBack",
    "route",
    "parentTaskId",
    "startLine",
    "brief",
    "clarify",
    "reply",
  ],
  additionalProperties: false,
};

export const clarifyingAnswerSchema = {
  type: "object",
  properties: {
    sayBack: text,
    route: { type: "string", enum: ["newTask", "followUp", "outsideResearch"] },
    parentTaskId: orNull(text),
    startLine: orNull(text),
    brief: orNull(briefSchema),
  },
  required: ["sayBack", "route", "parentTaskId", "startLine", "brief"],
  additionalProperties: false,
};

type Fields = Record<string, unknown>;

type FieldKind = "string" | "stringOrNull" | "objectOrNull";

const taskShape: Record<string, FieldKind> = {
  sayBack: "string",
  route: "string",
  parentTaskId: "stringOrNull",
  startLine: "stringOrNull",
  brief: "objectOrNull",
};

const questionShape: Record<string, FieldKind> = {
  ...taskShape,
  clarify: "objectOrNull",
  reply: "objectOrNull",
};

type IntakeCheck =
  { ok: true; outcome: IntakeOutcome } | { ok: false; reason: string };

const malformed = (reason: string): IntakeCheck => ({ ok: false, reason });

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fitsKind(value: unknown, kind: FieldKind): boolean {
  if (typeof value === "string") return kind !== "objectOrNull";
  if (value === null) return kind !== "string";
  return kind === "objectOrNull" && isFields(value);
}

function hasShape(fields: Fields, command: IntakeCommand): boolean {
  const shape = command.type === "question" ? questionShape : taskShape;
  const keys = Object.keys(fields);
  return (
    keys.length === Object.keys(shape).length &&
    keys.every(
      (key) => Object.hasOwn(shape, key) && fitsKind(fields[key], shape[key]),
    )
  );
}

function filled(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readBrief(value: unknown): Omit<WorkerBrief, "userWords"> | null {
  if (!isFields(value)) return null;
  const goal = filled(value.goal);
  const resultShape = filled(value.resultShape);
  const sources = filled(value.sources);
  const limits = filled(value.limits);
  if (!goal || !resultShape || !sources || !limits) return null;
  return { goal, resultShape, sources, limits };
}

function readChoices(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    return null;
  }
  const choices: string[] = [];
  for (const item of value) {
    const choice = filled(item);
    if (choice === null) return null;
    choices.push(choice);
  }
  return choices;
}

function readReply(
  value: unknown,
  choiceCount: number,
): ClarifyingReply | null {
  if (!isFields(value)) return null;
  const index = value.choiceIndex;
  if (typeof index === "number" && Number.isInteger(index)) {
    if (index >= 0 && index < choiceCount) return { kind: "choice", index };
  }
  const typed = filled(value.text);
  return typed === null ? null : { kind: "text", text: typed };
}

function taskRoute(
  fields: Fields,
  userWords: string,
  recent: RecentExchange[],
): IntakeCheck {
  const sayBack = filled(fields.sayBack);
  const startLine = filled(fields.startLine);
  const parts = readBrief(fields.brief);
  if (!sayBack || !startLine || !parts) return malformed("missingTaskField");
  const brief = { ...parts, userWords };
  const named = filled(fields.parentTaskId);
  const parent = recent.find((exchange) => exchange.taskId === named);
  if (fields.route === "followUp" && parent) {
    const parentTaskId = parent.taskId;
    const outcome: IntakeOutcome = {
      route: "followUp",
      parentTaskId,
      sayBack,
      startLine,
      brief,
    };
    return { ok: true, outcome };
  }
  return { ok: true, outcome: { route: "newTask", sayBack, startLine, brief } };
}

function answerRoute(fields: Fields, command: IntakeCommand): IntakeCheck {
  if (command.type !== "question") return malformed("routeNotAllowed");
  const { waiting } = command;
  if (waiting === null) return malformed("answerWithoutWaiting");
  const reply = readReply(fields.reply, waiting.question.choices.length);
  if (reply === null) return malformed("badReply");
  const outcome: IntakeOutcome = {
    route: "answer",
    waitingTaskId: waiting.taskId,
    questionId: waiting.question.questionId,
    reply,
  };
  return { ok: true, outcome };
}

function chatRoute(fields: Fields, command: IntakeCommand): IntakeCheck {
  if (command.type !== "question") return malformed("routeNotAllowed");
  const sayBack = filled(fields.sayBack);
  if (!sayBack) return malformed("missingSayBack");
  return { ok: true, outcome: { route: "chat", sayBack } };
}

function clarifyRoute(fields: Fields, command: IntakeCommand): IntakeCheck {
  if (command.type !== "question") return malformed("routeNotAllowed");
  const sayBack = filled(fields.sayBack);
  const clarify = isFields(fields.clarify) ? fields.clarify : null;
  const questionText = clarify ? filled(clarify.text) : null;
  const choices = clarify ? readChoices(clarify.choices) : null;
  if (!sayBack || !questionText || !choices) return malformed("badClarify");
  const question = { questionId: randomUUID(), text: questionText, choices };
  return { ok: true, outcome: { route: "clarify", sayBack, question } };
}

type FieldsRead = { ok: true; fields: Fields } | { ok: false; reason: string };

function readFields(message: Anthropic.Message): FieldsRead {
  if (message.stop_reason !== "end_turn") {
    return { ok: false, reason: `stopReason:${String(message.stop_reason)}` };
  }
  const blocks = message.content.filter((block) => block.type === "text");
  if (blocks.length !== 1 || blocks[0].type !== "text") {
    return { ok: false, reason: "textBlocks" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0].text);
  } catch {
    return { ok: false, reason: "invalidJson" };
  }
  return isFields(parsed)
    ? { ok: true, fields: parsed }
    : { ok: false, reason: "notAnObject" };
}

// Turns the model's JSON into an outcome; anything off the expected shape is malformed.
export function checkIntakeReply(
  message: Anthropic.Message,
  command: IntakeCommand,
): IntakeCheck {
  const read = readFields(message);
  if (!read.ok) return malformed(read.reason);
  const { fields } = read;
  if (!hasShape(fields, command)) return malformed("wrongShape");
  switch (fields.route) {
    case "newTask":
    case "followUp":
      return taskRoute(fields, userWordsFor(command), command.recent);
    case "answer":
      return answerRoute(fields, command);
    case "clarify":
      return clarifyRoute(fields, command);
    case "chat":
      return chatRoute(fields, command);
    case "outsideResearch":
      return { ok: true, outcome: { route: "outsideResearch" } };
    default:
      return malformed("unknownRoute");
  }
}
