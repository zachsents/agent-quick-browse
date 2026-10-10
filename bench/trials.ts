import { z } from "zod"
import * as tab from "../src/tab.ts"

export type Trial = {
  level: number
  name: string
  /**
   * A function when the goal depends on `prepare`'s result (e.g. a title that
   * changes daily)
   */
  goal: string | ((prepared: string) => string)
  url: string
  facts?: Record<string, string>
  /** Local files the agent may upload, by name → absolute path */
  files?: Record<string, string>
  maxSteps: number
  /**
   * Runs on the start page before the agent; its result is passed to `check`
   * (for answers that change over time).
   */
  prepare?: () => Promise<string>
  check: (
    page: {
      url: string
      text: string
      status: string
      /** What the fixture's `window.benchState()` reports (app levels) */
      state: unknown
    },
    expected: string | undefined,
  ) => boolean
}

/** File URL of a benchmark fixture page. */
function fixture(name: string) {
  return new URL(`fixtures/${name}`, import.meta.url).href
}

const CAPTION =
  "Missed mate in one?! Would you have seen it? #chess #chesstok #fyp"
const DESCRIPTION =
  "White castled into checkmate on move 14.\n\nCould you have spotted it? Tell me in the comments. #chess"

/**
 * Rich-text editors add trailing breaks and may double paragraph breaks, so
 * texts are compared by their non-blank lines.
 */
function sameLines(a: unknown, b: string) {
  return typeof a === "string" && nonBlankLines(a) === nonBlankLines(b)
}

function nonBlankLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Increasingly complex, read-only (or test-endpoint-only) goals with objective
 * success checks.
 */
export const TRIALS: Trial[] = [
  {
    level: 1,
    name: "one click",
    goal: "Open the Ask HN page",
    url: "https://news.ycombinator.com",
    maxSteps: 4,
    check: ({ url }) => url.endsWith("/ask"),
  },
  {
    level: 2,
    name: "search + pick result",
    goal: "Open the Wikipedia article about the Python programming language (not the snake)",
    url: "https://en.wikipedia.org",
    facts: { search: "Python programming language" },
    maxSteps: 6,
    check: ({ url }) => url.includes("/wiki/Python_(programming_language)"),
  },
  {
    level: 3,
    name: "4-hop navigation",
    goal: "Open the src/agent.ts file in the zachsents/agent-quick-browse repository",
    url: "https://github.com/zachsents",
    maxSteps: 8,
    check: ({ url }) =>
      url.endsWith("/zachsents/agent-quick-browse/blob/main/src/agent.ts"),
  },
  {
    level: 4,
    name: "7-field form + submit",
    goal: "Fill out the pizza order form: customer name, telephone, email, choose Medium size, select the Bacon and Extra Cheese toppings, then submit the order",
    url: "https://httpbin.org/forms/post",
    facts: {
      name: "Ada Lovelace",
      phone: "555-0100",
      email: "ada@example.com",
    },
    maxSteps: 12,
    check: ({ url, text }) =>
      url.endsWith("/post") &&
      ["Ada Lovelace", "555-0100", "medium", "bacon", "cheese"].every((s) =>
        text.includes(s),
      ),
  },
  {
    level: 5,
    name: "complex widgets",
    goal: "Search for one-way flights from Los Angeles to San Francisco departing October 20",
    url: "https://www.google.com/travel/flights",
    facts: { from: "LAX", to: "SFO", date: "Oct 20" },
    maxSteps: 14,
    check: ({ text }) =>
      /departing flights/i.test(text) &&
      /San Francisco|SFO/.test(text) &&
      /One way/i.test(text),
  },
  {
    level: 6,
    name: "3-part goal",
    goal: "Open the zachsents/agent-quick-browse repository, go to its list of commits, and open the most recent commit",
    url: "https://github.com/zachsents",
    maxSteps: 12,
    check: ({ url }) => url.includes("/zachsents/agent-quick-browse/commit/"),
  },
  {
    level: 7,
    name: "read then act",
    goal: "Open the Wikipedia article for the city where Cloudflare's headquarters is located",
    url: "https://en.wikipedia.org/wiki/Cloudflare",
    maxSteps: 8,
    check: ({ url }) => url.endsWith("/wiki/San_Francisco"),
  },
  {
    level: 8,
    name: "5-part goal",
    goal: "In the zachsents/agent-quick-browse repository, open the extension folder, open manifest.json, then go back to the repository's main page and open README.md",
    url: "https://github.com/zachsents/agent-quick-browse",
    maxSteps: 14,
    check: ({ url }) =>
      url.endsWith("/zachsents/agent-quick-browse/blob/main/README.md"),
  },
  {
    level: 9,
    name: "compare values",
    goal: "Open the comments page for the story with the most points on this Hacker News page",
    url: "https://news.ycombinator.com",
    maxSteps: 8,
    prepare: async () =>
      z.string().parse(
        await tab.evaluate(() => {
          const scored = [...document.querySelectorAll("tr.athing")].map(
            (row) => ({
              id: row.id,
              points: Number.parseInt(
                document.querySelector(`#score_${row.id}`)?.textContent ?? "0",
              ),
            }),
          )
          return scored.reduce((best, s) => (s.points > best.points ? s : best))
            .id
        }),
      ),
    check: ({ url }, expected) => url.includes(`item?id=${expected}`),
  },
  {
    level: 10,
    name: "long widget flow",
    goal: "Search for round-trip flights from Los Angeles to New York for 2 adults, departing October 20 and returning October 27",
    url: "https://www.google.com/travel/flights",
    facts: { from: "LAX", to: "JFK", departure: "Oct 20", return: "Oct 27" },
    maxSteps: 20,
    check: ({ text }) =>
      /departing flights/i.test(text) &&
      /New York|JFK/.test(text) &&
      text.includes("Oct 27") &&
      /\b2\b/.test(text),
  },
  {
    level: 11,
    name: "chained reading",
    goal: "Open the article about the creator of Python, then open the article about the city where he was born",
    url: "https://en.wikipedia.org/wiki/Python_(programming_language)",
    maxSteps: 8,
    check: ({ url }) => url.endsWith("/wiki/The_Hague"),
  },
  {
    level: 12,
    name: "rich form",
    goal: "Fill in the web form: put the text, password and textarea facts in their fields, choose Two in the dropdown, uncheck the checked checkbox, check the default checkbox, select the default radio button, then submit",
    url: "https://www.selenium.dev/selenium/web/web-form.html",
    facts: {
      text: "hello clef",
      password: "s3cret",
      textarea: "multi part form test",
    },
    maxSteps: 14,
    check: ({ url }) =>
      [
        "my-text=hello+clef",
        "my-password=s3cret",
        "my-textarea=multi+part+form+test",
        "my-select=2",
      ].every((p) => url.includes(p)),
  },
  {
    level: 13,
    name: "3 hops + reading",
    goal: "Go to page 2 of Hacker News, open the comments for the first story on that page, then open the profile of the user who submitted that story",
    url: "https://news.ycombinator.com",
    maxSteps: 10,
    prepare: async () =>
      z.string().parse(
        await tab.evaluate(async () => {
          const html = await fetch("/?p=2").then((res) => res.text())
          return (
            new DOMParser()
              .parseFromString(html, "text/html")
              .querySelector(".hnuser")?.textContent ?? ""
          )
        }),
      ),
    check: ({ url }, expected) => url.endsWith(`/user?id=${expected}`),
  },
  {
    level: 14,
    name: "7-part goal",
    goal: "In the zachsents/agent-quick-browse repository: open the scripts folder, open next-version.ts, go back to the repository main page, open the extension folder, open background.js, go back to the repository main page, then open package.json",
    url: "https://github.com/zachsents/agent-quick-browse",
    maxSteps: 18,
    check: ({ url }) =>
      url.endsWith("/zachsents/agent-quick-browse/blob/main/package.json"),
  },
  {
    level: 15,
    name: "4-step chained reading",
    goal: "Open the article about the creator of Python, then the article about the city where he was born, then the article about the country that city is in, then the article about that country's capital city",
    url: "https://en.wikipedia.org/wiki/Python_(programming_language)",
    maxSteps: 12,
    check: ({ url }) => url.endsWith("/wiki/Amsterdam"),
  },
  {
    level: 16,
    name: "10-part goal",
    goal: "In the zachsents/agent-quick-browse repository: open the src folder, open agent.ts, go back to the src folder, open tab.ts, go back to the repository main page, open the extension folder, open manifest.json, go back to the extension folder, open background.js, then go back to the repository main page and open README.md",
    url: "https://github.com/zachsents/agent-quick-browse",
    maxSteps: 24,
    check: ({ url }) =>
      url.endsWith("/zachsents/agent-quick-browse/blob/main/README.md"),
  },
  {
    level: 17,
    name: "numeric threshold",
    goal: "Open the comments page of the first story on this page that has more than 100 comments",
    url: "https://news.ycombinator.com/ask",
    maxSteps: 8,
    prepare: async () =>
      z.string().parse(
        await tab.evaluate(
          () =>
            [...document.querySelectorAll("tr.athing")].find((row) => {
              const link = [
                ...(row.nextElementSibling?.querySelectorAll("a") ?? []),
              ].at(-1)
              return Number.parseInt(link?.textContent ?? "") > 100
            })?.id ?? "none",
        ),
      ),
    check: ({ url }, expected) => url.includes(`item?id=${expected}`),
  },
  {
    level: 18,
    name: "search with paging",
    goal: (prepared) =>
      `Open the comments page for the story titled "${prepared.split("|")[1]}". It is somewhere in the first few pages of Hacker News.`,
    url: "https://news.ycombinator.com",
    maxSteps: 12,
    prepare: async () =>
      z.string().parse(
        await tab.evaluate(async () => {
          const html = await fetch("/?p=3").then((res) => res.text())
          const row = new DOMParser()
            .parseFromString(html, "text/html")
            .querySelectorAll("tr.athing")[4]
          return `${row?.id}|${row?.querySelector(".titleline > a")?.textContent}`
        }),
      ),
    check: ({ url }, expected) =>
      url.includes(`item?id=${expected?.split("|")[0]}`),
  },
  {
    level: 19,
    name: "use page controls + decide",
    goal: "Sort this list of repositories by name and open the first repository in alphabetical order",
    url: "https://github.com/zachsents?tab=repositories",
    maxSteps: 10,
    prepare: async () =>
      z.string().parse(
        await tab.evaluate(async () => {
          const html = await fetch(
            "/zachsents?tab=repositories&sort=name",
          ).then((res) => res.text())
          return (
            new DOMParser()
              .parseFromString(html, "text/html")
              .querySelector("[itemprop='name codeRepository']")
              ?.getAttribute("href") ?? ""
          )
        }),
      ),
    check: ({ url }, expected) => !!expected && url.endsWith(expected),
  },
  {
    level: 20,
    name: "leave the site",
    goal: "Open the official GitHub repository for Bun, using the link in this article",
    url: "https://en.wikipedia.org/wiki/Bun_(software)",
    maxSteps: 8,
    check: ({ url }) => url.startsWith("https://github.com/oven-sh/bun"),
  },
  {
    level: 21,
    name: "impossible goal",
    goal: "Open this site's Contact Us page",
    url: "https://httpbin.org/forms/post",
    maxSteps: 6,
    check: ({ status }) => status === "blocked",
  },

  // App levels: local copies of the creator-studio widgets that trip agents up (see bench/fixtures/app.js)
  {
    level: 22,
    name: "caption with hashtag popup",
    goal: "Type the caption into the Description box, then click Save draft. Do not click Post.",
    url: fixture("caption.html"),
    facts: { caption: CAPTION },
    maxSteps: 6,
    check: ({ state }) =>
      z
        .object({ saved: z.literal(CAPTION), posted: z.literal(false) })
        .safeParse(state).success,
  },
  {
    level: 23,
    name: "multi-paragraph text",
    goal: "Set the video's title and description to the given text, then click Save.",
    url: fixture("description.html"),
    facts: {
      title: "Castling Is Checkmate 😱 #chess #shorts",
      description: DESCRIPTION,
    },
    maxSteps: 8,
    check: ({ state }) => {
      const saved = z
        .object({
          saved: z.object({ title: z.string(), description: z.string() }),
        })
        .safeParse(state).data?.saved
      return (
        saved?.title === "Castling Is Checkmate 😱 #chess #shorts" &&
        sameLines(saved.description, DESCRIPTION)
      )
    },
  },
  {
    level: 24,
    name: "hidden switches",
    goal: "Turn on the AI-generated content label (it's under Show more). Leave the other settings as they are.",
    url: fixture("switches.html"),
    maxSteps: 6,
    check: ({ state }) =>
      z
        .object({
          ai: z.literal(true),
          disclose: z.literal(false),
          comments: z.literal(true),
        })
        .safeParse(state).success,
  },
  {
    level: 25,
    name: "scrolling time picker",
    goal: "Set the time to 17:00 using the hour and minute lists",
    url: fixture("widgets.html"),
    maxSteps: 6,
    check: ({ state }) =>
      z.object({ time: z.literal("17:00") }).safeParse(state).success,
  },
  {
    level: 26,
    name: "autocomplete",
    goal: "Set the location to San Francisco, California",
    url: fixture("location.html"),
    facts: { location: "San Francisco" },
    maxSteps: 6,
    check: ({ state }) =>
      z
        .object({ chosen: z.literal("San Francisco, California") })
        .safeParse(state).success,
  },
  {
    level: 27,
    name: "hover icon → edit → save",
    goal: 'Rename the post "Castling is checkmate" to the new title using its Edit icon, then save',
    url: fixture("posts.html"),
    facts: { title: "Castling IS checkmate!" },
    maxSteps: 8,
    check: ({ state }) =>
      z
        .object({
          titles: z
            .array(z.string())
            .refine(
              (titles) =>
                titles.length === 4 &&
                titles.includes("Castling IS checkmate!") &&
                !titles.includes("Castling is checkmate"),
            ),
        })
        .safeParse(state).success,
  },
  {
    level: 28,
    name: "confirm dialog",
    goal: 'Delete the post "Bongcloud test" and confirm the deletion',
    url: fixture("posts.html"),
    maxSteps: 6,
    check: ({ state }) =>
      z
        .object({ deleted: z.tuple([z.literal("Bongcloud test")]) })
        .safeParse(state).success,
  },
  {
    level: 29,
    name: "scheduled post draft",
    goal: "Prepare a scheduled post without posting it: upload the video, wait for the upload to finish, type the caption into Description, choose Schedule and set the time to 17:00, then turn on AI-generated content (under Show more). Do not click Post or Discard.",
    url: fixture("studio.html"),
    facts: { caption: CAPTION },
    files: { video: new URL("fixtures/clip.mp4", import.meta.url).pathname },
    maxSteps: 20,
    check: ({ state }) =>
      z
        .object({
          uploaded: z.literal("clip.mp4"),
          caption: z.literal(CAPTION),
          when: z.literal("schedule"),
          time: z.literal("17:00"),
          ai: z.literal(true),
          disclose: z.literal(false),
          posted: z.literal(false),
          discarded: z.literal(false),
        })
        .safeParse(state).success,
  },
]
