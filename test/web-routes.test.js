import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  registerWebRoutes,
  resolveSessionWorkspace,
  sessionAction,
  sessionInfo,
} from '../src/web-routes.js'

const ID = 'session-routes-1111-2222-3333-444444444444'

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-easy-sync-routes-'))
  const home = join(root, 'home')
  const sessionsRoot = join(home, 'sessions')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
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
    canonicalWs: realpathSync.native(ws),
    engine,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function writeSession(env, seqCount = 3) {
  const dir = sessionDir(env.sessionsRoot, env.canonicalWs, ID)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(
    file,
    encodeSessionLog(
      {
        header: { type: 'session', version: 4, id: ID, createdAt: 1, cwd: env.canonicalWs, isSeeded: false },
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

test('sessionAction archives and reports counts for sync/restore/archive', () => {
  const env = makeEnv()
  try {
    writeSession(env, 4)
    env.engine.refreshWorkspaces()
    const sync = sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'sync' })
    assert.equal(sync.status, 200)
    assert.equal(sync.body.ok, true)
    assert.equal(sync.body.archived, 1)
    assert.equal(sync.body.workspace.path, env.canonicalWs)

    const restore = sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'restore' })
    assert.equal(restore.status, 200)
    assert.equal(restore.body.action, 'restore')

    const archive = sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'archive' })
    assert.equal(archive.status, 200)
  } finally {
    env.cleanup()
  }
})

test('sessionAction rejects unknown actions and unsynced sessions', () => {
  const env = makeEnv()
  try {
    writeSession(env)
    env.engine.refreshWorkspaces()
    const unknown = sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: ID, action: 'explode' })
    assert.equal(unknown.status, 400)

    const unsynced = sessionAction(fakeCtx(), { engine: env.engine }, { sessionId: 'missing' })
    assert.equal(unsynced.status, 409)
    assert.equal(unsynced.body.error, 'workspace-not-synced')

    const notObject = sessionAction(fakeCtx(), { engine: env.engine }, 'sync')
    assert.equal(notObject.status, 400)
  } finally {
    env.cleanup()
  }
})

test('registerWebRoutes registers both routes and fences foreign requests', async () => {
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
    assert.deepEqual(paths, [INFO_ROUTE, ACTION_ROUTE])
    assert.deepEqual(registered, [INFO_ROUTE, ACTION_ROUTE])
    assert.equal(routes.size, 2)

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
    assert.deepEqual(blocked, [INFO_ROUTE, ACTION_ROUTE])
  } finally {
    env.cleanup()
  }
})
