import { $ } from "bun"

/*
 * Prints `version=X.Y.Z` (for $GITHUB_OUTPUT) when commits since the last release tag warrant a release, else nothing.
 * Bump from commit messages: "type!:" or "BREAKING CHANGE" → major (minor while on 0.x), "feat" → minor, anything else
 * → patch. The base is whichever is newer: the last vX.Y.Z tag or the version on npm.
 */

const lastTag = (
  await $`git describe --tags --abbrev=0 --match "v[0-9]*"`
    .nothrow()
    .quiet()
    .text()
).trim()
const published = (
  await $`npm view clef-browser version`.nothrow().quiet().text()
).trim()

const messages = (
  await $`git log ${lastTag ? `${lastTag}..HEAD` : "HEAD"} --format=%B%x00`
    .quiet()
    .text()
)
  .split("\0")
  .map((message) => message.trim())
  .filter(Boolean)
if (messages.length === 0) process.exit(0)

const base = [lastTag.replace(/^v/, ""), published, "0.0.0"]
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  .map((v) => v.split(".").map(Number))
  .reduce((best, v) => (compare(v, best) > 0 ? v : best))
const [major = 0, minor = 0, patch = 0] = base

const breaking = messages.some(
  (m) => /^\w+(\(.+\))?!:/.test(m) || m.includes("BREAKING CHANGE"),
)
const feature = messages.some((m) => /^feat(\(.+\))?:/i.test(m))
const next =
  breaking && major > 0
    ? [major + 1, 0, 0]
    : breaking || feature
      ? [major, minor + 1, 0]
      : [major, minor, patch + 1]

console.log(`version=${next.join(".")}`)

/** Compares two [major, minor, patch] tuples. */
function compare(
  [a0 = 0, a1 = 0, a2 = 0]: number[],
  [b0 = 0, b1 = 0, b2 = 0]: number[],
) {
  return a0 - b0 || a1 - b1 || a2 - b2
}
