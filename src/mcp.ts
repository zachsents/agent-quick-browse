import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { runAgent } from "./agent.ts"
import { describeElement, snapshotPage } from "./snapshot.ts"
import * as tab from "./tab.ts"

/**
 * Stdio MCP server. Every tool acts on a session's persistent agent tab in the
 * user's Chrome, so a smarter caller can chain small decision-model runs (and
 * its own precise actions) toward a larger goal. Each server process gets its
 * own default session; pass `session` to run several tabs in parallel.
 */
export async function startMcp() {
  const server = new McpServer({ name: "clef-browser", version: "0.2.0" })
  const defaultSession = `mcp-${crypto.randomUUID().slice(0, 8)}`
  const sessionArg = {
    session: z
      .string()
      .optional()
      .describe(
        "Agent tab to use. Each session is its own background tab, so different sessions can run in parallel. Defaults to this server's own session.",
      ),
  }
  /** Runs a tool handler inside its session's tab context. */
  const inSession =
    <A extends { session?: string }, R>(handler: (args: A) => Promise<R>) =>
    (args: A) =>
      tab.withSession(args.session ?? defaultSession, () => handler(args))

  server.registerTool(
    "browser_run",
    {
      description: `Hand a small, concrete browser sub-goal to a fast, cheap decision model (Clef: ~1–2s per step, sees screenshots; Jev: ~0.5s per step, reads a text outline). It works in the user's real, logged-in Chrome, in a background agent tab that persists between calls: each call continues from wherever the previous call (or browser_navigate/click/type) left off in the same session. Links that open a new tab hand the session to that tab.

These models only choose between options (which action, which element). How to scope goals, from benchmarks (see README):
- Reliable in one call: one objective on one site, stated with explicit steps. E.g. "search for X and open the matching result"; "fill the form with these facts, pick Two in the dropdown, check Y, submit"; navigation chains of up to ~10 explicit parts ("open folder A, open file B, go back, open C"); following links by what the page says ("open the article on its creator, then the city he was born in"); simple comparisons ("open the story with the most points"). An impossible goal returns "blocked" rather than a fake "done".
- Split up or do yourself: complex app widget flows (date pickers, multi-field search UIs like Google Flights) — the model tends to say "done" before the final submit, so verify and finish with browser_click; exploring for something that isn't on the current page (prefer jev, which pages; clef tends to scroll aimlessly); vague or judgment-heavy goals; anything needing writing or reading comprehension.
- Every string that must be typed (search terms, dates, emails) goes in facts. Name exact link/button text when you know it.
- Always check the result (status, reason, url, title, actions) before the next call; "done" is the model's belief, not proof. Runs return no text answer — read pages yourself with browser_page_text or browser_look, and use browser_look / browser_click / browser_type when a run gets stuck.
- jev is ~2–3× faster than clef and at least as accurate on most goals; use clef (vision) when the page is mostly visual.

The model can click anything the user is logged into. Do not give it goals that purchase, send, post, delete, or submit forms without the user's go-ahead.`,
      inputSchema: {
        goal: z
          .string()
          .describe(
            "One objective on one site, with explicit steps (see scoping guidance above)",
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
        max_steps: z.number().int().min(1).max(40).default(12),
        model: z
          .enum(["clef", "clef-flash", "jev"])
          .default("clef")
          .describe(
            "clef (27B, sees screenshots), clef-flash (9B, faster), jev (text-only, fastest)",
          ),
        text_only: z
          .boolean()
          .default(false)
          .describe(
            "Describe the page as a whole-page text outline instead of a screenshot. Always on for jev.",
          ),
        ...sessionArg,
      },
    },
    inSession(async ({ goal, url, facts, max_steps, model, text_only }) => {
      if (url) await tab.goto(url)
      const log: string[] = []
      const result = await runAgent({
        goal,
        facts: facts ?? {},
        model,
        mode: model === "jev" || text_only ? "text" : "vision",
        maxSteps: max_steps,
        log: (line) => log.push(line),
      })
      return text(
        `${JSON.stringify(result, null, 2)}\n\nstep log:\n${log.join("\n")}`,
      )
    }),
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
        "Replace the contents of a numbered text field (from the latest browser_look) with `text`, optionally pressing Enter.",
      inputSchema: {
        element: z.number().int().min(1),
        text: z.string(),
        submit: z.boolean().default(false),
        ...sessionArg,
      },
    },
    inSession(async ({ element, text: value, submit }) => {
      await tab.fill(`e${element}`, value)
      if (submit) {
        await tab.pressEnter()
        await tab.waitForLoad()
      }
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
    "browser_close",
    {
      description: "Close the session's tab when you're done with it.",
      inputSchema: sessionArg,
    },
    inSession(async () => {
      await tab.close()
      return text("Closed.")
    }),
  )

  await server.connect(new StdioServerTransport())
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}

async function pageInfo() {
  const { url, title } = await tab.info()
  return text(`Now on: ${title} — ${url}`)
}
