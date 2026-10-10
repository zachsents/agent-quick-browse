import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { runAgent } from "./agent.ts"
import { defaultModel, resolveMode } from "./decide.ts"
import { describeElement, snapshotPage } from "./snapshot.ts"
import * as tab from "./tab.ts"

/**
 * Stdio MCP server. Every tool acts on a session's persistent agent tab in the
 * user's Chrome, so a smarter caller can chain small decision-model runs (and
 * its own precise actions) toward a larger goal. Each server process gets its
 * own default session; pass `session` to run several tabs in parallel.
 */
export async function startMcp() {
  const server = new McpServer(
    { name: "aqb", version: "0.5.0" },
    {
      // Shown to the agent alongside every tool (Claude Code puts it in the system prompt): the cross-tool policy
      instructions: `AQB (agent-quick-browse) drives the user's real, logged-in Chrome with a fast decision model, in background tabs that don't disturb the user.

Prefer browser_run for routine web tasks (navigating, searching, following links, filling and submitting forms, multi-step clicking) over screenshot-driven browser control: it is 2–7x faster in benchmarks and already has the user's logins.

Give browser_run one objective on one site with explicit steps, put any text to type in facts, and check status and url before the next step. Read results with browser_page_text or browser_look; finish stuck steps with browser_click / browser_type. Use another browser tool for visual judgment, dragging or drawing, or when AQB is blocked.

Tabs: each session controls one tab, in a tab group you can name with \`group\` (sessions with the same group share it). To work in a tab the user already has open, find it with browser_tabs and take it over with browser_attach. When a session's work is done, call browser_release: tabs you opened close (or pass keep_open to leave them for the user), and a taken-over tab is handed back out of your group. Don't leave tabs behind in groups.

Ask the user before anything that purchases, sends, posts, deletes, or submits.`,
    },
  )
  const defaultSession = `mcp-${crypto.randomUUID().slice(0, 8)}`
  const sessionArg = {
    session: z
      .string()
      .optional()
      .describe(
        "Agent tab to use. Each session is its own tab, so different sessions can run in parallel. Defaults to this server's own session.",
      ),
    group: z
      .string()
      .optional()
      .describe(
        'Tab group for the session\'s tab (default "AQB"). Sessions with the same group share it; changing it moves the tab.',
      ),
  }
  /**
   * Sessions this server has used, released automatically when the server shuts
   * down.
   */
  const usedSessions = new Set<string>()
  /** Runs a tool handler inside its session's tab context. */
  const inSession =
    <A extends { session?: string; group?: string }, R>(
      handler: (args: A) => Promise<R>,
    ) =>
    (args: A) => {
      const session = args.session ?? defaultSession
      usedSessions.add(session)
      return tab.withSession(
        session,
        () => handler(args),
        args.group ? { group: args.group } : {},
      )
    }

  server.registerTool(
    "browser_run",
    {
      description: `Have a fast decision model (Jev ~0.5s/step, Clef ~1–2s/step) do one small web task (navigate, search, click, fill forms) in the user's real, logged-in Chrome. Runs in a background tab that persists per session: omit url to continue where the last call left off. Returns {status, reason, url, title, actions} and no text answer — read pages yourself with browser_page_text or browser_look. "done" is the model's belief, so check the result before the next call, and finish stuck steps yourself with browser_click / browser_type. Never give it goals that purchase, send, post, delete, or submit without the user's go-ahead.`,
      inputSchema: {
        goal: z
          .string()
          .describe(
            `One objective on one site, with explicit steps. Reliable: "search for X and open the result", "fill the form with these facts and submit", up to ~10 explicit navigation steps ("open folder A, open file B, go back, open C"), simple comparisons ("open the story with the most points"). Split up or do yourself: multi-widget app flows like date pickers or Google Flights (it may stop before the final submit), open-ended exploration, judgment calls, writing. Name exact link/button text when you know it.`,
          ),
        url: z
          .string()
          .optional()
          .describe(
            "Navigate here first. Omit to continue on the session's current tab.",
          ),
        facts: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'The only text the model can type — it picks which value fits each field, e.g. {"search": "Cloudflare"}. If a field needs text that is not here, the run stops as blocked with a reason.',
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Local files the model may upload, name → absolute path, e.g. {"resume": "/Users/me/resume.pdf"}. Uploads never open a file picker.',
          ),
        max_steps: z.number().int().min(1).max(40).default(12),
        keystrokes: z
          .boolean()
          .optional()
          .describe(
            "Type text with real per-character key events instead of inserting it in one go. Slower; use it when a rich-text editor mangles or drops inserted text, or only reacts to typing (hashtag/mention pickers). Newlines are typed as Enter.",
          ),
        model: z
          .enum(["clef", "clef-flash", "jev", "luna"])
          .optional()
          .describe(
            "Default: the best model the user's keys allow (jev, else luna, else clef). jev: text-only, fastest. luna: OpenAI GPT-6 Luna Decisions. clef / clef-flash: Cloudflare.",
          ),
        view: z
          .enum(["text", "vision"])
          .optional()
          .describe(
            "How the page is shown: a whole-page text outline or a screenshot. Default: text for jev (always) and luna, vision for clef. Use vision only when meaning is in pixels (unlabeled icons, canvases, charts).",
          ),
        ...sessionArg,
      },
    },
    inSession(
      async ({
        goal,
        url,
        facts,
        files,
        max_steps,
        model,
        view,
        keystrokes,
      }) => {
        if (url) await tab.goto(url)
        const log: string[] = []
        const result = await runAgent({
          goal,
          facts: facts ?? {},
          files: files ?? {},
          keystrokes,
          model: model ?? defaultModel(),
          mode: resolveMode(model ?? defaultModel(), view),
          maxSteps: max_steps,
          log: (line) => log.push(line),
        })
        return text(
          `${JSON.stringify(result, null, 2)}\n\nstep log:\n${log.join("\n")}`,
        )
      },
    ),
  )

  server.registerTool(
    "browser_look",
    {
      description:
        "Show the session's tab with interactive elements numbered: a screenshot with numbered boxes plus the element list, or with text: true a whole-page text outline (cheaper, includes off-screen content). Use the numbers with browser_click / browser_type. Numbers are only valid until the next look or run.",
      inputSchema: {
        url: z.string().optional().describe("Navigate here first"),
        text: z
          .boolean()
          .default(false)
          .describe("Return a whole-page text outline instead of a screenshot"),
        ...sessionArg,
      },
    },
    inSession(async ({ url, text: textMode }) => {
      if (url) await tab.goto(url)
      const [{ elements, screenshot, outline }, page] = await Promise.all([
        snapshotPage(textMode ? "text" : "vision"),
        tab.info(),
      ])
      if (screenshot == null)
        return text(`${page.title} — ${page.url}\n${outline}`)
      return {
        content: [
          {
            type: "text" as const,
            text: `${page.title} — ${page.url}\n${elements.map(describeElement).join("\n")}`,
          },
          {
            type: "image" as const,
            data: screenshot.slice(screenshot.indexOf(",") + 1),
            mimeType: "image/jpeg",
          },
        ],
      }
    }),
  )

  server.registerTool(
    "browser_navigate",
    {
      description: "Load a URL in the session's tab.",
      inputSchema: { url: z.string(), ...sessionArg },
    },
    inSession(async ({ url }) => {
      await tab.goto(url)
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_click",
    {
      description: "Click a numbered element from the latest browser_look.",
      inputSchema: { element: z.number().int().min(1), ...sessionArg },
    },
    inSession(async ({ element }) => {
      await tab.click(`e${element}`)
      await tab.waitForLoad()
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_type",
    {
      description:
        "Replace the contents of a numbered text field (from the latest browser_look) with `text`, optionally pressing Enter. Fails if the field doesn't end up containing the text.",
      inputSchema: {
        element: z.number().int().min(1),
        text: z.string(),
        submit: z.boolean().default(false),
        keystrokes: z
          .boolean()
          .optional()
          .describe(
            "Type text with real per-character key events instead of inserting it in one go. Slower; use it when a rich-text editor mangles or drops inserted text, or only reacts to typing (hashtag/mention pickers). Newlines are typed as Enter.",
          ),
        append: z
          .boolean()
          .optional()
          .describe(
            "Add the text at the end instead of replacing the contents.",
          ),
        ...sessionArg,
      },
    },
    inSession(async ({ element, text: value, submit, keystrokes, append }) => {
      await tab.fill(`e${element}`, value, { keystrokes, append })
      if (submit) {
        await tab.pressEnter()
        await tab.waitForLoad()
      }
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_value",
    {
      description:
        "Read the full current value of a numbered field from the latest browser_look (input, textarea, select, or rich-text editor); look truncates long values.",
      inputSchema: { element: z.number().int().min(1), ...sessionArg },
    },
    inSession(async ({ element }) => text(await tab.value(`e${element}`))),
  )

  server.registerTool(
    "browser_key",
    {
      description:
        "Press a key or shortcut on the focused element: Escape (close a popup or suggestion list), Enter, Tab, ArrowDown, Backspace, Cmd+A, Shift+Tab, or a single character.",
      inputSchema: { key: z.string(), ...sessionArg },
    },
    inSession(async ({ key }) => {
      await tab.key(key)
      await tab.waitForLoad()
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_hover",
    {
      description:
        "Move the mouse onto a numbered element from the latest browser_look and leave it there, to reveal controls or menus that only appear on hover. Look again afterwards to see them.",
      inputSchema: { element: z.number().int().min(1), ...sessionArg },
    },
    inSession(async ({ element }) => {
      await tab.hover(`e${element}`)
      await tab.waitForLoad()
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_upload",
    {
      description:
        "Attach local files to a numbered file input, upload button, or drop zone from the latest browser_look (no file picker opens).",
      inputSchema: {
        element: z.number().int().min(1),
        paths: z
          .array(z.string())
          .min(1)
          .describe("Absolute paths of local files"),
        ...sessionArg,
      },
    },
    inSession(async ({ element, paths }) => {
      await tab.upload(`e${element}`, paths)
      await tab.waitForLoad()
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_scroll",
    {
      description: "Scroll the session's tab by ~one screen.",
      inputSchema: { direction: z.enum(["down", "up"]), ...sessionArg },
    },
    inSession(async ({ direction }) => {
      await tab.scroll(direction === "down" ? 1 : -1)
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_back",
    {
      description: "Go back in the session's tab history.",
      inputSchema: sessionArg,
    },
    inSession(async () => {
      await tab.goBack()
      await tab.waitForLoad()
      return pageInfo()
    }),
  )

  server.registerTool(
    "browser_page_text",
    {
      description:
        "Read the visible text of the session's tab (first 30k chars).",
      inputSchema: sessionArg,
    },
    inSession(async () => {
      const [page, body] = await Promise.all([tab.info(), tab.innerText()])
      return text(`${page.title} — ${page.url}\n\n${body.slice(0, 30_000)}`)
    }),
  )

  server.registerTool(
    "browser_tabs",
    {
      description:
        "List every open Chrome tab: tab id, title, url, tab group, and which session (if any) controls it. Use with browser_attach to work in a tab the user already has open.",
    },
    async () => {
      const tabs = await tab.listTabs()
      return text(
        tabs
          .map(
            (t) =>
              `${t.tabId}${t.active ? " (active)" : ""}${t.group ? ` [${t.group}]` : ""}${t.session ? ` (session: ${t.session})` : ""} ${t.title} — ${t.url}`,
          )
          .join("\n"),
      )
    },
  )

  server.registerTool(
    "browser_attach",
    {
      description:
        "Take over an already-open tab (id from browser_tabs) as this session's tab. It moves into the session's group while you work; browser_release hands it back to the user where it was.",
      inputSchema: { tab_id: z.number().int(), ...sessionArg },
    },
    inSession(async ({ tab_id }) => {
      const { title, url } = await tab.adopt(tab_id)
      return text(`Now controlling: ${title} — ${url}`)
    }),
  )

  server.registerTool(
    "browser_release",
    {
      description:
        "End a session when its work is done. Tabs it opened are closed (keep_open: true leaves them open for the user, ungrouped); a tab taken over with browser_attach is always handed back, out of your group. Always release sessions so tabs don't pile up in groups.",
      inputSchema: {
        keep_open: z
          .boolean()
          .optional()
          .describe(
            "Leave the session's own tabs open for the user instead of closing them",
          ),
        ...sessionArg,
      },
    },
    inSession(async ({ keep_open }) => {
      await tab.release(keep_open)
      return text(
        keep_open ? "Released; tabs left open for the user." : "Released.",
      )
    }),
  )

  // When the agent goes away (stdin closes), release every session it used so no tabs linger in groups
  process.stdin.on("close", async () => {
    await Promise.allSettled(
      [...usedSessions].map((session) =>
        tab.withSession(session, () => tab.release()),
      ),
    )
    process.exit(0)
  })

  await server.connect(new StdioServerTransport())
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}

async function pageInfo() {
  const { url, title } = await tab.info()
  return text(`Now on: ${title} — ${url}`)
}
