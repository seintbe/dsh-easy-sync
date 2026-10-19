// dsh-easy-sync client half (desktop web client).
//
// Built by hand in the DSH client-module format: the shell executes this file,
// which only REGISTERS a factory; the factory materializes when the plugin is
// imported and receives the shell's synchronous `require`.
//
// Surface on DSH desktop 0.2.x (older shells degrade silently):
//   * session row "..." menu: sync / restore for sync workspaces, and a
//     one-click "enable this workspace" for sessions of workspaces not opted in
//     yet (`sidebar.workspaces.session.menu.item`);
//   * sidebar footer: an "Easy Sync" button opening a workspace list where each
//     row has a sync switch, including workspaces with no session yet
//     (`sidebar.footer.action`).
//
// All real work happens through the host routes in src/web-routes.js.

window.__ModuleLoader__.load({
  id: 'dsh-easy-sync',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    // Keep in sync with the route constants in src/web-routes.js.
    const INFO_ROUTE = '/dsh-easy-sync/session'
    const ACTION_ROUTE = '/dsh-easy-sync/session-action'
    const WORKSPACES_ROUTE = '/dsh-easy-sync/workspaces'
    const WORKSPACE_ACTION_ROUTE = '/dsh-easy-sync/workspace-action'
    const SLOT = 'sidebar.workspaces.session.menu.item'
    const FOOTER_SLOT = 'sidebar.footer.action'
    const NS = 'dsh-easy-sync'

    const zh = {
      'menu.sync': '同步此工作区',
      'menu.restore': '从存档恢复',
      'menu.enable': '启用此工作区同步',
      'menu.busy': '同步中…',
      'menu.enabling': '正在启用…',
      'menu.done': '已同步',
      'menu.enabled': '已启用',
      'menu.failed': '操作失败',
      'footer.label': 'Easy Sync',
      'panel.title': 'Easy Sync 工作区',
      'panel.hint': '打开开关，把工作区设为同步工作区：其对话会存档到工作区的 .dsh-sync/ 里，换设备后自动恢复。',
      'panel.loading': '正在读取工作区…',
      'panel.empty': '还没有已注册的工作区。先在侧边栏打开一个工作区。',
      'panel.error': '读取失败',
      'panel.sync': '立即同步',
      'close': '关闭',
    }
    const en = {
      'menu.sync': 'Sync this workspace',
      'menu.restore': 'Restore from archive',
      'menu.enable': 'Enable sync for this workspace',
      'menu.busy': 'Syncing…',
      'menu.enabling': 'Enabling…',
      'menu.done': 'Synced',
      'menu.enabled': 'Enabled',
      'menu.failed': 'Action failed',
      'footer.label': 'Easy Sync',
      'panel.title': 'Easy Sync workspaces',
      'panel.hint': 'Turn a workspace on to archive its conversations inside <workspace>/.dsh-sync and restore them on another device.',
      'panel.loading': 'Loading workspaces…',
      'panel.empty': 'No registered workspace yet. Open one in the sidebar first.',
      'panel.error': 'Could not load',
      'panel.sync': 'Sync now',
      'close': 'Close',
    }

    /** POST JSON and reject on a non-2xx / `{ ok: false }` reply. */
    async function postJson(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${String(response.status)}`)
      }
      return payload
    }

    /** Short-lived shared cache: a menu open mounts three entries at once. */
    const infoCache = new Map()
    const INFO_TTL_MS = 10_000

    function loadWorkspaceInfo(sessionId) {
      const key = String(sessionId ?? '')
      const cached = infoCache.get(key)
      if (cached !== undefined && Date.now() - cached.at < INFO_TTL_MS) return cached.promise
      const promise = fetch(`${INFO_ROUTE}?sessionId=${encodeURIComponent(key)}`, {
        headers: { accept: 'application/json' },
      })
        .then((response) => (response.ok ? response.json() : { enabled: false }))
        .then((payload) => {
          const workspace = payload !== null && typeof payload === 'object' ? payload.workspace : null
          if (workspace !== null && typeof workspace === 'object' && typeof workspace.path === 'string') {
            return { status: 'ready', enabled: payload.enabled === true, workspace }
          }
          return { status: 'hidden' }
        })
        .catch(() => ({ status: 'hidden' }))
      infoCache.set(key, { at: Date.now(), promise })
      return promise
    }

    function forgetWorkspaceInfo(sessionId) {
      infoCache.delete(String(sessionId ?? ''))
    }

    /**
     * Ask the host which workspace this session belongs to, and whether that
     * workspace is already opted in.
     * @param {string} sessionId
     */
    function useWorkspaceInfo(sessionId) {
      const [info, setInfo] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let cancelled = false
        void loadWorkspaceInfo(sessionId).then((next) => {
          if (!cancelled) setInfo(next)
        })
        return () => {
          cancelled = true
        }
      }, [sessionId])
      return info
    }

    /** Menu open state is a hook context supplied by the sidebar. */
    function useCloseMenu(useMenuOpenState) {
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      return () => {
        if (Array.isArray(menuState) && typeof menuState[1] === 'function') menuState[1](false)
      }
    }

    /** One session-row entry bound to one host session action. */
    function createMenuItem(action, labelKey) {
      return function SessionSyncMenuItem(props) {
        const { sessionId, useMenuOpenState, t } = props
        const info = useWorkspaceInfo(sessionId)
        const [state, setState] = React.useState('idle')
        const closeMenu = useCloseMenu(useMenuOpenState)
        if (info.status !== 'ready' || info.enabled !== true) return null
        const run = async () => {
          if (state === 'busy' || state === 'done') return
          setState('busy')
          try {
            await postJson(ACTION_ROUTE, { sessionId, action })
            forgetWorkspaceInfo(sessionId)
            setState('done')
            setTimeout(closeMenu, 1000)
          } catch {
            setState('error')
          }
        }
        const label = state === 'busy'
          ? t('menu.busy')
          : state === 'done'
            ? t('menu.done')
            : state === 'error'
              ? t('menu.failed')
              : t(labelKey)
        const MenuItemButton = primitives.MenuItemButton
        if (typeof MenuItemButton !== 'function') {
          return jsx('button', { type: 'button', onClick: run, children: label })
        }
        return jsx(MenuItemButton, { onSelect: run, children: label })
      }
    }

    /** One-click opt-in for a session whose workspace is not sync yet. */
    function EnableSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, t } = props
      const info = useWorkspaceInfo(sessionId)
      const [state, setState] = React.useState('idle')
      const closeMenu = useCloseMenu(useMenuOpenState)
      if (info.status !== 'ready' || info.enabled !== false) return null
      const run = async () => {
        if (state === 'busy' || state === 'done') return
        setState('busy')
        try {
          await postJson(ACTION_ROUTE, { sessionId, action: 'enable' })
          forgetWorkspaceInfo(sessionId)
          setState('done')
          setTimeout(closeMenu, 1200)
        } catch {
          setState('error')
        }
      }
      const label = state === 'busy'
        ? t('menu.enabling')
        : state === 'done'
          ? t('menu.enabled')
          : state === 'error'
            ? t('menu.failed')
            : t('menu.enable')
      const MenuItemButton = primitives.MenuItemButton
      if (typeof MenuItemButton !== 'function') {
        return jsx('button', { type: 'button', onClick: run, children: label })
      }
      return jsx(MenuItemButton, { onSelect: run, children: label })
    }

    function ActionButton({ children, onClick, disabled }) {
      const Button = primitives.Button
      if (typeof Button === 'function') {
        return jsx(Button, { variant: 'outline', onClick, disabled, children })
      }
      return jsx('button', { type: 'button', onClick, disabled, children })
    }

    function Toggle({ checked, label, disabled, onChange }) {
      const Switch = primitives.Switch
      if (typeof Switch === 'function') {
        return jsx(Switch, { checked, label, disabled, onChange })
      }
      return jsx('input', { type: 'checkbox', checked, disabled, onChange, 'aria-label': label })
    }

    /** Modal with a self-contained fallback for shells without the primitive. */
    function ModalFrame({ title, onClose, t, children }) {
      const Modal = primitives.Modal
      if (typeof Modal === 'function') {
        return jsx(Modal, { open: true, onClose, title, closeLabel: t('close'), children })
      }
      return jsx('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'rgba(0, 0, 0, 0.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        onClick: onClose,
        children: jsx('div', {
          onClick: (event) => event.stopPropagation(),
          style: {
            background: 'Canvas',
            color: 'CanvasText',
            borderRadius: 12,
            padding: 20,
            width: 'min(640px, 90vw)',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
          },
          children: [
            jsx('div', { style: { fontWeight: 600, marginBottom: 12 }, children: title }),
            children,
          ],
        }),
      })
    }

    /** Sidebar panel: every known workspace with a sync switch. */
    function WorkspacePanel({ onClose, t }) {
      const [phase, setPhase] = React.useState('loading')
      const [workspaces, setWorkspaces] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(WORKSPACES_ROUTE, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${String(response.status)}`)
          setWorkspaces(Array.isArray(payload.workspaces) ? payload.workspaces : [])
          setPhase('ready')
          setError('')
        } catch (failure) {
          setPhase('error')
          setError(String(failure?.message ?? failure))
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const runAction = async (workspace, action) => {
        if (busy !== '') return
        setBusy(workspace.path)
        setError('')
        try {
          await postJson(WORKSPACE_ACTION_ROUTE, { path: workspace.path, action })
          await load()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }

      let body
      if (phase === 'loading') {
        body = jsx('div', { style: { opacity: 0.7 }, children: t('panel.loading') })
      } else if (phase === 'error' && workspaces.length === 0) {
        body = jsx('div', { style: { opacity: 0.7 }, children: `${t('panel.error')}: ${error}` })
      } else if (workspaces.length === 0) {
        body = jsx('div', { style: { opacity: 0.7 }, children: t('panel.empty') })
      } else {
        body = jsx('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 4 },
          children: workspaces.map((workspace) => jsx('div', {
            key: workspace.path,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 0',
              borderBottom: '1px solid rgba(127, 127, 127, 0.18)',
            },
            children: [
              jsx('div', {
                style: { flex: 1, minWidth: 0 },
                children: [
                  jsx('div', {
                    style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    children: workspace.title || workspace.path,
                  }),
                  jsx('div', {
                    style: { fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    children: workspace.path,
                  }),
                  workspace.enabled
                    ? jsx('div', {
                      style: { fontSize: 12, opacity: 0.65 },
                      children: `${String(workspace.archiveSessions ?? 0)} archived / ${String(workspace.localSessions ?? 0)} local`,
                    })
                    : null,
                ],
              }),
              workspace.enabled
                ? jsx(ActionButton, {
                  onClick: () => runAction(workspace, 'sync'),
                  disabled: busy === workspace.path,
                  children: t('panel.sync'),
                })
                : null,
              jsx(Toggle, {
                checked: workspace.enabled === true,
                label: workspace.title || workspace.path,
                disabled: busy === workspace.path,
                onChange: () => runAction(workspace, workspace.enabled ? 'disable' : 'enable'),
              }),
            ],
          })),
        })
      }

      return jsx(ModalFrame, {
        title: t('panel.title'),
        onClose,
        t,
        children: [
          jsx('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 }, children: t('panel.hint') }),
          body,
          error !== '' ? jsx('div', { style: { marginTop: 8, color: 'var(--dsh-danger, #d33)', fontSize: 12 }, children: error }) : null,
        ],
      })
    }

    /** Sidebar footer action: icon-only when the rail is narrow. */
    function EasySyncFooterAction(props) {
      const { wide, t } = props
      const [open, setOpen] = React.useState(false)
      const label = t('footer.label')
      const button = jsx('button', {
        type: 'button',
        'aria-label': label,
        title: label,
        onClick: () => setOpen(true),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          width: wide ? '100%' : 'auto',
          minWidth: 0,
          background: 'transparent',
          border: 0,
          borderRadius: 6,
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          padding: '6px 8px',
        },
        children: wide ? label : '⇅',
      })
      const Tooltip = primitives.Tooltip
      const wrapped = typeof Tooltip === 'function' ? jsx(Tooltip, { label, side: 'top', children: button }) : button
      return jsx(React.Fragment, {
        children: [wrapped, open ? jsx(WorkspacePanel, { onClose: () => setOpen(false), t }) : null],
      })
    }

    /**
     * Client plugin body: register dictionaries, the session menu entries and
     * the sidebar footer action. Each registration is isolated so an older
     * shell without one slot keeps the others working.
     * @param {any} ctx - client root context.
     */
    function apply(ctx) {
      try {
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-easy-sync: dictionaries')
          } else {
            ctx.locale.register(NS, { zh, en })
          }
        }
      } catch (error) {
        console.warn('[dsh-easy-sync] locale registration failed', error)
      }

      const slots = ctx.slots
      if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      const registerMenuItem = (id, order, component) => {
        try {
          slots.inject(SLOT, () => slots.register({ name: SLOT, id, order, locale: NS }, component))
        } catch (error) {
          // Older shells do not declare this slot; the agent tool still works.
          console.warn('[dsh-easy-sync] session menu slot unavailable', error)
        }
      }
      registerMenuItem('dsh-easy-sync:sync', 500, createMenuItem('sync', 'menu.sync'))
      registerMenuItem('dsh-easy-sync:restore', 510, createMenuItem('restore', 'menu.restore'))
      registerMenuItem('dsh-easy-sync:enable', 520, EnableSessionMenuItem)

      try {
        slots.inject(FOOTER_SLOT, () => slots.register({
          name: FOOTER_SLOT,
          id: 'dsh-easy-sync',
          order: 500,
          locale: NS,
        }, EasySyncFooterAction))
      } catch (error) {
        console.warn('[dsh-easy-sync] sidebar footer slot unavailable', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
