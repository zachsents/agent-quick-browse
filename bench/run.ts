import { parseArgs } from "node:util"
import * as R from "remeda"
import { runAgent } from "../src/agent.ts"
import type { DecisionModel } from "../src/decide.ts"
import type { SnapshotMode } from "../src/snapshot.ts"
import * as tab from "../src/tab.ts"
import { TRIALS, type Trial } from "./trials.ts"

/*
 * Benchmark: runs trials × configs × reps, each in its own parallel session (background tab).
 *   bun bench/run.ts --levels 1,2,4,14,18,5 --configs clef-vision,clef-text,jev --reps 3 --concurrency 6
 */

const CONFIGS: Record<string, { model: DecisionModel; mode: SnapshotMode }> = {
  "clef-vision": { model: "clef", mode: "vision" },
  "clef-text": { model: "clef", mode: "text" },
  "flash-vision": { model: "clef-flash", mode: "vision" },
  jev: { model: "jev", mode: "text" },
  "luna-vision": { model: "luna", mode: "vision" },
  "luna-text": { model: "luna", mode: "text" },
}

const { values } = parseArgs({
  options: {
    levels: { type: "string", default: "1-10" },
    configs: { type: "string", default: "clef-vision,clef-text,jev" },
    reps: { type: "string", default: "1" },
    concurrency: { type: "string", default: "6" },
  },
})

/** "1-5" or "1,2,4,14" */
const levels = values.levels.includes("-")
  ? R.range(
      Number(values.levels.split("-")[0]),
      Number(values.levels.split("-")[1]) + 1,
    )
  : values.levels.split(",").map(Number)
const trials = R.sortBy(
  TRIALS.filter((t) => levels.includes(t.level)),
  (t) => levels.indexOf(t.level),
)
const configs = values.configs.split(",")
const jobs = trials.flatMap((trial) =>
  configs.flatMap((config) =>
    R.range(0, Number(values.reps)).map((rep) => ({ trial, config, rep })),
  ),
)

type Result = Awaited<ReturnType<typeof runJob>>

/**
 * Runs one trial in a fresh session and checks the outcome. Errors count as
 * failures.
 */
async function runJob({
  trial,
  config,
  rep,
}: {
  trial: Trial
  config: string
  rep: number
}) {
  const { model, mode } = CONFIGS[config] ?? {
    model: "clef" as const,
    mode: "vision" as const,
  }
  const session = `bench-${trial.level}-${config}-${rep}-${crypto.randomUUID().slice(0, 4)}`
  return tab.withSession(session, async () => {
    const started = performance.now()
    const log: string[] = []
    const outcome = await (async () => {
      await tab.goto(trial.url)
      const expected = await trial.prepare?.()
      const result = await runAgent({
        goal:
          typeof trial.goal === "string"
            ? trial.goal
            : trial.goal(expected ?? ""),
        facts: trial.facts ?? {},
        files: trial.files ?? {},
        model,
        mode,
        maxSteps: trial.maxSteps,
        log: (line) => log.push(line),
      })
      const [{ url }, text, state] = await Promise.all([
        tab.info(),
        tab.innerText(),
        tab.evaluateExpression("window.benchState?.() ?? null"),
      ])
      return {
        status: result.status,
        steps: result.actions.length,
        success: trial.check(
          { url, text, status: result.status, state },
          expected,
        ),
        state,
      }
    })().catch((error: unknown) => ({
      status: `error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      steps: 0,
      success: false,
      state: null,
    }))
    const secs = (performance.now() - started) / 1000
    await tab.close().catch(() => undefined)
    return {
      level: trial.level,
      name: trial.name,
      config,
      rep,
      ...outcome,
      secs,
      log,
    }
  })
}

/** Runs jobs with at most `limit` in flight. */
async function pool<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
) {
  const results: U[] = []
  let next = 0
  await Promise.all(
    R.range(0, limit).map(async () => {
      while (next < items.length) {
        const item = items[next++]
        if (item) results.push(await fn(item))
      }
    }),
  )
  return results
}

console.error(`${jobs.length} runs, concurrency ${values.concurrency}`)
const results: Result[] = await pool(
  jobs,
  Number(values.concurrency),
  async (job) => {
    const r = await runJob(job)
    console.error(
      `L${r.level} ${r.config.padEnd(12)} rep${r.rep}  ${r.success ? "PASS" : "FAIL"}  ${r.status.padEnd(9)} ${r.steps} steps  ${r.secs.toFixed(1)}s`,
    )
    return r
  },
)

await Bun.write(
  `bench/results/${new Date().toISOString().replaceAll(":", "-")}.json`,
  JSON.stringify(results, null, 2),
)

const rows = R.pipe(
  results,
  R.groupBy((r) => `${r.level}|${r.config}`),
  R.entries(),
  R.map(([, group]) => {
    const [first] = group
    const passed = group.filter((r) => r.success)
    return {
      level: first.level,
      name: first.name,
      config: first.config,
      pass: `${passed.length}/${group.length}`,
      avgSecs: passed.length ? R.meanBy(passed, (r) => r.secs).toFixed(1) : "-",
      avgSteps: passed.length
        ? R.meanBy(passed, (r) => r.steps).toFixed(1)
        : "-",
    }
  }),
  R.sortBy(
    (r) => levels.indexOf(r.level),
    (r) => configs.indexOf(r.config),
  ),
)
console.log(
  "| Level | Goal | Config | Pass | Avg time (passed) | Avg actions |",
)
console.log("|---|---|---|---|---|---|")
for (const r of rows)
  console.log(
    `| ${r.level} | ${r.name} | ${r.config} | ${r.pass} | ${r.avgSecs}s | ${r.avgSteps} |`,
  )
