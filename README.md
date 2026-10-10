<img src="extension/icons/icon-128.png" width="64" alt="" />

# Agent Quick Browse (AQB)

[![npm](https://img.shields.io/npm/v/agent-quick-browse)](https://www.npmjs.com/package/agent-quick-browse)

**Agents finish multi-step browser tasks in 38–77% less time (1.6–4.3× faster, 68% less overall) than with screenshot-driven browser control.**

Fast, cheap browser actions for agents. A decision model — TypeSafe's Jev, OpenAI's GPT-6 Luna Decisions, or Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) — picks each action and element in your real, logged-in Chrome; a smarter agent plans the goals. No LLM in the loop. Runs in parallel background tabs, via CLI or MCP.

## Recommended setup

- **Model: Jev, text mode (the default when you have a gateway or TypeSafe key).** Fastest or tied on most benchmark goals, and 5/5 on all of them except Google Flights and the 10-action scheduler draft. No flags needed. With only an OpenAI key, GPT-6 Luna (text) is picked automatically and is close behind.
- **If Jev gets stuck** on a long app flow, retry that sub-goal with `--model luna` or `--model clef --text` (Clef text finished the 10-action scheduler draft 5/5), or script it with `--match` commands.
- **Screenshots (`--vision`, with `--model luna` or `clef`) only when meaning is in pixels** — unlabeled icons, canvases, charts. It's slower and less reliable on normal pages.
- **Driving agent:** split tasks into sub-goals of a few explicit steps each, pass `facts` and `files`, check each result, and finish fiddly widgets (date pickers) yourself with `browser_look` + `browser_click`. That's the setup behind the 38–77% speedup below.

## Benchmarks

### Agent tasks: Sonnet + AQB vs Sonnet + Claude in Chrome

Each task needs ~3 sub-goals. Same model (Sonnet), same prompt; one side drives AQB (`run` with Jev for sub-goals, plus `text` / `look` / `click` to read and finish steps), the other uses Claude in Chrome. 2 runs each, 8 agents in parallel; all 16 runs answered correctly.

| Task                                                       | AQB       | Claude in Chrome | Time saved |
| ---------------------------------------------------------- | --------- | ---------------- | ---------- |
| GitHub: latest commit → file at that commit → read a value | **18.7s** | 72.8s            | 74%        |
| Wikipedia fact → fill + submit a form on another site      | **14.2s** | 35.7s            | 60%        |
| GitHub releases → latest release → tag + date              | **23.5s** | 38.0s            | 38%        |
| Google Flights: one-way search → cheapest nonstop          | **25.8s** | 112.0s           | 77%        |

The agent also made about a third as many tool calls (5.1 vs 14.8 per task). Google Flights now takes a single `run` (it used to need finishing by hand).

### Single goals: decision models alone

Time per goal, from start page to done (5 runs per decision-model cell, 1 run for Sonnet; pass rate shown when below 5/5). ✗ = failed every run.

| Goal                      | Jev (text) | GPT-6 Luna (text) | GPT-6 Luna (vision) | Clef (text) | Clef (vision) | Sonnet + Claude in Chrome |
| ------------------------- | ---------- | ----------------- | ------------------- | ----------- | ------------- | ------------------------- |
| One click                 | 2.7s       | **2.4s**          | 3.1s                | 4.7s        | 6.0s          | 19.1s                     |
| Search + pick result      | **4.7s**   | **4.7s**          | 5.4s                | 10.2s       | 8.1s          | 28.7s                     |
| 7-field form + submit     | **9.8s**   | 9.9s              | 13.1s               | 12.0s       | 12.7s         | 23.2s                     |
| 7-part navigation         | **17.0s**  | 18.2s             | ✗                   | 22.5s       | 30.3s         | 61.7s                     |
| Find a story across pages | **6.5s**   | 6.7s              | ✗                   | 17.9s (2/5) | ✗             | 92.2s                     |
| Google Flights search     | ✗          | ✗                 | ✗                   | ✗           | ✗             | **56.2s**                 |

Sonnet times exclude ~15s of agent startup; like AQB, it may only navigate to the start URL and must click through everything else. Reproduce with `bun bench/run.ts --levels 1,2,4,14,18,5 --reps 5`.

### App widgets: creator-studio patterns

Local copies of the TikTok Studio / YouTube Studio widgets that trip agents up ([`bench/fixtures`](bench/fixtures)), checked against the exact end state. 5 runs per cell.

| Goal                                                           | Jev (text)  | GPT-6 Luna (text) | GPT-6 Luna (vision) | Clef (text) | Clef (vision) |
| -------------------------------------------------------------- | ----------- | ----------------- | ------------------- | ----------- | ------------- |
| Caption with a hashtag suggestion popup                        | 4.4s        | 3.9s              | 4.1s                | **3.6s**    | 4.6s          |
| Multi-paragraph rich text + Save                               | **5.3s**    | 5.5s              | 6.2s                | 7.0s        | 7.2s          |
| Switches hidden under "Show more" (aria-hidden inputs)         | **3.4s**    | 3.9s              | 4.4s                | 4.2s        | 4.6s          |
| Time picker: scrolling, unlabeled hour/minute columns          | **3.4s**    | 3.7s              | ✗                   | 4.5s        | ✗             |
| Autocomplete: type, then pick the suggestion                   | 3.6s        | **3.3s**          | 4.0s                | 4.0s        | 6.2s          |
| Hover-only Edit icon → rename → Save                           | **5.2s**    | 6.3s              | 6.9s                | 7.6s        | 7.9s          |
| Delete + confirm dialog                                        | **3.5s**    | **3.5s**          | 8.2s                | 3.9s        | 5.8s          |
| Full scheduled-post draft (upload, wait, caption, time, label) | 17.8s (1/5) | ✗                 | ✗                   | **16.8s**   | ✗             |

The full draft is ~10 actions in one goal; models tend to set the hour and skip the minute. Split flows like it into sub-goals, or script them: the same draft with exact commands (`aqb upload/type/click --match …`, [`bench/scripted.sh`](bench/scripted.sh)) takes ~12s, with no decision model and the same result every time. Vision configs can't reach list items scrolled out of view. Reproduce with `bun bench/run.ts --levels 22-29 --reps 5`.

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
bunx agent-quick-browse mcp       # MCP server: browser_run, browser_look, browser_click, browser_type, browser_key, browser_upload, browser_tabs, browser_attach, browser_release, …
```

Exact steps without a model, using the numbers from the latest `look --text`:

```sh
aqb click 12
aqb type 15 "Caption #chess #fyp" --keystrokes   # replaces the text and verifies it; add --submit to press Enter
aqb key Escape                                   # also Enter, Tab, ArrowDown, Cmd+A, Shift+Tab, …
aqb upload 16 ./video.mp4
aqb scroll down; aqb navigate <url>; aqb back; aqb text
aqb value 15                                     # a field's full current value
aqb click --match 'radio "No, it.s not made for kids'   # target by outline text, waiting up to --timeout 30s
aqb wait --match 'Uploaded'                      # wait until a line of the outline matches
```

For the short `aqb` command, install globally: `bun add -g agent-quick-browse`.

Each `--session` (or MCP session) gets its own background tab, in a tab group you name with `--group` (default "AQB"); omit `--url` to continue where it left off. Take over a tab you already have open with `tabs` + `attach <tabId>`. `release` ends a session: tabs it opened close (`--keep` leaves them open, ungrouped), and taken-over tabs are handed back to their original group. MCP servers release their sessions automatically when the agent disconnects.
