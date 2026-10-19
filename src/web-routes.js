// Host-side HTTP routes for the optional desktop client plugin.
//
// The client half (../client.js) renders menu entries and the sidebar "Easy
// Sync" panel. It cannot reach the Host's engine directly, so these routes are
// the bridge:
//
//   GET  /dsh-easy-sync/session?sessionId=...   -> workspace behind one session, enabled or not
//   POST /dsh-easy-sync/session-action          -> {"sessionId", action: "sync"|"restore"|"archive"|"enable"|"disable"}
//   GET  /dsh-easy-sync/workspaces              -> workspaces known to the registry + sync state
//   POST /dsh-easy-sync/workspace-action        -> {"path", action: "enable"|"disable"|"sync"}
//
// Every route sits behind the composition's `connection` trust fence, exactly
// like DSH's own open-in-app routes: without it, a cross-site request could
// mutate the operator's conversation archive. The routes are only registered
// when both `webServer` and `connection` exist (web profiles), so headless
// profiles keep the plugin's agent-tool-only surface.

import { basename } from 'node:path'

import { pathKey } from './config.js'
import { readLocalEntry } from './engine.js'

/** Client mirror: keep these constants in sync with ../client.js. */
export const INFO_ROUTE = '/dsh-easy-sync/session'
export const ACTION_ROUTE = '/dsh-easy-sync/session-action'
export const WORKSPACES_ROUTE = '/dsh-easy-sync/workspaces'
export const WORKSPACE_ACTION_ROUTE = '/dsh-easy-sync/workspace-action'

/** Route bodies carry small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

const ACTIONS = {
  sync: { restore: true, archive: true },
  restore: { restore: true, archive: false },
  archive: { restore: false, archive: true },
}

/**
 * Register the four routes on a context that already has `webServer` and
 * `connection`.
 *
 * @param {any} ctx
 * @param {{
 *   engine: import('./engine.js').SyncEngine,
 *   log: (kind: 'error'|'warn'|'info'|'debug', message: string) => void,
 *   onWorkspaceEnabled?: (workspace: { path: string, title: string }) => Promise<void> | void,
 *   onRegistered?: (routes: string[]) => void,
 * }} deps
 * @returns {string[]} the registered paths (empty when the services are unusable)
 */
export function registerWebRoutes(ctx, deps) {
  const webServer = ctx?.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return []
  const routes = [INFO_ROUTE, ACTION_ROUTE, WORKSPACES_ROUTE, WORKSPACE_ACTION_ROUTE]
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
  register(WORKSPACES_ROUTE, (req, res) => handleWorkspacesRequest(ctx, deps, req, res), `GET ${WORKSPACES_ROUTE}`)
  register(WORKSPACE_ACTION_ROUTE, (req, res) => handleWorkspaceActionRequest(ctx, deps, req, res), `POST ${WORKSPACE_ACTION_ROUTE}`)
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
 * `workspace` is returned even when the workspace is not opted in yet (title is
 * the directory name), which is what lets the session menu offer a one-click
 * "enable this workspace".
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
  if (workspace !== undefined) {
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
  const candidate = typeof cwd === 'string' && cwd !== ''
    ? { path: cwd, title: basename(cwd) }
    : null
  return { status: 200, body: { ok: true, enabled: false, cwd: cwd ?? null, workspace: candidate } }
}

/**
 * Pure decision function behind POST /dsh-easy-sync/session-action.
 *
 * @param {any} ctx
 * @param {{
 *   engine: import('./engine.js').SyncEngine,
 *   onWorkspaceEnabled?: (workspace: { path: string, title: string }) => Promise<void> | void,
 * }} deps
 * @param {unknown} input
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function sessionAction(ctx, deps, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 400, body: { ok: false, error: 'JSON object body is required' } }
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  if (sessionId === '') return { status: 400, body: { ok: false, error: 'sessionId is required' } }
  const action = typeof record.action === 'string' && record.action !== '' ? record.action : 'sync'

  if (action === 'enable') {
    const { workspace, cwd } = resolveSessionWorkspace(ctx, deps, sessionId)
    if (workspace !== undefined) {
      return {
        status: 200,
        body: {
          ok: true,
          action,
          alreadyEnabled: true,
          workspace: { path: workspace.path, title: workspace.title },
        },
      }
    }
    if (cwd === undefined) {
      return { status: 409, body: { ok: false, error: 'workspace-unknown', message: 'This session has no workspace directory on this device.' } }
    }
    try {
      const result = deps.engine.enable(cwd, { note: 'enabled from the session menu', registryPaths: registryPathsOf(ctx) })
      await deps.onWorkspaceEnabled?.(result.workspace)
      return {
        status: 200,
        body: {
          ok: true,
          action,
          enabled: true,
          workspace: { path: result.workspace.path, title: result.workspace.title },
          archived: result.report.archived.length,
          restored: result.report.restored.length,
          markerCreated: result.markerCreated,
        },
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: errorText(error) } }
    }
  }

  if (action === 'disable') {
    const { workspace, cwd } = resolveSessionWorkspace(ctx, deps, sessionId)
    const target = workspace?.path ?? cwd
    if (target === undefined) {
      return { status: 409, body: { ok: false, error: 'workspace-unknown' } }
    }
    const removed = deps.engine.disable(target)
    return {
      status: 200,
      body: {
        ok: true,
        action,
        disabled: removed,
        workspace: { path: target, title: workspace?.title ?? basename(target) },
      },
    }
  }

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

/**
 * Pure decision function behind GET /dsh-easy-sync/workspaces.
 *
 * Merges the host registry's workspaces (what the sidebar shows) with the sync
 * engine's view, so the panel can offer a switch for workspaces that are not
 * opted in yet as well as archive counts for the ones that are.
 *
 * @param {any} ctx
 * @param {{ engine: import('./engine.js').SyncEngine }} deps
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function workspacesInfo(ctx, deps) {
  const registry = safeService(ctx, 'workspaceRegistry')
  const registryWorkspaces = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
  const registryPaths = registryWorkspaces
    .map((workspace) => workspace.path)
    .filter((path) => typeof path === 'string')
  deps.engine.refreshWorkspaces({ registryPaths })

  const merged = new Map()
  for (const record of registryWorkspaces) {
    if (typeof record?.path !== 'string') continue
    merged.set(pathKey(record.path), {
      path: record.path,
      title: typeof record.title === 'string' && record.title !== '' ? record.title : basename(record.path),
      enabled: false,
      archiveSessions: 0,
      localSessions: 0,
      registered: true,
    })
  }

  const status = deps.engine.status()
  const byPath = new Map(status.workspaces.map((workspace) => [pathKey(workspace.path), workspace]))
  for (const workspace of deps.engine.listWorkspaces()) {
    const key = pathKey(workspace.path)
    const row = merged.get(key) ?? {
      path: workspace.path,
      title: workspace.title,
      registered: false,
    }
    const counts = byPath.get(key)
    merged.set(key, {
      ...row,
      title: workspace.title !== '' ? workspace.title : row.title,
      enabled: true,
      archiveSessions: counts?.archiveSessions ?? 0,
      localSessions: counts?.localSessions ?? 0,
    })
  }

  const workspaces = [...merged.values()].sort((left, right) => left.title.localeCompare(right.title))
  return { status: 200, body: { ok: true, workspaces } }
}

/**
 * Pure decision function behind POST /dsh-easy-sync/workspace-action.
 *
 * @param {any} ctx
 * @param {{
 *   engine: import('./engine.js').SyncEngine,
 *   onWorkspaceEnabled?: (workspace: { path: string, title: string }) => Promise<void> | void,
 * }} deps
 * @param {unknown} input
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function workspaceAction(ctx, deps, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 400, body: { ok: false, error: 'JSON object body is required' } }
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (path === '') return { status: 400, body: { ok: false, error: 'path is required' } }
  const action = typeof record.action === 'string' && record.action !== '' ? record.action : 'sync'

  if (action === 'enable') {
    try {
      const result = deps.engine.enable(path, { note: 'enabled from the Easy Sync panel', registryPaths: registryPathsOf(ctx) })
      await deps.onWorkspaceEnabled?.(result.workspace)
      return {
        status: 200,
        body: {
          ok: true,
          action,
          enabled: true,
          workspace: { path: result.workspace.path, title: result.workspace.title },
          archived: result.report.archived.length,
          restored: result.report.restored.length,
          markerCreated: result.markerCreated,
        },
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: errorText(error) } }
    }
  }

  if (action === 'disable') {
    const removed = deps.engine.disable(path)
    return { status: 200, body: { ok: true, action, disabled: removed, workspace: { path } } }
  }

  if (action === 'sync') {
    deps.engine.refreshWorkspaces({ registryPaths: registryPathsOf(ctx) })
    const workspace = deps.engine.workspaceForCwd(path)
    if (workspace === undefined) {
      return { status: 409, body: { ok: false, error: 'workspace-not-synced' } }
    }
    const report = deps.engine.syncWorkspace(workspace, ACTIONS.sync)
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

  return { status: 400, body: { ok: false, error: `unknown action: ${action}` } }
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

async function handleWorkspacesRequest(ctx, deps, req, res) {
  if (rejectForeignRequest(ctx, req, res)) return
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  try {
    const outcome = workspacesInfo(ctx, deps)
    sendJson(res, outcome.status, outcome.body)
  } catch (error) {
    deps.log('warn', `workspaces route failed: ${errorText(error)}`)
    sendJson(res, 500, { ok: false, error: 'internal error' })
  }
}

async function handleActionRequest(ctx, deps, req, res) {
  await handleJsonPost(ctx, deps, req, res, (input) => sessionAction(ctx, deps, input))
}

async function handleWorkspaceActionRequest(ctx, deps, req, res) {
  await handleJsonPost(ctx, deps, req, res, (input) => workspaceAction(ctx, deps, input))
}

/**
 * Shared POST plumbing: trust fence, method, media type, bounded body, JSON
 * parse, then the pure decision function.
 *
 * @param {any} ctx
 * @param {{ log: (kind: string, message: string) => void }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(input: unknown) => Promise<{ status: number, body: Record<string, unknown> }>} decide
 */
async function handleJsonPost(ctx, deps, req, res, decide) {
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
    const outcome = await decide(input)
    sendJson(res, outcome.status, outcome.body)
  } catch (error) {
    deps.log('warn', `workspace action route failed: ${errorText(error)}`)
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

/** Registry workspace paths, the discovery candidates a route may use. */
function registryPathsOf(ctx) {
  const registry = safeService(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry.list().map((workspace) => workspace.path).filter((path) => typeof path === 'string')
  } catch {
    return []
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
