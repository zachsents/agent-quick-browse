import { mkdirSync, rmSync } from "node:fs"
import { z } from "zod"
import { SOCKET_PATH, STATE_DIR } from "./paths.ts"

/*
 * Native messaging host. Chrome spawns this when the extension connects and kills it when Chrome quits. It bridges CLI
 * requests on a unix socket to the extension over stdio (4-byte little-endian length + JSON frames).
 */

const replySchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})
const requestSchema = z.object({
  method: z.enum(["cdp", "tab"]),
  params: z.unknown().optional(),
})

const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
let nextId = 1

function send(message: unknown) {
  const body = Buffer.from(JSON.stringify(message))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  process.stdout.write(Buffer.concat([header, body]))
}

function call(method: string, params: unknown) {
  const id = nextId++
  send({ id, method, params })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id))
        reject(new Error(`extension did not answer ${method} within 30s`))
    }, 30_000)
  })
}

async function readFrames() {
  let buffer = Buffer.alloc(0)
  for await (const chunk of Bun.stdin.stream()) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0)
      const reply = replySchema.parse(
        JSON.parse(buffer.subarray(4, 4 + length).toString()),
      )
      buffer = buffer.subarray(4 + length)
      const waiter = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.error != null) waiter?.reject(new Error(reply.error))
      else waiter?.resolve(reply.result)
    }
  }
  // Chrome closed the port
  process.exit(0)
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
rmSync(SOCKET_PATH, { force: true })
Bun.serve({
  unix: SOCKET_PATH,
  async fetch(req) {
    const { method, params } = requestSchema.parse(await req.json())
    return call(method, params).then(
      (result) => Response.json({ result }),
      (error: unknown) =>
        Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 502 },
        ),
    )
  },
})
await readFrames()
