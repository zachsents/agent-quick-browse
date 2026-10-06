# clef-browser

Drive your own, logged-in Chrome with Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision model. Each step, Clef sees a screenshot with numbered interactive elements and picks one action + one element (~2s). A text LLM via Vercel AI Gateway only writes text to type and the final answer.

The agent works in one dedicated tab (pink "Clef" tab group). Every command continues in that tab, so a smarter model can chain small sub-goals.

## Setup

```sh
bun install && bun link
clef-browser setup   # registers the native messaging host
```

Then in `chrome://extensions`: Developer mode → Load unpacked → `extension/` (ID `enljjghanlofaifkkhdhgnnjekbjbpnc`).

Env (in `~/.zprofile`): `CLOUDFLARE_AI_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN` (Workers AI token), `AI_GATEWAY_API_KEY`.

## Usage

```sh
clef-browser run "search for Cloudflare and find its founding year" --url https://en.wikipedia.org
clef-browser run "open the History section"     # continues on the same tab
clef-browser look                               # numbered elements + annotated screenshot
clef-browser mcp                                # stdio MCP server
```

MCP tools: `browser_run`, `browser_look`, `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_page_text`.

## How it connects

`extension/` (MV3, `chrome.debugger`) ⇄ native messaging ⇄ `src/host.ts` ⇄ unix socket `~/.clef-browser/host.sock` ⇄ CLI / MCP server. Chrome starts the host automatically. The socket (not a localhost port) keeps web pages from reaching it.
