import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { runAgent } from "./agent.ts"
import { describeElement, snapshotPage } from "./snapshot.ts"
import * as tab from "./tab.ts"

/**
 * Stdio MCP server. Everything acts on the single persistent agent tab in the
 * user's Chrome, so a smarter caller can chain small Clef runs (and its own
 * precise actions) toward a larger goal.
 */
export async function startMcp() {
  const server = new McpServer({ name: "clef-browser", version: "0.1.0" })

  server.registerTool(
    "browser_run",
    {
      description: `Hand a small, concrete browser sub-goal to Clef, a fast/cheap decision model (~2s per step). It works in the user's real, logged-in Chrome, in one dedicated agent tab that persists between calls: each call continues from wherever the previous call (or browser_navigate/click/type) left off. Links that open a new tab hand control to that tab.

Clef is good at short, unambiguous, navigational goals ("open the Billing settings page", "search for X and open the first result", "find the price of Y on this page"). It is weak at long multi-part goals, judgement calls, and writing — so break complex tasks into small sub-goals, check the result of each (url, title, actions, answer), and call again. Use browser_look / browser_click / browser_type yourself when Clef gets stuck or a step needs precision.

Clef can click anything the user is logged into. Do not give it goals that purchase, send, post, delete, or submit forms without the user's go-ahead.`,
      inputSchema: {
        goal: z.string().describe("One small, concrete sub-goal"),
        url: z
          .string()
          .optional()
          .describe(
            "Navigate here first. Omit to continue on the current agent tab.",
          ),
        facts: z
          .record(z.string(), z.string())
          .optional()
          .describe('Values to use when typing, e.g. {"email": "a@b.com"}'),
        max_steps: z.number().int().min(1).max(40).default(12),
        fast: z
          .boolean()
          .default(false)
          .describe("Use clef-flash (9B): faster/cheaper, less accurate"),
      },
    },
    async ({ goal, url, facts, max_steps, fast }) => {
      if (url) await tab.goto(url)
      const log: string[] = []
      const result = await runAgent({
        goal,
        facts: facts ?? {},
        model: fast ? "clef-flash" : "clef",
        textModel: "google/gemini-3.8-flash",
        maxSteps: max_steps,
        log: (line) => log.push(line),
      })
      return text(
        `${JSON.stringify(result, null, 2)}\n\nstep log:\n${log.join("\n")}`,
      )
    },
  )

  server.registerTool(
    "browser_look",
    {
      description:
        "Screenshot the agent tab with interactive elements boxed and numbered, plus the numbered element list. Use the numbers with browser_click / browser_type. Numbers are only valid until the next look or run.",
      inputSchema: {
        url: z.string().optional().describe("Navigate here first"),
      },
    },
    async ({ url }) => {
      if (url) await tab.goto(url)
      const [{ elements, screenshot }, page] = await Promise.all([
        snapshotPage(),
        tab.info(),
      ])
      return {
        content: [
          {
            type: "text",
            text: `${page.title} — ${page.url}\n${elements.map(describeElement).join("\n")}`,
          },
          {
            type: "image",
            data: screenshot.slice(screenshot.indexOf(",") + 1),
            mimeType: "image/jpeg",
          },
        ],
      }
    },
  )

  server.registerTool(
    "browser_navigate",
    {
      description: "Load a URL in the agent tab.",
      inputSchema: { url: z.string() },
    },
    async ({ url }) => {
      await tab.goto(url)
      return pageInfo()
    },
  )

  server.registerTool(
    "browser_click",
    {
      description: "Click a numbered element from the latest browser_look.",
      inputSchema: { element: z.number().int().min(1) },
    },
    async ({ element }) => {
      await tab.click(`e${element}`)
      await tab.waitForLoad()
      return pageInfo()
    },
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
      },
    },
    async ({ element, text: value, submit }) => {
      await tab.fill(`e${element}`, value)
      if (submit) {
        await tab.pressEnter()
        await tab.waitForLoad()
      }
      return pageInfo()
    },
  )

  server.registerTool(
    "browser_scroll",
    {
      description: "Scroll the agent tab by ~one screen.",
      inputSchema: { direction: z.enum(["down", "up"]) },
    },
    async ({ direction }) => {
      await tab.scroll(direction === "down" ? 1 : -1)
      return pageInfo()
    },
  )

  server.registerTool(
    "browser_back",
    { description: "Go back in the agent tab's history." },
    async () => {
      await tab.goBack()
      await tab.waitForLoad()
      return pageInfo()
    },
  )

  server.registerTool(
    "browser_page_text",
    {
      description: "Read the visible text of the agent tab (first 30k chars).",
    },
    async () => {
      const [page, body] = await Promise.all([tab.info(), tab.innerText()])
      return text(`${page.title} — ${page.url}\n\n${body.slice(0, 30_000)}`)
    },
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
