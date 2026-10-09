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
    const json = await gateway("evaluate", {
      model: "typesafe-ai/jev",
      state,
      questions,
    })
    return z.object({ answers: answersSchema }).parse(json).answers
  }

  if (model === "luna") {
    const json = await gateway("decisions", {
      model: "openai/gpt-6-luna-decisions",
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
 * POSTs to a Vercel AI Gateway decision endpoint ("evaluate" for the System One
 * format, "decisions" for OpenAI's).
 */
async function gateway(endpoint: "evaluate" | "decisions", body: object) {
  const { AI_GATEWAY_API_KEY } = z
    .object({ AI_GATEWAY_API_KEY: z.string().min(1) })
    .parse(process.env)
  const res = await fetch(`https://ai-gateway.vercel.sh/v1/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok)
    throw new Error(`AI Gateway ${endpoint} ${res.status}: ${await res.text()}`)
  return res.json()
}
