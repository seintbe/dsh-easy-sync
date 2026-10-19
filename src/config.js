// Configuration, workspace discovery, and on-disk conventions for dsh-easy-sync.
//
// A sync workspace is opted in by a small marker file at its root. The marker
// is deliberately outside the archive directory so disabling sync keeps the
// archived conversations on disk.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Marker filename created in a workspace root to opt that workspace into sync. */
export const MARKER_FILENAME = '.dsh-sync.json'

/** Archive directory created inside an opted-in workspace. */
export const ARCHIVE_DIRNAME = '.dsh-sync'

/** Marker payload version written by this build. */
export const MARKER_VERSION = 1

/** Plugin-relative location of the device-local discovery cache. */
const REMEMBERED_FILENAME = 'workspaces.json'

/**
 * Normalize one plugin config object. Unknown keys are ignored on purpose: a
 * newer/older host patch must never make the plugin refuse to load.
 *
 * @param {Record<string, unknown> | undefined} input
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{
 *   workspaces: string[],
 *   roots: string[],
 *   maxDepth: number,
 *   restoreOnStart: boolean,
 *   registerWorkspaces: boolean,
 *   archiveOnEvent: boolean,
 *   archiveDebounceMs: number,
 *   workspacePollMs: number,
 *   includeSubagents: boolean,
 *   home: string,
 *   sessionsRoot: string,
 *   markerName: string,
 *   archiveDirName: string,
 *   logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug',
 * }}
 */
export function normalizeConfig(input = {}, options = {}) {
  const env = options.env ?? process.env
  const home = resolve(stringOr(input.home, resolveHome(env)))
  const workspaces = stringArray(input.workspaces).map((p) => resolve(p))
  const roots = stringArray(input.roots).map((p) => resolve(p))
  const markerName = stringOr(input.markerName, MARKER_FILENAME)
  const archiveDirName = stringOr(input.archiveDirName, ARCHIVE_DIRNAME)
  const maxDepth = clampInt(input.maxDepth, 0, 8, 3)
  const debounce = clampInt(input.archiveDebounceMs, 0, 600_000, 1500)
  const poll = clampInt(input.workspacePollMs, 0, 3_600_000, 15_000)
  const levels = new Set(['silent', 'error', 'warn', 'info', 'debug'])
  return {
    workspaces,
    roots,
    maxDepth,
    restoreOnStart: input.restoreOnStart !== false,
    registerWorkspaces: input.registerWorkspaces !== false,
    archiveOnEvent: input.archiveOnEvent !== false,
    archiveDebounceMs: debounce,
    workspacePollMs: poll,
    includeSubagents: input.includeSubagents !== false,
    home,
    sessionsRoot: resolve(stringOr(input.sessionsRoot, join(home, 'sessions'))),
    markerName,
    archiveDirName,
    logLevel: levels.has(input.logLevel) ? input.logLevel : 'info',
  }
}

/**
 * Resolve the Harness home exactly like the shipped CLI does.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : undefined
  return resolve(configured ?? join(homedir(), '.dsh'))
}

/** Device-local state directory (never synced with the workspace). */
export function stateDir(home) {
  return join(home, 'dsh-easy-sync')
}

/** Marker path inside a workspace root. */
export function markerPath(workspacePath, markerName = MARKER_FILENAME) {
  return join(workspacePath, markerName)
}

/** Archive directory inside a workspace root. */
export function archiveDir(workspacePath, archiveDirName = ARCHIVE_DIRNAME) {
  return join(workspacePath, archiveDirName)
}

/** Tracked sessions directory inside the archive. */
export function archiveSessionsDir(workspacePath, archiveDirName = ARCHIVE_DIRNAME) {
  return join(archiveDir(workspacePath, archiveDirName), 'sessions')
}

/**
 * Canonicalize an existing directory. Returns `undefined` for a missing or
 * unreadable path so a stale config entry can be skipped instead of failing
 * startup.
 *
 * @param {string} path
 * @returns {string | undefined}
 */
export function canonicalDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return undefined
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/**
 * Whether a directory currently carries the sync marker.
 *
 * @param {string} workspacePath
 * @param {string} markerName
 * @returns {boolean}
 */
export function hasMarker(workspacePath, markerName = MARKER_FILENAME) {
  try {
    return statSync(markerPath(workspacePath, markerName)).isFile()
  } catch {
    return false
  }
}

/**
 * Read the marker; a malformed marker still counts as opted in because the
 * file itself is the user's explicit opt-in.
 *
 * @param {string} workspacePath
 * @param {string} markerName
 * @returns {{ version: number, createdAt?: string, note?: string } | undefined}
 */
export function readMarker(workspacePath, markerName = MARKER_FILENAME) {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(workspacePath, markerName), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: Number.isSafeInteger(parsed.version) ? parsed.version : MARKER_VERSION,
        ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
        ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
      }
    }
  } catch {
    // Fall through: a present marker file is still an opt-in.
  }
  return undefined
}

/**
 * Create (or repair) the marker file.
 *
 * @param {string} workspacePath
 * @param {{ markerName?: string, note?: string }} [options]
 * @returns {{ markerPath: string, archiveDir: string, created: boolean }}
 */
export function enableWorkspace(workspacePath, options = {}) {
  const markerName = options.markerName ?? MARKER_FILENAME
  const archiveDirName = options.archiveDirName ?? ARCHIVE_DIRNAME
  const canonical = canonicalDirectory(workspacePath)
  if (canonical === undefined) throw new Error(`workspace directory does not exist: ${workspacePath}`)
  const marker = markerPath(canonical, markerName)
  const created = !existsSync(marker)
  if (created) {
    const payload = { version: MARKER_VERSION, createdAt: new Date().toISOString() }
    if (typeof options.note === 'string' && options.note !== '') payload.note = options.note
    writeFileSync(marker, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
  }
  const dir = archiveSessionsDir(canonical, archiveDirName)
  mkdirSync(dir, { recursive: true })
  return { markerPath: marker, archiveDir: archiveDir(canonical, archiveDirName), created }
}

/**
 * Remove the opt-in marker while keeping the archive data on disk.
 *
 * @param {string} workspacePath
 * @param {string} [markerName]
 * @returns {boolean} whether a marker was removed
 */
export function disableWorkspace(workspacePath, markerName = MARKER_FILENAME) {
  const marker = markerPath(workspacePath, markerName)
  if (!existsSync(marker)) return false
  // Rename rather than delete: a mistaken disable must be recoverable.
  const backup = `${marker}.disabled-${timestampSlug()}`
  try {
    renameSync(marker, backup)
    return true
  } catch {
    return false
  }
}

/**
 * Discover opted-in workspaces from explicit config, configured scan roots,
 * the device-local remembered list, and (when supplied) workspace-registry
 * paths. Every candidate must still carry the marker.
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {{ registryPaths?: string[], remembered?: string[], scanRoots?: boolean }} [options]
 * @returns {{ workspaces: string[], skipped: Array<{ path: string, reason: string }> }}
 */
export function discoverWorkspaces(config, options = {}) {
  const seen = new Map()
  const skipped = []
  const add = (candidate, source) => {
    const canonical = canonicalDirectory(candidate)
    if (canonical === undefined) {
      skipped.push({ path: candidate, reason: 'missing-directory' })
      return
    }
    if (!hasMarker(canonical, config.markerName)) {
      skipped.push({ path: canonical, reason: `missing-marker (${source})` })
      return
    }
    if (!seen.has(pathKey(canonical))) seen.set(pathKey(canonical), canonical)
  }

  for (const path of config.workspaces) add(path, 'config.workspaces')
  for (const path of options.remembered ?? []) add(path, 'remembered')
  for (const path of options.registryPaths ?? []) add(path, 'workspace-registry')

  if (config.roots.length > 0 && options.scanRoots !== false) {
    for (const root of config.roots) {
      const canonicalRoot = canonicalDirectory(root)
      if (canonicalRoot === undefined) {
        skipped.push({ path: root, reason: 'missing-root' })
        continue
      }
      for (const candidate of scanRoot(canonicalRoot, config.maxDepth, config.markerName)) add(candidate, 'roots')
    }
  }

  return { workspaces: [...seen.values()], skipped }
}

/**
 * Breadth-first scan for marker files under one root. Hidden directories and
 * heavyweight build/dependency directories are pruned.
 *
 * @param {string} root
 * @param {number} maxDepth
 * @param {string} markerName
 * @returns {string[]}
 */
export function scanRoot(root, maxDepth, markerName = MARKER_FILENAME) {
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    if (hasMarker(dir, markerName)) {
      found.push(dir)
      continue // a sync workspace does not contain nested sync workspaces
    }
    if (depth >= maxDepth) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (PRUNED_DIRS.has(entry.name)) continue
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
    }
  }
  return found
}

/** Directories never worth scanning for a workspace marker. */
const PRUNED_DIRS = new Set([
  'node_modules',
  'AppData',
  'Library',
  'Program Files',
  'Program Files (x86)',
  'Windows',
  'System32',
  'System Volume Information',
  '$Recycle.Bin',
])

/**
 * Read the workspace paths DSH itself persisted in `<home>/storages/`.
 *
 * The registry storage is the earliest durable record of "this device has seen
 * this workspace", so reading it at activation lets the plugin restore before
 * the workspace registry service exists — including on a device that has opened
 * the workspace once before. Every failure (missing file, unknown schema, a
 * record without a path) degrades to an empty list.
 *
 * @param {string} home
 * @returns {string[]}
 */
export function readStoredWorkspacePaths(home) {
  for (const fileName of ['workspace.json', 'workspaces.json']) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(home, 'storages', fileName), 'utf8'))
    } catch {
      continue
    }
    const tables = parsed !== null && typeof parsed === 'object' ? parsed.tables : undefined
    const workspaces = tables !== null && typeof tables === 'object' ? tables.workspaces : undefined
    const records = Array.isArray(workspaces)
      ? workspaces
      : (workspaces !== null && typeof workspaces === 'object' ? Object.values(workspaces) : [])
    const paths = []
    for (const record of records) {
      if (record !== null && typeof record === 'object' && typeof record.path === 'string' && record.path.trim() !== '') {
        paths.push(record.path)
      }
    }
    if (paths.length > 0) return paths
  }
  return []
}

/**
 * Read the device-local remembered workspace list.
 *
 * @param {string} home
 * @returns {string[]}
 */
export function readRememberedWorkspaces(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir(home), REMEMBERED_FILENAME), 'utf8'))
    if (Array.isArray(parsed)) return parsed.filter((value) => typeof value === 'string')
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.filter((value) => typeof value === 'string')
    }
  } catch {
    // Missing or malformed cache is not an error.
  }
  return []
}

/**
 * Persist the remembered workspace list so the next startup can restore before
 * any service is ready.
 *
 * @param {string} home
 * @param {string[]} workspaces
 * @returns {void}
 */
export function writeRememberedWorkspaces(home, workspaces) {
  const dir = stateDir(home)
  mkdirSync(dir, { recursive: true })
  const unique = [...new Set(workspaces.map((path) => path))]
  writeFileSync(join(dir, REMEMBERED_FILENAME), `${JSON.stringify({ version: 1, workspaces: unique }, undefined, 2)}\n`, 'utf8')
}

/**
 * Case/spelling-insensitive path identity key for comparing user spellings
 * against the workspace registry's canonical paths.
 *
 * @param {string} path
 * @returns {string}
 */
export function pathKey(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Compare two directory paths as the same workspace.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

/** Human-readable title for an auto-registered workspace. */
export function workspaceTitle(path) {
  const name = basename(resolve(path))
  return name === '' ? resolve(path) : name
}

function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
