<img src="extension/icons/icon-128.png" width="64" alt="" />

# Agent Quick Browse (AQB)

[![npm](https://img.shields.io/npm/v/agent-quick-browse)](https://www.npmjs.com/package/agent-quick-browse)

**Agents finish multi-step browser tasks in 51–77% less time (2–4× faster) than with screenshot-driven browser control.**

Fast, cheap browser actions for agents. A decision model — TypeSafe's Jev, OpenAI's GPT-6 Luna Decisions, or Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) — picks each action and element in your real, logged-in Chrome; a smarter agent plans the goals. No LLM in the loop. Runs in parallel background tabs, via CLI or MCP.

## Recommended setup

- **Model: Jev, text mode (the default when you have a gateway or TypeSafe key).** Fastest at every benchmark level and the most reliable (17–19 of 21 ceiling levels, vs 15 for GPT-6 Luna text and 10–18 for the vision configs). No flags needed. With only an OpenAI key, GPT-6 Luna is picked automatically.
- **If Jev gets stuck exploring** (e.g. hunting for something across pages), retry that sub-goal with `--model luna`.
- **Screenshots (`--vision`, with `--model luna` or `clef`) only when meaning is in pixels** — unlabeled icons, canvases, charts. It's slower and less reliable on normal pages.
- **Driving agent:** split tasks into sub-goals of a few explicit steps each, pass `facts` and `files`, check each result, and finish fiddly widgets (date pickers) yourself with `browser_look` + `browser_click`. That's the setup behind the 51–77% speedup below.

## Benchmarks

### Agent tasks: Sonnet + AQB vs Sonnet + Claude in Chrome

Each task needs ~3 sub-goals. Same model (Sonnet), same prompt; one side drives `browser_run` (Jev) and finishes stuck steps itself, the other uses Claude in Chrome. Average of 2 runs each; all 16 runs answered correctly.

| Task                                                       | AQB       | Claude in Chrome | Time saved |
| ---------------------------------------------------------- | --------- | ---------------- | ---------- |
| GitHub: latest commit → file at that commit → read a value | **28.2s** | 57.3s            | 51%        |
| Wikipedia fact → fill + submit a form on another site      | **24.9s** | 55.8s            | 55%        |
| GitHub releases → latest release → tag + date              | **17.5s** | 74.7s            | 77%        |
| Google Flights: one-way search → cheapest nonstop          | **41.1s** | 104.6s           | 61%        |

The agent also used about half as many tool calls (10.6 vs 19.5 per task).

### Single goals: decision models alone

Time per goal, from start page to done (5 runs per decision-model cell, 1 run for Sonnet; pass rate shown when below 5/5). ✗ = failed every run. Across all 21 ceiling levels: Jev 17/21, GPT-6 Luna text 15/21, GPT-6 Luna vision 10/21.

| Goal                      | Jev (text) | GPT-6 Luna (text) | GPT-6 Luna (vision) | Clef (text) | Clef (vision) | Sonnet + Claude in Chrome |
| ------------------------- | ---------- | ----------------- | ------------------- | ----------- | ------------- | ------------------------- |
| One click                 | **2.3s**   | 6.4s              | 9.8s                | 6.8s        | 11.8s         | 16.4s                     |
| Search + pick result      | **4.7s**   | 5.8s              | 8.4s                | 13.9s       | 9.1s          | 16.5s                     |
| 7-field form + submit     | **7.2s**   | 9.3s              | 10.0s               | 8.9s        | 11.7s         | 21.5s                     |
| 7-part navigation         | **13.9s**  | 20.8s             | 16.8s (2/5)         | 21.0s       | 23.0s         | 50.2s                     |
| Find a story across pages | **4.5s**   | 5.6s (2/5)        | ✗                   | ✗           | ✗             | 74.6s                     |
| Google Flights search     | ✗          | ✗                 | ✗                   | ✗           | ✗             | **56.0s**                 |

Sonnet times exclude ~15s of agent startup. Also passing in single-run ceiling tests: 10-part navigation, 4-step "read then follow" chains, 8-field forms with dropdowns/checkboxes/radios, numeric comparisons, hover-only controls (row buttons revealed on hover, hover menus, `mouseenter` menus — 9/9 across Jev, Clef, and Luna with `bun bench/hover.ts`, 0/6 before the hover action), file uploads (plain inputs and hidden inputs behind "Choose file" buttons — no OS file picker ever opens), and returning `blocked` for impossible goals. Where a single goal fails (Google Flights), the agent finishes it with `browser_look` / `browser_click` — still 61% faster end to end. Reproduce the single-goal table with `bun bench/run.ts --levels 1,2,4,14,18,5 --reps 5`.

## Scoping goals

- **One call:** one objective on one site with explicit steps — "search for X and open the result", "fill the form with these facts and submit", up to ~10 navigation steps, "open the story with the most points".
- **Split up or do yourself:** complex app widgets (date pickers, Google Flights — models declare `done` before the final submit), vague or judgment-heavy goals, anything needing writing.
- Pass every string to type (including dates) as `facts`, and files to upload as `files`. If a rich-text editor mangles typed text (hashtag/mention pickers), pass `keystrokes` (`--keystrokes`) to type it key by key. Check each result (`status`, `reason`, `url`, `actions`) before the next call.

## Setup

Requires macOS, Google Chrome, [Bun](https://bun.sh), and an API key for a decision model: a [Vercel AI Gateway](https://vercel.com/ai-gateway) key (covers Jev and GPT-6 Luna), or a TypeSafe key (Jev) or OpenAI key (GPT-6 Luna) directly. Published on npm as [`agent-quick-browse`](https://www.npmjs.com/package/agent-quick-browse). Paste this to your coding agent (Claude Code, Codex, Cursor, …):

```text
Set up the Agent Quick Browse (AQB) MCP server (https://github.com/zachsents/agent-quick-browse) for me:

1. Run: bunx agent-quick-browse@latest setup
2. Tell me to open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick
   ~/.aqb/extension. Wait until I confirm.
3. Check that one of these is exported in ~/.zprofile (login shells read that, not ~/.zshrc):
   AI_GATEWAY_API_KEY (Vercel AI Gateway, covers Jev + GPT-6 Luna), TYPESAFE_API_KEY (Jev), or
   OPENAI_API_KEY (GPT-6 Luna — then use --model luna / model "luna"). If none is, ask me to add one
   myself — never ask me to paste a key into chat.
4. Register the MCP server, launched through a login shell so it picks up that key. For Claude Code:
   claude mcp add -s user aqb -- zsh -lc "exec ~/.bun/bin/bun x agent-quick-browse@latest mcp"
   For other agents, add an MCP server with command `zsh` and
   args ["-lc", "exec ~/.bun/bin/bun x agent-quick-browse@latest mcp"].
5. Verify: bunx agent-quick-browse run "Open the Ask HN page" --url https://news.ycombinator.com
   It should print JSON with "status":"done" and a url ending in /ask.
6. Ask me whether to add this line to my global agent instructions (~/.claude/CLAUDE.md for
   Claude Code, ~/.codex/AGENTS.md or similar for other agents), and only add it if I say yes:
   "For routine web tasks (navigating, searching, filling forms), prefer the aqb MCP's
   browser_run over other browser tools; use those for visual work or when aqb is blocked."
7. Tell me to restart my agent session so the browser_* tools load.
```

Keys are read from the environment or from `~/.aqb/env` (`aqb setup --save-keys` copies them there, so agents and non-login shells find them). `AI_GATEWAY_API_KEY` is used when set; otherwise `TYPESAFE_API_KEY` (Jev, default model) and `OPENAI_API_KEY` (`--model luna`) talk to the providers directly. Clef needs `CLOUDFLARE_AI_ACCOUNT_ID` + `CLOUDFLARE_AI_API_TOKEN` (a Workers AI token). After upgrading, re-run `bunx agent-quick-browse@latest setup` and reload the extension.

## Usage

```sh
bunx agent-quick-browse run "search for Cloudflare and open its article" --url https://en.wikipedia.org --fact search=Cloudflare
bunx agent-quick-browse run "upload my resume" --url https://example.com/apply --file resume=/path/to/resume.pdf
bunx agent-quick-browse run "open my orders" --url https://amazon.com --model luna   # GPT-6 Luna Decisions (add --vision for screenshots)
bunx agent-quick-browse look --text     # what the model sees
bunx agent-quick-browse mcp       # MCP server: browser_run, browser_look, browser_click, browser_type, browser_hover, browser_upload, browser_tabs, browser_attach, browser_release, …
```

For the short `aqb` command, install globally: `bun add -g agent-quick-browse`.

Each `--session` (or MCP session) gets its own background tab, in a tab group you name with `--group` (default "Clef"); omit `--url` to continue where it left off. Take over a tab you already have open with `tabs` + `attach <tabId>`. `release` ends a session: tabs it opened close (`--keep` leaves them open, ungrouped), and taken-over tabs are handed back to their original group. MCP servers release their sessions automatically when the agent disconnects.
