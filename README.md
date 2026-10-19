# dsh-easy-sync

**Workspace-scoped conversation sync for DeepSeek Harness.**

DSH keeps conversations in `<DSH_HOME>/sessions/`, outside the project directory.
If you sync project files between machines but want those conversations to follow
the workspace too, this plugin archives every session of an opted-in workspace
inside the workspace itself and restores it on the next start.

- Opt a workspace in with a marker file: `<workspace>/.dsh-sync.json`.
- All sessions of that workspace are archived under `<workspace>/.dsh-sync/sessions/`.
- On every start the archive is reconciled inside plugin activation, without
  depending on workspace-registry load order. Workspace paths recorded in
  `<DSH_HOME>/storages/workspace.json` are honored, so a device that opened the
  workspace once restores before the GUI loads.
- Restored logs get their header `cwd` rewritten to the local workspace path, so
  machines may use different absolute paths for the same synced workspace.
- Restored sessions are attached to the workspace registry immediately, so they
  appear in the sidebar without a second restart.
- While running, live sessions are debounce-archived after a persistence flush.

Chinese documentation: [README.zh.md](README.zh.md).

## Install

Requirements: Node.js ≥ 22.15 (for `node:zlib` zstd support), DSH 0.1.5+.
The plugin has no third-party runtime dependencies.

### CLI-managed profiles

```powershell
dsh plugin --profile web add C:\path\to\dsh-easy-sync
```

### Desktop app (`desktop` profile, Electron-managed)

The desktop profile cannot be managed by `dsh plugin`; use the bundled script
then fully quit and reopen the app:

```powershell
pwsh -File .\scripts\install-desktop.ps1
pwsh -File .\scripts\install-desktop.ps1 -Remove   # uninstall
```

If the app exposes its own plugin manager, prefer it; the script is the
CLI-free fallback and backs up `package.json` before editing.

On macOS/Linux use the bash equivalent:

```bash
bash scripts/install-desktop.sh     # quit the app first
bash scripts/install-desktop.sh -r  # uninstall
```

See [README.zh.md](README.zh.md) for moving the repository to another device
(`git bundle`) and the manual three-step install.

## Use

Ask the agent, or call the tool directly:

```jsonc
{ "action": "enable", "path": "D:\\projects\\my-app" }  // opt in + archive now
{ "action": "status" }                                  // show workspaces/archives
{ "action": "sync", "path": "D:\\projects\\my-app" }    // archive + restore now
{ "action": "restore", "path": "D:\\projects\\my-app" } // restore only
{ "action": "disable", "path": "D:\\projects\\my-app" } // stop syncing, keep archive
```

Manual opt-in: create `<workspace>/.dsh-sync.json` containing `{"version":1}`.
See [README.zh.md](README.zh.md) for configuration, sync policy, conflicts and
design notes.

## Diagnostics

DSH ships no logger exporter today, so the plugin writes `warn`/`error` lines to
stderr and, with `logLevel: debug`, drops snapshots into
`<DSH_HOME>/dsh-easy-sync/`:

- `startup.json` — discovered workspaces plus the restore/archive report;
- `registry.json` — registry-visible workspaces, attach results/errors;
- `tools.json` — whether `workspace_sync` registered.

## Version compatibility

Session logs carry a physical generation version (for example
`session.v4.jsonl.zstd`). Restores preserve the archived version and never
migrate or downgrade it, so install the same DSH version on every device. A
desktop runtime and a CLI installed side by side may disagree (v4 vs v3) and
then refuse each other's logs.

## Test

```powershell
npm test          # unit tests
$env:DSH_E2E='1'; npm run test:e2e   # real dsh web boot, isolated DSH_HOME
```

The end-to-end test proves activation-time restore, header cwd rewriting,
workspace registration/attachment and tool registration against the real
harness; it never touches the real `~/.dsh` (only reads shared profile deps).

## License

MIT
