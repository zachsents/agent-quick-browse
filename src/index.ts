#!/usr/bin/env bun
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { runAgent } from "./agent.ts"
import { EXTENSION_ID, HOST_NAME } from "./paths.ts"
import { describeElement, snapshotPage } from "./snapshot.ts"
import * as tab from "./tab.ts"

const USAGE = `clef-browser — drive your own Chrome with a decision model (Clef or Jev)

Usage:
  clef-browser run "<goal>" [--url <url>] [--fact key=value ...] [--model jev|clef|clef-flash] [--text] [--max-steps 25]
  clef-browser look [--url <url>] [--text]  Print numbered elements + annotated screenshot (or the text outline)
  clef-browser close                  Close the session's tab
  clef-browser mcp                    Run as a stdio MCP server
  clef-browser setup                  Register the native host and print extension install steps
  All commands take --session <name> (default "default").

Each session works in its own background tab (grouped as "Clef") in your normal Chrome, with your logins, so
sessions can run in parallel. Successive commands in a session continue in its tab; omit --url to pick up there.
Text to type must be passed with --fact; Clef picks which fact fits each field.
--text describes the page as a whole-page text outline instead of a screenshot (always on for Jev).
Env: CLOUDFLARE_AI_ACCOUNT_ID, CLOUDFLARE_AI_API_TOKEN (Clef), AI_GATEWAY_API_KEY (Jev)`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    fact: { type: "string", multiple: true, default: [] },
    model: { type: "string", default: "jev" },
    text: { type: "boolean", default: false },
    "max-steps": { type: "string", default: "25" },
    session: { type: "string", default: "default" },
    help: { type: "boolean", short: "h", default: false },
  },
})

const [command, ...rest] = positionals

switch (command) {
  case "setup":
    await setup()
    break
  case "look":
    await tab.withSession(values.session, look)
    break
  case "run":
    await tab.withSession(values.session, run)
    break
  case "close":
    await tab.withSession(values.session, tab.close)
    break
  case "mcp":
    await import("./mcp.ts").then(({ startMcp }) => startMcp())
    break
  default:
    console.log(USAGE)
    process.exitCode = command && !values.help ? 1 : 0
}

/**
 * Writes Chrome's native messaging manifest so the extension can launch
 * bin/native-host.
 */
async function setup() {
  const projectRoot = resolve(import.meta.dir, "..")
  const manifestPath = join(
    homedir(),
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    `${HOST_NAME}.json`,
  )
  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "clef-browser native host",
        path: join(projectRoot, "bin/native-host"),
        type: "stdio",
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      },
      null,
      2,
    ),
  )
  console.log(`Wrote ${manifestPath}

Now load the extension once:
  1. Open chrome://extensions and turn on Developer mode
  2. Load unpacked → ${join(projectRoot, "extension")}
  3. Check it shows ID ${EXTENSION_ID}

Then try: clef-browser look --url https://news.ycombinator.com`)
}

async function look() {
  if (values.url) await tab.goto(values.url)
  const [{ elements, screenshot, outline }, { url, title }] = await Promise.all(
    [snapshotPage(values.text ? "text" : "vision"), tab.info()],
  )
  if (screenshot == null) {
    console.log(`${title} — ${url}\n${outline}`)
    return
  }
  const file = join(tmpdir(), `clef-look-${Date.now()}.jpg`)
  await Bun.write(file, Buffer.from(screenshot.split(",")[1] ?? "", "base64"))
  console.log(
    `${title} — ${url}\n${elements.map(describeElement).join("\n")}\n\nscreenshot: ${file}`,
  )
}

async function run() {
  const goal = rest.join(" ")
  if (!goal)
    throw new Error(
      'run needs a goal, e.g. clef-browser run "find the weather in Austin"',
    )
  const model = z.enum(["clef", "clef-flash", "jev"]).parse(values.model)
  if (values.url) await tab.goto(values.url)
  const started = performance.now()
  const result = await runAgent({
    goal,
    facts: Object.fromEntries(
      values.fact.map((f) => [
        f.slice(0, f.indexOf("=")),
        f.slice(f.indexOf("=") + 1),
      ]),
    ),
    model,
    mode: model === "jev" || values.text ? "text" : "vision",
    maxSteps: Number(values["max-steps"]),
    log: (line) => console.error(line),
  })
  console.error(
    `\n${result.status} after ${result.actions.length} actions in ${((performance.now() - started) / 1000).toFixed(1)}s — now on ${result.url}`,
  )
  console.log(JSON.stringify(result))
  process.exitCode = result.status === "done" ? 0 : 2
}
