#!/usr/bin/env bun
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import * as R from "remeda"
import { z } from "zod"
import { runAgent } from "./agent.ts"
import { defaultModel, resolveMode } from "./decide.ts"
import { EXTENSION_ID, HOST_NAME, STATE_DIR } from "./paths.ts"
import { describeElement, snapshotPage } from "./snapshot.ts"
import * as tab from "./tab.ts"

const USAGE = `clef-browser — drive your own Chrome with a decision model (Jev, GPT-6 Luna Decisions, or Clef)

Usage:
  clef-browser run "<goal>" [--url <url>] [--fact key=value ...] [--file name=path ...] [--model jev|luna|clef|clef-flash] [--text|--vision] [--max-steps 25]
  clef-browser look [--url <url>] [--text]  Print numbered elements + annotated screenshot (or the text outline)
  clef-browser tabs                   List open Chrome tabs (id, group, controlling session)
  clef-browser attach <tabId>         Take over an already-open tab for the session
  clef-browser release [--keep]       End the session: close its tabs (--keep: hand them back ungrouped);
                                      a tab taken over with attach is always handed back
  clef-browser close                  Same as release without --keep
  clef-browser mcp                    Run as a stdio MCP server
  clef-browser setup                  Register the native host and print extension install steps
  All commands take --session <name> (default "default") and --group <name> (tab group, default "Clef").

Each session works in its own background tab (grouped as "Clef") in your normal Chrome, with your logins, so
sessions can run in parallel. Successive commands in a session continue in its tab; omit --url to pick up there.
Text to type must be passed with --fact, and files to upload with --file; the model picks which one fits each field.
--model defaults to the best model your keys allow (Jev, else GPT-6 Luna, else Clef). --text / --vision choose how the
page is shown (outline vs screenshot); defaults: text for Jev (always) and Luna, screenshots for Clef.
Keys: AI_GATEWAY_API_KEY covers Jev and Luna; or use TYPESAFE_API_KEY (Jev) / OPENAI_API_KEY (Luna) directly.
Clef: CLOUDFLARE_AI_ACCOUNT_ID + CLOUDFLARE_AI_API_TOKEN. The gateway key wins when several are set.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    fact: { type: "string", multiple: true, default: [] },
    file: { type: "string", multiple: true, default: [] },
    model: { type: "string" },
    text: { type: "boolean", default: false },
    vision: { type: "boolean", default: false },
    "max-steps": { type: "string", default: "25" },
    session: { type: "string", default: "default" },
    group: { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

const [command, ...rest] = positionals

const inSession = <T>(fn: () => Promise<T>) =>
  tab.withSession(
    values.session,
    fn,
    values.group ? { group: values.group } : {},
  )

switch (command) {
  case "setup":
    await setup()
    break
  case "look":
    await inSession(look)
    break
  case "run":
    await inSession(run)
    break
  case "close":
    await inSession(tab.close)
    break
  case "release":
    await inSession(() => tab.release(values.keep))
    break
  case "tabs":
    for (const t of await tab.listTabs())
      console.log(
        `${String(t.tabId).padEnd(11)} ${t.active ? "*" : " "} ${(t.group ? `[${t.group}] ` : "") + t.title.slice(0, 60)}${t.session ? `  (session: ${t.session})` : ""}\n            ${t.url.slice(0, 100)}`,
      )
    break
  case "attach": {
    const tabId = Number(rest[0])
    if (!Number.isInteger(tabId))
      throw new Error("attach needs a tab id (see `clef-browser tabs`)")
    const { title, url } = await inSession(() => tab.adopt(tabId))
    console.log(`Session "${values.session}" now controls: ${title} — ${url}`)
    break
  }
  case "mcp":
    await import("./mcp.ts").then(({ startMcp }) => startMcp())
    break
  default:
    console.log(USAGE)
    process.exitCode = command && !values.help ? 1 : 0
}

/**
 * Installs the native host and extension into ~/.clef-browser (stable paths,
 * even when run from bunx's temporary cache) and registers the host with
 * Chrome. Re-run after upgrading.
 */
async function setup() {
  const projectRoot = resolve(import.meta.dir, "..")
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

  // Bundle the host so it no longer depends on this package's location
  const build = await Bun.build({
    entrypoints: [join(projectRoot, "src/host.ts")],
    outdir: STATE_DIR,
    target: "bun",
    naming: "host.js",
  })
  if (!build.success)
    throw new AggregateError(build.logs, "Failed to bundle the native host")
  const launcher = join(STATE_DIR, "native-host")
  await Bun.write(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${join(STATE_DIR, "host.js")}"\n`,
  )
  chmodSync(launcher, 0o755)

  const extensionDir = join(STATE_DIR, "extension")
  rmSync(extensionDir, { recursive: true, force: true })
  cpSync(join(projectRoot, "extension"), extensionDir, { recursive: true })

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
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      },
      null,
      2,
    ),
  )
  console.log(`Installed the native host and extension in ${STATE_DIR}

If you haven't already, load the extension once:
  1. Open chrome://extensions and turn on Developer mode
  2. Load unpacked → ${extensionDir}
  3. Check it shows ID ${EXTENSION_ID}
After upgrading, re-run setup and click the extension's reload button.

Then try: clef-browser run "Open the Ask HN page" --url https://news.ycombinator.com`)
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
  const model = z
    .enum(["clef", "clef-flash", "jev", "luna"])
    .parse(values.model ?? defaultModel())
  if (values.url) await tab.goto(values.url)
  const started = performance.now()
  const result = await runAgent({
    goal,
    facts: parsePairs(values.fact),
    files: R.mapValues(parsePairs(values.file), (path, name) => {
      const absolute = resolve(path)
      if (!existsSync(absolute))
        throw new Error(`--file ${name}: ${absolute} does not exist`)
      return absolute
    }),
    model,
    mode: resolveMode(
      model,
      values.vision ? "vision" : values.text ? "text" : undefined,
    ),
    maxSteps: Number(values["max-steps"]),
    log: (line) => console.error(line),
  })
  console.error(
    `\n${result.status} after ${result.actions.length} actions in ${((performance.now() - started) / 1000).toFixed(1)}s — now on ${result.url}`,
  )
  console.log(JSON.stringify(result))
  process.exitCode = result.status === "done" ? 0 : 2
}

/** Parses repeated `key=value` flags into an object (values may contain "="). */
function parsePairs(pairs: string[]) {
  return Object.fromEntries(
    pairs.map((pair) => [
      pair.slice(0, pair.indexOf("=")),
      pair.slice(pair.indexOf("=") + 1),
    ]),
  )
}
