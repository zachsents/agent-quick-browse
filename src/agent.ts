import { generateText } from "ai"
import * as R from "remeda"
import { askClef, type ClefModel } from "./clef.ts"
import { describeElement, snapshotPage, type PageElement } from "./snapshot.ts"
import * as tab from "./tab.ts"

const ACTIONS = {
  click:
    "Click the numbered element that best advances the goal (link, button, tab, checkbox, result, etc.).",
  type: "Type into a numbered text field / search box, or pick an option in a numbered dropdown. Only if that field doesn't already hold the right value.",
  press_enter:
    "Press Enter to submit text that was just typed (e.g. a search box with no visible submit button).",
  scroll_down: "Scroll down because what is needed is not visible yet.",
  scroll_up: "Scroll back up because what is needed is above the current view.",
  go_back: "Go back to the previous page because this page is a dead end.",
  done: "The goal is fully accomplished, or the information that answers it is visible on screen right now.",
  blocked:
    "Stuck: login wall, CAPTCHA, paywall, an error page, or the goal needs information we don't have. Also choose this if the same action keeps repeating without progress.",
}

type Action = keyof typeof ACTIONS

type Context = {
  goal: string
  facts: Record<string, string>
  model: ClefModel
  textModel: string
  history: string[]
  log: (line: string) => void
}

/**
 * Clef-driven browser loop over the agent tab. Each step Clef sees a numbered
 * screenshot plus the element list and picks one action and one target element
 * in a single call. A text LLM (via Vercel AI Gateway) is only used to write
 * text to type and to summarize the answer at the end.
 */
export async function runAgent({
  maxSteps,
  ...options
}: Omit<Context, "history"> & { maxSteps: number }) {
  const ctx: Context = { ...options, history: [] }
  const { goal, facts, model, history, log } = ctx

  for (let step = 1; step <= maxSteps; step++) {
    const started = performance.now()
    const { elements, screenshot } = await snapshotPage()
    const descriptions = elements.map(describeElement)
    const { url, title } = await tab.info()

    const answers = await askClef({
      model,
      images: [screenshot],
      state: {
        goal,
        ...(!R.isEmpty(facts) && { facts }),
        url,
        title,
        step: `${step} of ${maxSteps}`,
        previous_actions: history.length ? history.slice(-10) : "none yet",
        visible_elements: descriptions,
      },
      questions: {
        action: {
          type: "choice",
          instructions:
            "You are operating a web browser to achieve the goal. The screenshot shows the current page with interactive elements boxed and numbered in red. What is the single best next action?",
          criteria: ACTIONS,
        },
        ...(elements.length >= 2 && {
          target: {
            type: "choice",
            instructions:
              "If the next action is a click or typing, which numbered element should it act on? Pick the one that most directly advances the goal.",
            criteria: R.fromEntries(
              R.zip(R.map(elements, R.prop("id")), descriptions),
            ),
          },
        }),
      },
    })

    const { action: actionAnswer, target: targetAnswer } = answers
    if (!actionAnswer || !isAction(actionAnswer.choice))
      throw new Error(`Unexpected Clef answer: ${JSON.stringify(answers)}`)
    const action = actionAnswer.choice
    const target = elements.find(
      (el) => el.id === (targetAnswer?.choice ?? elements[0]?.id),
    )
    const ms = Math.round(performance.now() - started)
    const summary = `${action}${target && needsTarget(action) ? ` ${describeElement(target)}` : ""}`
    log(
      `step ${step}  ${summary}  (action ${actionAnswer.confidence.toFixed(2)}${targetAnswer ? `, target ${targetAnswer.confidence.toFixed(2)}` : ""}, ${ms}ms)`,
    )

    if (action === "done")
      return finish("done", history, await summarizeAnswer(ctx))
    if (action === "blocked") return finish("blocked", history)

    try {
      await perform(action, target, ctx)
      history.push(summary)
    } catch (error) {
      // Failed actions are fed back to Clef so it can pick something else next step
      const message =
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      log(`  ! ${message}`)
      history.push(`${summary} -> FAILED: ${message}`)
    }
    await tab.waitForLoad()
  }

  return finish("max_steps", history)
}

/**
 * Every outcome reports where the tab ended up and what was done, so a caller
 * (e.g. a smarter model chaining sub-goals) can continue from the same tab.
 */
async function finish(
  status: "done" | "blocked" | "max_steps",
  actions: string[],
  answer?: string,
) {
  return { status, answer, actions, ...(await tab.info()) }
}

function isAction(choice: string): choice is Action {
  return choice in ACTIONS
}

function needsTarget(action: Action) {
  return action === "click" || action === "type"
}

async function perform(
  action: Exclude<Action, "done" | "blocked">,
  target: PageElement | undefined,
  ctx: Context,
) {
  switch (action) {
    case "click":
      if (!target) throw new Error("no element to click")
      return tab.click(target.id)
    case "type": {
      if (!target) throw new Error("no element to type into")
      if (target.tag === "select") {
        const option = await chooseSelectOption(target, ctx)
        ctx.log(`  select "${option}"`)
        return tab.selectOption(target.id, option)
      }
      const text = await writeText(target, ctx)
      ctx.log(`  type "${text}"`)
      return tab.fill(target.id, text)
    }
    case "press_enter":
      return tab.pressEnter()
    case "scroll_down":
      return tab.scroll(1)
    case "scroll_up":
      return tab.scroll(-1)
    case "go_back":
      return tab.goBack()
  }
}

/**
 * Uses Clef again (not the LLM) to pick a dropdown option, since that's a pure
 * decision.
 */
async function chooseSelectOption(
  target: PageElement,
  { goal, facts, model }: Context,
) {
  const options = await tab.selectOptions(target.id)
  if (options.length < 2) throw new Error("dropdown has fewer than 2 options")

  const answers = await askClef({
    model,
    state: { goal, facts, dropdown: describeElement(target) },
    questions: {
      option: {
        type: "choice",
        instructions:
          "Which dropdown option should be selected to achieve the goal?",
        criteria: R.fromEntries(options.slice(0, 255).map((o) => [o, null])),
      },
    },
  })
  if (!answers.option) throw new Error("Clef returned no dropdown choice")
  return answers.option.choice
}

async function writeText(
  target: PageElement,
  { goal, facts, history, textModel }: Context,
) {
  const { url, title } = await tab.info()
  const { text } = await generateText({
    model: textModel,
    prompt: [
      "You are filling in one field in a web browser on behalf of a user.",
      `Goal: ${goal}`,
      !R.isEmpty(facts) &&
        `Known facts (use these verbatim where relevant): ${JSON.stringify(facts)}`,
      `Page: ${title} (${url})`,
      `Previous actions: ${history.slice(-5).join("; ") || "none"}`,
      `Field: ${describeElement(target)}`,
      "Reply with ONLY the exact text to type into this field — no quotes, no explanation.",
    ]
      .filter(Boolean)
      .join("\n"),
  })
  return text.trim()
}

/** Reads the final page text and has the LLM answer the goal from it. */
async function summarizeAnswer({ goal, history, textModel }: Context) {
  const [{ url }, pageText] = await Promise.all([tab.info(), tab.innerText()])
  const { text } = await generateText({
    model: textModel,
    prompt: [
      `A browser agent was given this goal: ${goal}`,
      `It took these actions: ${history.join("; ") || "none"}`,
      `It finished on ${url}. Visible page text:\n"""\n${pageText.slice(0, 20_000)}\n"""`,
      "Concisely report the outcome. If the goal asked for information, answer it from the page text. If the page text doesn't support an answer, say so.",
    ].join("\n\n"),
  })
  return text.trim()
}
