# clef-browser

[![npm](https://img.shields.io/npm/v/clef-browser)](https://www.npmjs.com/package/clef-browser)

**Agents finish multi-step browser tasks in 51–77% less time (2–4× faster) than with screenshot-driven browser control.**

Fast, cheap browser actions for agents. A decision model — Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) or TypeSafe's Jev — picks each action and element in your real, logged-in Chrome; a smarter agent plans the goals. No LLM in the loop. Runs in parallel background tabs, via CLI or MCP.

## Benchmarks

### Agent tasks: Sonnet + clef-browser vs Sonnet + Claude in Chrome

Each task needs ~3 sub-goals. Same model (Sonnet), same prompt; one side drives `browser_run` (Jev) and finishes stuck steps itself, the other uses Claude in Chrome. Average of 2 runs each; all 16 runs answered correctly.

| Task                                                       | clef-browser | Claude in Chrome | Time saved |
| ---------------------------------------------------------- | ------------ | ---------------- | ---------- |
| GitHub: latest commit → file at that commit → read a value | **28.2s**    | 57.3s            | 51%        |
| Wikipedia fact → fill + submit a form on another site      | **24.9s**    | 55.8s            | 55%        |
| GitHub releases → latest release → tag + date              | **17.5s**    | 74.7s            | 77%        |
| Google Flights: one-way search → cheapest nonstop          | **41.1s**    | 104.6s           | 61%        |

The agent also used about half as many tool calls (10.6 vs 19.5 per task).

### Single goals: decision models alone

Time per goal, from start page to done (5 runs per decision-model cell, 1 run for Sonnet). ✗ = failed every run.

| Goal                      | Jev (text) | Clef (text) | Clef (vision) | Sonnet + Claude in Chrome |
| ------------------------- | ---------- | ----------- | ------------- | ------------------------- |
| One click                 | **2.3s**   | 6.8s        | 11.8s         | 16.4s                     |
| Search + pick result      | **4.7s**   | 13.9s       | 9.1s          | 16.5s                     |
| 7-field form + submit     | **7.2s**   | 8.9s        | 11.7s         | 21.5s                     |
| 7-part navigation         | **13.9s**  | 21.0s       | 23.0s         | 50.2s                     |
| Find a story across pages | **4.5s**   | ✗           | ✗             | 74.6s                     |
| Google Flights search     | ✗          | ✗           | ✗             | **56.0s**                 |

Sonnet times exclude ~15s of agent startup. Also passing in single-run ceiling tests: 10-part navigation, 4-step "read then follow" chains, 8-field forms with dropdowns/checkboxes/radios, numeric comparisons, hover-only controls (row buttons revealed on hover, hover menus, `mouseenter` menus — 6/6 with `bun bench/hover.ts`, 0/6 before the hover action), and returning `blocked` for impossible goals. Where a single goal fails (Google Flights), the agent finishes it with `browser_look` / `browser_click` — still 61% faster end to end. Reproduce the single-goal table with `bun bench/run.ts --levels 1,2,4,14,18,5 --reps 5`.

## Scoping goals

- **One call:** one objective on one site with explicit steps — "search for X and open the result", "fill the form with these facts and submit", up to ~10 navigation steps, "open the story with the most points".
- **Split up or do yourself:** complex app widgets (date pickers, Google Flights — models declare `done` before the final submit), vague or judgment-heavy goals, anything needing writing.
- Pass every string to type (including dates) as `facts`. Check each result (`status`, `reason`, `url`, `actions`) before the next call.

## Setup

Requires macOS, Google Chrome, [Bun](https://bun.sh), and a [Vercel AI Gateway](https://vercel.com/ai-gateway) key. Published on npm as [`clef-browser`](https://www.npmjs.com/package/clef-browser). Paste this to your coding agent (Claude Code, Codex, Cursor, …):

```text
Set up the clef-browser MCP server (https://github.com/zachsents/clef-browser) for me:

1. Run: bunx clef-browser@latest setup
2. Tell me to open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick
   ~/.clef-browser/extension. Wait until I confirm.
3. Check that AI_GATEWAY_API_KEY is exported in ~/.zprofile (login shells read that, not ~/.zshrc).
   If it isn't, ask me to add it myself — never ask me to paste the key into chat.
4. Register the MCP server, launched through a login shell so it picks up that key. For Claude Code:
   claude mcp add -s user clef-browser -- zsh -lc "exec ~/.bun/bin/bun x clef-browser@latest mcp"
   For other agents, add an MCP server with command `zsh` and
   args ["-lc", "exec ~/.bun/bin/bun x clef-browser@latest mcp"].
5. Verify: bunx clef-browser run "Open the Ask HN page" --url https://news.ycombinator.com
   It should print JSON with "status":"done" and a url ending in /ask.
6. Ask me whether to add this line to my global agent instructions (~/.claude/CLAUDE.md for
   Claude Code, ~/.codex/AGENTS.md or similar for other agents), and only add it if I say yes:
   "For routine web tasks (navigating, searching, filling forms), prefer the clef-browser MCP's
   browser_run over other browser tools; use those for visual work or when clef-browser is blocked."
7. Tell me to restart my agent session so the browser_* tools load.
```

Optional: set `CLOUDFLARE_AI_ACCOUNT_ID` and `CLOUDFLARE_AI_API_TOKEN` (a Workers AI token) to use the Clef models. After upgrading, re-run `bunx clef-browser@latest setup` and reload the extension.

## Usage

```sh
bunx clef-browser run "search for Cloudflare and open its article" --url https://en.wikipedia.org --fact search=Cloudflare
bunx clef-browser look --text     # what the model sees
bunx clef-browser mcp             # MCP server: browser_run, browser_look, browser_click, browser_type, browser_hover, …
```

Each `--session` (or MCP session) gets its own background tab; omit `--url` to continue where it left off.
