import { homedir } from "node:os"
import { join } from "node:path"

export const STATE_DIR = join(homedir(), ".aqb")
/**
 * Unix socket the native host listens on. Only reachable by this user, unlike a
 * localhost port that web pages can hit.
 */
export const SOCKET_PATH = join(STATE_DIR, "host.sock")
export const HOST_NAME = "com.agent_quick_browse.host"
export const EXTENSION_ID = "enljjghanlofaifkkhdhgnnjekbjbpnc"
