/*
 * Runs INSIDE the browser page (see snapshot.ts): transpiled to JS at runtime and injected via CDP, so it can only use
 * DOM globals and things defined in this file — no imports.
 */

function clean(text: string | false | null | undefined) {
  return text ? text.replaceAll(/\s+/g, " ").trim() : ""
}

function inViewport(r: DOMRect) {
  return (
    r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  )
}

/** Pixels between the element and the viewport (0 when visible). */
function distance(el: Element) {
  const r = el.getBoundingClientRect()
  return r.bottom < 0
    ? -r.bottom
    : r.top > innerHeight
      ? r.top - innerHeight
      : 0
}

/** ARIA role, falling back to the implicit role of native elements. */
function implicitRole(el: HTMLElement) {
  const explicit = el.getAttribute("role")
  if (explicit) return explicit
  if (el instanceof HTMLAnchorElement) return "link"
  if (el instanceof HTMLSelectElement) return "combobox"
  if (el instanceof HTMLTextAreaElement) return "textbox"
  if (el instanceof HTMLInputElement)
    return (
      {
        checkbox: "checkbox",
        radio: "radio",
        search: "searchbox",
        button: "button",
        submit: "button",
        range: "slider",
      }[el.type] ?? "textbox"
    )
  return el.tagName === "BUTTON" || el.tagName === "SUMMARY"
    ? "button"
    : el.tagName.toLowerCase()
}

/**
 * Tags interactive elements with `data-clef-id` and returns their descriptions,
 * plus either numbered overlay boxes (vision) or a whole-page text outline
 * (text).
 */
export function collect({
  selector,
  mode,
}: {
  selector: string
  mode: "vision" | "text"
}) {
  document.getElementById("__clef_overlay")?.remove()
  for (const el of document.querySelectorAll("[data-clef-id]"))
    el.removeAttribute("data-clef-id")

  const candidates = new Set(
    [...document.querySelectorAll(selector)].filter((el): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false
      if (
        !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      )
        return false
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return false
      if (!inViewport(r)) return mode === "text"
      // Drop on-screen elements covered by something else (modals, sticky headers)
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      )
      return !!hit && (el.contains(hit) || hit.contains(el))
    }),
  )
  // Prefer the innermost match so a <div onclick> wrapping a <button> doesn't produce two entries
  const leaves = [...candidates].filter(
    (el) =>
      ![...el.querySelectorAll(selector)].some(
        (d) => d instanceof HTMLElement && candidates.has(d),
      ),
  )
  const kept = new Set(
    [...leaves].toSorted((a, b) => distance(a) - distance(b)).slice(0, 254),
  )
  const targets = leaves.filter((el) => kept.has(el))

  const elements = targets.map((el, i) => {
    const id = `e${i + 1}`
    el.setAttribute("data-clef-id", id)
    const input =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el
        : null
    const formField = input ?? (el instanceof HTMLSelectElement ? el : null)
    const labelledBy = el
      .getAttribute("aria-labelledby")
      ?.split(" ")
      .map((ref) => document.getElementById(ref)?.innerText)
      .join(" ")
    const parts = [
      el.getAttribute("aria-label"),
      labelledBy,
      ...[...(formField?.labels ?? [])].map((l) => l.innerText),
      formField?.name && `name=${formField.name}`,
      input?.placeholder,
      input &&
        input.type !== "checkbox" &&
        input.type !== "radio" &&
        input.value &&
        `value="${input.value}"`,
      el instanceof HTMLSelectElement &&
        `selected="${el.selectedOptions[0]?.text ?? ""}"`,
      el.innerText,
      el.getAttribute("title"),
      el.getAttribute("alt"),
    ].map(clean)
    const states = [
      ((input instanceof HTMLInputElement && input.checked) ||
        el.getAttribute("aria-checked") === "true") &&
        "checked",
      el.getAttribute("aria-selected") === "true" && "selected",
      el.getAttribute("aria-pressed") === "true" && "pressed",
      el.getAttribute("aria-expanded") &&
        `expanded=${el.getAttribute("aria-expanded")}`,
      (el.matches(":disabled") ||
        el.getAttribute("aria-disabled") === "true") &&
        "disabled",
      document.activeElement === el && "focused",
    ].filter(Boolean)
    const r = el.getBoundingClientRect()
    const screens = Math.max(1, Math.round(distance(el) / innerHeight))
    return {
      id,
      tag: el.tagName.toLowerCase(),
      role: implicitRole(el),
      label: [...new Set([...parts.filter(Boolean), ...states])]
        .join(" | ")
        .slice(0, 120),
      href: el.getAttribute("href")?.slice(0, 80) ?? null,
      // Whether text can be typed into it; custom widgets (div role=combobox, etc.) get clicked instead
      editable:
        el.isContentEditable ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
          ![
            "radio",
            "checkbox",
            "button",
            "submit",
            "reset",
            "image",
            "file",
            "range",
            "color",
          ].includes(el.type)),
      offscreen: inViewport(r)
        ? null
        : `${r.top < 0 ? "above" : "below"}, ~${screens} screen${screens > 1 ? "s" : ""}`,
    }
  })

  if (mode === "vision") {
    const overlay = document.createElement("div")
    overlay.id = "__clef_overlay"
    overlay.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
    document.documentElement.append(overlay)
    for (const [i, el] of targets.entries()) {
      const r = el.getBoundingClientRect()
      const box = document.createElement("div")
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e11d48;`
      const tag = document.createElement("span")
      tag.textContent = String(i + 1)
      tag.style.cssText =
        "position:absolute;right:0;top:0;background:rgba(225,29,72,.85);color:#fff;font:bold 10px/11px monospace;padding:0 2px"
      box.append(tag)
      overlay.append(box)
    }
    return { elements, outline: null }
  }

  // Text outline: landmarks as nested sections, headings as #, one line per block of text with interactive elements
  // inlined as [n] role "label". Interactive elements' own text is in their label, so their subtrees are skipped.
  const lineFor = new Map(
    elements.map((e) => [
      e.id,
      `[${e.id.slice(1)}] ${e.role} "${e.label}"${e.offscreen ? ` (${e.offscreen})` : ""}`,
    ]),
  )
  const landmarks: Record<string, string> = {
    NAV: "navigation",
    MAIN: "main",
    HEADER: "header",
    FOOTER: "footer",
    ASIDE: "sidebar",
    FORM: "form",
    DIALOG: "dialog",
  }
  const landmarkRoles = [
    "navigation",
    "main",
    "banner",
    "contentinfo",
    "complementary",
    "form",
    "dialog",
    "alertdialog",
    "search",
    "menu",
    "listbox",
    "tablist",
    "grid",
    "region",
    "alert",
    "status",
  ]
  const lines: string[] = []
  let pending = ""
  const flush = (depth: number) => {
    const text = clean(pending)
    if (text) lines.push(`${"  ".repeat(depth)}${text.slice(0, 800)}`)
    pending = ""
  }

  const walk = (node: Node, depth: number) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        pending += ` ${child.textContent}`
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      if (
        ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME"].includes(
          child.tagName,
        )
      )
        continue
      if (
        child.getAttribute("aria-hidden") === "true" ||
        !child.checkVisibility({ visibilityProperty: true })
      )
        continue

      const indent = "  ".repeat(depth)
      const id = child.getAttribute("data-clef-id")
      if (id) {
        // Inline with surrounding text so a row like `1. [13] link "Title" (example.com) 42 points` stays together
        pending += ` ${lineFor.get(id)} `
        continue
      }
      const level = /^H[1-6]$/.test(child.tagName)
        ? Number(child.tagName[1])
        : child.getAttribute("role") === "heading"
          ? Number(child.getAttribute("aria-level") ?? 2)
          : 0
      if (level) {
        // Walk instead of using innerText so links inside headings (e.g. GitHub repo names) still get numbered
        flush(depth)
        pending = `${"#".repeat(level)} `
        walk(child, depth)
        flush(depth)
        continue
      }
      const role = child.getAttribute("role")
      const landmark =
        role && landmarkRoles.includes(role) ? role : landmarks[child.tagName]
      if (landmark) {
        flush(depth)
        const name = clean(child.getAttribute("aria-label"))
        lines.push(`${indent}<${landmark}${name ? ` "${name}"` : ""}>`)
        walk(child, depth + 1)
        flush(depth + 1)
        continue
      }
      const block = !getComputedStyle(child).display.startsWith("inline")
      if (block) flush(depth)
      walk(child, depth)
      if (block) flush(depth)
    }
  }
  walk(document.body, 0)
  flush(0)

  const header = `(viewport shows y=${Math.round(scrollY)}–${Math.round(scrollY + innerHeight)} of a ${document.documentElement.scrollHeight}px page)`
  const body = lines.join("\n")
  return {
    elements,
    outline: `${header}\n${body.length > 40_000 ? `${body.slice(0, 40_000)}\n…(truncated)` : body}`,
  }
}
