import * as R from "remeda"
import { decide, type DecisionModel } from "./decide.ts"
import {
  describeElement,
  snapshotPage,
  type PageElement,
  type SnapshotMode,
} from "./snapshot.ts"
import * as tab from "./tab.ts"

const ACTIONS = {
  click:
    "Click the numbered element that best advances the goal (link, button, tab, checkbox, result, etc.).",
  type: "Type one of the provided facts into a numbered text field / search box, or pick an option in a numbered dropdown. Only if that field doesn't already hold the right value.",
  upload:
    "Attach one of the provided files using the numbered file upload field, upload button, or drop zone.",
  hover:
    "Hover the mouse over the numbered element (a row, card, or menu) to reveal controls or a menu that only appear on hover.",
  press_escape:
    "Press Escape to close a popup, suggestion list, menu, or dialog that is in the way (do not click buttons to dismiss it).",
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
  /** Local files the model may upload, by name → absolute path */
  files: Record<string, string>
  /**
   * Type text with per-character key events instead of inserting it in one go
   * (for picky rich-text editors)
   */
  keystrokes?: boolean
  model: DecisionModel
  /** Jev is text-only, so it always uses "text" */
  mode: SnapshotMode
  history: string[]
  log: (line: string) => void
}

/**
 * Decision-model-driven browser loop over the agent tab. Each step the model
 * sees the page (a numbered screenshot, or a whole-page text outline) and picks
 * one action and one target element in a single call. No LLM is involved: text
 * to type comes from the caller's `facts` (Clef picks which one fits a field),
 * and the caller reads the page itself if it needs information from it.
 */
export async function runAgent({
  maxSteps,
  ...options
}: Omit<Context, "history"> & { maxSteps: number }) {
  const ctx: Context = { ...options, history: [] }
  const { goal, facts, files, model, mode, history, log } = ctx

  for (let step = 1; step <= maxSteps; step++) {
    const started = performance.now()
    const { elements, screenshot, outline } = await snapshotWithRetry(mode)
    const descriptions = elements.map(describeElement)
    const { url, title } = await tab.info()

    const answers = await decide({
      model,
      ...(screenshot && { images: [screenshot] }),
      state: {
        goal,
        ...(!R.isEmpty(facts) && { facts }),
        ...(!R.isEmpty(files) && {
          uploads: R.isEmpty(filesLeft(files, history))
            ? `All provided files are attached (${attachedSoFar(history).join(", ")}); no uploads left to do`
            : {
                files_to_upload: Object.keys(filesLeft(files, history)),
                already_attached: attachedSoFar(history),
              },
        }),
        url,
        title,
        step: `${step} of ${maxSteps}`,
        previous_actions: history.length ? history.slice(-10) : "none yet",
        ...(outline == null
          ? { visible_elements: descriptions }
          : { page: outline }),
      },
      questions: {
        action: {
          type: "choice",
          instructions:
            mode === "vision"
              ? "You are operating a web browser to achieve the goal. The screenshot shows the current page with interactive elements boxed and numbered in red. What is the single best next action?"
              : "You are operating a web browser to achieve the goal. The page is given as a text outline with interactive elements numbered [n]. Elements marked (above/below …) are off-screen but can be clicked or typed into directly — no need to scroll to them. What is the single best next action?",
          criteria: ACTIONS,
        },
        ...(elements.length >= 2 && {
          target: {
            type: "choice",
            instructions:
              "If the next action is a click, typing, upload, or hover, which numbered element should it act on? Pick the one that most directly advances the goal.",
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

    if (action === "done") return finish("done", history)
    if (action === "blocked") return finish("blocked", history)

    try {
      const actionStarted = performance.now()
      const note = await perform(action, target, ctx)
      const actionMs = Math.round(performance.now() - actionStarted)
      if (actionMs > 1000) log(`  (action took ${actionMs}ms)`)
      history.push(typeof note === "string" ? `${summary} -> ${note}` : summary)
      if (isLooping(history, summary))
        return finish(
          "blocked",
          history,
          `Repeated "${summary}" without progress`,
        )
    } catch (error) {
      if (error instanceof NeedsInputError)
        return finish("blocked", history, error.message)
      // Failed actions are fed back to Clef so it can pick something else next step
      const message =
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      log(`  ! ${message}`)
      history.push(`${summary} -> FAILED: ${message}`)
      if (isLooping(history, summary))
        return finish(
          "blocked",
          history,
          `Repeated "${summary}" without progress (last error: ${message})`,
        )
    }
    const settleStarted = performance.now()
    await tab.waitForLoad()
    const settleMs = Math.round(performance.now() - settleStarted)
    if (settleMs > 1500) log(`  (page took ${settleMs}ms to settle)`)
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
  reason?: string,
) {
  return { status, ...(reason && { reason }), actions, ...(await tab.info()) }
}

/**
 * The model wants to type or upload, but none of the caller's facts or files
 * fits, so the caller has to supply it.
 */
class NeedsInputError extends Error {}

/**
 * Snapshots can fail when they land mid-navigation (the document is swapped out
 * underneath the script), so wait for the page and retry a couple of times
 * before giving up.
 */
async function snapshotWithRetry(mode: SnapshotMode) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await snapshotPage(mode)
    } catch (error) {
      if (attempt >= 3) throw error
      await tab.waitForLoad()
    }
  }
}

/**
 * True when the same action (ignoring its result note) shows up 3 times in the
 * last 6 steps. Catches both straight repeats and back-and-forth loops like
 * "type into box, click elsewhere, type into box, …".
 */
function isLooping(history: string[], summary: string) {
  return (
    history.slice(-6).filter((entry) => entry.split(" -> ")[0] === summary)
      .length >= 3
  )
}

/**
 * File names this run has attached so far, from the upload notes in its
 * history.
 */
function attachedSoFar(history: string[]) {
  return R.unique(
    history.flatMap(
      (entry) => /-> (?:already )?attached (.+)$/.exec(entry)?.[1] ?? [],
    ),
  )
}

/** The caller's files that this run hasn't attached yet. */
function filesLeft(files: Record<string, string>, history: string[]) {
  const attached = attachedSoFar(history)
  return R.pickBy(
    files,
    (path) => !attached.includes(path.split("/").at(-1) ?? path),
  )
}

function isAction(choice: string): choice is Action {
  return choice in ACTIONS
}

function needsTarget(action: Action) {
  return (
    action === "click" ||
    action === "type" ||
    action === "hover" ||
    action === "upload"
  )
}

async function perform(
  action: Exclude<Action, "done" | "blocked">,
  target: PageElement | undefined,
  ctx: Context,
) {
  switch (action) {
    case "click":
      if (!target) throw new Error("no element to click")
      // Clicking a native <select> or file input opens a browser/OS popup CDP can't operate, so act on it directly
      if (target.tag === "select") return selectFromDropdown(target, ctx)
      if (target.role === "file upload") return uploadFile(target, ctx)
      return tab.click(target.id)
    case "upload":
      if (!target) throw new Error("no element to upload to")
      return uploadFile(target, ctx)
    case "type": {
      if (!target) throw new Error("no element to type into")
      if (
        !target.editable &&
        target.tag !== "select" &&
        target.role !== "file upload"
      ) {
        // Dropdown-style widgets (e.g. a div combobox) are opened by clicking; clicking anything else on "type" is
        // how a Retry or Select button got pressed by mistake, so fail instead and let the model pick again
        if (!["combobox", "listbox", "spinbutton"].includes(target.role))
          throw new Error(
            ["input", "textarea"].includes(target.tag)
              ? `[${target.id.slice(1)}] is read-only; set it by clicking the page's own picker or list options instead of typing`
              : `[${target.id.slice(1)}] is not a text field (role ${target.role}); pick the field to type into`,
          )
        ctx.log("  (dropdown widget; clicking to open it)")
        return tab.click(target.id)
      }
      if (target.tag === "select") return selectFromDropdown(target, ctx)
      if (target.role === "file upload") return uploadFile(target, ctx)
      const text = await chooseFact(target, ctx)
      ctx.log(`  type "${text}"${ctx.keystrokes ? " (keystrokes)" : ""}`)
      return tab.fill(target.id, text, { keystrokes: ctx.keystrokes })
    }
    case "hover":
      if (!target) throw new Error("no element to hover")
      return tab.hover(target.id)
    case "press_enter":
      return tab.pressEnter()
    case "press_escape":
      return tab.key("Escape")
    case "scroll_down":
      return tab.scroll(1)
    case "scroll_up":
      return tab.scroll(-1)
    case "go_back":
      return tab.goBack()
  }
}

async function selectFromDropdown(target: PageElement, ctx: Context) {
  const option = await chooseSelectOption(target, ctx)
  ctx.log(`  select "${option}"`)
  return tab.selectOption(target.id, option)
}

/**
 * Uses the decision model to pick a dropdown option, since that's a pure
 * decision.
 */
async function chooseSelectOption(
  target: PageElement,
  { goal, facts, model }: Context,
) {
  const options = await tab.selectOptions(target.id)
  if (options.length < 2) throw new Error("dropdown has fewer than 2 options")

  const answers = await decide({
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

/**
 * Uses Clef to pick which of the caller's facts belongs in a text field. Throws
 * NeedsInputError when there are no facts or none fits, which ends the run as
 * blocked so the caller can type it themselves.
 */
async function chooseFact(
  target: PageElement,
  { goal, facts, history, model }: Context,
) {
  const needsText = new NeedsInputError(
    `Needs text for ${describeElement(target)}. Pass it in facts, or type it with browser_type.`,
  )
  if (R.isEmpty(facts)) throw needsText
  // With a single fact there's nothing to choose; asking the model only risks a wrong "none of these fits"
  const only = Object.values(facts)
  if (only.length === 1 && only[0] != null) return only[0]

  const answers = await decide({
    model,
    state: {
      goal,
      field: describeElement(target),
      previous_actions: history.slice(-5),
    },
    questions: {
      fact: {
        type: "choice",
        instructions:
          "Which of these values should be typed into the field to achieve the goal?",
        criteria: {
          ...R.mapValues(facts, (value, key) => `${key}: type "${value}"`),
          __none__: "None of these values belongs in this field",
        },
      },
    },
  })
  const text = answers.fact && facts[answers.fact.choice]
  if (text == null) throw needsText
  return text
}

/**
 * Uses the decision model to pick which of the caller's files belongs in an
 * upload field, then attaches it without opening the OS file picker. Ends the
 * run as blocked if no provided file fits.
 */
async function uploadFile(
  target: PageElement,
  { goal, files, history, model, log }: Context,
) {
  const needsFile = new NeedsInputError(
    `Needs a file for ${describeElement(target)}. Pass it in files, or attach it with browser_upload.`,
  )
  if (R.isEmpty(files)) throw needsFile
  const left = filesLeft(files, history)
  // Everything was already attached (the model just didn't notice), so there's nothing to do rather than a failure
  if (R.isEmpty(left))
    return `nothing left to upload (already attached: ${attachedSoFar(history).join(", ")})`
  const answers = await decide({
    model,
    state: {
      goal,
      upload_field: describeElement(target),
      previous_actions: history.slice(-5),
    },
    questions: {
      file: {
        type: "choice",
        instructions:
          "Which of these files should be uploaded here to achieve the goal?",
        criteria: {
          ...R.mapValues(
            left,
            (path, name) => `${name}: ${path.split("/").at(-1)}`,
          ),
          __none__: "None of these files belongs in this field",
        },
      },
    },
  })
  const path = answers.file && left[answers.file.choice]
  if (path == null) throw needsFile
  log(`  upload "${path}"`)
  const outcome = await tab.upload(target.id, [path])
  // The page often doesn't show the attached file (hidden input behind a button), so record it for the next step
  return `${outcome} ${path.split("/").at(-1)}`
}
