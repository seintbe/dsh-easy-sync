import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { SyncEngine, readLocalEntry } from '../src/engine.js'
import { archiveDir, archiveSessionsDir, markerPath } from '../src/config.js'
import { encodeSegment, projectDir, sessionDir } from '../src/paths.js'
import { encodeSessionLog, inspectSessionFile } from '../src/session-file.js'

const ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_DEVICE_CWD = 'D:\\other-device\\same-project'

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-easy-sync-'))
  const home = join(root, 'home')
  const sessionsRoot = join(home, 'sessions')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const engine = new SyncEngine({ config: { home, sessionsRoot, workspaces: [ws] } })
  return {
    root,
    home,
    sessionsRoot,
    ws,
    engine,
    canonicalWs: realpathSync.native(ws),
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function header(id, cwd) {
  return { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd, isSeeded: false }
}

function events(count, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'permission/preset',
    seq: start + index,
    time: 1_700_000_000_000 + index,
    data: { preset: 'danger-full-access' },
  }))
}

function generationName(compression) {
  return compression === 'zstd' ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl'
}

function writeSessionAt(dir, id, cwd, count, compression = 'zstd') {
  mkdirSync(dir, { recursive: true })
  const buffer = encodeSessionLog({ header: header(id, cwd), events: events(count) }, { compression })
  writeFileSync(join(dir, generationName(compression)), buffer)
  return buffer
}

function writeLocalSession(env, cwd, id, count, compression = 'zstd') {
  return writeSessionAt(sessionDir(env.sessionsRoot, cwd, id), id, cwd, count, compression)
}

function writeArchivedSession(env, id, cwd, count, compression = 'zstd') {
  return writeSessionAt(join(archiveSessionsDir(env.ws), encodeSegment(id)), id, cwd, count, compression)
}

function localDir(env, id) {
  return sessionDir(env.sessionsRoot, env.canonicalWs, id)
}

/** Opt the test workspace in without going through enable(). */
function markSync(env) {
  writeFileSync(markerPath(env.ws), `${JSON.stringify({ version: 1 })}\n`)
}

function inspect(file, compression = 'zstd') {
  return inspectSessionFile(readFileSync(file), { compression })
}

test('enable writes the marker, creates the archive, and archives existing sessions', () => {
  const env = makeEnv()
  try {
    writeLocalSession(env, env.canonicalWs, ID, 3)
    const result = env.engine.enable(env.ws)

    assert.ok(existsSync(markerPath(env.ws)), 'marker file must exist')
    assert.ok(existsSync(archiveDir(env.ws)), 'archive directory must exist')
    assert.equal(result.markerCreated, true)
    assert.ok(result.report.archived.includes(ID))

    const archived = inspect(join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd')))
    assert.equal(archived.header.cwd, env.canonicalWs)
    assert.equal(archived.lastSeq, 2)

    const status = env.engine.status()
    assert.equal(status.workspaces.length, 1)
    assert.equal(status.workspaces[0].archiveSessions, 1)
    assert.equal(status.workspaces[0].localSessions, 1)
  } finally {
    env.cleanup()
  }
})

test('startup restores a newer archive and rewrites the header cwd for this device', () => {
  const env = makeEnv()
  try {
    markSync(env)
    const originalEvents = events(4)
    const archivedBuffer = encodeSessionLog(
      { header: header(ID, OTHER_DEVICE_CWD), events: originalEvents },
      { compression: 'zstd' },
    )
    const archivePath = join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd'))
    mkdirSync(join(archiveSessionsDir(env.ws), encodeSegment(ID)), { recursive: true })
    writeFileSync(archivePath, archivedBuffer)

    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.deepEqual(report.restored, [ID])

    const target = join(localDir(env, ID), generationName('zstd'))
    assert.ok(existsSync(target), 'restored file must exist at the canonical project path')
    const restored = inspect(target)
    assert.equal(restored.header.cwd, env.canonicalWs)
    assert.deepEqual(restored.events, originalEvents)

    const located = readLocalEntry(localDir(env, ID))
    assert.equal(located.lastSeq, 3)
  } finally {
    env.cleanup()
  }
})

test('archive newer wins; local newer is copied back to the archive', () => {
  const env = makeEnv()
  try {
    markSync(env)
    writeLocalSession(env, env.canonicalWs, ID, 2)
    writeArchivedSession(env, ID, OTHER_DEVICE_CWD, 5)
    env.engine.refreshWorkspaces()
    let report = env.engine.runStartupSync()
    assert.ok(report.restored.includes(ID))
    assert.equal(readLocalEntry(localDir(env, ID)).lastSeq, 4)

    // Local grows past the archive (as if this device continued the session).
    const grown = encodeSessionLog(
      { header: header(ID, env.canonicalWs), events: events(7) },
      { compression: 'zstd' },
    )
    writeFileSync(join(localDir(env, ID), generationName('zstd')), grown)
    report = env.engine.runStartupSync()
    assert.ok(report.archived.includes(ID))
    const archived = inspect(join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd')))
    assert.equal(archived.lastSeq, 6)
    assert.equal(archived.header.cwd, env.canonicalWs)
  } finally {
    env.cleanup()
  }
})

test('equal histories are idempotent and do not rewrite files', () => {
  const env = makeEnv()
  try {
    markSync(env)
    writeLocalSession(env, env.canonicalWs, ID, 3)
    env.engine.refreshWorkspaces()
    env.engine.runStartupSync()

    const localFile = join(localDir(env, ID), generationName('zstd'))
    const archiveFile = join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd'))
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
    const beforeLocal = hash(localFile)
    const beforeArchive = hash(archiveFile)

    const report = env.engine.runStartupSync()
    assert.deepEqual(report.restored, [])
    assert.deepEqual(report.archived, [])
    assert.deepEqual(report.repaired, [])
    assert.equal(hash(localFile), beforeLocal)
    assert.equal(hash(archiveFile), beforeArchive)
  } finally {
    env.cleanup()
  }
})

test('a plaintext local root transcodes a zstd archive into the local encoding', () => {
  const env = makeEnv()
  try {
    markSync(env)
    // Another session establishes this device's physical encoding as plaintext.
    const otherId = 'session-99999999-8888-7777-6666-555555555555'
    writeLocalSession(env, 'C:\\another-workspace', otherId, 1, 'none')
    writeArchivedSession(env, ID, OTHER_DEVICE_CWD, 3, 'zstd')

    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.ok(report.restored.includes(ID))

    const target = join(localDir(env, ID), generationName('none'))
    assert.ok(existsSync(target), 'restored file must use the local plaintext encoding')
    assert.ok(!existsSync(join(localDir(env, ID), generationName('zstd'))))
    const restored = inspect(target, 'none')
    assert.equal(restored.header.cwd, env.canonicalWs)
    assert.equal(restored.lastSeq, 2)
  } finally {
    env.cleanup()
  }
})

test('a restored local copy with an equal history does not rewrite the archive header', () => {
  const env = makeEnv()
  try {
    markSync(env)
    writeLocalSession(env, env.canonicalWs, ID, 3)
    writeArchivedSession(env, ID, OTHER_DEVICE_CWD, 3)
    const archiveFile = join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd'))
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
    const before = hash(archiveFile)

    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.deepEqual(report.restored, [])
    assert.deepEqual(report.archived, [])
    assert.equal(hash(archiveFile), before, 'the foreign header cwd must survive an equal-history start')
  } finally {
    env.cleanup()
  }
})

test('a torn local tail is trimmed before archiving', () => {
  const env = makeEnv()
  try {
    markSync(env)
    const buffer = writeLocalSession(env, env.canonicalWs, ID, 2)
    const localFile = join(localDir(env, ID), generationName('zstd'))
    writeFileSync(localFile, Buffer.concat([buffer, Buffer.from([0x28, 0xb5, 0x2f])]))

    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.ok(report.archived.includes(ID))

    const archived = inspect(join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd')))
    assert.equal(archived.lastSeq, 1)
    assert.equal(archived.eventCount, 2)
  } finally {
    env.cleanup()
  }
})

test('a newer archive replaces a stale local copy sitting in another project directory', () => {
  const env = makeEnv()
  try {
    markSync(env)
    const staleCwd = 'C:\\old-location\\same-project'
    writeLocalSession(env, staleCwd, ID, 1)
    writeLocalSession(env, env.canonicalWs, ID, 2)
    writeArchivedSession(env, ID, OTHER_DEVICE_CWD, 6)

    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.ok(report.restored.includes(ID))

    const copies = dirsWithSession(env, ID)
    assert.deepEqual(copies, [localDir(env, ID)])
    assert.equal(readLocalEntry(localDir(env, ID)).lastSeq, 5)
  } finally {
    env.cleanup()
  }
})

test('duplicate local copies keep the longest history and quarantine the rest', () => {
  const env = makeEnv()
  try {
    markSync(env)
    const staleCwd = 'C:\\old-location\\same-project'
    writeLocalSession(env, env.canonicalWs, ID, 4)
    writeLocalSession(env, staleCwd, ID, 2)

    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.ok(report.conflicts.length >= 1, 'the shorter duplicate must be preserved as a conflict')
    assert.ok(existsSync(join(archiveDir(env.ws), 'conflicts')))

    const copies = dirsWithSession(env, ID)
    assert.deepEqual(copies, [localDir(env, ID)])
    const archived = inspect(join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd')))
    assert.equal(archived.lastSeq, 3)
  } finally {
    env.cleanup()
  }
})

test('disable removes the marker but keeps the archive', () => {
  const env = makeEnv()
  try {
    writeLocalSession(env, env.canonicalWs, ID, 1)
    env.engine.enable(env.ws)
    const archiveFile = join(archiveSessionsDir(env.ws), encodeSegment(ID), generationName('zstd'))
    assert.ok(existsSync(archiveFile))

    assert.equal(env.engine.disable(env.ws), true)
    assert.ok(!existsSync(markerPath(env.ws)))
    assert.ok(existsSync(archiveFile))
    env.engine.refreshWorkspaces()
    assert.equal(env.engine.status().workspaces.length, 0)
  } finally {
    env.cleanup()
  }
})

test('non-sync workspaces are ignored', () => {
  const env = makeEnv()
  try {
    writeLocalSession(env, 'C:\\unrelated\\project', ID, 3)
    env.engine.refreshWorkspaces()
    const report = env.engine.runStartupSync()
    assert.deepEqual(report.archived, [])
    assert.deepEqual(report.restored, [])
  } finally {
    env.cleanup()
  }
})

/**
 * Every project directory that currently holds a directory for the session id.
 * @param {ReturnType<typeof makeEnv>} env
 * @param {string} id
 * @returns {string[]}
 */
function dirsWithSession(env, id) {
  const found = []
  let projects
  try {
    projects = readdirSync(env.sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return found
  }
  for (const project of projects) {
    const dir = join(env.sessionsRoot, project.name, encodeSegment(id))
    if (existsSync(dir)) found.push(dir)
  }
  return found.sort()
}

test('projectDir helper stays in sync with the engine target directory', () => {
  const env = makeEnv()
  try {
    assert.equal(localDir(env, ID), join(projectDir(env.sessionsRoot, env.canonicalWs), encodeSegment(ID)))
  } finally {
    env.cleanup()
  }
})
