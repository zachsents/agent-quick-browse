import { z } from "zod"

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
})

const responseSchema = z.object({
  result: z.object({
    answers: z.record(z.string(), choiceAnswerSchema),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  }),
})

export type ChoiceQuestion = {
  type: "choice"
  instructions: string
  criteria: Record<string, string | null>
}

export type ClefModel = "clef" | "clef-flash"

const envSchema = z.object({
  CLOUDFLARE_AI_ACCOUNT_ID: z.string().min(1),
  CLOUDFLARE_AI_API_TOKEN: z.string().min(1),
})

/**
 * Asks Clef a batch of choice questions about `state` (plus optional
 * screenshots) in one call. Returns answers keyed by question id. Clef only
 * picks between options — it never generates text.
 */
export async function askClef({
  model,
  state,
  questions,
  images,
}: {
  model: ClefModel
  state: unknown
  questions: Record<string, ChoiceQuestion>
  images?: string[]
}) {
  const env = envSchema.parse(process.env)
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

  return responseSchema.parse(await res.json()).result.answers
}
