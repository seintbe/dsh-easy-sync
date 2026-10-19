import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  archiveSessionsDir,
  disableWorkspace,
  discoverWorkspaces,
  enableWorkspace,
  hasMarker,
  markerPath,
  normalizeConfig,
  readMarker,
  readRememberedWorkspaces,
  readStoredWorkspacePaths,
  scanRoot,
  writeRememberedWorkspaces,
} from '../src/config.js'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-easy-sync-config-'))
  return {
    root,
    home: join(root, 'home'),
    ws: join(root, 'projects', 'app'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function mark(path) {
  mkdirSync(path, { recursive: true })
  writeFileSync(markerPath(path), '{"version":1}\n')
}

test('normalizeConfig applies defaults and clamps numeric options', () => {
  const env = makeRoot()
  try {
    const config = normalizeConfig({}, { env: { DSH_HOME: env.home } })
    assert.equal(config.home, env.home)
    assert.equal(config.sessionsRoot, join(env.home, 'sessions'))
    assert.equal(config.maxDepth, 3)
    assert.equal(config.archiveDebounceMs, 1500)
    assert.equal(config.workspacePollMs, 15_000)
    assert.equal(config.restoreOnStart, true)
    assert.equal(config.logLevel, 'info')

    const clamped = normalizeConfig({ maxDepth: 99, archiveDebounceMs: -5, logLevel: 'verbose' }, { env: {} })
    assert.equal(clamped.maxDepth, 8)
    assert.equal(clamped.archiveDebounceMs, 0)
    assert.equal(clamped.logLevel, 'info')
  } finally {
    env.cleanup()
  }
})

test('readStoredWorkspacePaths understands both storage layouts', () => {
  const env = makeRoot()
  try {
    mkdirSync(join(env.home, 'storages'), { recursive: true })
    const storage = join(env.home, 'storages', 'workspace.json')
    writeFileSync(
      storage,
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        tables: {
          workspaces: {
            'workspace-1': { path: 'D:\\one', title: 'one', sessionIds: [] },
            'workspace-2': { path: 'D:\\two', title: 'two', sessionIds: [] },
            broken: { title: 'no path' },
          },
        },
      }),
    )
    assert.deepEqual(readStoredWorkspacePaths(env.home), ['D:\\one', 'D:\\two'])

    writeFileSync(storage, JSON.stringify({ tables: { workspaces: [{ path: 'E:\\three' }] } }))
    assert.deepEqual(readStoredWorkspacePaths(env.home), ['E:\\three'])

    writeFileSync(storage, 'not json')
    assert.deepEqual(readStoredWorkspacePaths(env.home), [])
  } finally {
    env.cleanup()
  }
})

test('readStoredWorkspacePaths returns an empty list without a storage file', () => {
  const env = makeRoot()
  try {
    assert.deepEqual(readStoredWorkspacePaths(env.home), [])
  } finally {
    env.cleanup()
  }
})

test('scanRoot stops at a marker and prunes hidden/heavy directories', () => {
  const env = makeRoot()
  try {
    mark(env.ws)
    mark(join(env.ws, 'nested'))
    mkdirSync(join(env.ws, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(markerPath(join(env.ws, 'node_modules', 'pkg')), '{}')
    mkdirSync(join(env.ws, '.hidden', 'deep'), { recursive: true })
    writeFileSync(markerPath(join(env.ws, '.hidden', 'deep')), '{}')

    const found = scanRoot(join(env.root, 'projects'), 4)
    assert.deepEqual(found, [env.ws])
  } finally {
    env.cleanup()
  }
})

test('discoverWorkspaces filters candidates by marker and canonicalizes paths', () => {
  const env = makeRoot()
  try {
    mark(env.ws)
    const unmarked = join(env.root, 'projects', 'plain')
    mkdirSync(unmarked, { recursive: true })
    const config = normalizeConfig({ workspaces: [env.ws, unmarked], roots: [join(env.root, 'projects')] }, { env: {} })
    const { workspaces, skipped } = discoverWorkspaces(config)
    assert.equal(workspaces.length, 1)
    assert.equal(workspaces[0], realpathSync.native(env.ws))
    assert.ok(skipped.some((entry) => entry.reason.startsWith('missing-marker')))
  } finally {
    env.cleanup()
  }
})

test('enableWorkspace writes the marker and disableWorkspace renames it away', () => {
  const env = makeRoot()
  try {
    mkdirSync(env.ws, { recursive: true })
    assert.equal(hasMarker(env.ws), false)
    const enabled = enableWorkspace(env.ws, { note: 'test' })
    assert.equal(enabled.created, true)
    assert.equal(hasMarker(env.ws), true)
    assert.ok(existsSync(enabled.archiveDir))
    assert.equal(readMarker(env.ws).note, 'test')
    assert.ok(existsSync(archiveSessionsDir(env.ws)))

    assert.equal(disableWorkspace(env.ws), true)
    assert.equal(hasMarker(env.ws), false)
    const backups = readdirSync(env.ws).filter((name) => name.startsWith('.dsh-sync.json.disabled-'))
    assert.equal(backups.length, 1)
    assert.ok(existsSync(archiveSessionsDir(env.ws)), 'disabling must keep archived data')
  } finally {
    env.cleanup()
  }
})

test('a malformed marker still counts as opted in', () => {
  const env = makeRoot()
  try {
    mkdirSync(env.ws, { recursive: true })
    writeFileSync(markerPath(env.ws), '{ broken')
    assert.equal(hasMarker(env.ws), true)
    assert.equal(readMarker(env.ws), undefined)
  } finally {
    env.cleanup()
  }
})

test('remembered workspaces round-trip through the state directory', () => {
  const env = makeRoot()
  try {
    writeRememberedWorkspaces(env.home, ['D:\\one', 'D:\\one', 'D:\\two'])
    assert.deepEqual(readRememberedWorkspaces(env.home), ['D:\\one', 'D:\\two'])
  } finally {
    env.cleanup()
  }
})
