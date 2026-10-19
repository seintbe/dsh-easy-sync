import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  encodeSegment,
  generationLogFilename,
  newestGenerationName,
  parseGenerationLogFilename,
  projectDir,
  projectKey,
  sessionDir,
} from '../src/paths.js'

test('encodeSegment keeps safe units and escapes everything else', () => {
  assert.equal(encodeSegment('session-5dd30758-98fc-40c5-a2f0-78831544f161'), 'session-5dd30758-98fc-40c5-a2f0-78831544f161')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('a~b/c'), 'a~007Eb~002Fc')
  assert.equal(encodeSegment('中文'), '~4E2D~6587')
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

test('projectKey matches the shipped backend directory names', () => {
  assert.equal(projectKey('C:\\Users\\Seint\\Desktop\\dsh-easy-sync'), '--C-Users-Seint-Desktop-dsh-easy-sync--')
  assert.equal(projectKey('/home/me/work'), '--home-me-work--')
  assert.equal(projectKey('C:\\a\\\\b::c'), '--C-a-b-c--')
  assert.equal(projectKey('---'), '--root--')
  assert.equal(projectKey('~weird~'), '--~007Eweird~007E--')
})

test('projectDir and sessionDir follow the backend layout', () => {
  assert.equal(projectDir(join('root'), undefined), join('root', '_no-cwd'))
  assert.equal(projectDir(join('root'), '/x/y'), join('root', '--x-y--'))
  assert.equal(sessionDir(join('root'), '/x/y', 'id/1'), join('root', '--x-y--', 'id~002F1'))
})

test('generation filenames round-trip', () => {
  assert.equal(generationLogFilename(0, 'none'), 'session.jsonl')
  assert.equal(generationLogFilename(0, 'zstd'), 'session.jsonl.zstd')
  assert.equal(generationLogFilename(4, 'zstd'), 'session.v4.jsonl.zstd')
  assert.deepEqual(parseGenerationLogFilename('session.v4.jsonl.zstd'), { version: 4, compression: 'zstd' })
  assert.deepEqual(parseGenerationLogFilename('session.jsonl'), { version: 0, compression: 'none' })
  assert.equal(parseGenerationLogFilename('notes.jsonl'), undefined)
  assert.equal(parseGenerationLogFilename('session.vx.jsonl'), undefined)
  assert.equal(parseGenerationLogFilename('session.lock'), undefined)
})

test('newestGenerationName selects the highest canonical version', () => {
  const names = ['session.v2.jsonl', 'session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.lock', 'readme.txt']
  assert.equal(newestGenerationName(names), 'session.v4.jsonl.zstd')
  assert.equal(newestGenerationName(['session.lock']), undefined)
  assert.equal(newestGenerationName([]), undefined)
})
