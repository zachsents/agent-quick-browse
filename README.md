# clef-browser

Fast, cheap browser actions for agents. A decision model — Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) or TypeSafe's Jev — picks each action and element in your real, logged-in Chrome; a smarter agent plans the goals. No LLM in the loop. Runs in parallel background tabs, via CLI or MCP.

## Benchmarks

Average time per goal, from start page to done (5 runs per decision-model cell, 1 run for Sonnet). ✗ = failed every run.

| Goal                      | Jev (text) | Clef (text) | Clef (vision) | Sonnet + Claude in Chrome |
| ------------------------- | ---------- | ----------- | ------------- | ------------------------- |
| One click                 | **2.3s**   | 6.8s        | 11.8s         | 16.4s                     |
| Search + pick result      | **4.7s**   | 13.9s       | 9.1s          | 16.5s                     |
| 7-field form + submit     | **7.2s**   | 8.9s        | 11.7s         | 21.5s                     |
| 7-part navigation         | **13.9s**  | 21.0s       | 23.0s         | 50.2s                     |
| Find a story across pages | **4.5s**   | ✗           | ✗             | 74.6s                     |
| Google Flights search     | ✗          | ✗           | ✗             | **56.0s**                 |

Sonnet times exclude ~15s of agent startup. Also passing in single-run ceiling tests: 10-part navigation, 4-step "read then follow" chains, 8-field forms with dropdowns/checkboxes/radios, numeric comparisons, and returning `blocked` for impossible goals. Reproduce with `bun bench/run.ts --levels 1,2,4,14,18,5 --reps 5`.

## Scoping goals

- **One call:** one objective on one site with explicit steps — "search for X and open the result", "fill the form with these facts and submit", up to ~10 navigation steps, "open the story with the most points".
- **Split up or do yourself:** complex app widgets (date pickers, Google Flights — models declare `done` before the final submit), vague or judgment-heavy goals, anything needing writing.
- Pass every string to type (including dates) as `facts`. Check each result (`status`, `reason`, `url`, `actions`) before the next call.

## Setup

```sh
bun install && bun link && clef-browser setup
```

Load `extension/` unpacked in `chrome://extensions`. Env: `AI_GATEWAY_API_KEY` (Jev), `CLOUDFLARE_AI_ACCOUNT_ID` + `CLOUDFLARE_AI_API_TOKEN` (Clef).

## Usage

```sh
clef-browser run "search for Cloudflare and open its article" --url https://en.wikipedia.org --fact search=Cloudflare --model jev
clef-browser look --text          # what the model sees
clef-browser mcp                  # MCP server: browser_run, browser_look, browser_click, browser_type, …
```

Each `--session` (or MCP session) gets its own background tab; omit `--url` to continue where it left off.
