// Workspace-scoped conversation archive/restore engine.
//
// The engine is deliberately synchronous and service-free: it is the same code
// path at plugin activation (before the workspace registry exists), inside the
// `workspace_sync` tool, and in unit tests. Nothing here touches DSH services.
//
// Freshness model: a session log is append-only, so the log whose last event
// carries the greater `seq` is the newer log. The archive wins when it is
// strictly newer (or the local copy is absent); the local copy wins when it is
// strictly newer, and is copied back into the archive. Equal logs are only
// repaired (canonical path / header cwd), never rewritten.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  archiveDir,
  archiveSessionsDir,
  canonicalDirectory,
  disableWorkspace as removeMarker,
  discoverWorkspaces,
  enableWorkspace,
  normalizeConfig,
  pathKey,
  readRememberedWorkspaces,
  samePath,
  workspaceTitle,
  writeRememberedWorkspaces,
} from './config.js'
import {
  encodeSegment,
  generationLogFilename,
  newestGenerationName,
  parseGenerationLogFilename,
  projectDir,
  sessionDir,
} from './paths.js'
import { encodeSessionLog, inspectSessionFile, rewriteHeaderCwd, trimIncompleteTail } from './session-file.js'

/** Returned by {@link SyncEngine#runStartupSync} and the tool's sync action. */
export function emptyReport() {
  return {
    restored: [],
    archived: [],
    repaired: [],
    conflicts: [],
    warnings: [],
    workspaces: [],
    perWorkspace: [],
  }
}

/**
 * One sync workspace plus its cached archive paths.
 *
 * @typedef {{
 *   path: string,
 *   title: string,
 *   archive: string,
 *   sessions: string,
 * }} SyncWorkspace
 */

export class SyncEngine {
  /**
   * @param {{
   *   config?: Record<string, unknown>,
   *   logger?: (level: 'error'|'warn'|'info'|'debug', message: string) => void,
   *   env?: NodeJS.ProcessEnv,
   *   isSessionLive?: (id: string) => boolean,
   * }} [options]
   */
  constructor(options = {}) {
    /** @type {ReturnType<typeof normalizeConfig>} */
    this.config = normalizeConfig(options.config, { env: options.env })
    this.logger = options.logger ?? (() => {})
    this.isSessionLive = options.isSessionLive ?? (() => false)
    /** @type {Map<string, SyncWorkspace>} */
    this.workspaces = new Map()
    /** @type {'zstd' | 'none' | undefined} */
    this.rootEncoding = undefined
    this.remembered = readRememberedWorkspaces(this.config.home)
    this.lastRememberedSerialized = JSON.stringify(this.remembered)
  }

  log(level, message) {
    this.logger(level, message)
  }

  // -------------------------------------------------------------------------
  // Workspace discovery
  // -------------------------------------------------------------------------

  /**
   * Rediscover opted-in workspaces and remember every marker-backed path.
   *
   * @param {{ registryPaths?: string[], scanRoots?: boolean }} [options]
   * @returns {{ workspaces: string[], skipped: Array<{ path: string, reason: string }> }}
   */
  refreshWorkspaces(options = {}) {
    const { workspaces, skipped } = discoverWorkspaces(this.config, {
      registryPaths: options.registryPaths,
      remembered: this.remembered,
      scanRoots: options.scanRoots,
    })
    /** @type {Map<string, SyncWorkspace>} */
    const next = new Map()
    for (const path of workspaces) {
      const key = pathKey(path)
      next.set(key, {
        path,
        title: workspaceTitle(path),
        archive: archiveDir(path, this.config.archiveDirName),
        sessions: archiveSessionsDir(path, this.config.archiveDirName),
      })
      mkdirSync(archiveSessionsDir(path, this.config.archiveDirName), { recursive: true })
    }
    this.workspaces = next
    this.remembered = [...new Set([...this.remembered, ...workspaces])]
    const serialized = JSON.stringify(this.remembered)
    if (serialized !== this.lastRememberedSerialized) {
      this.lastRememberedSerialized = serialized
      writeRememberedWorkspaces(this.config.home, this.remembered)
    }
    for (const entry of skipped) this.log('debug', `skip workspace ${entry.path}: ${entry.reason}`)
    return { workspaces, skipped }
  }

  /**
   * Find the enabled workspace owning one cwd.
   *
   * @param {string | undefined} cwd
   * @returns {SyncWorkspace | undefined}
   */
  workspaceForCwd(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    for (const workspace of this.workspaces.values()) {
      if (samePath(workspace.path, cwd)) return workspace
    }
    const canonical = canonicalDirectory(cwd)
    if (canonical !== undefined) {
      for (const workspace of this.workspaces.values()) {
        if (samePath(workspace.path, canonical)) return workspace
      }
    }
    return undefined
  }

  /** @returns {SyncWorkspace[]} */
  listWorkspaces() {
    return [...this.workspaces.values()]
  }

  /**
   * Opt a workspace into sync and reconcile anything it already has.
   *
   * @param {string} workspacePath
   * @param {{ note?: string, registryPaths?: string[] }} [options]
   * @returns {{ workspace: SyncWorkspace, report: ReturnType<typeof emptyReport>, markerCreated: boolean }}
   */
  enable(workspacePath, options = {}) {
    const created = enableWorkspace(workspacePath, {
      markerName: this.config.markerName,
      archiveDirName: this.config.archiveDirName,
      note: options.note,
    })
    const canonical = canonicalDirectory(workspacePath)
    if (canonical === undefined) throw new Error(`workspace directory does not exist: ${workspacePath}`)
    // The workspace may be brand new to this process and neither configured nor
    // remembered yet; naming it in the discovery candidates makes the marker we
    // just wrote visible without requiring a roots scan.
    const registryPaths = [...new Set([...(options.registryPaths ?? []), canonical])]
    this.refreshWorkspaces({ registryPaths })
    const workspace = this.workspaceForCwd(canonical)
    if (workspace === undefined) throw new Error(`failed to register sync workspace: ${workspacePath}`)
    const report = this.syncWorkspace(workspace, { restore: true, archive: true })
    return { workspace, report, markerCreated: created.created }
  }

  /**
   * Stop archiving a workspace. The archive directory is intentionally kept.
   *
   * @param {string} workspacePath
   * @returns {boolean}
   */
  disable(workspacePath) {
    const removed = removeMarker(workspacePath, this.config.markerName)
    this.refreshWorkspaces()
    return removed
  }

  /**
   * Full bidirectional reconciliation for every enabled workspace.
   *
   * @param {{ restore?: boolean, archive?: boolean }} [options]
   * @returns {ReturnType<typeof emptyReport>}
   */
  runStartupSync(options = {}) {
    const report = emptyReport()
    for (const workspace of this.workspaces.values()) {
      const workspaceReport = this.syncWorkspace(workspace, {
        restore: options.restore ?? this.config.restoreOnStart,
        archive: options.archive ?? true,
      })
      report.perWorkspace.push({
        path: workspace.path,
        restored: [...workspaceReport.restored],
        archived: [...workspaceReport.archived],
        warnings: [...workspaceReport.warnings],
      })
      mergeReport(report, workspaceReport)
    }
    return report
  }

  /**
   * Reconcile one workspace.
   *
   * @param {SyncWorkspace} workspace
   * @param {{ restore?: boolean, archive?: boolean }} [options]
   * @returns {ReturnType<typeof emptyReport> & { id: string }}
   */
  syncWorkspace(workspace, options = {}) {
    const restore = options.restore !== false
    const archive = options.archive !== false
    const report = { ...emptyReport(), id: workspace.path }
    report.workspaces.push({ path: workspace.path, title: workspace.title })

    const archiveEntries = this.listArchiveEntries(workspace, report)
    const localEntries = this.listLocalEntries(workspace, report)
    const ids = new Set([...archiveEntries.keys(), ...localEntries.keys()])

    for (const id of ids) {
      const archiveEntry = archiveEntries.get(id)
      const candidates = this.collectLocalCandidates(id, localEntries.get(id) ?? [])
      const target = sessionDir(this.config.sessionsRoot, workspace.path, id)
      const live = this.isSessionLive(id)

      // Collapse duplicate local copies first: choose the longest, preserve the
      // rest in the archive's conflicts directory instead of deleting them.
      let local = pickBestLocal(candidates)
      if (candidates.length > 1) {
        for (const duplicate of candidates) {
          if (duplicate === local) continue
          if (live) {
            report.warnings.push(`cannot merge duplicate local copies of ${id}: session is live in this process`)
          } else {
            this.quarantineDuplicate(workspace, id, duplicate, report)
          }
        }
      }
      if (local !== undefined && local.dir !== target) {
        if (live) {
          report.warnings.push(`cannot relocate live session ${id} from ${local.dir}`)
        } else {
          this.moveDirectory(local.dir, target, report)
          if (existsSync(target)) {
            local = readLocalEntry(target) ?? local
          }
        }
      }
      if (local !== undefined && local.dir === target && this.needsRepair(local, workspace)) {
        if (live) {
          report.warnings.push(`cannot repair live session ${id} in place`)
        } else {
          this.repairLocal(workspace, id, local, report)
          local = readLocalEntry(target) ?? local
        }
      }

      if (archiveEntry === undefined) {
        if (archive && local !== undefined) this.writeArchive(workspace, id, local, report)
        continue
      }

      if (local === undefined) {
        if (restore) {
          this.restoreSession(workspace, id, archiveEntry, target, report)
          this.removeStaleCopies(id, target, report)
        }
        continue
      }

      const localSeq = local.lastSeq
      const archiveSeq = archiveEntry.lastSeq
      if (archiveSeq > localSeq) {
        if (!restore) {
          report.warnings.push(`archive is newer than local session ${id} (restoreOnStart is false)`)
        } else if (live) {
          report.warnings.push(`archive is newer than live session ${id}; leaving the live log untouched`)
        } else {
          this.restoreSession(workspace, id, archiveEntry, target, report)
          this.removeStaleCopies(id, target, report)
        }
      } else if (localSeq > archiveSeq) {
        if (archive) this.writeArchive(workspace, id, local, report)
      } else if (archive && !this.archiveMatches(workspace, id, archiveEntry, local)) {
        this.writeArchive(workspace, id, local, report)
      }
    }

    return report
  }

  // -------------------------------------------------------------------------
  // Event-driven archive
  // -------------------------------------------------------------------------

  /**
   * Archive one live session by its header cwd/id. Safe to call repeatedly;
   * returns without writing when the archive already holds the same history.
   *
   * @param {string | undefined} cwd
   * @param {string} id
   * @returns {{ archived: boolean, reason?: string, path?: string }}
   */
  archiveSession(cwd, id) {
    const workspace = this.workspaceForCwd(cwd)
    if (workspace === undefined) return { archived: false, reason: 'workspace-not-synced' }
    const exactDir = typeof cwd === 'string' && cwd !== '' ? sessionDir(this.config.sessionsRoot, cwd, id) : undefined
    let dir
    if (exactDir !== undefined && existsSync(exactDir)) dir = exactDir
    else dir = this.locateLocal(id)[0]?.dir
    if (dir === undefined) return { archived: false, reason: 'local-session-not-found' }
    const local = readLocalEntry(dir)
    if (local === undefined) return { archived: false, reason: 'local-session-unreadable' }
    const archiveEntries = this.listArchiveEntries(workspace, emptyReport())
    const archived = archiveEntries.get(id)
    if (archived !== undefined && this.archiveMatches(workspace, id, archived, local)) {
      return { archived: false, reason: 'up-to-date' }
    }
    const report = emptyReport()
    const ok = this.writeArchive(workspace, id, local, report)
    if (!ok) return { archived: false, reason: report.warnings[0] }
    return { archived: true, path: workspace.archive }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Human/machine readable status for the tool and diagnostics.
   *
   * @returns {{
   *   home: string,
   *   sessionsRoot: string,
   *   encoding: 'zstd' | 'none',
   *   workspaces: Array<{
   *     path: string,
   *     title: string,
   *     archive: string,
   *     archiveSessions: number,
   *     localSessions: number,
   *     archivedBytes: number,
   *   }>,
   * }}
   */
  status() {
    const workspaces = []
    for (const workspace of this.workspaces.values()) {
      const archiveEntries = this.listArchiveEntries(workspace, emptyReport())
      const localEntries = this.listLocalEntries(workspace, emptyReport())
      let archivedBytes = 0
      for (const entry of archiveEntries.values()) archivedBytes += entry.sizeBytes
      workspaces.push({
        path: workspace.path,
        title: workspace.title,
        archive: workspace.archive,
        archiveSessions: archiveEntries.size,
        localSessions: localEntries.size,
        archivedBytes,
      })
    }
    return {
      home: this.config.home,
      sessionsRoot: this.config.sessionsRoot,
      encoding: this.detectRootEncoding(),
      workspaces,
    }
  }

  // -------------------------------------------------------------------------
  // Internals: local state
  // -------------------------------------------------------------------------

  /**
   * All project directories under the configured session root.
   *
   * @returns {string[]}
   */
  listProjectDirs() {
    try {
      return readdirSync(this.config.sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.config.sessionsRoot, entry.name))
    } catch {
      return []
    }
  }

  /**
   * Locate every on-disk copy of one session id across project directories.
   *
   * @param {string} id
   * @returns {Array<{ dir: string }>}
   */
  locateLocal(id) {
    const encoded = encodeSegment(id)
    const found = []
    for (const project of this.listProjectDirs()) {
      const dir = join(project, encoded)
      try {
        if (statSync(dir).isDirectory()) found.push({ dir })
      } catch {
        // Not present in this project directory.
      }
    }
    return found
  }

  /**
   * Enrich the entries discovered under the canonical project directories with
   * copies left behind under an older project key. Only ids already known from
   * the archive or the canonical directory are searched, which keeps startup
   * proportional to the workspace's own history.
   *
   * @param {string} id
   * @param {LocalEntry[]} known
   * @returns {LocalEntry[]}
   */
  collectLocalCandidates(id, known) {
    const candidates = [...known]
    const seen = new Set(candidates.map((entry) => pathKey(entry.dir)))
    for (const located of this.locateLocal(id)) {
      const key = pathKey(located.dir)
      if (seen.has(key)) continue
      const entry = readLocalEntry(located.dir)
      if (entry === undefined || entry.header.id !== id) continue
      candidates.push(entry)
      seen.add(key)
    }
    return candidates
  }

  /**
   * Read every local session that belongs to a workspace.
   *
   * @param {SyncWorkspace} workspace
   * @param {ReturnType<typeof emptyReport>} report
   * @returns {Map<string, LocalEntry[]>}
   */
  listLocalEntries(workspace, report) {
    /** @type {Map<string, LocalEntry[]>} */
    const byId = new Map()
    for (const project of this.workspaceProjectDirs(workspace)) {
      let sessionDirs
      try {
        sessionDirs = readdirSync(project, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      } catch {
        continue
      }
      for (const entry of sessionDirs) {
        const dir = join(project, entry.name)
        const local = readLocalEntry(dir)
        if (local === undefined) {
          report.warnings.push(`unreadable session directory: ${dir}`)
          continue
        }
        if (!headerBelongsToWorkspace(local.header, workspace)) continue
        const list = byId.get(local.header.id) ?? []
        list.push(local)
        byId.set(local.header.id, list)
      }
    }
    return byId
  }

  /**
   * Project directories that can hold sessions of one workspace.
   *
   * @param {SyncWorkspace} workspace
   * @returns {string[]}
   */
  workspaceProjectDirs(workspace) {
    const dirs = new Set([projectDir(this.config.sessionsRoot, workspace.path)])
    for (const remembered of this.remembered) {
      if (samePath(remembered, workspace.path)) dirs.add(projectDir(this.config.sessionsRoot, remembered))
    }
    return [...dirs]
  }

  /**
   * Whether a local session needs a header/path repair.
   *
   * @param {LocalEntry} entry
   * @param {SyncWorkspace} workspace
   * @returns {boolean}
   */
  needsRepair(entry, workspace) {
    if (!samePath(entry.dir, sessionDir(this.config.sessionsRoot, workspace.path, entry.header.id))) return true
    return !headerMatchesWorkspace(entry.header, workspace)
  }

  /**
   * Rewrite a local session's header cwd to the workspace path (all canonical
   * generations) without touching its events.
   *
   * @param {SyncWorkspace} workspace
   * @param {string} id
   * @param {LocalEntry} entry
   * @param {ReturnType<typeof emptyReport>} report
   */
  repairLocal(workspace, id, entry, report) {
    try {
      for (const file of entry.files) {
        const parsed = parseGenerationLogFilename(basename(file))
        if (parsed === undefined) continue
        const buffer = readFileSync(file)
        const rewritten = rewriteHeaderCwd(buffer, workspace.path, { compression: parsed.compression })
        atomicWrite(file, rewritten)
      }
      report.repaired.push(id)
      this.log('debug', `repaired session ${id} in ${workspace.path}`)
    } catch (error) {
      report.warnings.push(`could not repair session ${id}: ${errorMessage(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Internals: archive state
  // -------------------------------------------------------------------------

  /**
   * Read every archived session entry of one workspace.
   *
   * @param {SyncWorkspace} workspace
   * @param {ReturnType<typeof emptyReport>} report
   * @returns {Map<string, ArchiveEntry>}
   */
  listArchiveEntries(workspace, report) {
    /** @type {Map<string, ArchiveEntry>} */
    const byId = new Map()
    let dirs
    try {
      dirs = readdirSync(workspace.sessions, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      return byId
    }
    for (const entry of dirs) {
      const dir = join(workspace.sessions, entry.name)
      const archived = readArchiveEntry(dir)
      if (archived === undefined) {
        report.warnings.push(`unreadable archived session directory: ${dir}`)
        continue
      }
      if (encodeSegment(archived.header.id) !== entry.name) {
        report.warnings.push(`archived session directory ${dir} does not match header id ${archived.header.id}`)
        continue
      }
      byId.set(archived.header.id, archived)
    }
    return byId
  }

  /**
   * Copy one local session into the archive (atomic per generation file).
   *
   * @param {SyncWorkspace} workspace
   * @param {string} id
   * @param {LocalEntry} local
   * @param {ReturnType<typeof emptyReport>} report
   * @returns {boolean}
   */
  writeArchive(workspace, id, local, report) {
    try {
      const targetDir = join(workspace.sessions, encodeSegment(id))
      mkdirSync(targetDir, { recursive: true })
      const sourceFile = local.newestFile
      const parsed = parseGenerationLogFilename(basename(sourceFile))
      if (parsed === undefined) throw new Error(`unexpected generation filename: ${sourceFile}`)
      // Validate before publishing; a torn tail is trimmed to its longest
      // complete prefix so a concurrently appended log still reaches the archive.
      const safe = readSessionFileSafe(sourceFile, parsed.compression)
      const targetName = basename(sourceFile)
      atomicWrite(join(targetDir, targetName), safe.buffer)
      removeOtherGenerations(targetDir, targetName)
      report.archived.push(id)
      if (safe.trimmedBytes > 0) {
        this.log('debug', `trimmed ${safe.trimmedBytes} torn byte(s) from session ${id} before archiving`)
      }
      this.log('debug', `archived session ${id} for ${workspace.path} (${safe.buffer.length} bytes)`)
      return true
    } catch (error) {
      report.warnings.push(`could not archive session ${id}: ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * Whether the archive already holds exactly the local generation.
   *
   * @param {SyncWorkspace} workspace
   * @param {string} id
   * @param {ArchiveEntry} archiveEntry
   * @param {LocalEntry} local
   * @returns {boolean}
   */
  archiveMatches(workspace, id, archiveEntry, local) {
    // Header cwd legitimately differs between devices (a restore rewrites it),
    // so byte size alone must not decide equality: comparing it would make
    // every device rewrite the archive with its own local path on every start.
    return (
      archiveEntry.lastSeq === local.lastSeq &&
      archiveEntry.version === local.version &&
      archiveEntry.compression === local.compression
    )
  }

  // -------------------------------------------------------------------------
  // Internals: restore
  // -------------------------------------------------------------------------

  /**
   * Publish one archived session into the local session root, rewriting its
   * header cwd to the local workspace path so the backend's path identity check
   * and the workspace registry's cwd index both accept it.
   *
   * @param {SyncWorkspace} workspace
   * @param {string} id
   * @param {ArchiveEntry} archiveEntry
   * @param {string} targetDir
   * @param {ReturnType<typeof emptyReport>} report
   */
  restoreSession(workspace, id, archiveEntry, targetDir, report) {
    try {
      const targetCompression = this.detectRootEncoding()
      const targetName = generationLogFilename(archiveEntry.version, targetCompression)
      const safe = readSessionFileSafe(archiveEntry.newestFile, archiveEntry.compression)
      if (safe.trimmedBytes > 0) {
        this.log('warn', `archive of ${id} has a torn tail; restoring its complete prefix only`)
      }
      const sourceBuffer = safe.buffer

      let output
      if (archiveEntry.compression === targetCompression) {
        output = rewriteHeaderCwd(sourceBuffer, workspace.path, { compression: targetCompression })
      } else {
        // Cross-device encoding difference: transcode the validated logical log.
        const inspected = safe.inspected
        output = encodeSessionLog(
          { header: { ...inspected.header, cwd: workspace.path }, events: inspected.events },
          { compression: targetCompression },
        )
      }
      mkdirSync(targetDir, { recursive: true })
      const target = join(targetDir, targetName)
      atomicWrite(target, output)
      removeOtherGenerations(targetDir, targetName)
      report.restored.push(id)
      this.log('info', `restored session ${id} into ${workspace.path}`)
    } catch (error) {
      report.warnings.push(`could not restore session ${id}: ${errorMessage(error)}`)
    }
  }

  /**
   * Remove non-canonical local copies of a session after a successful restore.
   *
   * @param {string} id
   * @param {string} targetDir
   * @param {ReturnType<typeof emptyReport>} report
   */
  removeStaleCopies(id, targetDir, report) {
    if (this.isSessionLive(id)) return
    for (const copy of this.locateLocal(id)) {
      if (samePath(copy.dir, targetDir)) continue
      try {
        rmSync(copy.dir, { recursive: true, force: true })
        this.log('debug', `removed stale local copy ${copy.dir} of ${id}`)
      } catch (error) {
        report.warnings.push(`could not remove stale local copy ${copy.dir}: ${errorMessage(error)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals: filesystem helpers
  // -------------------------------------------------------------------------

  /**
   * Detect the physical encoding already used by the local session root. The
   * backend rejects a root that mixes encodings, so restore must follow it.
   *
   * @returns {'zstd' | 'none'}
   */
  detectRootEncoding() {
    if (this.rootEncoding !== undefined) return this.rootEncoding
    /** @type {'zstd' | 'none' | undefined} */
    let detected
    outer: for (const project of this.listProjectDirs()) {
      let entries
      try {
        entries = readdirSync(project, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        let files
        try {
          files = readdirSync(join(project, entry.name))
        } catch {
          continue
        }
        for (const name of files) {
          const parsed = parseGenerationLogFilename(name)
          if (parsed !== undefined) {
            detected = parsed.compression
            break outer
          }
        }
      }
    }
    this.rootEncoding = detected ?? 'zstd'
    return this.rootEncoding
  }

  /**
   * Move a stale local session directory into the canonical project directory.
   *
   * @param {string} from
   * @param {string} to
   * @param {ReturnType<typeof emptyReport>} report
   */
  moveDirectory(from, to, report) {
    try {
      if (existsSync(to)) {
        report.warnings.push(`cannot relocate ${from}: ${to} already exists`)
        return
      }
      mkdirSync(join(to, '..'), { recursive: true })
      renameSync(from, to)
    } catch (error) {
      report.warnings.push(`could not relocate ${from}: ${errorMessage(error)}`)
    }
  }

  /**
   * Preserve a duplicate copy inside the workspace archive instead of deleting
   * it, so no conversation data is lost.
   *
   * @param {SyncWorkspace} workspace
   * @param {string} id
   * @param {LocalEntry} duplicate
   * @param {ReturnType<typeof emptyReport>} report
   */
  quarantineDuplicate(workspace, id, duplicate, report) {
    try {
      const conflicts = join(workspace.archive, 'conflicts')
      mkdirSync(conflicts, { recursive: true })
      const target = join(conflicts, `${encodeSegment(id)}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      renameSync(duplicate.dir, target)
      report.conflicts.push({ id, from: duplicate.dir, to: target })
      report.warnings.push(`duplicate copy of ${id} moved to ${target}`)
    } catch (error) {
      report.warnings.push(`could not quarantine duplicate ${duplicate.dir}: ${errorMessage(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   dir: string,
 *   header: { id: string, cwd?: string, version?: number },
 *   newestFile: string,
 *   files: string[],
 *   lastSeq: number,
 *   version: number,
 *   compression: 'zstd' | 'none',
 *   sizeBytes: number,
 * }} LocalEntry
 */

/**
 * @typedef {{
 *   dir: string,
 *   header: { id: string, cwd?: string, version?: number },
 *   newestFile: string,
 *   lastSeq: number,
 *   version: number,
 *   compression: 'zstd' | 'none',
 *   sizeBytes: number,
 * }} ArchiveEntry
 */

/**
 * Read the highest canonical generation of one local session directory.
 *
 * @param {string} dir
 * @returns {LocalEntry | undefined}
 */
export function readLocalEntry(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const newest = newestGenerationName(names)
  if (newest === undefined) return undefined
  const parsed = parseGenerationLogFilename(newest)
  if (parsed === undefined) return undefined
  const file = join(dir, newest)
  try {
    const safe = readSessionFileSafe(file, parsed.compression)
    return {
      dir,
      header: /** @type {any} */ (safe.inspected.header),
      newestFile: file,
      files: names.filter((name) => parseGenerationLogFilename(name) !== undefined).map((name) => join(dir, name)),
      lastSeq: safe.inspected.lastSeq,
      version: parsed.version,
      compression: parsed.compression,
      sizeBytes: safe.buffer.length,
    }
  } catch {
    return undefined
  }
}

/**
 * Read the highest canonical generation of one archived session directory.
 *
 * @param {string} dir
 * @returns {ArchiveEntry | undefined}
 */
export function readArchiveEntry(dir) {
  const entry = readLocalEntry(dir)
  if (entry === undefined) return undefined
  return {
    dir: entry.dir,
    header: entry.header,
    newestFile: entry.newestFile,
    lastSeq: entry.lastSeq,
    version: entry.version,
    compression: entry.compression,
    sizeBytes: entry.sizeBytes,
  }
}

/**
 * Pick the copy with the longest history; the first copy wins ties so repeated
 * runs are stable.
 *
 * @param {LocalEntry[] | undefined} entries
 * @returns {LocalEntry | undefined}
 */
function pickBestLocal(entries) {
  if (entries === undefined || entries.length === 0) return undefined
  let best = entries[0]
  for (const entry of entries.slice(1)) {
    if (entry.lastSeq > best.lastSeq) best = entry
  }
  return best
}

/**
 * Whether a header cwd is this workspace, accepting canonical aliases.
 *
 * @param {{ cwd?: string }} header
 * @param {SyncWorkspace} workspace
 * @returns {boolean}
 */
function headerBelongsToWorkspace(header, workspace) {
  return headerMatchesWorkspace(header, workspace) || (header.cwd !== undefined && canonicalDirectory(header.cwd) !== undefined && samePath(canonicalDirectory(header.cwd), workspace.path))
}

/**
 * Whether a header cwd equals the workspace path.
 *
 * @param {{ cwd?: string }} header
 * @param {SyncWorkspace} workspace
 * @returns {boolean}
 */
function headerMatchesWorkspace(header, workspace) {
  return header.cwd !== undefined && samePath(header.cwd, workspace.path)
}

/**
 * Remove superseded generation files from a session directory, keeping only
 * the selected generation filename.
 *
 * @param {string} dir
 * @param {string} keepName
 */
function removeOtherGenerations(dir, keepName) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keepName) continue
    if (parseGenerationLogFilename(name) === undefined) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // A read-only leftover generation is harmless: the backend selects the
      // highest version and will ignore it.
    }
  }
}

/**
 * Atomic publish: write a sibling temp file, then rename over the target.
 *
 * @param {string} target
 * @param {Buffer} buffer
 */
export function atomicWrite(target, buffer) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, buffer)
  try {
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort cleanup.
    }
    throw error
  }
}

/**
 * Merge one workspace report into a total report.
 *
 * @param {ReturnType<typeof emptyReport>} target
 * @param {ReturnType<typeof emptyReport>} source
 */
export function mergeReport(target, source) {
  for (const key of ['restored', 'archived', 'repaired', 'conflicts', 'warnings', 'workspaces', 'perWorkspace']) {
    target[key].push(...source[key])
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one session file, trimming a torn tail to the longest complete prefix.
 * Append-only logs make a prefix a valid (older) snapshot; this is how a live
 * session can be archived safely while the backend is still appending.
 *
 * @param {string} file
 * @param {'zstd' | 'none'} compression
 * @returns {{ buffer: Buffer, inspected: ReturnType<typeof inspectSessionFile>, trimmedBytes: number }}
 */
export function readSessionFileSafe(file, compression) {
  const raw = readFileSync(file)
  try {
    return { buffer: raw, inspected: inspectSessionFile(raw, { compression }), trimmedBytes: 0 }
  } catch (error) {
    const trimmed = trimIncompleteTail(raw, { compression })
    if (trimmed.trimmedBytes === 0) throw error
    const inspected = inspectSessionFile(trimmed.buffer, { compression })
    return { buffer: trimmed.buffer, inspected, trimmedBytes: trimmed.trimmedBytes }
  }
}
