// The worker's one output: the spoken line, the card text and the claims that tie it to read pages.
type Claim = { claim: string; sourceIds: string[] };

const statuses = ["complete", "sourcesThin", "needsUser"] as const;
type AnswerStatus = (typeof statuses)[number];

export type Answer = {
  spokenLine: string;
  cardText: string;
  claims: Claim[];
  openPoints: string[];
  status: AnswerStatus;
  nextQuestion: string | null; // set exactly when status is needsUser
};

const text = { type: "string" };
const textList = { type: "array", items: text };

export const answerSchema = {
  type: "object",
  properties: {
    spokenLine: text,
    cardText: text,
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: text, sourceIds: textList },
        required: ["claim", "sourceIds"],
        additionalProperties: false,
      },
    },
    openPoints: textList,
    status: { type: "string", enum: [...statuses] },
    nextQuestion: { anyOf: [{ type: "null" }, text] },
  },
  required: [
    "spokenLine",
    "cardText",
    "claims",
    "openPoints",
    "status",
    "nextQuestion",
  ],
  additionalProperties: false,
};

type Fields = Record<string, unknown>;

function fieldsWith(value: unknown, keys: string[]): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const own = Object.keys(value);
  const exact =
    own.length === keys.length && keys.every((key) => own.includes(key));
  return exact ? (value as Fields) : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? value : null;
}

function claimFrom(value: unknown): Claim | null {
  const fields = fieldsWith(value, ["claim", "sourceIds"]);
  if (fields === null || typeof fields.claim !== "string") return null;
  const sourceIds = stringList(fields.sourceIds);
  return sourceIds === null ? null : { claim: fields.claim, sourceIds };
}

function claimsFrom(value: unknown): Claim[] | null {
  if (!Array.isArray(value)) return null;
  const claims = value.map(claimFrom);
  return claims.every((claim) => claim !== null) ? claims : null;
}

// A next question goes with needsUser and nothing else; any other pairing is malformed.
function statusFrom(
  fields: Fields,
): Pick<Answer, "status" | "nextQuestion"> | null {
  const { status, nextQuestion } = fields;
  const known = statuses.find((value) => value === status);
  if (known === undefined) return null;
  if (known !== "needsUser") {
    return nextQuestion === null ? { status: known, nextQuestion } : null;
  }
  if (typeof nextQuestion !== "string" || nextQuestion.trim() === "") {
    return null;
  }
  return { status: known, nextQuestion: nextQuestion.trim() };
}

// Anything off the schema is malformed; empty strings pass here and meet the code check.
export function parseAnswer(json: string): Answer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const fields = fieldsWith(parsed, answerSchema.required);
  if (fields === null) return null;
  const { spokenLine, cardText } = fields;
  const claims = claimsFrom(fields.claims);
  const openPoints = stringList(fields.openPoints);
  const status = statusFrom(fields);
  if (typeof spokenLine !== "string" || typeof cardText !== "string") {
    return null;
  }
  if (claims === null || openPoints === null || status === null) return null;
  return { spokenLine, cardText, claims, openPoints, ...status };
}
