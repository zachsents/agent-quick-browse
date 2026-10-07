import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import { SOCKET_PATH } from "./paths.ts"

const sessionStore = new AsyncLocalStorage<string>()

/**
 * Runs `fn` against the named session's agent tab. Each session has its own
 * background tab, so sessions can run in parallel. Calls outside withSession
 * use the "default" session.
 */
export function withSession<T>(session: string, fn: () => Promise<T>) {
  return sessionStore.run(session, fn)
}

/** Closes the session's agent tab. */
export async function close() {
  await rpc("close")
}

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

async function rpc(method: "cdp" | "tab" | "close", params?: object) {
  const res = await fetch("http://localhost/rpc", {
    unix: SOCKET_PATH,
    method: "POST",
    body: JSON.stringify({
      method,
      params: { ...params, session: sessionStore.getStore() ?? "default" },
    }),
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
  return evaluateExpression(`(${fn.toString()})(${JSON.stringify(arg)})`)
}

/**
 * Evaluates a JS expression in the agent tab (awaiting promises) and returns
 * its JSON-serializable value.
 */
export async function evaluateExpression(expression: string) {
  const { result, exceptionDetails } = evaluateResultSchema.parse(
    await cdp("Runtime.evaluate", {
      expression,
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
 * Waits until the page is parsed and then visually settled: no DOM mutations
 * for 500ms (max ~6s). The settle step matters for SPAs like Gmail, which
 * report "complete" while still showing a splash screen.
 */
export async function waitForLoad() {
  for (let i = 0; i < 25; i++) {
    // Evaluate throws while a navigation swaps the document; treat that as still loading
    const ready = await evaluate(() => document.readyState).catch(
      () => "loading",
    )
    if (ready !== "loading") break
    await Bun.sleep(200)
  }
  await evaluate(
    () =>
      new Promise<void>((resolve) => {
        const finish = () => {
          observer.disconnect()
          clearTimeout(maxTimer)
          resolve()
        }
        let quietTimer = setTimeout(finish, 500)
        const maxTimer = setTimeout(finish, 4000)
        const observer = new MutationObserver(() => {
          clearTimeout(quietTimer)
          quietTimer = setTimeout(finish, 500)
        })
        // Structural changes only: spinners/animations churn attributes forever
        observer.observe(document, {
          subtree: true,
          childList: true,
          characterData: true,
        })
      }),
  ).catch(() => undefined)
}

/**
 * Viewport screenshot at CSS-pixel resolution (not retina) to keep Clef
 * requests small. CDP's clip is measured in unzoomed pixels, so it's scaled by
 * the page zoom (e.g. 125%) to cover the whole viewport. Works while the tab is
 * in the background — it captures the tab's own rendering, not the screen.
 */
export async function screenshot() {
  const [metrics, dpr] = await Promise.all([
    cdp("Page.getLayoutMetrics"),
    evaluate(() => devicePixelRatio),
  ])
  const viewport = z
    .object({
      clientWidth: z.number(),
      clientHeight: z.number(),
      zoom: z.number(),
    })
    .parse(
      z.object({ cssVisualViewport: z.unknown() }).parse(metrics)
        .cssVisualViewport,
    )
  const { data } = z.object({ data: z.string() }).parse(
    await cdp("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: {
        x: 0,
        y: 0,
        width: viewport.clientWidth * viewport.zoom,
        height: viewport.clientHeight * viewport.zoom,
        scale: 1 / z.number().parse(dpr),
      },
    }),
  )
  return `data:image/jpeg;base64,${data}`
}

/**
 * Scrolls the tagged element into view and returns a point that actually hits
 * it. Uses the element's individual line boxes, because the bounding-box center
 * of a link that wraps onto two lines falls in the gap between them.
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
      const centers = [...el.getClientRects(), el.getBoundingClientRect()]
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))
      const hits = centers.find(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        return !!hit && (el === hit || el.contains(hit) || hit.contains(el))
      })
      return hits ?? centers.at(-1)
    }, id),
  )
}

/**
 * Last pointer position per session, so movement starts where the mouse
 * actually is.
 */
const pointers = new Map<string, { x: number; y: number }>()

/**
 * Glides the mouse to (x, y) at roughly human speed (100–500ms depending on
 * distance, eased in and out) with a mouseMoved event per ~16ms frame, so
 * elements along the path get real hover, mouseenter, and mouseleave events.
 */
async function movePointer(x: number, y: number) {
  const session = sessionStore.getStore() ?? "default"
  const from = pointers.get(session) ?? { x, y }
  const duration = Math.min(500, 100 + Math.hypot(x - from.x, y - from.y) * 0.4)
  const frames = Math.max(1, Math.round(duration / 16))
  const started = performance.now()
  for (let frame = 1; frame <= frames; frame++) {
    const t = frame / frames
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + (x - from.x) * eased,
      y: from.y + (y - from.y) * eased,
    })
    await Bun.sleep(Math.max(0, started + t * duration - performance.now()))
  }
  pointers.set(session, { x, y })
}

/**
 * Moves the mouse onto the element and leaves it there, revealing hover-only
 * controls and menus.
 */
export async function hover(id: string) {
  const { x, y } = await elementCenter(id)
  await movePointer(x, y)
}

/**
 * Real (trusted) mouse click via CDP input events, after gliding the pointer
 * onto the element.
 */
export async function click(id: string) {
  const { x, y } = await elementCenter(id)
  await movePointer(x, y)
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
