import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { archiveSessionsDir, markerPath } from '../src/config.js'
import { encodeSegment, sessionDir } from '../src/paths.js'
import { encodeSessionLog, inspectSessionFile } from '../src/session-file.js'

const ID = 'session-plugin-1111-2222-3333-444444444444'

function header(id, cwd) {
  return { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd, isSeeded: false }
}

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-easy-sync-plugin-'))
  const home = join(root, 'home')
  const sessionsRoot = join(home, 'sessions')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  writeFileSync(markerPath(ws), '{"version":1}\n')

  const handlers = new Map()
  const effects = []
  const tools = []
  const records = []
  let flushes = 0
  let sessionsFlushes = 0

  const registry = {
    records,
    list: () => records.slice(),
    async resolveByPath(path) {
      return records.find((record) => record.path === path)
    },
    async create(path, title) {
      const record = {
        id: `workspace-${records.length + 1}`,
        path,
        title: title ?? 'ws',
        sessionIds: [],
        async attachSession(id) {
          if (!this.sessionIds.includes(id)) this.sessionIds.unshift(id)
        },
      }
      records.unshift(record)
      return record
    },
  }
  const services = {
    workspaceRegistry: registry,
    sessionPersistence: {
      flush() {
        flushes += 1
        return Promise.resolve()
      },
    },
    sessions: {
      get: () => undefined,
      list: () => [],
      flush: () => {
        sessionsFlushes += 1
        return Promise.resolve()
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }

  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    },
    inject(deps, callback) {
      const child = Object.create(ctx)
      for (const dep of deps) child[dep] = services[dep]
      return Promise.resolve()
        .then(() => callback(child))
        .catch(() => undefined)
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    get(name) {
      return services[name]
    },
    fire(event, argument) {
      for (const handler of handlers.get(event) ?? []) handler(argument)
    },
    dispose() {
      for (const disposer of effects) disposer()
    },
  }

  return {
    root,
    home,
    sessionsRoot,
    ws,
    canonicalWs: realpathSync.native(ws),
    ctx,
    registry,
    tools,
    get flushes() {
      return flushes
    },
    get sessionsFlushes() {
      return sessionsFlushes
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeLocalSession(harness, count = 3) {
  const dir = sessionDir(harness.sessionsRoot, harness.canonicalWs, ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    encodeSessionLog(
      {
        header: header(ID, harness.canonicalWs),
        events: Array.from({ length: count }, (_, index) => ({
          type: 'permission/preset',
          seq: index,
          time: 1_700_000_000_000 + index,
          data: { preset: 'danger-full-access' },
        })),
      },
      { compression: 'zstd' },
    ),
  )
}

function archiveFile(harness) {
  return join(archiveSessionsDir(harness.ws), encodeSegment(ID), 'session.v4.jsonl.zstd')
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('apply restores at startup and registers/attaches the workspace', async () => {
  const harness = makeHarness()
  try {
    const archiveDir = join(archiveSessionsDir(harness.ws), encodeSegment(ID))
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(
      join(archiveDir, 'session.v4.jsonl.zstd'),
      encodeSessionLog(
        {
          header: header(ID, 'E:\\other-device\\ws'),
          events: [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }],
        },
        { compression: 'zstd' },
      ),
    )

    apply(harness.ctx, {
      home: harness.home,
      sessionsRoot: harness.sessionsRoot,
      workspaces: [harness.ws],
      archiveDebounceMs: 30,
      workspacePollMs: 0,
      logLevel: 'silent',
    })

    const restoredFile = join(sessionDir(harness.sessionsRoot, harness.canonicalWs, ID), 'session.v4.jsonl.zstd')
    assert.ok(existsSync(restoredFile), 'restore must happen inside apply, before any await')
    assert.equal(inspectSessionFile(readFileSync(restoredFile), { compression: 'zstd' }).header.cwd, harness.canonicalWs)

    await settle()
    assert.equal(harness.registry.records.length, 1)
    assert.equal(harness.registry.records[0].path, harness.canonicalWs)
    assert.deepEqual(harness.registry.records[0].sessionIds, [ID])
  } finally {
    harness.cleanup()
  }
})

test('apply restores a workspace recorded only in DSH storage, before services exist', async () => {
  const harness = makeHarness()
  try {
    mkdirSync(join(harness.home, 'storages'), { recursive: true })
    writeFileSync(
      join(harness.home, 'storages', 'workspace.json'),
      JSON.stringify({ unit: { name: 'workspace', version: 2 }, tables: { workspaces: { w1: { path: harness.canonicalWs } } } }),
    )
    const archiveDir = join(archiveSessionsDir(harness.ws), encodeSegment(ID))
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(
      join(archiveDir, 'session.v4.jsonl.zstd'),
      encodeSessionLog(
        {
          header: header(ID, 'F:\\third-device\\ws'),
          events: [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }],
        },
        { compression: 'zstd' },
      ),
    )

    apply(harness.ctx, {
      home: harness.home,
      sessionsRoot: harness.sessionsRoot,
      archiveDebounceMs: 30,
      workspacePollMs: 0,
      logLevel: 'silent',
    })

    const restoredFile = join(sessionDir(harness.sessionsRoot, harness.canonicalWs, ID), 'session.v4.jsonl.zstd')
    assert.ok(existsSync(restoredFile), 'stored workspace paths must be usable during activation')
    assert.equal(inspectSessionFile(readFileSync(restoredFile), { compression: 'zstd' }).header.cwd, harness.canonicalWs)
  } finally {
    harness.cleanup()
  }
})

test('session events debounce, flush persistence, then archive', async () => {
  const harness = makeHarness()
  try {
    apply(harness.ctx, {
      home: harness.home,
      sessionsRoot: harness.sessionsRoot,
      workspaces: [harness.ws],
      archiveDebounceMs: 30,
      workspacePollMs: 0,
      logLevel: 'silent',
    })
    await settle()
    writeLocalSession(harness)

    harness.ctx.fire('session/event', { id: ID, header: { cwd: harness.canonicalWs } })
    await new Promise((resolve) => setTimeout(resolve, 120))

    assert.ok(harness.sessionsFlushes >= 1, 'archive must be preceded by a per-session flush')
    assert.ok(existsSync(archiveFile(harness)))
    assert.equal(inspectSessionFile(readFileSync(archiveFile(harness)), { compression: 'zstd' }).lastSeq, 2)
  } finally {
    harness.cleanup()
  }
})

test('sessions outside sync workspaces are ignored', async () => {
  const harness = makeHarness()
  try {
    apply(harness.ctx, {
      home: harness.home,
      sessionsRoot: harness.sessionsRoot,
      workspaces: [harness.ws],
      archiveDebounceMs: 30,
      workspacePollMs: 0,
      logLevel: 'silent',
    })
    await settle()
    const otherCwd = join(harness.root, 'elsewhere')
    mkdirSync(otherCwd, { recursive: true })
    harness.ctx.fire('session/event', { id: ID, header: { cwd: otherCwd } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(harness.flushes, 0)
    assert.ok(!existsSync(archiveFile(harness)))
  } finally {
    harness.cleanup()
  }
})

test('dispose archives queued sessions synchronously', async () => {
  const harness = makeHarness()
  try {
    apply(harness.ctx, {
      home: harness.home,
      sessionsRoot: harness.sessionsRoot,
      workspaces: [harness.ws],
      archiveDebounceMs: 5_000,
      workspacePollMs: 0,
      logLevel: 'silent',
    })
    await settle()
    writeLocalSession(harness)
    harness.ctx.fire('session/event', { id: ID, header: { cwd: harness.canonicalWs } })
    harness.ctx.dispose()
    assert.ok(existsSync(archiveFile(harness)), 'shutdown must not lose queued archive work')
  } finally {
    harness.cleanup()
  }
})
