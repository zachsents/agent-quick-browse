import { z } from "zod"

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
})
const answersSchema = z.record(z.string(), choiceAnswerSchema)

export type ChoiceQuestion = {
  type: "choice"
  instructions: string
  criteria: Record<string, string | null>
}

/**
 * Clef runs on Cloudflare Workers AI (and can see images); Jev runs via Vercel
 * AI Gateway (text only).
 */
export type DecisionModel = "clef" | "clef-flash" | "jev"

/**
 * Asks a decision model a batch of choice questions about `state` in one call.
 * Returns answers keyed by question id. These models only pick between options
 * — they never generate text. `images` are only sent to Clef.
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
    const { AI_GATEWAY_API_KEY } = z
      .object({ AI_GATEWAY_API_KEY: z.string().min(1) })
      .parse(process.env)
    const res = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "typesafe-ai/jev", state, questions }),
    })
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`)
    return z.object({ answers: answersSchema }).parse(await res.json()).answers
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
