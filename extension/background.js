// Relays commands from the clef-browser native host to one dedicated "agent" tab via chrome.debugger (CDP).
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
  async cdp({ method, params }) {
    const tabId = await ensureAttachedTab()
    return chrome.debugger.sendCommand({ tabId }, method, params)
  },
  async tab() {
    const tab = await chrome.tabs.get(await ensureAttachedTab())
    return { url: tab.url ?? "", title: tab.title ?? "" }
  },
}

async function getAgentTabId() {
  const { agentTabId } = await chrome.storage.session.get("agentTabId")
  if (agentTabId == null) return null
  return chrome.tabs.get(agentTabId).then(
    (tab) => tab.id,
    () => null,
  )
}

async function setAgentTab(tabId) {
  await chrome.storage.session.set({ agentTabId: tabId })
  const tab = await chrome.tabs.get(tabId)
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const groupId = await chrome.tabs.group({ tabIds: tabId })
    await chrome.tabGroups.update(groupId, { title: "Clef", color: "pink" })
  }
}

const attached = new Set()
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId))

/**
 * Returns the agent tab, creating it (in a "Clef" tab group) if needed, with
 * the debugger attached.
 */
async function ensureAttachedTab() {
  let tabId = await getAgentTabId()
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true })
    tabId = tab.id
    await setAgentTab(tabId)
  }
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3")
    attached.add(tabId)
  }
  return tabId
}

// Links that open a new tab from the agent tab hand control over to that new tab
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId != null && tab.openerTabId === (await getAgentTabId()))
    await setAgentTab(tab.id)
})
