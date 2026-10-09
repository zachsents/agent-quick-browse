import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import { SOCKET_PATH } from "./paths.ts"

const sessionStore = new AsyncLocalStorage<{
  session: string
  group?: string
}>()

/** The current session's name ("default" outside withSession). */
function currentSession() {
  return sessionStore.getStore()?.session ?? "default"
}

/**
 * Runs `fn` against the named session's tab. Each session has its own tab, so
 * sessions can run in parallel. `group` names the tab group the session's tab
 * goes in (default "AQB"); sessions with the same group share it.
 */
export function withSession<T>(
  session: string,
  fn: () => Promise<T>,
  options: { group?: string } = {},
) {
  return sessionStore.run({ session, ...options }, fn)
}

/**
 * Closes the session's tabs (a tab taken over with `adopt` is still handed
 * back, never closed).
 */
export async function close() {
  await rpc("close")
}

/**
 * Ends the session. Tabs it opened close unless `keepOpen`; a tab it took over
 * (or any tab, with `keepOpen`) is handed back: debugger detached and removed
 * from the agent's group, back into its original group if it had one.
 */
export async function release(keepOpen?: boolean) {
  await rpc("release", { keepOpen })
}

const tabListSchema = z.array(
  z.object({
    tabId: z.number(),
    title: z.string(),
    url: z.string(),
    active: z.boolean(),
    windowId: z.number(),
    group: z.string().nullable(),
    session: z.string().nullable(),
  }),
)

/**
 * Every open tab in Chrome, with its group and the session controlling it (if
 * any).
 */
export async function listTabs() {
  return tabListSchema.parse(await rpc("tabs"))
}

/**
 * Makes an already-open tab this session's tab. Releasing the session hands it
 * back.
 */
export async function adopt(tabId: number) {
  return z
    .object({ url: z.string(), title: z.string() })
    .parse(await rpc("adopt", { tabId }))
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

async function rpc(
  method: "cdp" | "tab" | "close" | "release" | "tabs" | "adopt",
  params?: object,
) {
  const res = await fetch("http://localhost/rpc", {
    unix: SOCKET_PATH,
    method: "POST",
    body: JSON.stringify({
      method,
      params: {
        ...params,
        ...sessionStore.getStore(),
        session: currentSession(),
      },
    }),
  }).catch(() => {
    throw new Error(
      "Can't reach the Agent Quick Browse Bridge. Is Chrome running with the extension loaded? (run `aqb setup`)",
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

const scrollMovesSchema = z.array(
  z.object({
    id: z.string(),
    from: z.tuple([z.number(), z.number()]),
    to: z.tuple([z.number(), z.number()]),
  }),
)

/**
 * Scrolls the tagged element into view with an animation driven from here
 * (~300ms of eased frames), then returns a point that actually hits it.
 * Chrome's own smooth scrolling crawls in hidden background tabs, so the page
 * only computes where each scroll container needs to end up and we step them
 * there. The hit point uses the element's individual line boxes, because the
 * bounding-box center of a link that wraps onto two lines falls in the gap.
 */
async function elementCenter(id: string) {
  const moves = scrollMovesSchema.parse(
    await evaluate((targetId) => {
      const el = document.querySelector(`[data-aqb-id="${targetId}"]`)
      if (!el) throw new Error(`element ${targetId} is gone`)
      const r = el.getBoundingClientRect()
      if (
        r.top >= 0 &&
        r.left >= 0 &&
        r.bottom <= innerHeight &&
        r.right <= innerWidth
      )
        return []
      const scrollers: Element[] = []
      for (let parent = el.parentElement; parent; parent = parent.parentElement)
        scrollers.push(parent)
      const before = scrollers.map((s) => [s.scrollLeft, s.scrollTop] as const)
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      })
      // Record each container's destination, then put it back so the animation can play from the start
      return scrollers.flatMap((s, i) => {
        const [left, top] = before[i] ?? [0, 0]
        if (s.scrollLeft === left && s.scrollTop === top) return []
        const to = [s.scrollLeft, s.scrollTop]
        s.scrollLeft = left
        s.scrollTop = top
        s.setAttribute("data-aqb-scroll", String(i))
        return [{ id: String(i), from: [left, top], to }]
      })
    }, id),
  )
  if (moves.length) await animateScroll(moves)

  return rectSchema.parse(
    await evaluate((targetId) => {
      const el = document.querySelector(`[data-aqb-id="${targetId}"]`)
      if (!el) throw new Error(`element ${targetId} is gone`)
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
 * Steps the given scroll containers from their start to end positions over
 * ~300ms of eased frames.
 */
async function animateScroll(moves: z.infer<typeof scrollMovesSchema>) {
  await playFrames(300, (eased, isLast) => ({
    method: "Runtime.evaluate",
    params: {
      expression: `(${applyScroll.toString()})(${JSON.stringify({ moves, eased, isLast })})`,
    },
  }))
}

/** Runs in the page: sets each tagged scroll container to its eased position. */
function applyScroll({
  moves,
  eased,
  isLast,
}: {
  moves: z.infer<typeof scrollMovesSchema>
  eased: number
  isLast: boolean
}) {
  for (const { id, from, to } of moves) {
    const el = document.querySelector(`[data-aqb-scroll="${id}"]`)
    if (!el) continue
    el.scrollLeft = from[0] + (to[0] - from[0]) * eased
    el.scrollTop = from[1] + (to[1] - from[1]) * eased
    if (isLast) el.removeAttribute("data-aqb-scroll")
  }
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
  const session = currentSession()
  const from = pointers.get(session) ?? { x, y }
  const duration = Math.min(500, 100 + Math.hypot(x - from.x, y - from.y) * 0.4)
  await showOrb(
    `glide(${JSON.stringify(from)}, ${JSON.stringify({ x, y })}, ${duration})`,
  )
  await playFrames(duration, (eased) => ({
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mouseMoved",
      x: from.x + (x - from.x) * eased,
      y: from.y + (y - from.y) * eased,
    },
  }))
  pointers.set(session, { x, y })
}

/**
 * Animates the visible pointer orb the extension injects (`window.__aqbOrb`).
 * It's driven explicitly rather than by mouse events so the user's own mouse
 * never makes it appear. A no-op on pages without it.
 */
async function showOrb(call: string) {
  await cdp("Runtime.evaluate", { expression: `window.__aqbOrb?.${call}` })
}

/** Ease-in-out curve for animations, t in [0, 1]. */
function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

/**
 * Plays an animation by sending one CDP command per ~16ms frame over `duration`
 * ms, paced from here. (Handing the whole sequence to the extension to play was
 * measured to be choppier under load: its timers stall while it relays
 * screenshots for other sessions.)
 */
async function playFrames(
  duration: number,
  frame: (
    eased: number,
    isLast: boolean,
  ) => { method: string; params: Record<string, unknown> },
) {
  const frames = Math.max(1, Math.round(duration / 16))
  const started = performance.now()
  for (let i = 1; i <= frames; i++) {
    const { method, params } = frame(easeInOut(i / frames), i === frames)
    await cdp(method, params)
    await Bun.sleep(
      Math.max(0, started + (i / frames) * duration - performance.now()),
    )
  }
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
  await showOrb(`click(${JSON.stringify({ x, y })})`)
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

/**
 * Attaches local files to the file input behind a numbered element: the input
 * itself, an upload button or drop zone that contains or labels one, or the
 * page's only file input. Uses CDP, so no OS file picker ever opens.
 */
export async function upload(id: string, paths: string[]) {
  const { result } = z
    .object({ result: z.object({ objectId: z.string().optional() }) })
    .parse(
      await cdp("Runtime.evaluate", {
        expression: `(${findFileInput.toString()})(${JSON.stringify(id)})`,
      }),
    )
  if (!result.objectId)
    throw new Error("no file input found behind this element")
  await cdp("DOM.setFileInputFiles", {
    files: paths,
    objectId: result.objectId,
  })
}

/**
 * Runs in the page: finds the `<input type=file>` a numbered element stands for
 * (often hidden behind a button).
 */
function findFileInput(targetId: string) {
  const el = document.querySelector(`[data-aqb-id="${targetId}"]`)
  if (!el) throw new Error(`element ${targetId} is gone`)
  if (el.matches("input[type=file]")) return el
  if (el instanceof HTMLLabelElement && el.control?.matches("input[type=file]"))
    return el.control
  for (
    let scope: Element | null = el, depth = 0;
    scope && depth < 5;
    scope = scope.parentElement, depth++
  ) {
    const input = scope.querySelector("input[type=file]")
    if (input) return input
  }
  const all = document.querySelectorAll("input[type=file]")
  return all.length === 1 ? all[0] : null
}

export async function selectOption(id: string, label: string) {
  await evaluate(
    ({ targetId, label }) => {
      const select = document.querySelector(`[data-aqb-id="${targetId}"]`)
      if (!(select instanceof HTMLSelectElement))
        throw new Error(`element ${targetId} is not a <select>`)
      const option = [...select.options].find(
        (o) => o.textContent.trim() === label,
      )
      if (!option) throw new Error(`no option "${label}"`)
      select.value = option.value
      select.dispatchEvent(new Event("input", { bubbles: true }))
      select.dispatchEvent(new Event("change", { bubbles: true }))
    },
    { targetId: id, label },
  )
}

export async function selectOptions(id: string) {
  return z
    .array(z.string())
    .parse(
      await evaluate(
        (targetId) =>
          [...document.querySelectorAll(`[data-aqb-id="${targetId}"] option`)]
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

/**
 * Scrolls ~80% of a screen with real mouse-wheel events at the pointer, eased
 * over ~300ms. Like a person's scroll, it moves whatever is under the mouse
 * (e.g. Gmail's message list) and triggers infinite scroll / lazy loading.
 */
export async function scroll(direction: 1 | -1) {
  const viewport = z
    .object({ width: z.number(), height: z.number() })
    .parse(await evaluate(() => ({ width: innerWidth, height: innerHeight })))
  const session = currentSession()
  const center = { x: viewport.width / 2, y: viewport.height / 2 }
  const pointer = pointers.get(session) ?? center
  // Like a person, move the mouse over the content first if nothing under it can scroll
  const canScrollHere = z.boolean().parse(
    await evaluate(({ x, y }) => {
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement)
        if (
          el.scrollHeight > el.clientHeight + 1 &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY)
        )
          return true
      const root = document.scrollingElement
      return !!root && root.scrollHeight > root.clientHeight + 1
    }, pointer),
  )
  if (!canScrollHere) await movePointer(center.x, center.y)
  const { x, y } = canScrollHere ? pointer : center
  const total = direction * viewport.height * 0.8
  // Wheel deltas are per frame, so send the difference between consecutive eased positions
  let scrolled = 0
  await playFrames(300, (eased) => {
    const delta = total * eased - scrolled
    scrolled = total * eased
    return {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x, y, deltaX: 0, deltaY: delta },
    }
  })
}

export async function goBack() {
  await evaluate(() => history.back())
}

export async function innerText() {
  return z.string().parse(await evaluate(() => document.body.innerText))
}
