#!/usr/bin/env bun
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

const USAGE = `aqb (agent-quick-browse) — drive your own Chrome with a decision model (Jev, GPT-6 Luna Decisions, or Clef)

Usage:
  aqb run "<goal>" [--url <url>] [--fact key=value ...] [--file name=path ...] [--model jev|luna|clef|clef-flash] [--text|--vision] [--keystrokes] [--max-steps 25]
  aqb look [--url <url>] [--text]  Print numbered elements + annotated screenshot (or the text outline)
  aqb click <n>               Click element n from the latest look      aqb hover <n>
  aqb type <n> "<text>" [--keystrokes] [--append] [--submit]   Replace (or append to) field n's text, verified
  aqb key <combo>            Press a key: Escape, Enter, Tab, ArrowDown, Cmd+A, Shift+Tab, …
  aqb scroll <up|down>       aqb upload <n> <path...>   aqb navigate <url>   aqb back   aqb text (page text)
  aqb value <n>              Print a field's full current value (input, textarea, rich-text editor)
  aqb wait --match '<regex>' Wait until a line of the outline matches (e.g. 'Uploaded'); prints it
  Instead of <n>, click/hover/type/upload/value take --match '<regex>' against the outline entry (role "label"),
  waiting up to --timeout <seconds> (default 30) for it to appear: aqb click --match 'radio "No, it.s not made for kids'
  (--nth <k> or --last picks among several matches)

  aqb tabs                   List open Chrome tabs (id, group, controlling session)
  aqb attach <tabId>         Take over an already-open tab for the session
  aqb release [--keep]       End the session: close its tabs (--keep: hand them back ungrouped);
                                      a tab taken over with attach is always handed back
  aqb close                  Same as release without --keep
  aqb mcp                    Run as a stdio MCP server
  aqb setup [--save-keys]    Register the native host and print extension install steps
                                      (--save-keys: copy API keys from this shell to ~/.aqb/env)
  All commands take --session <name> (default "default") and --group <name> (tab group, default "AQB").

Each session works in its own background tab (grouped as "AQB") in your normal Chrome, with your logins, so
sessions can run in parallel. Successive commands in a session continue in its tab; omit --url to pick up there.
Text to type must be passed with --fact, and files to upload with --file; the model picks which one fits each field.
--keystrokes types text with per-character key events (for rich-text editors that mangle inserted text).
API keys come from the environment, or from ~/.aqb/env (KEY=value lines) so non-login shells and agents find them.
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
    keystrokes: { type: "boolean", default: false },
    submit: { type: "boolean", default: false },
    match: { type: "string" },
    nth: { type: "string", default: "1" },
    last: { type: "boolean", default: false },
    timeout: { type: "string", default: "30" },
    append: { type: "boolean", default: false },
    "save-keys": { type: "boolean", default: false },
    session: { type: "string", default: "default" },
    group: { type: "string" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

loadKeyFile()

// Agents read the output: print failures as one line instead of a stack trace
process.on("uncaughtException", (error) => {
  console.error(`error: ${error.message}`)
  process.exit(1)
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
  case "tabs": {
    const tabs = await tab.listTabs()
    // Agent groups: the default plus any group a live session uses. Tabs there with no session lost their session
    // (e.g. the extension was removed and re-added) and can be taken back with `aqb attach <id>`.
    const agentGroups = new Set([
      "AQB",
      "Clef",
      ...tabs.flatMap((t) => (t.session && t.group ? [t.group] : [])),
    ])
    for (const t of tabs) {
      const owner = t.session
        ? `  (session: ${t.session})`
        : t.group && agentGroups.has(t.group)
          ? "  (orphaned agent tab: no session; `aqb attach` it)"
          : ""
      console.log(
        `${String(t.tabId).padEnd(11)} ${t.active ? "*" : " "} ${(t.group ? `[${t.group}] ` : "") + t.title.slice(0, 60)}${owner}\n            ${t.url.slice(0, 100)}`,
      )
    }
    break
  }
  case "click":
  case "hover":
  case "type":
  case "upload":
  case "key":
  case "scroll":
  case "navigate":
  case "back":
  case "text":
  case "value":
  case "wait":
    await inSession(() => act(command, rest))
    break
  case "attach": {
    const tabId = Number(rest[0])
    if (!Number.isInteger(tabId))
      throw new Error("attach needs a tab id (see `aqb tabs`)")
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
 * Installs the native host and extension into ~/.aqb (stable paths, even when
 * run from bunx's temporary cache) and registers the host with Chrome. Re-run
 * after upgrading.
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

  const hostsDir = join(
    homedir(),
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  )
  const manifestPath = join(hostsDir, `${HOST_NAME}.json`)
  // This project used to be called clef-browser; drop its native host so the old extension stops launching it
  const migrated = existsSync(join(hostsDir, "com.clef_browser.host.json"))
  rmSync(join(hostsDir, "com.clef_browser.host.json"), { force: true })
  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "agent-quick-browse native host",
        path: launcher,
        type: "stdio",
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      },
      null,
      2,
    ),
  )
  console.log(`Installed the native host and extension in ${STATE_DIR}

${migrated ? `Upgrading from clef-browser: in chrome://extensions, remove "Clef Browser Bridge" and load the new folder below.\n\n` : ""}If you haven't already, load the extension once:
  1. Open chrome://extensions and turn on Developer mode
  2. Load unpacked → ${extensionDir}
  3. Check it shows ID ${EXTENSION_ID}
After upgrading, re-run setup and click the extension's reload button.

${values["save-keys"] ? saveKeys() : ""}Then try: aqb run "Open the Ask HN page" --url https://news.ycombinator.com`)
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
  const file = join(tmpdir(), `aqb-look-${Date.now()}.jpg`)
  await Bun.write(file, Buffer.from(screenshot.split(",")[1] ?? "", "base64"))
  console.log(
    `${title} — ${url}\n${elements.map(describeElement).join("\n")}\n\nscreenshot: ${file}`,
  )
}

async function run() {
  const goal = rest.join(" ")
  if (!goal)
    throw new Error(
      'run needs a goal, e.g. aqb run "find the weather in Austin"',
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
    keystrokes: values.keystrokes,
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

/**
 * Loads `KEY=value` lines (optionally `export`ed and quoted) from ~/.aqb/env
 * without overriding the environment, so aqb finds its keys in shells and
 * agents that don't source the user's shell profile.
 */
function loadKeyFile() {
  const file = join(STATE_DIR, "env")
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
      line,
    )
    if (match?.[1] && process.env[match[1]] == null)
      process.env[match[1]] = (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2")
  }
}

/**
 * Writes the API keys set in this shell to ~/.aqb/env (owner-only) and returns
 * a line for the setup output.
 */
function saveKeys() {
  const found = [
    "AI_GATEWAY_API_KEY",
    "TYPESAFE_API_KEY",
    "OPENAI_API_KEY",
    "CLOUDFLARE_AI_ACCOUNT_ID",
    "CLOUDFLARE_AI_API_TOKEN",
    "JEV_MODEL",
  ].filter((name) => process.env[name])
  if (!found.length) return "No API keys found in this shell to save.\n\n"
  const file = join(STATE_DIR, "env")
  writeFileSync(
    file,
    found.map((name) => `${name}=${process.env[name]}`).join("\n") + "\n",
    { mode: 0o600 },
  )
  chmodSync(file, 0o600)
  return `Saved ${found.join(", ")} to ${file}.\n\n`
}

/**
 * The element a command targets, plus its remaining arguments: either the first
 * argument as a number from the latest `aqb look`, or (with --match) the first
 * element whose outline entry (`role "label"`) matches the regex, waiting up to
 * --timeout seconds for it to appear.
 */
async function target(args: string[]) {
  if (!values.match) {
    const n = Number(args[0])
    if (!Number.isInteger(n) || n < 1)
      throw new Error(
        "expected an element number from `aqb look` (or use --match '<regex>')",
      )
    return { id: `e${n}`, rest: args.slice(1) }
  }
  const pattern = new RegExp(values.match)
  // --nth / --last pick among several matches, e.g. the minute "00" after the hour "00" in a time picker
  const line = await waitFor((elements) => {
    const matches = elements
      .map((e) => `[${e.id.slice(1)}] ${e.role} "${e.label}"`)
      .filter((entry) => pattern.test(entry.replace(/^\[\d+\] /, "")))
    return values.last ? matches.at(-1) : matches[Number(values.nth) - 1]
  })
  return { id: `e${/^\[(\d+)\]/.exec(line)?.[1]}`, rest: args }
}

/**
 * Re-snapshots the page every second until `find` returns something, for up to
 * --timeout seconds.
 */
async function waitFor(
  find: (
    elements: Awaited<ReturnType<typeof snapshotPage>>["elements"],
    outline: string,
  ) => string | undefined,
) {
  const deadline = performance.now() + Number(values.timeout) * 1000
  for (;;) {
    const { elements, outline } = await snapshotPage("text")
    const found = find(elements, outline ?? "")
    if (found) return found
    if (performance.now() > deadline)
      throw new Error(
        `nothing matched /${values.match}/ within ${values.timeout}s`,
      )
    await Bun.sleep(1000)
  }
}

/**
 * Runs one exact action (no model) on the session's tab, then prints where the
 * tab is.
 */
async function act(command: string, args: string[]) {
  switch (command) {
    case "click":
      await tab.click((await target(args)).id)
      break
    case "hover":
      await tab.hover((await target(args)).id)
      break
    case "type": {
      const { id, rest } = await target(args)
      if (!rest.length)
        throw new Error(
          'usage: aqb type <n|--match regex> "<text>" [--keystrokes] [--append] [--submit]',
        )
      await tab.fill(id, rest.join(" "), {
        keystrokes: values.keystrokes,
        append: values.append,
      })
      if (values.submit) await tab.pressEnter()
      break
    }
    case "upload": {
      const { id, rest } = await target(args)
      const paths = rest.map((path) => resolve(path))
      const missing = paths.find((path) => !existsSync(path))
      if (!paths.length || missing)
        throw new Error(
          missing
            ? `${missing} does not exist`
            : "usage: aqb upload <n|--match regex> <path...>",
        )
      console.log(await tab.upload(id, paths))
      break
    }
    case "value":
      console.log(await tab.value((await target(args)).id))
      return
    case "wait": {
      if (!values.match) throw new Error("usage: aqb wait --match '<regex>'")
      const pattern = new RegExp(values.match)
      console.log(
        await waitFor((_, outline) =>
          outline
            .split("\n")
            .find((line) => pattern.test(line))
            ?.trim(),
        ),
      )
      return
    }
    case "key":
      if (!args[0]) throw new Error("usage: aqb key <Escape|Enter|Tab|Cmd+A|…>")
      await tab.key(args[0])
      break
    case "scroll":
      await tab.scroll(args[0] === "up" ? -1 : 1)
      break
    case "navigate":
      if (!args[0]) throw new Error("usage: aqb navigate <url>")
      await tab.goto(args[0])
      break
    case "back":
      await tab.goBack()
      break
    case "text": {
      const [{ url, title }, body] = await Promise.all([
        tab.info(),
        tab.innerText(),
      ])
      console.log(`${title} — ${url}\n\n${body}`)
      return
    }
  }
  await tab.waitForLoad()
  const { url, title } = await tab.info()
  console.log(`Now on: ${title} — ${url}`)
}
