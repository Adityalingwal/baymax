// The worker's one output: the spoken line, the card text and the claims that tie it to read pages.
type Claim = { claim: string; sourceIds: string[] };
export type Answer = {
  spokenLine: string;
  cardText: string;
  claims: Claim[];
  openPoints: string[];
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
  },
  required: ["spokenLine", "cardText", "claims", "openPoints"],
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

// Anything off the schema is malformed; empty strings pass here and meet the code check.
export function parseAnswer(json: string): Answer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const fields = fieldsWith(parsed, Object.keys(answerSchema.properties));
  if (fields === null) return null;
  const { spokenLine, cardText } = fields;
  const claims = claimsFrom(fields.claims);
  const openPoints = stringList(fields.openPoints);
  if (typeof spokenLine !== "string" || typeof cardText !== "string") {
    return null;
  }
  if (claims === null || openPoints === null) return null;
  return { spokenLine, cardText, claims, openPoints };
}
