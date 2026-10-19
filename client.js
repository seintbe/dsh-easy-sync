// dsh-easy-sync client half (desktop web client).
//
// Built by hand in the DSH client-module format: the shell executes this file,
// which only REGISTERS a factory; the factory materializes when the plugin is
// imported and receives the shell's synchronous `require`.
//
// It adds two entries to the session row menu (the "..." menu, also used for
// right-click rows) on hosts that declare `sidebar.workspaces.session.menu.item`
// (DSH desktop 0.2.x). Hosts without that slot simply never render the entries.
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

    // Keep in sync with INFO_ROUTE / ACTION_ROUTE in src/web-routes.js.
    const INFO_ROUTE = '/dsh-easy-sync/session'
    const ACTION_ROUTE = '/dsh-easy-sync/session-action'
    const SLOT = 'sidebar.workspaces.session.menu.item'
    const NS = 'dsh-easy-sync'

    const zh = {
      'menu.sync': '同步此工作区',
      'menu.restore': '从存档恢复',
      'menu.busy': '同步中…',
      'menu.done': '已同步',
      'menu.failed': '同步失败',
    }
    const en = {
      'menu.sync': 'Sync this workspace',
      'menu.restore': 'Restore from archive',
      'menu.busy': 'Syncing…',
      'menu.done': 'Synced',
      'menu.failed': 'Sync failed',
    }

    /**
     * Ask the host whether this session's workspace is a sync workspace.
     * @param {string} sessionId
     * @returns {{ status: 'loading' | 'hidden' | 'ready', workspace?: { path: string, title: string } }}
     */
    function useWorkspaceInfo(sessionId) {
      const [info, setInfo] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        fetch(`${INFO_ROUTE}?sessionId=${encodeURIComponent(String(sessionId ?? ''))}`, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : { enabled: false }))
          .then((payload) => {
            if (cancelled) return
            if (payload !== null && typeof payload === 'object' && payload.enabled === true && payload.workspace) {
              setInfo({ status: 'ready', workspace: payload.workspace })
            } else {
              setInfo({ status: 'hidden' })
            }
          })
          .catch(() => {
            if (!cancelled) setInfo({ status: 'hidden' })
          })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [sessionId])
      return info
    }

    /**
     * One session-row menu entry bound to one host action.
     * @param {'sync' | 'restore'} action
     * @param {string} labelKey
     */
    function createMenuItem(action, labelKey) {
      return function SessionSyncMenuItem(props) {
        const { sessionId, useMenuOpenState, t } = props
        const info = useWorkspaceInfo(sessionId)
        const [state, setState] = React.useState('idle')
        const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
        const closeMenu = () => {
          if (Array.isArray(menuState) && typeof menuState[1] === 'function') menuState[1](false)
        }
        if (info.status !== 'ready') return null
        const run = async () => {
          if (state === 'busy' || state === 'done') return
          setState('busy')
          try {
            const response = await fetch(ACTION_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, action }),
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${String(response.status)}`)
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

    /**
     * Client plugin body: register dictionaries, then the two menu entries.
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
      try {
        const slots = ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
        slots.inject(SLOT, () => slots.register({
          name: SLOT,
          id: 'dsh-easy-sync:sync',
          order: 500,
          locale: NS,
        }, createMenuItem('sync', 'menu.sync')))
        slots.inject(SLOT, () => slots.register({
          name: SLOT,
          id: 'dsh-easy-sync:restore',
          order: 510,
          locale: NS,
        }, createMenuItem('restore', 'menu.restore')))
      } catch (error) {
        // Older shells do not declare this slot; the agent tool still works.
        console.warn('[dsh-easy-sync] session menu slot unavailable', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
