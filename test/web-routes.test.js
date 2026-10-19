import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { SyncEngine } from '../src/engine.js'
import { markerPath } from '../src/config.js'
import { sessionDir } from '../src/paths.js'
import { encodeSessionLog } from '../src/session-file.js'
import {
  ACTION_ROUTE,
  INFO_ROUTE,
  WORKSPACES_ROUTE,
  WORKSPACE_ACTION_ROUTE,
  registerWebRoutes,
  resolveSessionWorkspace,
  sessionAction,
  sessionInfo,
  workspaceAction,
  workspacesInfo,
} from '../src/web-routes.js'

const ID = 'session-routes-1111-2222-3333-444444444444'
const PLAIN_ID = 'session-routes-plain-1111-2222-3333-444444444444'

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-easy-sync-routes-'))
  const home = join(root, 'home')
  const sessionsRoot = join(home, 'sessions')
  const ws = join(root, 'ws')
  const plain = join(root, 'plain')
  mkdirSync(ws, { recursive: true })
  mkdirSync(plain, { recursive: true })
  writeFileSync(markerPath(ws), '{"version":1}\n')
  const engine = new SyncEngine({
    config: { home, sessionsRoot, workspaces: [ws], archiveDebounceMs: 0, logLevel: 'silent' },
    env: {},
  })
  engine.refreshWorkspaces()
  engine.enable(ws)
  return {
    root,
    home,
    sessionsRoot,
    ws,
    plain,
    canonicalWs: realpathSync.native(ws),
    canonicalPlain: realpathSync.native(plain),
    engine,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function writeSession(env, seqCount = 3, cwd = env.canonicalWs, id = ID) {
  const dir = sessionDir(env.sessionsRoot, cwd, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(
    file,
    encodeSessionLog(
      {
        header: { type: 'session', version: 4, id, createdAt: 1, cwd, isSeeded: false },
        events: Array.from({ length: seqCount }, (_, index) => ({
          type: 'permission/preset',
          seq: index,
          time: 1 + index,
          data: { preset: 'danger-full-access' },
        })),
      },
      { compression: 'zstd' },
    ),
  )
  return dir
}

function fakeCtx(overrides = {}) {
  const ctx = {
    workspaceRegistry: {
      list: () => [],
    },
    connection: {
      requestRejection: () => undefined,
    },
    ...overrides,
  }
  return ctx
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      if (chunk) this.body += String(chunk)
    },
  }
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

test('sessionInfo reports enabled for a session in a sync workspace', () => {
  const env = makeEnv()
  try {
    writeSession(env)
    env.engine.refreshWorkspaces()
    const outcome = sessionInfo(fakeCtx(), { engine: env.engine }, ID)
    assert.equal(outcome.status, 200)
    assert.equal(outcome.body.ok, true)
    assert.equal(outcome.body.enabled, true)
    assert.equal(outcome.body.workspace.path, env.canonicalWs)

    const missing = sessionInfo(fakeCtx(), { engine: env.engine }, 'nope')
    assert.equal(missing.body.enabled, false)

    const bad = sessionInfo(fakeCtx(), { engine: env.engine }, '')
    assert.equal(bad.status, 400)
  } finally {
    env.cleanup()
  }
})

test('sessionInfo offers the candidate workspace for a session that is not opted in', () => {
  const env = makeEnv()
  try {
    writeSession(env, 2, env.canonicalPlain, PLAIN_ID)
    env.engine.refreshWorkspaces()
    const outcome = sessionInfo(fakeCtx(), { engine: env.engine }, PLAIN_ID)
    assert.equal(outcome.status, 200)
    assert.equal(outcome.body.enabled, false)
    assert.equal(outcome.body.workspace.path, env.canonicalPlain)
    assert.equal(outcome.body.workspace.title, 'plain')
  } finally {
    env.cleanup()
  }
})

test('resolveSessionWorkspace reads the header cwd from the local log', () => {
  const env = makeEnv()
  try {
    writeSession(env)
    env.engine.refreshWorkspaces()
    const resolved = resolveSessionWorkspace(fakeCtx(), { engine: env.engine }, ID)
    assert.equal(resolved.cwd, env.canonicalWs)
    assert.equal(resolved.workspace.path, env.canonicalWs)
  } finally {
    env.cleanup()
  }
})

test('sessionAction archives and reports counts for sync/restore/archive', async () => {
  const env = makeEnv()
  try {
    writeSession(env, 4)
    env.engine.refreshWorkspaces()
    const sync = await sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'sync' })
    assert.equal(sync.status, 200)
    assert.equal(sync.body.ok, true)
    assert.equal(sync.body.archived, 1)
    assert.equal(sync.body.workspace.path, env.canonicalWs)

    const restore = await sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'restore' })
    assert.equal(restore.status, 200)
    assert.equal(restore.body.action, 'restore')

    const archive = await sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'archive' })
    assert.equal(archive.status, 200)
  } finally {
    env.cleanup()
  }
})

test('sessionAction enable opts a workspace in, then disable removes the marker', async () => {
  const env = makeEnv()
  try {
    writeSession(env, 3, env.canonicalPlain, PLAIN_ID)
    env.engine.refreshWorkspaces()
    const calls = []
    const deps = { engine: env.engine, onWorkspaceEnabled: async (workspace) => calls.push(workspace.path) }

    const enabled = await sessionAction(fakeCtx(), deps, { sessionId: PLAIN_ID, action: 'enable' })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.enabled, true)
    assert.equal(enabled.body.markerCreated, true)
    assert.equal(enabled.body.archived, 1)
    assert.equal(enabled.body.workspace.path, env.canonicalPlain)
    assert.deepEqual(calls, [env.canonicalPlain])

    // A second enable is a no-op, not an error.
    const again = await sessionAction(fakeCtx(), deps, { sessionId: PLAIN_ID, action: 'enable' })
    assert.equal(again.status, 200)
    assert.equal(again.body.alreadyEnabled, true)

    const disabled = await sessionAction(fakeCtx(), deps, { sessionId: PLAIN_ID, action: 'disable' })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.disabled, true)
    assert.equal(existsSync(markerPath(env.canonicalPlain)), false)
  } finally {
    env.cleanup()
  }
})

test('sessionAction rejects unknown actions and unsynced sessions', async () => {
  const env = makeEnv()
  try {
    writeSession(env)
    env.engine.refreshWorkspaces()
    const unknown = await sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'explode' })
    assert.equal(unknown.status, 400)

    const unsynced = await sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: 'missing' })
    assert.equal(unsynced.status, 409)
    assert.equal(unsynced.body.error, 'workspace-not-synced')

    const notObject = await sessionAction(fakeCtx(), { engine: env.engine }, 'sync')
    assert.equal(notObject.status, 400)
  } finally {
    env.cleanup()
  }
})

test('workspacesInfo merges registry rows with sync state and counts', () => {
  const env = makeEnv()
  try {
    writeSession(env, 4)
    env.engine.refreshWorkspaces()
    const ctx = fakeCtx({
      workspaceRegistry: {
        list: () => [
          { path: env.canonicalWs, title: 'WS' },
          { path: env.canonicalPlain, title: 'Plain' },
        ],
      },
    })
    const outcome = workspacesInfo(ctx, { engine: env.engine })
    assert.equal(outcome.status, 200)
    const byPath = new Map(outcome.body.workspaces.map((workspace) => [workspace.path, workspace]))
    const enabled = byPath.get(env.canonicalWs)
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.registered, true)
    assert.equal(enabled.archiveSessions, 0)
    const plain = byPath.get(env.canonicalPlain)
    assert.equal(plain.enabled, false)
    assert.equal(plain.registered, true)
  } finally {
    env.cleanup()
  }
})

test('workspaceAction enables, syncs and disables a workspace by path', async () => {
  const env = makeEnv()
  try {
    writeSession(env, 3, env.canonicalPlain, PLAIN_ID)
    env.engine.refreshWorkspaces()
    const calls = []
    const deps = { engine: env.engine, onWorkspaceEnabled: (workspace) => calls.push(workspace.path) }

    const bad = await workspaceAction(fakeCtx(), deps, { action: 'enable' })
    assert.equal(bad.status, 400)

    const enabled = await workspaceAction(fakeCtx(), deps, { path: env.canonicalPlain, action: 'enable' })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.enabled, true)
    assert.equal(enabled.body.archived, 1)
    assert.deepEqual(calls, [env.canonicalPlain])

    const sync = await workspaceAction(fakeCtx(), deps, { path: env.canonicalPlain, action: 'sync' })
    assert.equal(sync.status, 200)
    assert.equal(sync.body.workspace.path, env.canonicalPlain)

    const disabled = await workspaceAction(fakeCtx(), deps, { path: env.canonicalPlain, action: 'disable' })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.disabled, true)

    const unknown = await workspaceAction(fakeCtx(), deps, { path: env.canonicalPlain, action: 'explode' })
    assert.equal(unknown.status, 400)
  } finally {
    env.cleanup()
  }
})

test('registerWebRoutes registers all routes and fences foreign requests', async () => {
  const env = makeEnv()
  try {
    writeSession(env)
    env.engine.refreshWorkspaces()
    const routes = new Map()
    const ctx = fakeCtx({
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return () => {}
        },
      },
      effect(callback) {
        callback()
        return () => {}
      },
    })
    const registered = []
    const paths = registerWebRoutes(ctx, {
      engine: env.engine,
      log: () => {},
      onRegistered: (list) => registered.push(...list),
    })
    assert.deepEqual(paths, [INFO_ROUTE, ACTION_ROUTE, WORKSPACES_ROUTE, WORKSPACE_ACTION_ROUTE])
    assert.deepEqual(registered, paths)
    assert.equal(routes.size, 4)

    const info = routes.get(INFO_ROUTE)
    let res = fakeRes()
    await info.handler(fakeReq({ method: 'GET', url: `${INFO_ROUTE}?sessionId=${ID}` }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).enabled, true)

    const action = routes.get(ACTION_ROUTE)
    res = fakeRes()
    await action.handler(
      fakeReq({
        method: 'POST',
        url: ACTION_ROUTE,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: ID, action: 'sync' }),
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).ok, true)

    const list = routes.get(WORKSPACES_ROUTE)
    res = fakeRes()
    await list.handler(fakeReq({ method: 'GET', url: WORKSPACES_ROUTE }), res)
    assert.equal(res.statusCode, 200)
    assert.ok(Array.isArray(JSON.parse(res.body).workspaces))

    const workspaceActionRoute = routes.get(WORKSPACE_ACTION_ROUTE)
    res = fakeRes()
    await workspaceActionRoute.handler(
      fakeReq({
        method: 'POST',
        url: WORKSPACE_ACTION_ROUTE,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: env.canonicalPlain, action: 'enable' }),
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).enabled, true)

    // Method and media-type guards.
    res = fakeRes()
    await action.handler(fakeReq({ method: 'POST', url: ACTION_ROUTE }), res)
    assert.equal(res.statusCode, 415)

    res = fakeRes()
    await info.handler(fakeReq({ method: 'POST', url: INFO_ROUTE }), res)
    assert.equal(res.statusCode, 405)

    // The trust fence rejects before any work.
    const rejecting = fakeCtx({
      connection: { requestRejection: () => 403 },
      webServer: { register: () => () => {} },
    })
    const blocked = registerWebRoutes(rejecting, { engine: env.engine, log: () => {} })
    assert.deepEqual(blocked, paths)
  } finally {
    env.cleanup()
  }
})
