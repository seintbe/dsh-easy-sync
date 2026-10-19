// End-to-end test: boot the real harness with an isolated DSH_HOME, a throwaway
// profile that loads this repository as a bundle, and a sync workspace whose
// archive already contains a conversation recorded on "another device".
//
// This starts the web app, so it is opt-in: set DSH_E2E=1. It skips itself when
// the real profiles directory cannot be found.
//
// What it proves that unit tests cannot:
//   * the bundle patch loads this plugin inside the real boot order;
//   * a session archived under a foreign cwd is restored into the canonical
//     local project directory with this device's cwd during plugin activation;
//   * the workspace registry registers the marker workspace and attaches the
//     restored session before the user opens anything;
//   * the archive is not rewritten by a restore.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodeSegment, generationLogFilename, sessionDir } from '../src/paths.js'
import { encodeSessionLog, inspectSessionFile } from '../src/session-file.js'
import { ACTION_ROUTE, INFO_ROUTE } from '../src/web-routes.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = process.env.DSH_BIN || (process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const realProfiles = process.env.DSH_REAL_PROFILES || join(homedir(), '.dsh', 'profiles')

const SESSION_ID = 'session-e2e-1111-2222-3333-444444444444'
const FOREIGN_CWD = 'E:\\other-device\\projects\\demo'
// Some installations still write logical format v3; the plugin restores the
// archived generation as-is, so the test archive must match the installed dsh.
const HEADER_VERSION = Number(process.env.DSH_E2E_HEADER_VERSION ?? 3)
const GENERATION = generationLogFilename(HEADER_VERSION, 'zstd')

function canRun() {
  return process.env.DSH_E2E === '1' && existsSync(realProfiles)
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-easy-sync-e2e-'))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'e2e')
  const modules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })

  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, '.dsh-sync.json'), '{"version":1}\n')

  const events = Array.from({ length: 5 }, (_, index) => ({
    type: 'permission/preset',
    seq: index,
    time: 1_700_000_000_000 + index,
    data: { preset: 'danger-full-access' },
  }))
  const archiveDir = join(workspace, '.dsh-sync', 'sessions', encodeSegment(SESSION_ID))
  mkdirSync(archiveDir, { recursive: true })
  const archiveFile = join(archiveDir, GENERATION)
  writeFileSync(
    archiveFile,
    encodeSessionLog(
      {
        header: {
          type: 'session',
          version: HEADER_VERSION,
          id: SESSION_ID,
          createdAt: 1_700_000_000_000,
          cwd: FOREIGN_CWD,
          isSeeded: false,
          delegationDepth: 0,
          agentPreset: 'standard',
        },
        events,
      },
      { compression: 'zstd' },
    ),
  )

  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-e2e',
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-easy-sync'],
            patchReload: 'startup',
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  // The workspace is configured explicitly: a fresh device has no remembered
  // workspaces or registry entries yet, which is exactly the cold-start case.
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '- id: dsh-easy-sync',
      '  config:',
      '    workspaces:',
      `      - '${workspace.replace(/\\/g, '/')}'`,
      '    logLevel: debug',
      '',
    ].join('\n'),
  )

  symlinkSync(repoRoot, join(modules, 'dsh-easy-sync'), 'junction')
  const shared = join(realProfiles, 'node_modules', '@deepseek-ai')
  if (!existsSync(shared)) throw new Error(`shared profile dependencies not found: ${shared}`)
  symlinkSync(shared, join(modules, '@deepseek-ai'), 'junction')

  return {
    root,
    home,
    workspace,
    canonicalWorkspace: realpathSync.native(workspace),
    archiveFile,
    archiveHash: createHash('sha256').update(readFileSync(archiveFile)).digest('hex'),
    events,
  }
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

async function waitFor(predicate, timeoutMs, description) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${description}`)
}

test(
  'boot restores a foreign-workspace archive and attaches it to the workspace',
  { skip: canRun() ? false : 'set DSH_E2E=1 (and install dsh) to run the end-to-end test' },
  async () => {
    const env = makeEnv()
    let child
    let output = ''
    try {
      child = spawn(dshBin, ['--profile', 'e2e', '--port', '0', '--no-open'], {
        cwd: env.root,
        env: { ...process.env, DSH_HOME: env.home, DSH_DISABLE_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })

      await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), 120_000, 'the web app to start')

      // The plugin activation must have restored the session synchronously,
      // before the registry reconciliation; the debug snapshot records that.
      const snapshotPath = join(env.home, 'dsh-easy-sync', 'startup.json')
      const snapshot = await waitFor(() => {
        if (!existsSync(snapshotPath)) return undefined
        try {
          return JSON.parse(readFileSync(snapshotPath, 'utf8'))
        } catch {
          return undefined
        }
      }, 60_000, 'the plugin activation snapshot')
      assert.equal(snapshot.phase, 'startup')
      assert.deepEqual(snapshot.report.restored, [SESSION_ID])
      assert.deepEqual(snapshot.report.warnings, [])

      const restoredFile = join(
        sessionDir(join(env.home, 'sessions'), env.canonicalWorkspace, SESSION_ID),
        GENERATION,
      )
      assert.ok(existsSync(restoredFile), 'restored file must exist at the canonical project path')
      const restored = inspectSessionFile(readFileSync(restoredFile), { compression: 'zstd' })
      assert.equal(restored.header.cwd, env.canonicalWorkspace)
      assert.equal(restored.header.id, SESSION_ID)
      assert.deepEqual(restored.events, env.events)

      const storagePath = join(env.home, 'storages', 'workspace.json')
      await waitFor(() => {
        if (!existsSync(storagePath)) return undefined
        let data
        try {
          data = JSON.parse(readFileSync(storagePath, 'utf8'))
        } catch {
          return undefined
        }
        const records = Object.values(data.tables?.workspaces ?? {})
        const record = records.find((candidate) => candidate?.path === env.canonicalWorkspace)
        return record !== undefined && Array.isArray(record.sessionIds) && record.sessionIds.includes(SESSION_ID)
          ? record
          : undefined
      }, 60_000, 'the workspace registry to record the workspace and its session')

      const toolsSnapshotPath = join(env.home, 'dsh-easy-sync', 'tools.json')
      const toolsSnapshot = await waitFor(() => {
        if (!existsSync(toolsSnapshotPath)) return undefined
        try {
          return JSON.parse(readFileSync(toolsSnapshotPath, 'utf8'))
        } catch {
          return undefined
        }
      }, 30_000, 'the workspace_sync tool to register')
      assert.deepEqual(toolsSnapshot.registered, ['workspace_sync'])

      const webSnapshotPath = join(env.home, 'dsh-easy-sync', 'web.json')
      const webSnapshot = await waitFor(() => {
        if (!existsSync(webSnapshotPath)) return undefined
        try {
          return JSON.parse(readFileSync(webSnapshotPath, 'utf8'))
        } catch {
          return undefined
        }
      }, 30_000, 'the client-menu web routes to register')
      assert.deepEqual(webSnapshot.routes, [INFO_ROUTE, ACTION_ROUTE])

      // Prove the client half is actually served by the real web client module
      // system: the shell HTML carries the boot graph, and one served script
      // contains our ModuleLoader registration. This is host-side only; it does
      // not execute the browser code (that needs the desktop app).
      const urlMatch = output.match(/http:\/\/127\.0\.0\.1:\d+\/?\S*/)
      assert.ok(urlMatch, `web URL missing from output: ${output.slice(-400)}`)
      const pageUrl = new URL(urlMatch[0])
      // The tokenized URL sets the login cookie and redirects; Node fetch drops
      // Set-Cookie across redirects, so capture it explicitly.
      const first = await fetch(pageUrl, { redirect: 'manual', headers: { accept: 'text/html' } })
      const cookie = first.headers.getSetCookie?.()[0]?.split(';')[0]
        ?? first.headers.get('set-cookie')?.split(';')[0]
      const location = first.headers.get('location')
      const indexResponse = first.status >= 300 && first.status < 400
        ? await fetch(new URL(location ?? '/', pageUrl), { headers: cookie === undefined ? {} : { cookie } })
        : first
      const html = await indexResponse.text()
      if (!html.includes('dsh-easy-sync')) {
        process.stderr.write(`[e2e-debug] first=${first.status} index=${indexResponse.status} length=${html.length}\n${html.slice(0, 1200)}\n`)
      }
      assert.ok(html.includes('dsh-easy-sync'), 'boot graph must contain the client half')
      const assetUrls = new Set()
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assetUrls.add(match[1].replaceAll('&amp;', '&'))
      assert.ok(assetUrls.size > 0, 'shell must reference client assets')
      const authHeaders = cookie === undefined ? {} : { cookie }
      let clientServed = false
      for (const source of assetUrls) {
        if (!/\/(?:plugins|assets)\//.test(source)) continue
        const assetUrl = new URL(source, pageUrl)
        const response = await fetch(assetUrl, { headers: authHeaders })
        const text = response.ok ? await response.text() : ''
        if (text.includes('__ModuleLoader__.load') && text.includes('sidebar.workspaces.session.menu.item')) {
          clientServed = text.includes('dsh-easy-sync')
          if (clientServed) break
        }
      }
      assert.ok(clientServed, 'the client bundle must be served by the web module system')

      const archiveHashAfter = createHash('sha256').update(readFileSync(env.archiveFile)).digest('hex')
      assert.equal(archiveHashAfter, env.archiveHash, 'restoring must not rewrite the archive')
    } catch (error) {
      const tail = output.slice(-4000)
      if (tail !== '') console.error(`--- harness output ---\n${tail}`)
      console.error(`test directory: ${env.root}`)
      throw error
    } finally {
      if (child !== undefined) killTree(child)
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (process.env.DSH_E2E_KEEP !== '1') rmSync(env.root, { recursive: true, force: true })
    }
  },
)
