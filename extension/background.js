// Relays commands from the agent-quick-browse native host to agent tabs via chrome.debugger (CDP).
// Each named session controls one tab (created in the background, or an existing tab it took over), grouped under a
// tab group the agent chooses, so any number of agents can run in parallel. Sessions are released when done: agent
// tabs close, taken-over tabs are handed back (debugger detached, original group restored).
// The native port also keeps this service worker alive while Chrome is running.

const HOST = "com.agent_quick_browse.host"
const DEFAULT_GROUP = "AQB"
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE
let port = null

/**
 * Runs best-effort background work (startup cleanup, alarms, tab grouping)
 * without leaving an unhandled rejection. While the extension reloads or its
 * service worker is torn down, Chrome rejects in-flight API calls with "No SW";
 * that's expected then, and anything else is logged as a warning instead of an
 * uncaught error.
 */
function background(promise) {
  promise.catch((error) => {
    if (!String(error?.message ?? error).includes("No SW"))
      console.warn("aqb background task failed:", error)
  })
}

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
background(pruneSessions())
// Safety net in case the worker was restarted without a live port
background(chrome.alarms.create("reconnect", { periodInMinutes: 1 }))
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
  async cdp({ session, group, method, params }) {
    const tabId = await ensureAttachedTab(session, group)
    return chrome.debugger.sendCommand({ tabId }, method, params)
  },
  async tab({ session, group }) {
    const tab = await chrome.tabs.get(await ensureAttachedTab(session, group))
    return { url: tab.url ?? "", title: tab.title ?? "" }
  },
  /**
   * Every open tab, with its group and the session controlling it (if any), so
   * an agent can pick one to take over.
   */
  async tabs() {
    const [tabs, sessions, groups] = await Promise.all([
      chrome.tabs.query({}),
      getSessions(),
      chrome.tabGroups.query({}),
    ])
    const owners = new Map(
      Object.entries(sessions).map(([name, meta]) => [meta.tabId, name]),
    )
    const titles = new Map(groups.map((group) => [group.id, group.title ?? ""]))
    return tabs.map((tab) => ({
      tabId: tab.id,
      title: tab.title ?? "",
      url: tab.url ?? "",
      active: tab.active,
      windowId: tab.windowId,
      group: titles.get(tab.groupId) ?? null,
      session: owners.get(tab.id) ?? null,
    }))
  },
  /**
   * Takes over an already-open tab for a session. Releasing the session later
   * hands it back where it was.
   */
  async adopt({ session, group, tabId }) {
    const sessions = await getSessions()
    const owner = Object.keys(sessions).find(
      (name) => sessions[name].tabId === tabId,
    )
    if (owner != null && owner !== session)
      throw new Error(
        `tab ${tabId} is already controlled by session "${owner}"`,
      )
    if (sessions[session] && sessions[session].tabId !== tabId)
      await release(session)
    const tab = await chrome.tabs.get(tabId)
    const meta = {
      tabId,
      group: group ?? DEFAULT_GROUP,
      adopted: true,
      originalGroupId: tab.groupId,
      others: [],
    }
    await setSession(session, meta)
    background(groupTab(tabId, meta.group))
    await ensureAttachedTab(session, group)
    return { url: tab.url ?? "", title: tab.title ?? "" }
  },
  /**
   * Ends a session. Agent-opened tabs close unless keepOpen; taken-over tabs
   * (or keepOpen) are handed back: debugger detached, removed from the agent's
   * group, and returned to their original group. Chrome deletes empty groups.
   */
  async release({ session, keepOpen }) {
    await release(session, keepOpen)
    return null
  },
  async close({ session }) {
    await release(session, false)
    return null
  },
}

/**
 * Session name → { tabId, group, adopted, originalGroupId, others }, kept in
 * session storage so it survives service worker restarts. `others` are earlier
 * tabs the session moved away from (e.g. after a link opened a new tab),
 * cleaned up on release too.
 */
async function getSessions() {
  const { sessions } = await chrome.storage.local.get("sessions")
  return Object.fromEntries(
    Object.entries(sessions ?? {}).map(([name, meta]) => [
      name,
      // Older versions stored just the tab id
      typeof meta === "number"
        ? { tabId: meta, group: DEFAULT_GROUP, adopted: false, others: [] }
        : meta,
    ]),
  )
}

/** Drops sessions whose tabs no longer exist. */
async function pruneSessions() {
  const sessions = await getSessions()
  for (const [name, meta] of Object.entries(sessions))
    if (!(await tabExists(meta.tabId))) await setSession(name, null)
}

async function tabExists(tabId) {
  return chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  )
}

/** The session's metadata if its tab still exists. */
async function getLiveSession(session) {
  const meta = (await getSessions())[session]
  return meta && (await tabExists(meta.tabId)) ? meta : null
}

// Session map updates are serialized so parallel sessions don't overwrite each other's entries
let sessionWrite = Promise.resolve()
function setSession(session, meta) {
  sessionWrite = sessionWrite.then(async () => {
    const sessions = await getSessions()
    if (meta == null) delete sessions[session]
    else sessions[session] = meta
    await chrome.storage.local.set({ sessions })
  })
  return sessionWrite
}

async function release(session, keepOpen = false) {
  const meta = (await getSessions())[session]
  await setSession(session, null)
  if (!meta) return
  // The tab the session took over from the user (it may have moved on to a new tab since) is always handed back
  const userTab = meta.adopted ? meta.tabId : meta.handBack
  for (const tabId of [meta.tabId, ...meta.others]) {
    if (!(await tabExists(tabId))) continue
    if (!keepOpen && tabId !== userTab) {
      await closeTab(tabId)
      continue
    }
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => undefined)
    await ungroupTab(tabId, tabId === userTab ? meta.originalGroupId : NO_GROUP)
  }
}

/**
 * Chrome rejects tab edits while the user is dragging tabs, so group changes
 * retry briefly and then give up (they're cosmetic and must never fail a call).
 * Serialized so parallel sessions don't each create the same group.
 */
let tabEdits = Promise.resolve()
function tabEdit(edit) {
  tabEdits = tabEdits.then(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await edit()
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  })
  return tabEdits
}

/** Stable color per group title ("AQB" is pink). */
function groupColor(title) {
  if (title === DEFAULT_GROUP) return "pink"
  const colors = [
    "blue",
    "cyan",
    "green",
    "yellow",
    "orange",
    "red",
    "purple",
    "grey",
  ]
  const hash = [...title].reduce(
    (sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0,
    7,
  )
  return colors[hash % colors.length]
}

/** Puts the tab in the named group in its window, creating the group if needed. */
function groupTab(tabId, title) {
  return tabEdit(async () => {
    const tab = await chrome.tabs.get(tabId)
    const [existing] = await chrome.tabGroups.query({
      title,
      windowId: tab.windowId,
    })
    if (existing && tab.groupId === existing.id) return
    if (existing) {
      await chrome.tabs.group({ tabIds: tabId, groupId: existing.id })
      return
    }
    const groupId = await chrome.tabs.group({
      tabIds: tabId,
      createProperties: { windowId: tab.windowId },
    })
    await chrome.tabGroups.update(groupId, {
      title,
      color: groupColor(title),
      collapsed: true,
    })
  })
}

/**
 * Takes the tab out of the agent's group, back into its original group if that
 * still exists.
 */
function ungroupTab(tabId, originalGroupId) {
  return tabEdit(async () => {
    const groups = await chrome.tabGroups.query({})
    if (
      originalGroupId != null &&
      originalGroupId !== NO_GROUP &&
      groups.some((group) => group.id === originalGroupId)
    )
      await chrome.tabs.group({ tabIds: tabId, groupId: originalGroupId })
    else await chrome.tabs.ungroup(tabId)
  })
}

/**
 * Shows where the agent's pointer is: a small glowing violet→cyan orb with a
 * soft halo that ripples on clicks. It is driven only by the agent
 * (window.__aqbOrb.glide / .click, called from the CLI alongside its mouse
 * events), never by mouse events, so your own mouse on the page doesn't make it
 * appear. Each glide is one smooth Web Animation, and the orb fades out 2.5s
 * after the agent's last move. Built only with DOM APIs (no innerHTML
 * or<style>), so strict Trusted Types / CSP pages like Gmail allow it, and it
 * ignores pointer events so it never blocks clicks.
 */
const CURSOR_SCRIPT = `(() => {
  if (window.__aqbOrb) return
  const orb = document.createElement("div")
  orb.style.cssText =
    "position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;pointer-events:none;" +
    "z-index:2147483647;opacity:0;background:radial-gradient(circle at 35% 30%,#e0f2fe 0%,#22d3ee 35%,#8b5cf6 100%);" +
    "box-shadow:0 0 0 3px rgba(139,92,246,.18),0 0 14px 4px rgba(34,211,238,.45),0 0 28px 8px rgba(139,92,246,.25);" +
    "transition:opacity .25s ease"
  let hideTimer
  let at = { x: -100, y: -100 }
  const place = ({ x, y }) => (orb.style.transform = "translate(" + x + "px," + y + "px)")
  const show = () => {
    if (!orb.isConnected) document.documentElement.append(orb)
    orb.style.opacity = "1"
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (orb.style.opacity = "0"), 2500)
  }
  window.__aqbOrb = {
    glide(from, to, duration) {
      show()
      at = to
      orb
        .animate(
          [{ transform: "translate(" + from.x + "px," + from.y + "px)" }, { transform: "translate(" + to.x + "px," + to.y + "px)" }],
          { duration, easing: "ease-in-out" },
        )
        .finished.then(() => place(at), () => {})
      place(to)
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => (orb.style.opacity = "0"), duration + 2500)
    },
    click({ x, y }) {
      at = { x, y }
      place(at)
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
    },
  }
})()`

const attached = new Set()
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId))

/**
 * Attaches the debugger to a tab. When Chrome restarts this service worker it
 * forgets which tabs it had attached, but the attachments live on, so a fresh
 * attach fails with "Another debugger is already attached". If the stale
 * attachment is ours, detaching works and we start over; if it isn't (DevTools
 * or another extension), detaching fails and we say so.
 */
async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3")
  } catch (error) {
    if (!String(error?.message).includes("Another debugger")) throw error
    await chrome.debugger.detach({ tabId }).catch(() => {
      throw new Error(
        `tab ${tabId} is being debugged by something else (DevTools or another extension); close that, or release this session and use a new tab`,
        { cause: error },
      )
    })
    await chrome.debugger.attach({ tabId }, "1.3")
  }
}

/**
 * Tabs being closed by a session, whose "Leave site?" prompt is accepted
 * automatically.
 */
const closing = new Set()

/**
 * Closes a session's tab. Pages with unsaved work (e.g. a half-filled upload
 * form) answer with a "Leave site?" prompt that would block the close forever,
 * so it is accepted through the debugger.
 */
async function closeTab(tabId) {
  closing.add(tabId)
  try {
    await chrome.tabs.remove(tabId)
  } finally {
    closing.delete(tabId)
  }
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (
    method === "Page.javascriptDialogOpening" &&
    params.type === "beforeunload" &&
    closing.has(tabId)
  )
    background(
      chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", {
        accept: true,
      }),
    )
})

// One in-flight tab creation per session, so concurrent first calls don't open duplicate tabs
const creating = new Map()

/**
 * Returns the session's tab (creating one in the background if needed) with the
 * debugger attached. Passing a different group moves the tab into that group.
 */
async function ensureAttachedTab(session, group) {
  let meta = await getLiveSession(session)
  if (!meta) {
    if (!creating.has(session)) {
      creating.set(
        session,
        (async () => {
          // Background tab so the agent never steals focus from what the user is doing
          const tab = await chrome.tabs.create({
            url: "about:blank",
            active: false,
          })
          const created = {
            tabId: tab.id,
            group: group ?? DEFAULT_GROUP,
            adopted: false,
            others: [],
          }
          await setSession(session, created)
          background(groupTab(tab.id, created.group))
          return created
        })().finally(() => creating.delete(session)),
      )
    }
    meta = await creating.get(session)
  } else if (group && group !== meta.group) {
    meta = { ...meta, group }
    await setSession(session, meta)
    background(groupTab(meta.tabId, group))
  }
  const { tabId } = meta
  if (!attached.has(tabId)) {
    await attachDebugger(tabId)
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

// A link that opens a new tab from a session's tab hands the session to the new tab (same group). The previous tab is
// remembered so release() cleans it up too.
chrome.tabs.onCreated.addListener((tab) => background(handOffToNewTab(tab)))

async function handOffToNewTab(tab) {
  if (tab.openerTabId == null) return
  const sessions = await getSessions()
  const session = Object.keys(sessions).find(
    (name) => sessions[name].tabId === tab.openerTabId,
  )
  if (session == null) return
  const meta = sessions[session]
  await setSession(session, {
    ...meta,
    tabId: tab.id,
    adopted: false,
    others: [...meta.others, meta.tabId],
    // A taken-over tab keeps its original group on release; the new tab is the agent's own
    ...(meta.adopted && { handBack: meta.tabId }),
  })
  background(groupTab(tab.id, meta.group))
}
