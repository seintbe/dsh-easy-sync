// Host-side HTTP routes for the optional desktop client plugin.
//
// The client half (../client.js) renders "sync this workspace" entries in the
// session row menu. It cannot reach the Host's engine directly, so these two
// routes are the bridge:
//
//   GET  /dsh-easy-sync/session?sessionId=...  -> is the session's workspace a sync workspace?
//   POST /dsh-easy-sync/session-action         -> {"sessionId", action: "sync"|"restore"|"archive"}
//
// Both routes sit behind the composition's `connection` trust fence, exactly
// like DSH's own open-in-app routes: without it, a cross-site request could
// mutate the operator's conversation archive. The routes are only registered
// when both `webServer` and `connection` exist (web profiles), so headless
// profiles keep the plugin's agent-tool-only surface.

import { readLocalEntry } from './engine.js'

/** Client mirror: keep these two constants in sync with ../client.js. */
export const INFO_ROUTE = '/dsh-easy-sync/session'
export const ACTION_ROUTE = '/dsh-easy-sync/session-action'

/** Session rows carry small JSON bodies; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

const ACTIONS = {
  sync: { restore: true, archive: true },
  restore: { restore: true, archive: false },
  archive: { restore: false, archive: true },
}

/**
 * Register the two routes on a context that already has `webServer` and
 * `connection`.
 *
 * @param {any} ctx
 * @param {{
 *   engine: import('./engine.js').SyncEngine,
 *   log: (kind: 'error'|'warn'|'info'|'debug', message: string) => void,
 *   onRegistered?: (routes: string[]) => void,
 * }} deps
 * @returns {string[]} the registered paths (empty when the services are unusable)
 */
export function registerWebRoutes(ctx, deps) {
  const webServer = ctx?.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return []
  const routes = [INFO_ROUTE, ACTION_ROUTE]
  const register = (path, handler, label) => {
    const dispose = webServer.register({ kind: 'exact', path, handler })
    try {
      if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
        ctx.effect(() => dispose, `dsh-easy-sync: ${label}`)
      }
    } catch {
      // Disposal is best-effort in minimal embedders.
    }
  }
  register(INFO_ROUTE, (req, res) => handleInfoRequest(ctx, deps, req, res), `GET ${INFO_ROUTE}`)
  register(ACTION_ROUTE, (req, res) => handleActionRequest(ctx, deps, req, res), `POST ${ACTION_ROUTE}`)
  deps.onRegistered?.(routes)
  return routes
}

/**
 * Resolve the sync workspace owning one session id without relying on the
 * browser: the local session header (or the live session) carries the cwd.
 *
 * @param {any} ctx
 * @param {{
 *   engine: import('./engine.js').SyncEngine,
 * }} deps
 * @param {string} sessionId
 * @returns {{ workspace: ReturnType<import('./engine.js').SyncEngine['workspaceForCwd']>, cwd: string | undefined }}
 */
export function resolveSessionWorkspace(ctx, deps, sessionId) {
  const registry = safeService(ctx, 'workspaceRegistry')
  const registryPaths = registry !== undefined && typeof registry.list === 'function'
    ? registry.list().map((workspace) => workspace.path).filter((path) => typeof path === 'string')
    : []
  deps.engine.refreshWorkspaces({ registryPaths })

  let cwd
  for (const located of deps.engine.locateLocal(sessionId)) {
    const entry = readLocalEntry(located.dir)
    if (entry !== undefined && entry.header.id === sessionId && typeof entry.header.cwd === 'string') {
      cwd = entry.header.cwd
      break
    }
  }
  if (cwd === undefined) {
    const sessions = safeService(ctx, 'sessions')
    const session = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (typeof session?.header?.cwd === 'string' && session.header.cwd !== '') cwd = session.header.cwd
    else if (typeof session?.cwd === 'string' && session.cwd !== '') cwd = session.cwd
  }
  if (cwd === undefined && registry !== undefined && typeof registry.list === 'function') {
    const record = registry.list().find((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
    if (record !== undefined && typeof record.path === 'string') cwd = record.path
  }

  return { workspace: deps.engine.workspaceForCwd(cwd), cwd }
}

/**
 * Pure decision function behind GET /dsh-easy-sync/session.
 *
 * @param {any} ctx
 * @param {{ engine: import('./engine.js').SyncEngine }} deps
 * @param {string} sessionId
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function sessionInfo(ctx, deps, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { status: 400, body: { ok: false, error: 'sessionId is required' } }
  }
  const { workspace, cwd } = resolveSessionWorkspace(ctx, deps, sessionId)
  if (workspace === undefined) {
    return { status: 200, body: { ok: true, enabled: false, cwd: cwd ?? null } }
  }
  return {
    status: 200,
    body: {
      ok: true,
      enabled: true,
      cwd: cwd ?? null,
      workspace: { path: workspace.path, title: workspace.title },
    },
  }
}

/**
 * Pure decision function behind POST /dsh-easy-sync/session-action.
 *
 * @param {any} ctx
 * @param {{ engine: import('./engine.js').SyncEngine }} deps
 * @param {unknown} input
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function sessionAction(ctx, deps, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 400, body: { ok: false, error: 'JSON object body is required' } }
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  if (sessionId === '') return { status: 400, body: { ok: false, error: 'sessionId is required' } }
  const action = typeof record.action === 'string' && record.action !== '' ? record.action : 'sync'
  const options = ACTIONS[action]
  if (options === undefined) {
    return { status: 400, body: { ok: false, error: `unknown action: ${action}` } }
  }
  const { workspace } = resolveSessionWorkspace(ctx, deps, sessionId)
  if (workspace === undefined) {
    return {
      status: 409,
      body: { ok: false, error: 'workspace-not-synced', message: 'This session workspace is not a dsh-easy-sync workspace.' },
    }
  }
  const report = deps.engine.syncWorkspace(workspace, options)
  return {
    status: 200,
    body: {
      ok: true,
      action,
      workspace: { path: workspace.path, title: workspace.title },
      restored: report.restored.length,
      archived: report.archived.length,
      repaired: report.repaired.length,
      conflicts: report.conflicts.length,
      warnings: report.warnings.slice(0, 5),
    },
  }
}

async function handleInfoRequest(ctx, deps, req, res) {
  if (rejectForeignRequest(ctx, req, res)) return
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  try {
    const url = new URL(String(req.url ?? ''), 'http://localhost')
    const outcome = sessionInfo(ctx, deps, url.searchParams.get('sessionId') ?? '')
    sendJson(res, outcome.status, outcome.body)
  } catch (error) {
    deps.log('warn', `session info route failed: ${errorText(error)}`)
    sendJson(res, 500, { ok: false, error: 'internal error' })
  }
}

async function handleActionRequest(ctx, deps, req, res) {
  if (rejectForeignRequest(ctx, req, res)) return
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
    return
  }
  let text
  try {
    text = await readBoundedBody(req)
  } catch {
    sendJson(res, 400, { ok: false, error: 'could not read request body' })
    return
  }
  if (text === null) {
    sendJson(res, 413, { ok: false, error: 'request body too large' })
    return
  }
  let input
  try {
    input = JSON.parse(text)
  } catch {
    sendJson(res, 400, { ok: false, error: 'body is not valid JSON' })
    return
  }
  try {
    const outcome = sessionAction(ctx, deps, input)
    sendJson(res, outcome.status, outcome.body)
  } catch (error) {
    deps.log('warn', `session action route failed: ${errorText(error)}`)
    sendJson(res, 500, { ok: false, error: 'internal error' })
  }
}

/**
 * Apply the composition's Host/Origin + authentication fence.
 *
 * @param {any} ctx
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} whether the request was rejected
 */
function rejectForeignRequest(ctx, req, res) {
  const connection = safeService(ctx, 'connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    // Fail closed: without the fence the routes would be a cross-site write.
    res.statusCode = 503
    res.end()
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      for await (const _rest of req) {
        // Drain the rest so the socket can be reused.
      }
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

function safeService(ctx, name) {
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
