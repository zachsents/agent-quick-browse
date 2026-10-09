import * as R from "remeda"
import { z } from "zod"

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
})
const answersSchema = z.record(z.string(), choiceAnswerSchema)

/**
 * OpenAI Decisions API answers: an array in question order; refused questions
 * come back as `{ type: "refusal" }`.
 */
const openAiAnswersSchema = z.object({
  answers: z.array(
    z.union([
      z.object({
        type: z.literal("choice"),
        name: z.string(),
        choice: z.string(),
        confidence: z.number(),
        probabilities: z.array(
          z.object({ value: z.string(), probability: z.number() }),
        ),
      }),
      z.object({ type: z.literal("refusal"), name: z.string() }),
    ]),
  ),
})

export type ChoiceQuestion = {
  type: "choice"
  instructions: string
  criteria: Record<string, string | null>
}

/**
 * Clef runs on Cloudflare Workers AI (sees images); Jev (text only) and
 * OpenAI's GPT-6 Luna Decisions ("luna", sees images) run via Vercel AI
 * Gateway.
 */
export type DecisionModel = "clef" | "clef-flash" | "jev" | "luna"

/**
 * Asks a decision model a batch of choice questions about `state` in one call.
 * Returns answers keyed by question id (refused questions are omitted). These
 * models only pick between options — they never generate text. `images` are
 * sent to the models that can see them (Clef, Luna).
 */
export async function decide({
  model,
  state,
  questions,
  images,
}: {
  model: DecisionModel
  state: unknown
  questions: Record<string, ChoiceQuestion>
  images?: string[]
}) {
  if (model === "jev") {
    const { url, key, model: jevModel } = jevEndpoint()
    const json = await post(url, key, {
      model: jevModel,
      state,
      questions,
    })
    return z.object({ answers: answersSchema }).parse(json).answers
  }

  if (model === "luna") {
    const { url, key, model: lunaModel } = lunaEndpoint()
    const json = await post(url, key, {
      model: lunaModel,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: JSON.stringify(state) },
            ...(images ?? []).map((image) => ({
              type: "input_image",
              image_url: image,
              detail: "high",
            })),
          ],
        },
      ],
      questions: Object.entries(questions).map(
        ([name, { instructions, criteria }]) => ({
          type: "choice",
          name,
          instructions,
          choices: Object.entries(criteria).map(([value, description]) => ({
            value,
            ...(description && { description }),
          })),
        }),
      ),
    })
    return R.pipe(
      openAiAnswersSchema.parse(json).answers,
      R.filter((answer) => answer.type === "choice"),
      R.map(
        ({ name, choice, confidence, probabilities }) =>
          [
            name,
            {
              type: "choice" as const,
              choice,
              confidence,
              probabilities: R.fromEntries(
                probabilities.map((p) => [p.value, p.probability]),
              ),
            },
          ] as const,
      ),
      R.fromEntries(),
    )
  }

  const env = z
    .object({
      CLOUDFLARE_AI_ACCOUNT_ID: z.string().min(1),
      CLOUDFLARE_AI_API_TOKEN: z.string().min(1),
    })
    .parse(process.env)
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_AI_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, state, questions, images }),
    },
  )
  if (!res.ok) throw new Error(`Clef ${res.status}: ${await res.text()}`)
  return z
    .object({ result: z.object({ answers: answersSchema }) })
    .parse(await res.json()).result.answers
}

/**
 * Where Jev requests go: Vercel AI Gateway if AI_GATEWAY_API_KEY is set (one
 * key for Jev and Luna), otherwise TypeSafe directly with TYPESAFE_API_KEY.
 * Both take the same System One request shape. JEV_MODEL overrides the direct
 * model id.
 */
function jevEndpoint() {
  const { AI_GATEWAY_API_KEY, TYPESAFE_API_KEY, JEV_MODEL } = process.env
  if (AI_GATEWAY_API_KEY)
    return {
      url: "https://ai-gateway.vercel.sh/v1/evaluate",
      key: AI_GATEWAY_API_KEY,
      model: "typesafe-ai/jev",
    }
  if (TYPESAFE_API_KEY)
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      key: TYPESAFE_API_KEY,
      model: JEV_MODEL ?? "jev-latest",
    }
  throw new Error(
    "Jev needs an API key: set AI_GATEWAY_API_KEY (Vercel AI Gateway) or TYPESAFE_API_KEY (TypeSafe)",
  )
}

/**
 * Where GPT-6 Luna Decisions requests go: Vercel AI Gateway if
 * AI_GATEWAY_API_KEY is set, otherwise OpenAI directly with OPENAI_API_KEY.
 * Both take the same OpenAI Decisions request shape.
 */
function lunaEndpoint() {
  const { AI_GATEWAY_API_KEY, OPENAI_API_KEY } = process.env
  if (AI_GATEWAY_API_KEY)
    return {
      url: "https://ai-gateway.vercel.sh/v1/decisions",
      key: AI_GATEWAY_API_KEY,
      model: "openai/gpt-6-luna-decisions",
    }
  if (OPENAI_API_KEY)
    return {
      url: "https://api.openai.com/v1/decisions",
      key: OPENAI_API_KEY,
      model: "gpt-6-luna",
    }
  throw new Error(
    "GPT-6 Luna needs an API key: set AI_GATEWAY_API_KEY (Vercel AI Gateway) or OPENAI_API_KEY (OpenAI)",
  )
}

async function post(url: string, key: string, body: object) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok)
    throw new Error(`${new URL(url).host} ${res.status}: ${await res.text()}`)
  return res.json()
}

/**
 * The model to use when none is specified, based on which keys are set: Jev
 * (best in benchmarks) via the gateway or TypeSafe, else GPT-6 Luna via OpenAI,
 * else Clef via Cloudflare. Throws a setup hint if no key is set.
 */
export function defaultModel(): DecisionModel {
  const {
    AI_GATEWAY_API_KEY,
    TYPESAFE_API_KEY,
    OPENAI_API_KEY,
    CLOUDFLARE_AI_API_TOKEN,
  } = process.env
  if (AI_GATEWAY_API_KEY || TYPESAFE_API_KEY) return "jev"
  if (OPENAI_API_KEY) return "luna"
  if (CLOUDFLARE_AI_API_TOKEN) return "clef"
  throw new Error(
    "No decision model key found. Set AI_GATEWAY_API_KEY (Jev + GPT-6 Luna), TYPESAFE_API_KEY (Jev), OPENAI_API_KEY (GPT-6 Luna), or CLOUDFLARE_AI_ACCOUNT_ID + CLOUDFLARE_AI_API_TOKEN (Clef).",
  )
}

/**
 * How the page is shown to the model: Jev only reads text; otherwise an
 * explicit choice wins, and the default is each model's better mode in
 * benchmarks (text for Luna, screenshots for Clef).
 */
export function resolveMode(model: DecisionModel, view?: "text" | "vision") {
  if (model === "jev") return "text"
  return view ?? (model === "luna" ? "text" : "vision")
}
