// Relays commands from the clef-browser native host to agent tabs via chrome.debugger (CDP).
// Each named session gets its own background tab, so any number of agents can run in parallel.
// The native port also keeps this service worker alive while Chrome is running.

const HOST = "com.clef_browser.host"
let port = null

function connect() {
  if (port) return
  port = chrome.runtime.connectNative(HOST)
  port.onMessage.addListener(onMessage)
  port.onDisconnect.addListener(() => {
    port = null
    setTimeout(connect, 5000)
  })
}

connect()
// Safety net in case the worker was restarted without a live port
chrome.alarms.create("reconnect", { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(connect)

async function onMessage({ id, method, params }) {
  try {
    port?.postMessage({ id, result: await handlers[method](params) })
  } catch (error) {
    port?.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const handlers = {
  async cdp({ session, method, params }) {
    const tabId = await ensureAttachedTab(session)
    return chrome.debugger.sendCommand({ tabId }, method, params)
  },
  async tab({ session }) {
    const tab = await chrome.tabs.get(await ensureAttachedTab(session))
    return { url: tab.url ?? "", title: tab.title ?? "" }
  },
  async close({ session }) {
    const tabId = await getSessionTab(session)
    await setSessionTab(session, null)
    if (tabId != null) await chrome.tabs.remove(tabId)
    return null
  },
}

/**
 * Session name → tab id, kept in session storage so it survives service worker
 * restarts.
 */
async function getSessions() {
  const { sessions } = await chrome.storage.session.get("sessions")
  return sessions ?? {}
}

async function getSessionTab(session) {
  const tabId = (await getSessions())[session]
  if (tabId == null) return null
  return chrome.tabs.get(tabId).then(
    (tab) => tab.id,
    () => null,
  )
}

// Session map updates are serialized so parallel sessions don't overwrite each other's entries
let sessionWrite = Promise.resolve()
function setSessionTab(session, tabId) {
  sessionWrite = sessionWrite.then(async () => {
    const sessions = await getSessions()
    if (tabId == null) delete sessions[session]
    else sessions[session] = tabId
    await chrome.storage.session.set({ sessions })
  })
  return sessionWrite
}

/**
 * Puts the tab in the shared pink "Clef" group (one per window). Purely
 * cosmetic, so it never fails a call: Chrome rejects tab edits while the user
 * is dragging tabs, so it retries briefly and then gives up. Calls are
 * serialized so parallel sessions don't each create their own group.
 */
let grouping = Promise.resolve()
function groupTab(tabId) {
  grouping = grouping.then(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await groupTabOnce(tabId)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  })
  return grouping
}

async function groupTabOnce(tabId) {
  const tab = await chrome.tabs.get(tabId)
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return
  const [existing] = await chrome.tabGroups.query({
    title: "Clef",
    windowId: tab.windowId,
  })
  if (existing) {
    await chrome.tabs.group({ tabIds: tabId, groupId: existing.id })
    return
  }
  const groupId = await chrome.tabs.group({ tabIds: tabId })
  await chrome.tabGroups.update(groupId, {
    title: "Clef",
    color: "pink",
    collapsed: true,
  })
}

/**
 * Shows where the agent's pointer is: a small glowing violet→cyan orb with a
 * soft halo, centered on the pointer, that ripples on clicks. It fades in on
 * mouse activity and out after 2.5s idle, and a short transform transition
 * smooths over uneven event timing. Built only with DOM APIs and the Web
 * Animations API (no innerHTML or <style>), so strict Trusted Types / CSP pages
 * like Gmail allow it, and it ignores pointer events so it never blocks
 * clicks.
 */
const CURSOR_SCRIPT = `(() => {
  if (window.__clefCursor) return
  window.__clefCursor = true
  const orb = document.createElement("div")
  orb.style.cssText =
    "position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;pointer-events:none;" +
    "z-index:2147483647;opacity:0;background:radial-gradient(circle at 35% 30%,#e0f2fe 0%,#22d3ee 35%,#8b5cf6 100%);" +
    "box-shadow:0 0 0 3px rgba(139,92,246,.18),0 0 14px 4px rgba(34,211,238,.45),0 0 28px 8px rgba(139,92,246,.25);" +
    "transition:opacity .25s ease,transform 50ms linear;transform:translate(-100px,-100px)"
  let hideTimer
  let x = -100
  let y = -100
  const show = () => {
    if (!orb.isConnected) document.documentElement.append(orb)
    orb.style.opacity = "1"
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (orb.style.opacity = "0"), 2500)
  }
  addEventListener("mousemove", (event) => {
    x = event.clientX
    y = event.clientY
    orb.style.transform = "translate(" + x + "px," + y + "px)"
    show()
  }, { capture: true, passive: true })
  addEventListener("mousedown", () => {
    show()
    orb.animate([{ scale: 1 }, { scale: 0.7 }, { scale: 1 }], { duration: 220, easing: "ease-out" })
    const ripple = document.createElement("div")
    ripple.style.cssText =
      "position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;pointer-events:none;" +
      "z-index:2147483646;border:2px solid rgba(34,211,238,.9);box-shadow:0 0 16px rgba(139,92,246,.6);" +
      "left:" + x + "px;top:" + y + "px"
    document.documentElement.append(ripple)
    ripple
      .animate([{ transform: "scale(.15)", opacity: 1 }, { transform: "scale(1.3)", opacity: 0 }], { duration: 500, easing: "ease-out" })
      .finished.then(() => ripple.remove(), () => ripple.remove())
  }, { capture: true, passive: true })
})()`

const attached = new Set()
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId))

// One in-flight tab creation per session, so concurrent first calls don't open duplicate tabs
const creating = new Map()

/**
 * Returns the session's agent tab, creating it in the background if needed,
 * with the debugger attached.
 */
async function ensureAttachedTab(session) {
  let tabId = await getSessionTab(session)
  if (tabId == null) {
    if (!creating.has(session)) {
      creating.set(
        session,
        (async () => {
          // Background tab so the agent never steals focus from what the user is doing
          const tab = await chrome.tabs.create({
            url: "about:blank",
            active: false,
          })
          await setSessionTab(session, tab.id)
          void groupTab(tab.id)
          return tab.id
        })().finally(() => creating.delete(session)),
      )
    }
    tabId = await creating.get(session)
  }
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3")
    // Hidden tabs otherwise report no focus and some sites pause or skip focus-dependent UI
    await chrome.debugger.sendCommand(
      { tabId },
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
    )
    // Visible pointer for every page this tab loads, plus the current one. Injected scripts only run with Page enabled.
    await chrome.debugger.sendCommand({ tabId }, "Page.enable")
    // Never let a page open the OS file picker from a background tab; uploads go through DOM.setFileInputFiles
    await chrome.debugger.sendCommand(
      { tabId },
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
    )
    await chrome.debugger.sendCommand(
      { tabId },
      "Page.addScriptToEvaluateOnNewDocument",
      { source: CURSOR_SCRIPT },
    )
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: CURSOR_SCRIPT,
    })
    attached.add(tabId)
  }
  return tabId
}

// A link that opens a new tab from a session's tab hands that session over to the new tab
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return
  const sessions = await getSessions()
  const session = Object.keys(sessions).find(
    (name) => sessions[name] === tab.openerTabId,
  )
  if (session == null) return
  await setSessionTab(session, tab.id)
  void groupTab(tab.id)
})
