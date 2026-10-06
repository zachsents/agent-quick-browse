import { z } from "zod"
import { SOCKET_PATH } from "./paths.ts"

const rpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.string().optional(),
})
const evaluateResultSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z
    .object({
      text: z.string(),
      exception: z.object({ description: z.string().optional() }).optional(),
    })
    .optional(),
})
const rectSchema = z.object({ x: z.number(), y: z.number() })

async function rpc(method: "cdp" | "tab", params?: unknown) {
  const res = await fetch("http://localhost/rpc", {
    unix: SOCKET_PATH,
    method: "POST",
    body: JSON.stringify({ method, params }),
  }).catch(() => {
    throw new Error(
      "Can't reach the Clef Browser Bridge. Is Chrome running with the extension loaded? (run `clef-browser setup`)",
    )
  })
  const { result, error } = rpcResponseSchema.parse(await res.json())
  if (error != null) throw new Error(error)
  return result
}

function cdp(method: string, params?: Record<string, unknown>) {
  return rpc("cdp", { method, params })
}

/**
 * Runs a self-contained function in the agent tab and returns its
 * JSON-serializable result (validate it with zod). `fn` is stringified, so it
 * must not reference anything outside its own body.
 */
export async function evaluate<A>(fn: (arg: A) => unknown, arg?: A) {
  const { result, exceptionDetails } = evaluateResultSchema.parse(
    await cdp("Runtime.evaluate", {
      expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
      returnByValue: true,
      awaitPromise: true,
    }),
  )
  if (exceptionDetails)
    throw new Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    )
  return result.value
}

export async function info() {
  return z
    .object({ url: z.string(), title: z.string() })
    .parse(await rpc("tab"))
}

export async function goto(url: string) {
  await cdp("Page.navigate", { url })
  await waitForLoad()
}

/**
 * Waits for the DOM to be parsed (pages that never go fully idle are fine).
 * Gives up quietly after ~5s.
 */
export async function waitForLoad() {
  for (let i = 0; i < 25; i++) {
    await Bun.sleep(200)
    const ready = await evaluate(() => document.readyState).catch(
      () => "loading",
    )
    if (ready !== "loading") break
  }
  await Bun.sleep(300)
}

/**
 * Viewport screenshot at CSS-pixel resolution (not retina) to keep Clef
 * requests small.
 */
export async function screenshot() {
  const viewport = z
    .object({ width: z.number(), height: z.number(), dpr: z.number() })
    .parse(
      await evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      })),
    )
  const { data } = z.object({ data: z.string() }).parse(
    await cdp("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
        scale: 1 / viewport.dpr,
      },
    }),
  )
  return `data:image/jpeg;base64,${data}`
}

/**
 * Scrolls the tagged element into view and returns its center in viewport
 * coordinates.
 */
async function elementCenter(id: string) {
  return rectSchema.parse(
    await evaluate((clefId) => {
      const el = document.querySelector(`[data-clef-id="${clefId}"]`)
      if (!el) throw new Error(`element ${clefId} is gone`)
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      })
      const rect = el.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, id),
  )
}

/** Real (trusted) mouse click via CDP input events. */
export async function click(id: string) {
  const { x, y } = await elementCenter(id)
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  })
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  })
}

/** Focuses the field, selects its existing contents, and types over them. */
export async function fill(id: string, text: string) {
  await click(id)
  await evaluate(() => {
    const el = document.activeElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      el.select()
    else if (el instanceof HTMLElement && el.isContentEditable)
      getSelection()?.selectAllChildren(el)
  })
  await cdp("Input.insertText", { text })
}

export async function selectOption(id: string, label: string) {
  await evaluate(
    ({ clefId, label }) => {
      const select = document.querySelector(`[data-clef-id="${clefId}"]`)
      if (!(select instanceof HTMLSelectElement))
        throw new Error(`element ${clefId} is not a <select>`)
      const option = [...select.options].find(
        (o) => o.textContent.trim() === label,
      )
      if (!option) throw new Error(`no option "${label}"`)
      select.value = option.value
      select.dispatchEvent(new Event("input", { bubbles: true }))
      select.dispatchEvent(new Event("change", { bubbles: true }))
    },
    { clefId: id, label },
  )
}

export async function selectOptions(id: string) {
  return z
    .array(z.string())
    .parse(
      await evaluate(
        (clefId) =>
          [...document.querySelectorAll(`[data-clef-id="${clefId}"] option`)]
            .map((o) => o.textContent.trim())
            .filter(Boolean),
        id,
      ),
    )
}

export async function pressEnter() {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" })
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key })
}

export async function scroll(direction: 1 | -1) {
  await evaluate(
    (dir) => scrollBy({ top: dir * innerHeight * 0.8, behavior: "instant" }),
    direction,
  )
}

export async function goBack() {
  await evaluate(() => history.back())
}

export async function innerText() {
  return z.string().parse(await evaluate(() => document.body.innerText))
}
