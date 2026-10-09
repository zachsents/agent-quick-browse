import { runAgent } from "../src/agent.ts"
import type { DecisionModel } from "../src/decide.ts"
import type { SnapshotMode } from "../src/snapshot.ts"
import * as tab from "../src/tab.ts"

/*
 * Hover benchmark against bench/fixtures/hover.html: opacity-hidden row buttons, display:none card menus, and a
 * JS mouseenter menu. Run: bun bench/hover.ts
 */

const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(Bun.file(new URL("fixtures/hover.html", import.meta.url))),
})
const url = `http://localhost:${server.port}/`

const goals = [
  { goal: "Delete Item B", expected: "deleted B" },
  {
    goal: "Archive Project X (its menu appears when you hover the card)",
    expected: "archived X",
  },
  {
    goal: "Open Settings from the Account menu (it appears when you hover Account)",
    expected: "opened settings",
  },
]
const configs: { name: string; model: DecisionModel; mode: SnapshotMode }[] = [
  { name: "jev", model: "jev", mode: "text" },
  { name: "clef-vision", model: "clef", mode: "vision" },
  { name: "luna-vision", model: "luna", mode: "vision" },
]

const results = await Promise.all(
  configs.flatMap((config) =>
    goals.map(({ goal, expected }, i) =>
      tab.withSession(`hover-${config.name}-${i}`, async () => {
        await tab.goto(url)
        const log: string[] = []
        const result = await runAgent({
          goal,
          facts: {},
          files: {},
          model: config.model,
          mode: config.mode,
          maxSteps: 6,
          log: (l) => log.push(l),
        })
        const status = await tab.evaluate(
          // Only the first outcome counts: opening the row/card first is a failure even if the agent recovers
          () => document.getElementById("result")?.dataset.first ?? "nothing",
        )
        await tab.close()
        return {
          config: config.name,
          goal,
          pass: status === expected,
          status,
          result: result.status,
          log,
        }
      }),
    ),
  ),
)
for (const r of results)
  console.log(
    `${r.pass ? "PASS" : "FAIL"} ${r.config.padEnd(12)} ${r.goal}\n${r.log.map((l) => `    ${l}`).join("\n")}`,
  )
await server.stop()
