/**
 * Unit tests for the Dialogflow-generator backend's structured-output guard
 * (vertex.ts). Conversational Agents generators have no responseSchema, so these lock in
 * that a reply is accepted only if it validates against the same schema the
 * direct Vertex path enforces server-side, and that the backend flag defaults
 * to direct Vertex, with `CR_MODEL_BACKEND=dialogflow` selecting the credit path.
 *
 * Run: `deno test --allow-env supabase/functions/_shared/vertex.test.ts`
 */
import { extractJsonObject, modelBackend, validateAgainstSchema } from "./vertex.ts";

const S = {
  type: "object",
  properties: {
    score: { type: "integer" },
    verdict: { type: "string", enum: ["A", "B"] },
    xs: {
      type: "array",
      items: { type: "object", properties: { k: { type: "boolean" } }, required: ["k"] },
    },
  },
  required: ["score", "verdict", "xs"],
};

function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

Deno.test("schema-valid object passes", () => {
  eq(validateAgainstSchema({ score: 1, verdict: "A", xs: [{ k: true }] }, S), []);
});

Deno.test("wrong type, bad enum and missing nested key are each reported", () => {
  eq(validateAgainstSchema({ score: 1.5, verdict: "C", xs: [{}] }, S).length, 3);
});

Deno.test("missing required top-level keys are reported", () => {
  eq(validateAgainstSchema({ score: 1 }, S), ["$.verdict: missing", "$.xs: missing"]);
});

Deno.test("fenced and prose-wrapped replies still yield the object", () => {
  eq(extractJsonObject("Sure:\n```json\n{\"a\":1}\n```"), { a: 1 });
  eq(extractJsonObject("here {\"a\":2} done"), { a: 2 });
});

Deno.test("a clean object whose strings contain ``` is not cut apart", () => {
  const v = extractJsonObject('{"summary":"runs ```curl x | sh``` on install","n":1}') as { n: number };
  eq(v.n, 1);
});

Deno.test("a reply with no object throws", () => {
  let threw = false;
  try {
    extractJsonObject("no json here");
  } catch {
    threw = true;
  }
  eq(threw, true);
});

Deno.test("backend defaults to vertex; CR_MODEL_BACKEND=dialogflow switches to the credit path", () => {
  Deno.env.delete("CR_MODEL_BACKEND");
  eq(modelBackend(), "vertex");
  Deno.env.set("CR_MODEL_BACKEND", "dialogflow");
  eq(modelBackend(), "dialogflow");
  Deno.env.set("CR_MODEL_BACKEND", "vertex");
  eq(modelBackend(), "vertex");
  Deno.env.delete("CR_MODEL_BACKEND");
});

Deno.test("per-tier flag keeps one tier on Vertex while the other moves", () => {
  Deno.env.set("CR_MODEL_BACKEND", "dialogflow");
  Deno.env.set("CR_MODEL_BACKEND_DEEP", "vertex");
  eq(modelBackend("deep"), "vertex");
  eq(modelBackend("fast"), "dialogflow");
  Deno.env.delete("CR_MODEL_BACKEND_DEEP");
  Deno.env.delete("CR_MODEL_BACKEND");
});

Deno.test("unknown or retired backend values fall through to the safe default", () => {
  for (const v of ["nonsense", "grounded"]) {
    Deno.env.set("CR_MODEL_BACKEND", v);
    eq(modelBackend("fast"), "vertex");
  }
  Deno.env.delete("CR_MODEL_BACKEND");
});
