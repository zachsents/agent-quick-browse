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

/**
 * Elements where a pointer cursor starts (its parent doesn't have one). Catches
 * click targets wired up purely in JS, like Gmail's row actions (`<li
 * data-tooltip="Archive">`), which no role/tag selector matches. The cursor is
 * inherited, so only the outermost element of each pointer region is taken.
 */
function pointerTargets() {
  return [...document.body.querySelectorAll("*")].filter(
    (el) =>
      el instanceof HTMLElement &&
      getComputedStyle(el).cursor === "pointer" &&
      // Outermost element of a pointer region, or a named control inside one (Gmail rows are all pointer)
      (el.matches("[aria-label], [title], [data-tooltip]") ||
        !(
          el.parentElement &&
          getComputedStyle(el.parentElement).cursor === "pointer"
        )),
  )
}

/** All ancestors of an element, nearest first. */
function ancestors(el: Element) {
  const chain: Element[] = []
  for (let parent = el.parentElement; parent; parent = parent.parentElement)
    chain.push(parent)
  return chain
}

/**
 * "checked" / "unchecked" for anything that acts as a toggle, else false.
 * Covers native checkboxes and radios, ARIA switches and checkboxes, and custom
 * switches that wrap or label a hidden checkbox (TikTok's AI-content toggle),
 * whose state is otherwise invisible in text.
 */
function toggleState(el: HTMLElement) {
  const aria = el.getAttribute("aria-checked")
  if (aria === "true" || aria === "false")
    return aria === "true" ? "checked" : "unchecked"
  const box =
    el instanceof HTMLInputElement
      ? el
      : el instanceof HTMLLabelElement
        ? el.control
        : el.querySelector(
            "input[type=checkbox], input[type=radio], [role=switch], [role=checkbox]",
          )
  if (
    box instanceof HTMLInputElement &&
    (box.type === "checkbox" || box.type === "radio")
  )
    return box.checked ? "checked" : "unchecked"
  const nestedAria = box?.getAttribute("aria-checked")
  return nestedAria === "true"
    ? "checked"
    : nestedAria === "false"
      ? "unchecked"
      : false
}

/**
 * True when a scrolling or clipping ancestor (e.g. a list with overflow: auto)
 * hides the element's center.
 */
function clippedByContainer(el: Element) {
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  for (
    let parent = el.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    if (getComputedStyle(parent).overflow === "visible") continue
    const p = parent.getBoundingClientRect()
    if (x < p.left || x > p.right || y < p.top || y > p.bottom) return true
  }
  return false
}

/**
 * For list items and options, which list they're in ("in minutes"), taken from
 * the list's aria-label, labelling element, or id. Bare items like "12" are
 * otherwise ambiguous when a picker has several lists (hours vs minutes).
 */
function listContext(el: HTMLElement) {
  if (
    !el.matches("li, option, [role=option], [role=menuitem], [role=gridcell]")
  )
    return ""
  const list = el.closest(
    "ul, ol, select, [role=listbox], [role=menu], [role=grid], [role=list]",
  )
  if (!list) return ""
  const labelledBy = list.getAttribute("aria-labelledby")
  const name =
    list.getAttribute("aria-label") ??
    (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ??
    (/^[a-z][\w-]{2,30}$/i.test(list.id) ? list.id : null)
  return name ? `in ${clean(name)}` : ""
}

/**
 * "attached: a.pdf, b.png" for a file input, or for an upload button / drop
 * zone sitting next to one (the input is often hidden behind the button), so
 * the model can see an upload already happened.
 */
function attachedFiles(el: HTMLElement) {
  let input: Element | null = el.matches("input[type=file]") ? el : null
  for (
    let scope: Element | null = el, depth = 0;
    !input && scope && depth < 3;
    scope = scope.parentElement, depth++
  )
    input = scope.querySelector("input[type=file]")
  const names =
    input instanceof HTMLInputElement
      ? [...(input.files ?? [])].map((file) => file.name)
      : []
  return names.length ? `attached: ${names.join(", ")}` : ""
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
        file: "file upload",
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
 * Tags interactive elements with `data-aqb-id` and returns their descriptions,
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
  document.getElementById("__aqb_overlay")?.remove()
  for (const el of document.querySelectorAll("[data-aqb-id]"))
    el.removeAttribute("data-aqb-id")

  // Controls hidden with opacity/visibility (not display:none) that sit in the viewport usually appear on hover
  const hoverOnly = new Set<Element>()
  const candidates = new Set(
    [...document.querySelectorAll(selector), ...pointerTargets()].filter(
      (el): el is HTMLElement => {
        if (!(el instanceof HTMLElement) || !el.checkVisibility()) return false
        // Links and buttons inside a rich-text editor are part of its content; the editor itself is the target
        if (el.parentElement?.isContentEditable) return false
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) return false
        const shown = el.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        })
        if (!inViewport(r)) return shown && mode === "text"
        // Scrolled out of view inside a list or panel: actionable in text mode (it gets scrolled into view first), but
        // not visible in a screenshot
        if (clippedByContainer(el)) return shown && mode === "text"
        // Drop on-screen elements covered by something else (modals, sticky headers)
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        )
        if (!hit || !(el.contains(hit) || hit.contains(el))) return false
        if (!shown) hoverOnly.add(el)
        return true
      },
    ),
  )
  // Prefer the innermost match so a <div onclick> wrapping a <button> doesn't produce two entries. Only visible
  // descendants count, so a row isn't dropped in favor of its hover-only buttons.
  const hasCandidateInside = new Set<Element>(
    [...candidates]
      .filter((el) => !hoverOnly.has(el))
      .flatMap((el) => ancestors(el)),
  )
  // A rich-text editor root stays a target even when its content holds links or mentions
  const leaves = [...candidates].filter(
    (el) => !hasCandidateInside.has(el) || el.isContentEditable,
  )
  const kept = new Set(
    [...leaves].toSorted((a, b) => distance(a) - distance(b)).slice(0, 254),
  )
  const targets = leaves.filter((el) => kept.has(el))

  const elements = targets.map((el, i) => {
    const id = `e${i + 1}`
    el.setAttribute("data-aqb-id", id)
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
      el.getAttribute("data-tooltip"),
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
      toggleState(el),
      el.getAttribute("aria-selected") === "true" && "selected",
      el.getAttribute("aria-pressed") === "true" && "pressed",
      el.getAttribute("aria-expanded") &&
        `expanded=${el.getAttribute("aria-expanded")}`,
      (el.matches(":disabled") ||
        el.getAttribute("aria-disabled") === "true") &&
        "disabled",
      document.activeElement === el && "focused",
      hoverOnly.has(el) && "shows on hover",
    ].filter(Boolean)
    const r = el.getBoundingClientRect()
    const screens = Math.max(1, Math.round(distance(el) / innerHeight))
    return {
      id,
      tag: el.tagName.toLowerCase(),
      role: implicitRole(el),
      label: [
        ...new Set(
          [
            ...parts.filter(Boolean),
            ...states,
            listContext(el),
            attachedFiles(el),
          ].filter(Boolean),
        ),
      ]
        .join(" | ")
        .slice(0, 120),
      href: el.getAttribute("href")?.slice(0, 80) ?? null,
      // Whether text can be typed into it; custom widgets (div role=combobox, etc.) get clicked instead
      // Read-only or disabled fields (e.g. TikTok's time box, set via its pickers) can't be typed into
      editable:
        !el.matches(
          ":disabled, [readonly], [aria-readonly=true], [aria-disabled=true]",
        ) &&
        (el.isContentEditable ||
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
            ].includes(el.type))),
      offscreen: clippedByContainer(el)
        ? "scrolled out of view in its list/panel"
        : inViewport(r)
          ? null
          : `${r.top < 0 ? "above" : "below"}, ~${screens} screen${screens > 1 ? "s" : ""}`,
    }
  })

  if (mode === "vision") {
    const overlay = document.createElement("div")
    overlay.id = "__aqb_overlay"
    overlay.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
    document.documentElement.append(overlay)
    for (const [i, el] of targets.entries()) {
      const r = el.getBoundingClientRect()
      const box = document.createElement("div")
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px ${hoverOnly.has(el) ? "dashed" : "solid"} #e11d48;`
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
      const id = child.getAttribute("data-aqb-id")
      if (id) {
        // Inline with surrounding text so a row like `1. [13] link "Title" (example.com) 42 points` stays together.
        // Numbered controls nested inside (e.g. a row's hover-only buttons) follow it, since the row's subtree is skipped.
        const nested = [...child.querySelectorAll("[data-aqb-id]")].map((el) =>
          lineFor.get(el.getAttribute("data-aqb-id") ?? ""),
        )
        pending += ` ${[lineFor.get(id), ...nested].join(" ")} `
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
