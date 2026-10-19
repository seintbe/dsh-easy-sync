// dsh-easy-sync host plugin.
//
// Responsibilities:
//   1. At activation, reconcile every opted-in workspace *synchronously*:
//      restore archived conversations into the local session root (rewriting
//      the stored header cwd to this device's workspace path) and copy newer
//      local conversations back into the workspace archive.
//   2. Once `workspaceRegistry` is available, make every restored session
//      visible in the GUI immediately: register marker-backed workspaces and
//      attach restored session ids. This does not depend on plugin load order.
//   3. While running, debounce-archive live sessions whose cwd belongs to a
//      sync workspace, after forcing the persistence layer to flush.
//   4. Expose a `workspace_sync` tool so a user can opt a workspace in/out and
//      inspect or force a sync from inside the harness.
//
// The plugin must never break boot: every failure is contained and logged.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasMarker, normalizeConfig, pathKey, readStoredWorkspacePaths, samePath, stateDir } from './config.js'
import { SyncEngine, emptyReport } from './engine.js'
import { registerWebRoutes } from './web-routes.js'

/** Cordis plugin name. */
export const name = 'dsh-easy-sync'

/**
 * Mount the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const log = createLogger(ctx, config.logLevel)

  /** @type {SyncEngine | undefined} */
  let engine
  try {
    engine = new SyncEngine({
      config: rawConfig,
      logger: log,
      isSessionLive: (id) => isSessionLive(ctx, id),
    })
  } catch (error) {
    log('error', `engine could not be constructed: ${errorText(error)}`)
    return
  }

  /** Paths already reconciled during activation. @type {Set<string>} */
  const startupSynced = new Set()
  /** @type {ReturnType<typeof emptyReport> | undefined} */
  let startupReport

  // ---------------------------------------------------------------------
  // 1. Startup restore/archive, before any await (deterministic, fs-only).
  // ---------------------------------------------------------------------
  try {
    // `storages/workspace.json` is written by DSH itself and survives restarts,
    // so a device that opened the workspace once can restore at activation
    // without waiting for the registry service (or the GUI) to come up.
    const stored = readStoredWorkspacePaths(config.home)
    engine.refreshWorkspaces({ registryPaths: stored })
    startupReport = engine.runStartupSync()
    for (const entry of startupReport.perWorkspace) startupSynced.add(pathKey(entry.path))
    if (startupReport.restored.length > 0) {
      log('info', `restored ${startupReport.restored.length} session(s) from ${startupReport.perWorkspace.length} sync workspace(s)`)
    }
    if (startupReport.warnings.length > 0) {
      log('warn', `${startupReport.warnings.length} sync warning(s): ${startupReport.warnings.slice(0, 3).join(' | ')}`)
    }
    writeStartupSnapshot(config, 'startup', {
      phase: 'startup',
      discovered: engine.listWorkspaces().map((workspace) => workspace.path),
      report: startupReport,
    })
  } catch (error) {
    log('error', `startup sync failed: ${errorText(error)}`)
    writeStartupSnapshot(config, 'startup', { phase: 'startup-failed', error: errorText(error) })
  }

  // ---------------------------------------------------------------------
  // 2. Workspace registry integration: make sessions visible right away.
  // ---------------------------------------------------------------------
  try {
    ctx.inject(['workspaceRegistry'], async (child) => {
      try {
        const registryPaths = []
        const registry = child.workspaceRegistry
        if (registry !== undefined && typeof registry.list === 'function') {
          for (const workspace of registry.list()) {
            if (typeof workspace?.path === 'string') registryPaths.push(workspace.path)
          }
        }
        const attachErrors = []
        await reconcileWithRegistry(registry, engine, {
          log,
          registerWorkspaces: config.registerWorkspaces,
          startupSynced,
          attachErrors,
        })
        writeStartupSnapshot(config, 'registry', {
          phase: 'registry',
          registryPaths,
          synced: [...startupSynced],
          discovered: engine.listWorkspaces().map((workspace) => workspace.path),
          attachErrors,
        })
      } catch (error) {
        log('warn', `workspace registry reconciliation failed: ${errorText(error)}`)
        writeStartupSnapshot(config, 'registry', { phase: 'registry-failed', error: errorText(error) })
      }
      startWorkspacePoller(ctx, child.workspaceRegistry, engine, {
        log,
        registerWorkspaces: config.registerWorkspaces,
        startupSynced,
        pollMs: config.workspacePollMs,
        markerName: config.markerName,
      })
    })
  } catch (error) {
    log('debug', `workspaceRegistry is unavailable: ${errorText(error)}`)
  }

  // ---------------------------------------------------------------------
  // 3. Live archiving with debounce.
  // ---------------------------------------------------------------------
  /** @type {Map<string, { id: string, cwd: string }>} */
  const pending = new Map()
  /** @type {NodeJS.Timeout | undefined} */
  let drainTimer
  let draining = false

  const schedule = (session, delay) => {
    try {
      const header = session?.header
      const cwd = header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return
      if (engine.workspaceForCwd(cwd) === undefined) return
      const id = typeof session.id === 'string' && session.id !== '' ? session.id : header.id
      if (typeof id !== 'string' || id === '') return
      pending.set(id, { id, cwd, session })
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      drainTimer = setTimeout(() => {
        drainTimer = undefined
        void drain()
      }, delay)
      if (typeof drainTimer.unref === 'function') drainTimer.unref()
    } catch (error) {
      log('debug', `could not schedule archive: ${errorText(error)}`)
    }
  }

  const drain = async () => {
    if (draining || pending.size === 0) return
    draining = true
    const batch = [...pending.values()]
    pending.clear()
    try {
      // Force a durability barrier so the archive never reads a partially
      // written log. Prefer the per-session flush to avoid a global stall; the
      // persistence-wide flush remains the fallback for disposed sessions.
      const sessions = safeGet(ctx, 'sessions')
      let flushed = false
      if (sessions !== undefined && typeof sessions.flush === 'function') {
        for (const item of batch) {
          if (item.session === undefined) continue
          try {
            await sessions.flush(item.session)
            flushed = true
          } catch {
            // A disposed session cannot be flushed individually.
          }
        }
      }
      if (!flushed) {
        const persistence = safeGet(ctx, 'sessionPersistence')
        if (persistence !== undefined && typeof persistence.flush === 'function') {
          await persistence.flush()
        }
      }
    } catch (error) {
      log('warn', `session flush before archiving failed: ${errorText(error)}`)
    }
    for (const item of batch) {
      try {
        const result = engine.archiveSession(item.cwd, item.id)
        if (result.archived) log('debug', `archived live session ${item.id}`)
        else if (result.reason !== 'up-to-date') log('debug', `archive skipped for ${item.id}: ${result.reason}`)
      } catch (error) {
        log('warn', `could not archive session ${item.id}: ${errorText(error)}`)
      }
    }
    draining = false
    if (pending.size > 0) {
      // Events arrived while draining; run another pass soon.
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      drainTimer = setTimeout(() => {
        drainTimer = undefined
        void drain()
      }, Math.max(50, config.archiveDebounceMs))
      if (typeof drainTimer.unref === 'function') drainTimer.unref()
    }
  }

  if (config.archiveOnEvent) {
    ctx.on('session/event', (session) => schedule(session, config.archiveDebounceMs))
    ctx.on('session/flush', (session) => schedule(session, Math.max(50, Math.trunc(config.archiveDebounceMs / 2))))
    ctx.on('session/disposed', (session) => schedule(session, 0))
  }

  // Flush any queued archive work on teardown. Best effort: the app may be
  // exiting, so never throw from the disposer.
  try {
    ctx.effect(() => () => {
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      drainTimer = undefined
      if (pending.size === 0) return
      const batch = [...pending.values()]
      pending.clear()
      for (const item of batch) {
        try {
          engine.archiveSession(item.cwd, item.id)
        } catch {
          // Shutdown path: nothing useful to do.
        }
      }
    })
  } catch {
    // `ctx.effect` is optional in minimal embedders.
  }

  // ---------------------------------------------------------------------
  // 4. Agent tool.
  // ---------------------------------------------------------------------
  try {
    ctx.inject(['tools'], async (child) => {
      // Zero-dependency tool registration: the definition matches the shape
      // defineTool() produces (a JSON-Schema object root plus a canonical
      // output declaration), so the plugin never imports a harness package it
      // cannot resolve from its installation location.
      const tool = {
        name: 'workspace_sync',
        description: [
          'Manage dsh-easy-sync for a workspace: archive its conversations into <workspace>/.dsh-sync and restore archived conversations into this device.',
          'Actions: status (default), enable, disable, sync (archive + restore now), restore (restore only).',
          'Use `path` to name the workspace explicitly; it defaults to the current session workspace.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'enable', 'disable', 'sync', 'restore'],
              description: 'Operation to perform; defaults to status.',
            },
            path: {
              type: 'string',
              description: 'Absolute workspace directory. Defaults to the current session workspace.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          try {
            return await runToolAction(args ?? {}, {
              engine,
              ctx,
              log,
              registerWorkspaces: config.registerWorkspaces,
              startupSynced,
              defaultPath: sessionCwd(exec),
            })
          } catch (error) {
            return `dsh-easy-sync error: ${errorText(error)}`
          }
        },
      }
      child.tools.register(tool)
      log('debug', 'registered workspace_sync tool')
      writeStartupSnapshot(config, 'tools', { phase: 'tools', registered: [tool.name] })
    })
  } catch (error) {
    log('debug', `tools service is unavailable: ${errorText(error)}`)
  }

  // ---------------------------------------------------------------------
  // 5. Web routes for the optional desktop client menu.
  // ---------------------------------------------------------------------
  try {
    ctx.inject(['webServer', 'connection'], (child) => {
      try {
        const routes = registerWebRoutes(child, {
          engine,
          log,
          onWorkspaceEnabled: async (workspace) => {
            // The session menu and the sidebar panel can opt a workspace in
            // from the browser; make it visible in the registry immediately.
            if (typeof workspace?.path === 'string') startupSynced.add(pathKey(workspace.path))
            const registry = safeGet(ctx, 'workspaceRegistry')
            if (registry === undefined || registry === null) return
            try {
              await reconcileWithRegistry(registry, engine, {
                log,
                registerWorkspaces: config.registerWorkspaces,
                startupSynced,
              })
            } catch (error) {
              log('warn', `registry reconciliation after enable failed: ${errorText(error)}`)
            }
          },
          onRegistered: (paths) => {
            log('debug', `registered web route(s): ${paths.join(', ')}`)
            writeStartupSnapshot(config, 'web', { phase: 'web', routes: paths })
          },
        })
        if (routes.length === 0) {
          log('debug', 'web server is present but refused the dsh-easy-sync routes')
        }
      } catch (error) {
        log('warn', `web routes could not be registered: ${errorText(error)}`)
      }
    })
  } catch (error) {
    log('debug', `web routes unavailable: ${errorText(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Late workspace discovery
// ---------------------------------------------------------------------------

/**
 * Watch for workspaces opened after boot (for example the first time a synced
 * project is opened on a new device). The registry emits no workspace events,
 * so a cheap marker probe is polled instead.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} registry
 * @param {SyncEngine} engine
 * @param {{
 *   log: ReturnType<typeof createLogger>,
 *   registerWorkspaces: boolean,
 *   startupSynced: Set<string>,
 *   pollMs: number,
 *   markerName: string,
 * }} options
 */
function startWorkspacePoller(ctx, registry, engine, options) {
  if (options.pollMs <= 0 || registry === undefined || registry === null) return
  let busy = false
  const probe = async () => {
    if (busy) return
    busy = true
    try {
      const list = typeof registry.list === 'function' ? registry.list() : []
      const candidates = []
      for (const workspace of list) {
        if (typeof workspace?.path !== 'string') continue
        if (options.startupSynced.has(pathKey(workspace.path))) continue
        if (!hasMarker(workspace.path, options.markerName)) continue
        candidates.push(workspace.path)
      }
      if (candidates.length === 0) return
      options.log('info', `discovered ${candidates.length} newly opened sync workspace(s); syncing`)
      await reconcileWithRegistry(registry, engine, {
        log: options.log,
        registerWorkspaces: options.registerWorkspaces,
        startupSynced: options.startupSynced,
      })
    } catch (error) {
      options.log('debug', `workspace poll failed: ${errorText(error)}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => {
    void probe()
  }, options.pollMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    ctx.effect(() => () => clearInterval(timer))
  } catch {
    // Minimal embedder without effects: the timer is unref'd and harmless.
  }
}

// ---------------------------------------------------------------------------
// Registry reconciliation
// ---------------------------------------------------------------------------

/**
 * Register marker-backed workspaces, attach their local sessions to the
 * registry, and reconcile workspaces first seen after activation.
 *
 * @param {any} registry
 * @param {SyncEngine} engine
 * @param {{
 *   log: ReturnType<typeof createLogger>,
 *   registerWorkspaces: boolean,
 *   startupSynced: Set<string>,
 *   attachErrors?: string[],
 * }} options
 */
async function reconcileWithRegistry(registry, engine, options) {
  if (registry === undefined || registry === null) return
  const current = typeof registry.list === 'function' ? registry.list() : []
  const registryPaths = current.map((workspace) => workspace.path).filter((path) => typeof path === 'string')
  engine.refreshWorkspaces({ registryPaths })
  const report = emptyReport()

  for (const workspace of engine.listWorkspaces()) {
    try {
      let record = await findWorkspaceRecord(registry, workspace.path)
      if (record === undefined && options.registerWorkspaces && typeof registry.create === 'function') {
        record = await registry.create(workspace.path, workspace.title)
        options.log('info', `registered workspace ${workspace.path}`)
      }
      if (record === undefined) continue

      if (!options.startupSynced.has(pathKey(workspace.path))) {
        const workspaceReport = engine.syncWorkspace(workspace, { restore: true, archive: true })
        options.startupSynced.add(pathKey(workspace.path))
        for (const key of ['restored', 'archived', 'repaired', 'warnings']) report[key].push(...workspaceReport[key])
      }

      await attachLocalSessions(record, workspace, engine, options.log, options.attachErrors)
    } catch (error) {
      options.log('warn', `workspace ${workspace.path} reconciliation failed: ${errorText(error)}`)
    }
  }

  if (report.restored.length > 0) {
    options.log('info', `late-restored ${report.restored.length} session(s) for newly registered workspace(s)`)
  }
}

/**
 * Attach every local session of one workspace that the registry does not yet
 * account for. This is what makes a late restore visible without a restart.
 *
 * @param {any} record
 * @param {{ path: string }} workspace
 * @param {SyncEngine} engine
 * @param {string[]} [errors] collects attach failures for diagnostics
 */
async function attachLocalSessions(record, workspace, engine, log, errors) {
  if (record === undefined || typeof record.attachSession !== 'function') return
  const localEntries = engine.listLocalEntries(/** @type {any} */ (workspace), emptyReport())
  const known = new Set(Array.isArray(record.sessionIds) ? record.sessionIds.map(String) : [])
  for (const id of localEntries.keys()) {
    if (known.has(id)) continue
    try {
      await record.attachSession(id)
      known.add(id)
      log('debug', `attached session ${id} to workspace ${workspace.path}`)
    } catch (error) {
      const message = `could not attach session ${id} to workspace ${workspace.path}: ${errorText(error)}`
      if (Array.isArray(errors)) errors.push(message)
      log('warn', message)
    }
  }
}

/** @returns {Promise<any | undefined>} */
async function findWorkspaceRecord(registry, path) {
  if (registry === undefined || registry === null) return undefined
  try {
    if (typeof registry.resolveByPath === 'function') {
      const resolved = await registry.resolveByPath(path)
      if (resolved !== undefined) return resolved
    }
  } catch {
    // Fall through to the synchronous projection.
  }
  if (typeof registry.list !== 'function') return undefined
  try {
    return registry.list().find((workspace) => samePath(workspace.path, path))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/**
 * @param {{ action?: string, path?: string }} args
 * @param {{
 *   engine: SyncEngine,
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   log: ReturnType<typeof createLogger>,
 *   registerWorkspaces: boolean,
 *   startupSynced: Set<string>,
 *   defaultPath?: string,
 * }} deps
 * @returns {Promise<string>}
 */
async function runToolAction(args, deps) {
  const { engine, ctx, log, registerWorkspaces, startupSynced } = deps
  const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'status'
  const targetPath = typeof args.path === 'string' && args.path.trim() !== ''
    ? resolve(args.path.trim())
    : (typeof deps.defaultPath === 'string' && deps.defaultPath !== '' ? resolve(deps.defaultPath) : undefined)

  const refresh = async () => {
    const registry = safeGet(ctx, 'workspaceRegistry')
    const paths = registry !== undefined && typeof registry.list === 'function'
      ? registry.list().map((workspace) => workspace.path)
      : []
    engine.refreshWorkspaces({ registryPaths: paths })
    return registry
  }

  if (action === 'status') {
    await refresh()
    return formatStatus(engine.status())
  }

  if (action === 'enable') {
    if (targetPath === undefined) return 'dsh-easy-sync: enable needs an absolute workspace `path`.'
    const registryBefore = safeGet(ctx, 'workspaceRegistry')
    const registryPaths = registryBefore !== undefined && typeof registryBefore.list === 'function'
      ? registryBefore.list().map((workspace) => workspace.path).filter((item) => typeof item === 'string')
      : []
    const result = engine.enable(targetPath, { note: 'enabled from workspace_sync tool', registryPaths })
    const registry = await refresh()
    if (registry !== undefined) {
      await reconcileWithRegistry(registry, engine, { log, registerWorkspaces, startupSynced })
    }
    const lines = [
      `dsh-easy-sync: enabled ${result.workspace.path}`,
      `marker: ${result.markerCreated ? 'created' : 'already present'}`,
      `archive: ${result.workspace.archive}`,
      summarizeReport(result.report),
    ].filter(Boolean)
    return lines.join('\n')
  }

  if (action === 'disable') {
    if (targetPath === undefined) return 'dsh-easy-sync: disable needs an absolute workspace `path`.'
    const removed = engine.disable(targetPath)
    return removed
      ? `dsh-easy-sync: disabled ${targetPath}. The archive under .dsh-sync was kept.`
      : `dsh-easy-sync: ${targetPath} was not enabled.`
  }

  if (action === 'sync' || action === 'restore') {
    const registry = await refresh()
    const restoreOnly = action === 'restore'
    /** @type {ReturnType<typeof emptyReport>} */
    const report = emptyReport()
    const workspaces = targetPath === undefined
      ? engine.listWorkspaces()
      : [engine.workspaceForCwd(targetPath)].filter(Boolean)
    if (workspaces.length === 0) {
      return targetPath === undefined
        ? 'dsh-easy-sync: no sync workspaces are enabled.'
        : `dsh-easy-sync: ${targetPath} is not an enabled sync workspace. Use action "enable" first.`
    }
    for (const workspace of workspaces) {
      const workspaceReport = engine.syncWorkspace(workspace, { restore: true, archive: !restoreOnly })
      for (const key of ['restored', 'archived', 'repaired', 'warnings']) report[key].push(...workspaceReport[key])
    }
    if (registry !== undefined) {
      await reconcileWithRegistry(registry, engine, { log, registerWorkspaces, startupSynced })
    }
    const header = restoreOnly ? 'restore complete' : 'sync complete'
    return [`dsh-easy-sync: ${header}`, summarizeReport(report)].filter(Boolean).join('\n')
  }

  return `dsh-easy-sync: unknown action "${action}". Use status, enable, disable, sync, or restore.`
}

/** Human-readable status text. */
function formatStatus(status) {
  const lines = [
    `dsh-easy-sync status`,
    `  harness home : ${status.home}`,
    `  sessions root: ${status.sessionsRoot}`,
    `  encoding     : ${status.encoding}`,
    `  workspaces   : ${status.workspaces.length}`,
  ]
  if (status.workspaces.length === 0) {
    lines.push('  (no sync workspaces; opt one in with action "enable" and an absolute path)')
  }
  for (const workspace of status.workspaces) {
    lines.push(
      `  - ${workspace.path}`,
      `      archive: ${workspace.archive} (${workspace.archiveSessions} session(s), ${formatBytes(workspace.archivedBytes)})`,
      `      local  : ${workspace.localSessions} session(s)`,
    )
  }
  return lines.join('\n')
}

/** One-line report summary. */
function summarizeReport(report) {
  const parts = []
  if (report.restored.length > 0) parts.push(`restored ${report.restored.length}`)
  if (report.archived.length > 0) parts.push(`archived ${report.archived.length}`)
  if (report.repaired.length > 0) parts.push(`repaired ${report.repaired.length}`)
  if (report.conflicts.length > 0) parts.push(`conflicts ${report.conflicts.length}`)
  if (report.warnings.length > 0) parts.push(`warnings ${report.warnings.length}`)
  const summary = parts.length === 0 ? 'no changes' : parts.join(', ')
  const warnings = report.warnings.slice(0, 3)
  return warnings.length === 0 ? `  ${summary}` : `  ${summary}\n  warnings: ${warnings.join(' | ')}`
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a cordis service without initializing it when absent.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} name
 * @returns {any}
 */
function safeGet(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    // Service not registered.
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Whether a session id currently has a live Session in this process.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id
 * @returns {boolean}
 */
function isSessionLive(ctx, id) {
  const sessions = safeGet(ctx, 'sessions')
  if (sessions === undefined) return false
  try {
    if (typeof sessions.get === 'function') return sessions.get(id) !== undefined
    if (typeof sessions.list === 'function') return sessions.list().some((session) => session?.id === id)
  } catch {
    return false
  }
  return false
}

/**
 * Structured logger that keeps working even when the host exposes no logger.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {'silent'|'error'|'warn'|'info'|'debug'} level
 */
function createLogger(ctx, level) {
  const ranks = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
  const threshold = ranks[level] ?? ranks.info
  let named
  try {
    // cordis exposes `ctx.logger(name)`; the harness ships no exporter, so the
    // stderr fallback below is what a human actually sees during debugging.
    named = typeof ctx?.logger === 'function' ? ctx.logger('dsh-easy-sync') : ctx?.logger
  } catch {
    named = undefined
  }
  const emit = (kind, message) => {
    if (ranks[kind] > threshold) return
    const prefix = `[dsh-easy-sync] ${message}`
    let delivered = false
    try {
      if (named !== undefined && named !== null && typeof named[kind] === 'function') {
        named[kind](message)
        delivered = true
      }
    } catch {
      delivered = false
    }
    if (!delivered || kind === 'warn' || kind === 'error') {
      const write = kind === 'debug' ? console.log : (console[kind] ?? console.log)
      try {
        write.call(console, prefix)
      } catch {
        // Logging must never break the plugin.
      }
    }
  }
  return (kind, message) => emit(kind, message)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort cwd of the session driving a tool call. The field is optional in
 * the execution context, so every hop is guarded.
 *
 * @param {any} exec
 * @returns {string | undefined}
 */
function sessionCwd(exec) {
  try {
    const header = exec?.agent?.session?.header
    if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
    const cwd = exec?.agent?.session?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    // Unknown execution shape.
  }
  return undefined
}

/**
 * Persist a small diagnostic snapshot while running at debug level. Users can
 * inspect `<DSH_HOME>/dsh-easy-sync/<name>.json` to see what the plugin
 * discovered during boot without attaching a debugger.
 *
 * @param {{ home: string, logLevel: string }} config
 * @param {string} name
 * @param {Record<string, unknown>} snapshot
 */
function writeStartupSnapshot(config, name, snapshot) {
  if (config.logLevel !== 'debug') return
  try {
    const dir = stateDir(config.home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${name}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), ...snapshot }, null, 2)}\n`,
    )
  } catch {
    // Diagnostics must never break boot.
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
