import { z } from "zod"
import * as tab from "./tab.ts"

const pageElementSchema = z.object({
  id: z.string(),
  tag: z.string(),
  role: z.string().nullable(),
  type: z.string().nullable(),
  label: z.string(),
  href: z.string().nullable(),
})

export type PageElement = z.infer<typeof pageElementSchema>

/**
 * Tags every visible interactive element in the viewport with `data-clef-id`,
 * draws numbered boxes over them, screenshots the viewport, then removes the
 * overlay. Returns the element list and a JPEG data URL Clef can read. Capped
 * at 254 elements because Clef choice questions allow at most 255 options.
 */
export async function snapshotPage() {
  const elements = z
    .array(pageElementSchema)
    .parse(await tab.evaluate(collectAndLabel))
  const screenshot = await tab.screenshot()
  await tab.evaluate(() => document.getElementById("__clef_overlay")?.remove())
  return { elements, screenshot }
}

/** Runs inside the page, so it must be fully self-contained. */
function collectAndLabel(): PageElement[] {
  document.getElementById("__clef_overlay")?.remove()
  for (const el of document.querySelectorAll("[data-clef-id]"))
    el.removeAttribute("data-clef-id")

  const selector = [
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
      "checkbox",
      "radio",
      "option",
      "combobox",
      "textbox",
      "searchbox",
      "switch",
    ].map((role) => `[role=${role}]`),
  ].join(",")

  const visible = [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) return false
      if (
        rect.bottom < 0 ||
        rect.top > innerHeight ||
        rect.right < 0 ||
        rect.left > innerWidth
      )
        return false
      const style = getComputedStyle(el)
      if (style.visibility === "hidden" || style.opacity === "0") return false
      // Drop elements covered by something else (modals, sticky headers)
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      )
      return !!hit && (el.contains(hit) || hit.contains(el))
    },
  )
  // Prefer the innermost match so a <div onclick> wrapping a <button> doesn't produce two labels
  const leaves = visible
    .filter(
      (el) => !visible.some((other) => other !== el && el.contains(other)),
    )
    .slice(0, 254)

  const overlay = document.createElement("div")
  overlay.id = "__clef_overlay"
  overlay.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
  document.documentElement.append(overlay)

  return leaves.map((el, i) => {
    const id = `e${i + 1}`
    el.setAttribute("data-clef-id", id)
    const rect = el.getBoundingClientRect()
    const box = document.createElement("div")
    box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid #e11d48;`
    const tag = document.createElement("span")
    tag.textContent = String(i + 1)
    tag.style.cssText =
      "position:absolute;right:0;top:0;background:rgba(225,29,72,.85);color:#fff;font:bold 10px/11px monospace;padding:0 2px"
    box.append(tag)
    overlay.append(box)

    const input =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el
        : null
    const parts = [
      el.getAttribute("aria-label"),
      input?.placeholder,
      input?.value && `value="${input.value}"`,
      el.innerText,
      el.getAttribute("title"),
      el.getAttribute("alt"),
    ].map((part) => part?.replaceAll(/\s+/g, " ").trim())
    const label = [...new Set(parts.filter(Boolean))].join(" | ").slice(0, 100)

    return {
      id,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      type: el.getAttribute("type"),
      label,
      href: el.getAttribute("href")?.slice(0, 80) ?? null,
    }
  })
}

/** One-line human/model readable description of an element. */
export function describeElement({
  id,
  tag,
  role,
  type,
  label,
  href,
}: PageElement) {
  return `[${id.slice(1)}] <${tag}${type ? ` type=${type}` : ""}${role ? ` role=${role}` : ""}> ${label || "(no text)"}${href ? ` -> ${href}` : ""}`
}
