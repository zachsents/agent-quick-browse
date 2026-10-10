// Widgets that copy real creator-studio markup (TikTok Studio, YouTube Studio) for the "app" benchmark levels.
// Each page exposes window.benchState() so trials check the exact end state.

/** Element from an HTML string. */
function html(source) {
  const template = document.createElement("template")
  template.innerHTML = source.trim()
  return template.content.firstElementChild
}

/**
 * Rich-text editor with a hashtag suggestion popup, like TikTok's caption box
 * and YouTube's title: typing "#word" opens a listbox that covers the controls
 * below it. Enter while it's open swaps the tag for the first suggestion
 * ("#shorts" → "#shortsbeta"), clicking an option inserts it, Escape or leaving
 * the editor closes it.
 */
function hashtagEditor(label) {
  const wrap = html(
    `<div class="editor-wrap"><div class="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${label}"></div></div>`,
  )
  const editor = wrap.firstElementChild
  const popup = html(`<div class="suggestions" role="listbox" hidden></div>`)
  wrap.append(popup)
  const partialTag = () =>
    /#(\w*)$/.exec(editor.innerText.replace(/\n$/, ""))?.[1]
  const close = () => (popup.hidden = true)
  const replaceTag = (tag) => {
    editor.innerText = editor.innerText
      .replace(/\n$/, "")
      .replace(/#\w*$/, `${tag} `)
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    close()
  }
  editor.addEventListener("input", () => {
    const word = partialTag()
    if (word == null) return close()
    popup.replaceChildren(
      ...[`#${word}beta`, `#${word}tok`, `#${word}`].map((tag) => {
        const option = html(
          `<div role="option" class="option">${tag} <small>${(tag.length * 1.7).toFixed(1)}M posts</small></div>`,
        )
        option.addEventListener("mousedown", (event) => {
          event.preventDefault()
          replaceTag(tag)
        })
        return option
      }),
    )
    popup.hidden = false
  })
  editor.addEventListener("keydown", (event) => {
    if (popup.hidden) return
    if (event.key === "Enter") {
      event.preventDefault()
      replaceTag(popup.firstElementChild.textContent.split(" ")[0])
    }
    if (event.key === "Escape") close()
  })
  editor.addEventListener("blur", () => setTimeout(close, 100))
  return { el: wrap, editor, popupOpen: () => !popup.hidden }
}

/**
 * TikTok's switch: the real input is invisible and aria-hidden, its label is a
 * sibling span a few levels up.
 */
function switchRow(label, { checked = false, disabled = false } = {}) {
  const row = html(
    `<div class="switch-row"><span class="switch-label">${label}</span><div class="tooltip"><div class="switch"><div class="switch-root${disabled ? " disabled" : ""}"><div class="switch-content" aria-checked="${checked}"><span class="thumb"></span><input class="switch-input" role="switch" aria-hidden="true" type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} /></div></div></div></div></div>`,
  )
  const input = row.querySelector("input")
  input.addEventListener("change", () =>
    row
      .querySelector(".switch-content")
      .setAttribute("aria-checked", String(input.checked)),
  )
  return { el: row, on: () => input.checked }
}

/**
 * YouTube Studio's buttons: the <button> sits inside a box-less
 * display:contents wrapper.
 */
function contentsButton(label, onClick, { disabled = false } = {}) {
  const wrap = html(
    `<div class="contents-wrap" style="display:contents"><button type="button" ${disabled ? "disabled" : ""}>${label}</button></div>`,
  )
  wrap.querySelector("button").addEventListener("click", onClick)
  return { el: wrap, button: wrap.querySelector("button") }
}

/**
 * TikTok's time picker: a read-only box that opens two short scrolling columns
 * of bare spans (hours, then minutes in 5s) with no roles or labels.
 */
function timePicker(initial) {
  const wrap = html(
    `<div class="time-wrap"><input class="time" readonly value="${initial}" aria-label="Time" /><div class="picker" hidden><div class="column"></div><div class="column"></div></div></div>`,
  )
  const [input, picker] = wrap.children
  const [hours, minutes] = picker.children
  const fill = (column, values, part) =>
    column.append(
      ...values.map((value) => {
        const option = html(
          `<div class="cell"><span class="cell-text">${value}</span></div>`,
        )
        option.firstElementChild.addEventListener("click", () => {
          const parts = input.value.split(":")
          parts[part] = value
          input.value = parts.join(":")
        })
        return option
      }),
    )
  fill(
    hours,
    Array.from({ length: 24 }, (_, i) => pad(i)),
    0,
  )
  fill(
    minutes,
    Array.from({ length: 12 }, (_, i) => pad(i * 5)),
    1,
  )
  input.addEventListener("click", () => (picker.hidden = false))
  document.addEventListener("mousedown", (event) => {
    if (!wrap.contains(event.target)) picker.hidden = true
  })
  return { el: wrap, value: () => input.value }
}

/** Two-digit clock number. */
function pad(n) {
  return String(n).padStart(2, "0")
}

// The fixture pages call these from their own inline scripts
Object.assign(window, {
  html,
  hashtagEditor,
  switchRow,
  contentsButton,
  timePicker,
})

/** Shared look for the fixtures. */
document.head.append(
  html(`<style>
    body { font: 15px system-ui; margin: 24px; max-width: 720px; }
    .editor-wrap { position: relative; }
    .editor { border: 1px solid #bbb; border-radius: 6px; min-height: 64px; padding: 8px; white-space: pre-wrap; }
    .suggestions { position: absolute; left: 0; right: 0; top: 100%; z-index: 10; background: #fff; border: 1px solid #ccc; box-shadow: 0 4px 12px #0003; min-height: 160px; }
    .option { padding: 8px; cursor: pointer; }
    .option:hover { background: #eee; }
    .switch-row { display: flex; justify-content: space-between; align-items: center; margin: 10px 0; }
    .switch-root { cursor: pointer; }
    .switch-root.disabled { cursor: not-allowed; opacity: .5; }
    .switch-content { position: relative; width: 28px; height: 16px; border-radius: 8px; background: #ccc; }
    .switch-content[aria-checked="true"] { background: #fe2c55; }
    .thumb { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 6px; background: #fff; }
    .switch-content[aria-checked="true"] .thumb { left: 14px; }
    .switch-input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: inherit; }
    .time-wrap { position: relative; display: inline-block; }
    .picker { position: absolute; top: 100%; display: flex; gap: 8px; background: #fff; border: 1px solid #ccc; z-index: 5; }
    .picker[hidden] { display: none; }
    .column { height: 140px; overflow: auto; width: 60px; }
    .cell-text { display: block; padding: 4px 8px; cursor: pointer; }
    .cell-text:hover { background: #eee; }
    section { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  </style>`),
)
