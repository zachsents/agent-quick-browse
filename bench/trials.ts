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
  maxSteps: number
  /**
   * Runs on the start page before the agent; its result is passed to `check`
   * (for answers that change over time).
   */
  prepare?: () => Promise<string>
  check: (
    page: { url: string; text: string; status: string },
    expected: string | undefined,
  ) => boolean
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
    goal: "Open the src/agent.ts file in the zachsents/clef-browser repository",
    url: "https://github.com/zachsents",
    maxSteps: 8,
    check: ({ url }) =>
      url.endsWith("/zachsents/clef-browser/blob/main/src/agent.ts"),
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
    goal: "Open the zachsents/clef-browser repository, go to its list of commits, and open the most recent commit",
    url: "https://github.com/zachsents",
    maxSteps: 12,
    check: ({ url }) => url.includes("/zachsents/clef-browser/commit/"),
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
    goal: "In the zachsents/clef-browser repository, open the extension folder, open manifest.json, then go back to the repository's main page and open README.md",
    url: "https://github.com/zachsents/clef-browser",
    maxSteps: 14,
    check: ({ url }) =>
      url.endsWith("/zachsents/clef-browser/blob/main/README.md"),
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
    goal: "In the zachsents/clef-browser repository: open the scripts folder, open next-version.ts, go back to the repository main page, open the extension folder, open background.js, go back to the repository main page, then open package.json",
    url: "https://github.com/zachsents/clef-browser",
    maxSteps: 18,
    check: ({ url }) =>
      url.endsWith("/zachsents/clef-browser/blob/main/package.json"),
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
    goal: "In the zachsents/clef-browser repository: open the src folder, open agent.ts, go back to the src folder, open tab.ts, go back to the repository main page, open the extension folder, open manifest.json, go back to the extension folder, open background.js, then go back to the repository main page and open README.md",
    url: "https://github.com/zachsents/clef-browser",
    maxSteps: 24,
    check: ({ url }) =>
      url.endsWith("/zachsents/clef-browser/blob/main/README.md"),
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
]
