// Session-root path grammar, mirrored exactly from the shipped JSONL session
// persistence backend (@deepseek-ai/dsh-session-persistence-jsonl). The backend
// refuses to open a stored session unless the physical log path equals the path
// derived from the header's `id` and `cwd`, so restore must reproduce these two
// encodings byte-for-byte.
//
// Keep this module dependency-free and synchronous: it is imported by the
// plugin entry before any service is available.

import { join } from 'node:path'

/** Current logical session format version used by the shipped backend. */
export const SESSION_FORMAT_VERSION = 4

/**
 * Encode an arbitrary string as one injective, filesystem-safe path segment.
 * Mirrors the backend's `encodeSegment`: `[A-Za-z0-9._-]` stays literal, every
 * other UTF-16 code unit becomes `~XXXX`; `.` and `..` are special-cased.
 *
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('cannot encode an empty path segment')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the human-readable project directory key for a cwd. Mirrors the
 * backend's `projectKey`: runs of `/`, `\` and `:` collapse to one `-`, other
 * unsafe units use the `~XXXX` escape, and the whole name is bounded.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cannot encode an empty project path')
  }
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Project directory under a session root.
 *
 * @param {string} root
 * @param {string | undefined} cwd
 * @returns {string}
 */
export function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

/**
 * Session-owned directory beneath its project directory.
 *
 * @param {string} root
 * @param {string | undefined} cwd
 * @param {string} id
 * @returns {string}
 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/**
 * One immutable session generation filename.
 *
 * @param {number} version
 * @param {'zstd' | 'none'} compression
 * @returns {string}
 */
export function generationLogFilename(version, compression) {
  return `session${version === 0 ? '' : `.v${version}`}.jsonl${compression === 'zstd' ? '.zstd' : ''}`
}

/**
 * Parse a generation filename. Returns `undefined` for anything else, so
 * unrelated artifacts in a session directory are ignored.
 *
 * @param {string} name
 * @returns {{ version: number, compression: 'zstd' | 'none' } | undefined}
 */
export function parseGenerationLogFilename(name) {
  if (typeof name !== 'string') return undefined
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
  if (match === null) return undefined
  const version = match[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(version) || version < 0) return undefined
  return { version, compression: match[2] === '.zstd' ? 'zstd' : 'none' }
}

/**
 * Pick the generation the backend would select: the numerically highest
 * canonical generation.
 *
 * @param {Iterable<string>} names
 * @returns {string | undefined}
 */
export function newestGenerationName(names) {
  let best
  let bestVersion = -1
  for (const name of names) {
    const parsed = parseGenerationLogFilename(name)
    if (parsed === undefined) continue
    if (parsed.version > bestVersion) {
      best = name
      bestVersion = parsed.version
    }
  }
  return best
}
