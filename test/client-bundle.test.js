import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { ACTION_ROUTE, INFO_ROUTE, WORKSPACES_ROUTE, WORKSPACE_ACTION_ROUTE } from '../src/web-routes.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(join(root, 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function loadBundle() {
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(registration, 'client.js must register with the module loader')
  const react = {
    Fragment: function Fragment() {},
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
  }
  const primitives = {
    MenuItemButton: function MenuItemButton() {},
    Button: function Button() {},
    Switch: function Switch() {},
    Modal: function Modal() {},
    Tooltip: function Tooltip() {},
  }
  const require = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return { jsx: () => ({}) }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${specifier}`)
  }
  return registration.factory(require)
}

test('package declares the web client half next to the host bundle', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('client.js'))
})

test('client bundle registers session menu entries and the sidebar footer action', () => {
  const exported = loadBundle()
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(Array.from(exported.inject), ['slots', 'locale'])

  const dictionaries = []
  const registrations = []
  const injects = []
  const ctx = {
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    effect(callback) {
      callback()
      return () => {}
    },
    slots: {
      inject(slot, callback) {
        injects.push(slot)
        callback()
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'dsh-easy-sync')
  assert.equal(dictionaries[0].dicts.zh['menu.sync'], '同步此工作区')
  assert.equal(dictionaries[0].dicts.zh['menu.enable'], '启用此工作区同步')
  assert.equal(dictionaries[0].dicts.en['menu.restore'], 'Restore from archive')
  assert.equal(dictionaries[0].dicts.en['footer.label'], 'Easy Sync')

  assert.deepEqual(injects, [
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.menu.item',
    'sidebar.footer.action',
  ])
  assert.deepEqual(registrations.map((entry) => entry.definition.id), [
    'dsh-easy-sync:sync',
    'dsh-easy-sync:restore',
    'dsh-easy-sync:enable',
    'dsh-easy-sync',
  ])
  assert.deepEqual(registrations.map((entry) => entry.definition.order), [500, 510, 520, 500])
  assert.ok(registrations.every((entry) => entry.definition.locale === 'dsh-easy-sync'))
  assert.ok(registrations.every((entry) => typeof entry.component === 'function'))
})

test('client bundle uses the same route constants as the host', () => {
  assert.ok(source.includes(INFO_ROUTE), 'client must query the host info route')
  assert.ok(source.includes(ACTION_ROUTE), 'client must post to the host action route')
  assert.ok(source.includes(WORKSPACES_ROUTE), 'client must list workspaces through the host')
  assert.ok(source.includes(WORKSPACE_ACTION_ROUTE), 'client must post workspace actions')
  assert.ok(source.includes('sidebar.workspaces.session.menu.item'))
  assert.ok(source.includes('sidebar.footer.action'))
})
