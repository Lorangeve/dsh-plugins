/**
 * Host half of the Skills panel bundle.
 *
 * Three HTTP callers share one collector:
 *
 * - `GET  /skills-panel/list`   — every skill this profile can currently reach,
 *   with its source, instruction path and current invocation state;
 * - `GET  /skills-panel/file`   — the SKILL.md body of a skill that route just
 *   listed, so the panel can show it without a second discovery path;
 * - `POST /skills-panel/toggle` — flip one on-disk skill on or off.
 *
 * "On" and "off" are the harness's own frontmatter contract: `off` writes
 * `disable-model-invocation: true` and `user-invocable: false`, which removes the
 * skill from the model catalog and from the `/` menu; `on` writes the inverse.
 * Skills shipped inside a bundled package (app.asar) are read-only and report
 * `manageable: false`.
 */

import { constants as fsConstants } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const inject = ['skills', 'webServer']

const LIST_PATH = '/skills-panel/list'
const FILE_PATH = '/skills-panel/file'
const TOGGLE_PATH = '/skills-panel/toggle'

const MAX_BODY_BYTES = 64 * 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_SCOPES = 6

const KEY_MODEL = 'disable-model-invocation'
const KEY_USER = 'user-invocable'

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Answer with JSON and no caching; every answer here is a live fact.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status code.
 * @param {unknown} payload JSON payload.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Apply the connection's Host/Origin and browser-credential checks to a route
 * this plugin owns. Returns true when the request was already refused.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {import('@deepseek-ai/cordis').Context} scope plugin context.
 */
function refused(req, res, scope) {
  const connection = scope.get('connection')
  if (connection === undefined) return false
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    rejection = 403
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * Resource-side twin of {@link refused}: a Fetch request instead of a Node one.
 * @param {Request} request fetch request.
 * @param {import('@deepseek-ai/cordis').Context} scope plugin context.
 * @returns {Promise<Response | undefined>}
 */
function refusedRequest(request, scope) {
  const connection = scope.get('connection')
  if (connection === undefined) return undefined
  let rejection
  try {
    rejection = connection.requestRejection({ headers: request.headers })
  } catch {
    rejection = 403
  }
  return rejection === undefined ? undefined : new Response(null, { status: rejection })
}

/**
 * Read one bounded JSON body.
 * @param {import('node:http').IncomingMessage} req request.
 * @returns {Promise<unknown | null>} parsed body, or null when it is not JSON.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The user root this panel tells people to drop skills into. */
function userSkillsDir() {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'skills')
}

/**
 * Map a provider source onto the panel's three groups.
 * @param {string} source skill source.
 */
function groupOf(source) {
  if (source === 'project-dsh' || source === 'project-agents') return 'project'
  if (source === 'user-dsh' || source === 'user-agents' || source === 'custom') return 'user'
  if (source === 'bundled' || source === 'runtime') return 'bundled'
  return 'other'
}

/**
 * Whether this panel may rewrite the skill's frontmatter.
 *
 * Packaged skills resolve inside `app.asar`, which the Host filesystem wrapper
 * refuses to open for writing; probing that is cheaper and more honest than
 * guessing from the source label.
 * @param {string | undefined} filePath instruction path.
 * @returns {Promise<boolean>}
 */
async function canManage(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  try {
    await access(filePath, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Collect the union of the global layer and every live agent's layer.
 *
 * A global panel has no Session of its own: the preset-scoped skills of the
 * agents running in this Host are added so the list matches what a session can
 * actually call. First occurrence by name wins, global layer first.
 * @param {import('@deepseek-ai/cordis').Context} scope plugin context.
 */
async function collect(scope) {
  const workingDirectory = scope.get('workingDirectory')
  const defaultCwd = workingDirectory?.defaultDirectory ?? process.cwd()

  /** @type {Map<string, any>} */
  const byName = new Map()
  let complete = true
  const add = (list) => {
    for (const summary of list) {
      if (!byName.has(summary.name)) byName.set(summary.name, summary)
    }
  }

  const base = await scope.skills.snapshot({ cwd: defaultCwd })
  complete = base.complete
  add(base.skills)

  const agents = scope.get('agents')
  let live = []
  try {
    live = agents?.list() ?? []
  } catch {
    live = []
  }
  for (const agent of live.slice(0, MAX_SCOPES)) {
    try {
      let cwd = defaultCwd
      try {
        cwd = workingDirectory?.get(agent.session) ?? defaultCwd
      } catch {
        cwd = defaultCwd
      }
      const snapshot = await scope.skills.snapshot({ cwd, scope: agent })
      complete = complete && snapshot.complete
      add(snapshot.skills)
    } catch {
      // A layer that cannot be read still leaves the global list usable.
      complete = false
    }
  }

  const skills = []
  for (const summary of byName.values()) {
    const manageable = await canManage(summary.path)
    const modelInvocable = summary.invocation?.modelInvocable !== false
    const userInvocable = summary.invocation?.userInvocable !== false
    skills.push({
      name: summary.name,
      description: summary.description,
      whenToUse: summary.whenToUse ?? undefined,
      source: summary.source,
      provider: summary.provider,
      group: groupOf(summary.source),
      path: summary.path ?? undefined,
      modelInvocable,
      userInvocable,
      enabled: modelInvocable && userInvocable,
      mixed: modelInvocable !== userInvocable,
      manageable,
    })
  }

  skills.sort((left, right) => {
    const order = { project: 0, user: 1, bundled: 2, other: 3 }
    const delta = (order[left.group] ?? 3) - (order[right.group] ?? 3)
    return delta !== 0 ? delta : left.name.localeCompare(right.name)
  })

  return {
    skills,
    complete,
    cwd: defaultCwd,
    counts: {
      total: skills.length,
      manageable: skills.filter((skill) => skill.manageable).length,
      enabled: skills.filter((skill) => skill.enabled).length,
    },
    dirs: {
      user: userSkillsDir(),
      project: path.join(defaultCwd, '.dsh', 'skills'),
    },
  }
}

// ---------------------------------------------------------------------------
// Frontmatter editing
// ---------------------------------------------------------------------------

/**
 * Split a SKILL.md into its YAML frontmatter lines and body.
 * @param {string} text file text.
 * @returns {{lines: string[], start: number, end: number, eol: string} | null}
 *   `start`/`end` delimit the frontmatter interior; null when there is none.
 */
function splitFrontmatter(text) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const eol = normalized.includes('\r\n') ? '\r\n' : '\n'
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '---' || line === '...') return { lines, start: 1, end: index, eol }
  }
  return null
}

/**
 * Set one top-level frontmatter key, replacing an existing line or inserting a
 * new one before the closing fence.
 * @param {{lines: string[], start: number, end: number}} frontmatter block.
 * @param {string} key key name.
 * @param {string} value scalar value.
 */
function setFrontmatterKey(frontmatter, key, value) {
  for (let index = frontmatter.start; index < frontmatter.end; index += 1) {
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(frontmatter.lines[index])
    if (match !== null && match[1] === key) {
      frontmatter.lines[index] = `${key}: ${value}`
      return
    }
  }
  frontmatter.lines.splice(frontmatter.end, 0, `${key}: ${value}`)
  frontmatter.end += 1
}

/**
 * Write the invocation contract for one skill.
 * @param {string} filePath SKILL.md path.
 * @param {boolean} enabled whether both callers may use the skill.
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function writeInvocation(filePath, enabled) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    return { ok: false, error: `read failed: ${errorMessage(error)}` }
  }
  const frontmatter = splitFrontmatter(text)
  if (frontmatter === null) return { ok: false, error: 'SKILL.md has no YAML frontmatter' }
  setFrontmatterKey(frontmatter, KEY_MODEL, enabled ? 'false' : 'true')
  setFrontmatterKey(frontmatter, KEY_USER, enabled ? 'true' : 'false')
  try {
    await writeFile(filePath, frontmatter.lines.join(frontmatter.eol), 'utf8')
  } catch (error) {
    return { ok: false, error: `write failed: ${errorMessage(error)}` }
  }
  return { ok: true }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof Error) {
    const code = error.code === undefined ? '' : `${error.code}: `
    return `${code}${error.message}`
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Register the three routes behind the connection trust fence.
 * @param {import('@deepseek-ai/cordis').Context} scope plugin context.
 */
export function apply(ctx) {
  const register = (pathName, handler) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: pathName, handler }),
      `skills-panel:${pathName}`,
    )

  register(LIST_PATH, async (req, res) => {
    if (refused(req, res, ctx)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    try {
      sendJson(res, 200, await collect(ctx))
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) })
    }
  })

  register(FILE_PATH, async (req, res) => {
    if (refused(req, res, ctx)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const requested = url.searchParams.get('path') ?? ''
      const { skills } = await collect(ctx)
      const target = skills.find((skill) => skill.path === requested)
      if (target === undefined || target.path === undefined) {
        sendJson(res, 404, { error: 'not a listed skill' })
        return
      }
      const text = await readFile(target.path, 'utf8')
      sendJson(res, 200, {
        path: target.path,
        name: target.name,
        content: text.length > MAX_FILE_BYTES ? `${text.slice(0, MAX_FILE_BYTES)}\n\n… truncated` : text,
      })
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) })
    }
  })

  register(TOGGLE_PATH, async (req, res) => {
    if (refused(req, res, ctx)) return
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const body = await readJsonBody(req)
    const target = body !== null && typeof body === 'object' ? body : null
    const requested = target !== null && typeof target.path === 'string' ? target.path : null
    const enabled = target !== null && typeof target.enabled === 'boolean' ? target.enabled : null
    if (requested === null || enabled === null) {
      sendJson(res, 400, { error: 'expected { path: string, enabled: boolean }' })
      return
    }
    try {
      const { skills } = await collect(ctx)
      const skill = skills.find((entry) => entry.path === requested)
      if (skill === undefined || skill.path === undefined) {
        sendJson(res, 404, { error: 'not a listed skill' })
        return
      }
      if (!skill.manageable) {
        sendJson(res, 409, { error: 'this skill ships with a package and is read-only' })
        return
      }
      const written = await writeInvocation(skill.path, enabled)
      if (!written.ok) {
        sendJson(res, 500, { error: written.error })
        return
      }
      sendJson(res, 200, { name: skill.name, path: skill.path, enabled })
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) })
    }
  })
}
