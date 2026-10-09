import { z } from "zod"
import * as tab from "./tab.ts"

const pageElementSchema = z.object({
  id: z.string(),
  tag: z.string(),
  role: z.string(),
  label: z.string(),
  editable: z.boolean(),
  href: z.string().nullable(),
  offscreen: z.string().nullable(),
})

export type PageElement = z.infer<typeof pageElementSchema>

/**
 * "vision": viewport elements + annotated screenshot. "text": whole-page
 * outline, no screenshot.
 */
export type SnapshotMode = "vision" | "text"

/**
 * Page/collect.ts as plain JS (types and `export`s stripped), ready to inject.
 * Loaded once per process.
 */
const collectScript = Bun.file(new URL("page/collect.ts", import.meta.url))
  .text()
  .then((source) =>
    new Bun.Transpiler({ loader: "ts" })
      .transformSync(source)
      .replaceAll(/^export /gm, ""),
  )

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "summary",
  "[contenteditable=true]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
  ...[
    "button",
    "link",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "checkbox",
    "radio",
    "option",
    "combobox",
    "textbox",
    "searchbox",
    "switch",
    "slider",
    "treeitem",
  ].map((role) => `[role=${role}]`),
].join(",")

/**
 * Tags interactive elements with `data-aqb-id` and describes the page for the
 * decision model. Vision mode tags only what's in the viewport and returns a
 * screenshot with numbered boxes drawn on it. Text mode tags elements across
 * the whole page (marking off-screen ones) and returns a structured text
 * outline instead. Capped at 254 elements because choice questions allow at
 * most 255 options; the ones nearest the viewport win.
 */
export async function snapshotPage(mode: SnapshotMode) {
  const { elements, outline } = z
    .object({
      elements: z.array(pageElementSchema),
      outline: z.string().nullable(),
    })
    .parse(
      await tab.evaluateExpression(
        `(() => {\n${await collectScript}\nreturn collect(${JSON.stringify({ selector: INTERACTIVE_SELECTOR, mode })})\n})()`,
      ),
    )
  if (mode === "text")
    return { elements, outline: outline ?? "", screenshot: null }

  const screenshot = await tab.screenshot()
  await tab.evaluate(() => document.getElementById("__aqb_overlay")?.remove())
  return { elements, outline: null, screenshot }
}

/** One-line description of an element for the model. */
export function describeElement({
  id,
  role,
  tag,
  label,
  href,
  offscreen,
}: PageElement) {
  return `[${id.slice(1)}] ${role}${role === tag ? "" : ` <${tag}>`} ${label || "(no text)"}${href ? ` -> ${href}` : ""}${offscreen ? ` (${offscreen})` : ""}`
}
