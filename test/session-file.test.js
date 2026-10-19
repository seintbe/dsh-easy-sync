// Tests for the session-log container codec.
//
// The real session sample is read-only and never copied into the repository:
// tests either read it in memory or skip when it is unavailable or happens to
// be captured mid-append (the backend keeps appending while a session runs).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'

import {
  SessionFileError,
  detectCompression,
  encodeSessionLog,
  inspectSessionFile,
  readHeader,
  rewriteHeaderCwd,
  scanZstdFrames,
  trimIncompleteTail,
} from '../src/session-file.js'

/** Live sample of a DSH JSONL.zstd session; kept out of the repository. */
const REAL_SAMPLE_PATH =
  'C:/Users/Seint/.dsh/sessions/--C-Users-Seint-Desktop-dsh-easy-sync--/session-5dd30758-98fc-40c5-a2f0-78831544f161/session.v4.jsonl.zstd'

const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd]
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function makeHeader(overrides = {}) {
  return {
    type: 'session',
    version: 4,
    id: 'session-00000000-0000-4000-8000-000000000000',
    createdAt: 1700000000000,
    cwd: 'C:\\Users\\Seint\\Desktop\\dsh-easy-sync',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  }
}

/**
 * @param {number} count
 * @param {{ startSeq?: number, startTime?: number }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
function makeEvents(count, { startSeq = 0, startTime = 1700000000100 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    type: index % 2 === 0 ? 'message' : 'step/start',
    seq: startSeq + index,
    time: startTime + index,
    data: { index, label: `event-${index}` },
  }))
}

/**
 * @param {string} text
 * @param {import('node:zlib').ZstdOptions} [options]
 * @returns {Buffer}
 */
function zstdFrame(text, options) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), options)
}

/**
 * Build a zstd log where each frame after the header holds a whole group of
 * event lines, mimicking the backend's batching.
 *
 * @param {Record<string, unknown>} header
 * @param {Array<Array<Record<string, unknown>>>} eventGroups
 * @param {{ checksum?: boolean }} [options]
 * @returns {Buffer}
 */
function buildZstdLog(header, eventGroups, { checksum = false } = {}) {
  const frameOptions = checksum ? CHECKSUM_OPTIONS : undefined
  const chunks = [zstdFrame(`${JSON.stringify(header)}\n`, frameOptions)]
  for (const group of eventGroups) {
    chunks.push(
      zstdFrame(group.map((event) => `${JSON.stringify(event)}\n`).join(''), frameOptions),
    )
  }
  return Buffer.concat(chunks)
}

/**
 * @param {Buffer} buffer
 * @param {{ start: number, end: number }} frame
 * @returns {Buffer}
 */
function frameBytes(buffer, frame) {
  return buffer.subarray(frame.start, frame.end)
}

/**
 * @param {() => unknown} fn
 * @param {string} [message]
 */
function assertSessionFileError(fn, message) {
  assert.throws(
    fn,
    (error) => error instanceof SessionFileError && error.name === 'SessionFileError',
    message,
  )
}

/**
 * @param {Buffer} buffer
 * @returns {number} Offset just past the first LF, or the buffer length.
 */
function firstLineEnd(buffer) {
  const index = buffer.indexOf(0x0a)
  return index === -1 ? buffer.length : index + 1
}

/**
 * Assert every frame after the header is byte-identical between two logs.
 *
 * @param {Buffer} before
 * @param {Buffer} after
 */
function assertEventFramesUnchanged(before, after) {
  const beforeFrames = scanZstdFrames(before)
  const afterFrames = scanZstdFrames(after)
  assert.equal(afterFrames.length, beforeFrames.length, 'frame count must not change')
  for (let index = 1; index < beforeFrames.length; index++) {
    assert.ok(
      frameBytes(after, afterFrames[index]).equals(frameBytes(before, beforeFrames[index])),
      `event frame ${index} must be byte-identical`,
    )
  }
}

describe('encodeSessionLog / inspectSessionFile (zstd)', () => {
  it('round-trips the header and every event', () => {
    const header = makeHeader()
    const events = makeEvents(5)
    const buffer = encodeSessionLog({ header, events })

    assert.equal(detectCompression(buffer), 'zstd')
    const inspected = inspectSessionFile(buffer)
    assert.deepEqual(inspected.header, header)
    assert.deepEqual(inspected.events, events)
    assert.equal(inspected.eventCount, 5)
    assert.equal(inspected.lastSeq, 4)
    assert.equal(inspected.frameCount, 6)
    assert.equal(inspected.compression, 'zstd')
    assert.equal(inspected.version, 4)

    const frames = scanZstdFrames(buffer)
    assert.equal(frames.length, 6)
    assert.equal(frames[0].start, 0)
    assert.equal(frames.at(-1).end, buffer.length)
    for (let index = 1; index < frames.length; index++) {
      assert.equal(frames[index].start, frames[index - 1].end)
    }
    const decodedText = Buffer.concat(
      frames.map((frame) => zstdDecompressSync(frameBytes(buffer, frame))),
    ).toString('utf8')
    assert.equal(
      decodedText,
      encodeSessionLog({ header, events }, { compression: 'none' }).toString('utf8'),
    )
  })

  it('accepts explicit compression and Uint8Array input', () => {
    const header = makeHeader()
    const events = makeEvents(3)
    const buffer = encodeSessionLog({ header, events })
    const inspected = inspectSessionFile(new Uint8Array(buffer), { compression: 'zstd' })
    assert.deepEqual(inspected.header, header)
    assert.deepEqual(inspected.events, events)
    assert.equal(scanZstdFrames(new Uint8Array(buffer)).length, inspected.frameCount)
  })

  it('handles a header-only log with no events', () => {
    const header = makeHeader()
    const buffer = encodeSessionLog({ header, events: [] })
    const inspected = inspectSessionFile(buffer)
    assert.deepEqual(inspected.header, header)
    assert.deepEqual(inspected.events, [])
    assert.equal(inspected.eventCount, 0)
    assert.equal(inspected.lastSeq, undefined)
    assert.equal(inspected.frameCount, 1)
  })

  it('reports the last numeric seq and skips events without one', () => {
    const events = [
      { type: 'a', seq: 0 },
      { type: 'b' },
      { type: 'c', seq: 2 },
      { type: 'd', note: 'no seq' },
    ]
    const inspected = inspectSessionFile(encodeSessionLog({ header: makeHeader(), events }))
    assert.equal(inspected.eventCount, 4)
    assert.equal(inspected.lastSeq, 2)
  })

  it('parses frames that batch several event lines', () => {
    const header = makeHeader()
    const events = makeEvents(5)
    const buffer = buildZstdLog(header, [events.slice(0, 2), events.slice(2, 4), events.slice(4)])
    const inspected = inspectSessionFile(buffer)
    assert.deepEqual(inspected.header, header)
    assert.deepEqual(inspected.events, events)
    assert.equal(inspected.eventCount, 5)
    assert.equal(inspected.frameCount, 4)
    assert.equal(inspected.lastSeq, 4)
  })

  it('parses frames carrying content checksums', () => {
    const header = makeHeader()
    const events = makeEvents(3)
    const buffer = buildZstdLog(header, [events.slice(0, 2), events.slice(2)], {
      checksum: true,
    })
    const frames = scanZstdFrames(buffer)
    assert.equal(frames.length, 3)
    // Content checksum adds four bytes past the last block.
    for (const frame of frames) {
      assert.equal(zstdDecompressSync(frameBytes(buffer, frame)).length > 0, true)
    }
    const inspected = inspectSessionFile(buffer)
    assert.deepEqual(inspected.events, events)
    assert.equal(inspected.frameCount, 3)
    const read = readHeader(buffer)
    assert.deepEqual(read.header, header)
    assert.equal(read.frameEnd, frames[0].end)
  })
})

describe('rewriteHeaderCwd (zstd)', () => {
  it('rewrites only the header frame and preserves event bytes', () => {
    const header = makeHeader()
    const events = makeEvents(4)
    const buffer = encodeSessionLog({ header, events })
    const targetCwd = 'D:\\restored\\workspace'
    const restored = rewriteHeaderCwd(buffer, targetCwd)

    const inspected = inspectSessionFile(restored)
    assert.deepEqual(inspected.header, { ...header, cwd: targetCwd })
    assert.equal(inspected.header.id, header.id)
    assert.equal(inspected.version, 4)
    assert.deepEqual(inspected.events, events)
    assert.equal(inspected.frameCount, 5)
    assertEventFramesUnchanged(buffer, restored)
  })

  it('adds cwd when the header has none', () => {
    const { cwd: _omitted, ...headerWithoutCwd } = makeHeader()
    const buffer = encodeSessionLog({ header: headerWithoutCwd, events: makeEvents(2) })
    const targetCwd = 'C:\\Users\\Seint\\Desktop\\moved-workspace'
    const restored = rewriteHeaderCwd(buffer, targetCwd)
    const inspected = inspectSessionFile(restored)
    assert.equal(inspected.header.cwd, targetCwd)
    assert.equal(inspected.header.id, headerWithoutCwd.id)
    assert.equal(inspected.header.version, 4)
    assert.deepEqual(inspected.events, makeEvents(2))
  })

  it('keeps checksummed event frames intact', () => {
    const header = makeHeader()
    const events = makeEvents(5)
    const buffer = buildZstdLog(header, [events.slice(0, 2), events.slice(2)], {
      checksum: true,
    })
    const restored = rewriteHeaderCwd(buffer, 'C:\\moved')
    assert.equal(scanZstdFrames(restored).length, 3)
    assert.deepEqual(inspectSessionFile(restored).events, events)
    assertEventFramesUnchanged(buffer, restored)
  })

  it('refuses a first frame that also contains event lines', () => {
    const header = makeHeader()
    const events = makeEvents(2)
    const buffer = Buffer.concat([
      zstdFrame(`${JSON.stringify(header)}\n${JSON.stringify(events[0])}\n`),
      zstdFrame(`${JSON.stringify(events[1])}\n`),
    ])
    // Inspection still works, but rewriting would silently drop events[0].
    assert.deepEqual(inspectSessionFile(buffer).events, events)
    assert.equal(readHeader(buffer).header.id, header.id)
    assertSessionFileError(() => rewriteHeaderCwd(buffer, 'C:\\x'))
  })

  it('rejects invalid cwd arguments', () => {
    const buffer = encodeSessionLog({ header: makeHeader(), events: makeEvents(1) })
    assertSessionFileError(() => rewriteHeaderCwd(buffer, ''))
    assertSessionFileError(() => rewriteHeaderCwd(buffer, undefined))
    assertSessionFileError(() => rewriteHeaderCwd(buffer, 42))
  })
})

describe('plain-text logs', () => {
  it('round-trips with frameCount 0', () => {
    const header = makeHeader()
    const events = makeEvents(3)
    const buffer = encodeSessionLog({ header, events }, { compression: 'none' })
    assert.equal(detectCompression(buffer), 'none')
    const inspected = inspectSessionFile(buffer)
    assert.deepEqual(inspected.header, header)
    assert.deepEqual(inspected.events, events)
    assert.equal(inspected.eventCount, 3)
    assert.equal(inspected.lastSeq, 2)
    assert.equal(inspected.frameCount, 0)
    assert.equal(inspected.compression, 'none')
  })

  it('rewrites only the first line', () => {
    const header = makeHeader()
    const events = makeEvents(2)
    const buffer = encodeSessionLog({ header, events }, { compression: 'none' })
    const targetCwd = 'D:\\plain\\workspace'
    const restored = rewriteHeaderCwd(buffer, targetCwd)
    const inspected = inspectSessionFile(restored)
    assert.equal(inspected.header.cwd, targetCwd)
    assert.equal(inspected.header.id, header.id)
    assert.deepEqual(inspected.events, events)
    assert.ok(
      restored
        .subarray(firstLineEnd(restored))
        .equals(buffer.subarray(firstLineEnd(buffer))),
      'bytes after the first line must be preserved',
    )
  })

  it('preserves a CRLF header terminator and parses CRLF events', () => {
    const header = { ...makeHeader(), cwd: 'C:\\old' }
    const events = makeEvents(2)
    const text =
      `${JSON.stringify(header)}\r\n` +
      events.map((event) => `${JSON.stringify(event)}\r\n`).join('')
    const buffer = Buffer.from(text)
    const inspected = inspectSessionFile(buffer)
    assert.deepEqual(inspected.events, events)
    assert.equal(inspected.lastSeq, 1)

    const restored = rewriteHeaderCwd(buffer, 'C:\\new')
    const newlineIndex = restored.indexOf(0x0a)
    assert.ok(newlineIndex > 0)
    assert.equal(restored[newlineIndex - 1], 0x0d, 'CRLF must be preserved')
    assert.equal(JSON.parse(restored.subarray(0, newlineIndex - 1).toString()).cwd, 'C:\\new')
    assert.ok(
      restored.subarray(firstLineEnd(restored)).equals(buffer.subarray(firstLineEnd(buffer))),
    )
  })

  it('adds cwd to a single-line header without a trailing newline', () => {
    const { cwd: _omitted, ...headerWithoutCwd } = makeHeader()
    const buffer = Buffer.from(JSON.stringify(headerWithoutCwd))
    const read = readHeader(buffer)
    assert.equal(read.frameEnd, buffer.length)
    assert.equal(read.header.type, 'session')

    const restored = rewriteHeaderCwd(buffer, 'C:\\new')
    assert.equal(restored[restored.length - 1], 0x0a, 'rewritten header line is newline-terminated')
    const inspected = inspectSessionFile(restored)
    assert.equal(inspected.header.cwd, 'C:\\new')
    assert.equal(inspected.header.id, headerWithoutCwd.id)
    assert.equal(inspected.eventCount, 0)
  })
})

describe('zstd frame scanning', () => {
  it('handles a raw block frame and reports exact boundaries', () => {
    const rawFrame = Buffer.concat([
      Buffer.from([...ZSTD_MAGIC_BYTES, 0x20, 5, 0x29, 0x00, 0x00]),
      Buffer.from('hello'),
    ])
    const frames = scanZstdFrames(rawFrame)
    assert.deepEqual(frames, [{ start: 0, end: rawFrame.length }])
    assert.equal(zstdDecompressSync(frameBytes(rawFrame, frames[0])).toString('utf8'), 'hello')
  })

  it('handles RLE blocks whose payload is a single byte', () => {
    // Single-segment frame, content size 5, last block type RLE, regenerated size 5.
    const rleFrame = Buffer.concat([
      Buffer.from([...ZSTD_MAGIC_BYTES, 0x20, 5, 0x2b, 0x00, 0x00]),
      Buffer.from('A'),
    ])
    const frames = scanZstdFrames(rleFrame)
    assert.deepEqual(frames, [{ start: 0, end: rleFrame.length }])
    assert.equal(zstdDecompressSync(frameBytes(rleFrame, frames[0])).toString('utf8'), 'AAAAA')
  })

  it('rejects a reserved block type', () => {
    const reservedFrame = Buffer.from([...ZSTD_MAGIC_BYTES, 0x20, 1, 0x0f, 0x00, 0x00])
    assertSessionFileError(() => scanZstdFrames(reservedFrame))
  })

  it('rejects reserved frame header descriptor bits', () => {
    assertSessionFileError(() => scanZstdFrames(Buffer.from([...ZSTD_MAGIC_BYTES, 0x08])))
    assertSessionFileError(() => scanZstdFrames(Buffer.from([...ZSTD_MAGIC_BYTES, 0x10])))
  })

  it('rejects truncation at every structural boundary', () => {
    const buffer = encodeSessionLog({ header: makeHeader(), events: makeEvents(3) })
    const frames = scanZstdFrames(buffer)
    const frameBoundaries = new Set(frames.map((frame) => frame.end))
    const candidates = new Set([
      1,
      2,
      3,
      frames[0].start + 4,
      frames[0].start + 5,
      frames[0].end - 1,
      frames[1].start + 3,
      frames[1].end - 1,
      buffer.length - 1,
    ])
    for (const cut of candidates) {
      if (cut <= 0 || cut >= buffer.length || frameBoundaries.has(cut)) continue
      assertSessionFileError(
        () => scanZstdFrames(buffer.subarray(0, cut)),
        `truncating at byte ${cut} must throw`,
      )
    }
  })

  it('rejects a truncated content checksum', () => {
    const frame = zstdCompressSync(Buffer.from('{"a":1}'), CHECKSUM_OPTIONS)
    assertSessionFileError(() => scanZstdFrames(frame.subarray(0, frame.length - 1)))
  })

  it('rejects a truncated magic and bad magic', () => {
    assertSessionFileError(() => scanZstdFrames(Buffer.from(ZSTD_MAGIC_BYTES.slice(0, 3))))
    assertSessionFileError(() => scanZstdFrames(Buffer.from(ZSTD_MAGIC_BYTES)))
    assertSessionFileError(() => scanZstdFrames(Buffer.from('not a zstd session log')))
    const valid = encodeSessionLog({ header: makeHeader(), events: makeEvents(1) })
    assertSessionFileError(() =>
      scanZstdFrames(Buffer.concat([valid, Buffer.from('trailing garbage')])),
    )
  })

  it('rejects empty and non-buffer input', () => {
    assertSessionFileError(() => scanZstdFrames(Buffer.alloc(0)))
    assertSessionFileError(() => scanZstdFrames('a string'))
    assertSessionFileError(() => scanZstdFrames(null))
  })
})

describe('malformed logs', () => {
  it('rejects an invalid header line', () => {
    assertSessionFileError(() => inspectSessionFile(Buffer.from('{"type":"session"\n')))
    assertSessionFileError(() => inspectSessionFile(Buffer.from(JSON.stringify({ type: 'event' }))))
    assertSessionFileError(() => inspectSessionFile(Buffer.from('[]\n')))
    assertSessionFileError(() => inspectSessionFile(Buffer.alloc(0)))
    assertSessionFileError(() => readHeader(Buffer.alloc(0)))
  })

  it('rejects an invalid event line', () => {
    const headerLine = `${JSON.stringify(makeHeader())}\n`
    assertSessionFileError(() => inspectSessionFile(Buffer.from(`${headerLine}not json\n`)))
    assertSessionFileError(() => inspectSessionFile(Buffer.from(`${headerLine}[1,2,3]\n`)))
  })

  it('rejects unsupported compression values', () => {
    const buffer = encodeSessionLog({ header: makeHeader(), events: makeEvents(1) })
    assertSessionFileError(() => inspectSessionFile(buffer, { compression: 'gzip' }))
    assertSessionFileError(() => readHeader(buffer, { compression: 'brotli' }))
    assertSessionFileError(() =>
      rewriteHeaderCwd(buffer, 'C:\\x', { compression: 'gzip' }),
    )
  })

  it('rejects zstd framing when compression is declared or autodetected incorrectly', () => {
    assertSessionFileError(() => inspectSessionFile(Buffer.from('plain text'), { compression: 'zstd' }))
    assertSessionFileError(() => readHeader(Buffer.from('plain text'), { compression: 'zstd' }))
  })

  it('rejects invalid encodeSessionLog input', () => {
    assertSessionFileError(() => encodeSessionLog({ header: { type: 'event' }, events: [] }))
    assertSessionFileError(() => encodeSessionLog({ header: makeHeader(), events: 'nope' }))
    assertSessionFileError(() => encodeSessionLog({ header: makeHeader(), events: [null] }))
    assertSessionFileError(() =>
      encodeSessionLog({ header: makeHeader(), events: [{ type: 'a', seq: 0, data: { big: 1n } }] }),
    )
    assertSessionFileError(() =>
      encodeSessionLog({ header: makeHeader(), events: [] }, { compression: 'lz4' }),
    )
  })
})

describe('trimIncompleteTail', () => {
  it('returns a complete zstd log unchanged', () => {
    const buffer = encodeSessionLog({ header: makeHeader(), events: makeEvents(3) })
    const result = trimIncompleteTail(buffer)
    assert.equal(result.buffer, buffer, 'complete logs are returned by identity')
    assert.equal(result.trimmedBytes, 0)
    assert.equal(result.frames, scanZstdFrames(buffer).length)
  })

  it('drops a zstd frame truncated in the middle', () => {
    const buffer = encodeSessionLog({ header: makeHeader(), events: makeEvents(3) })
    const frames = scanZstdFrames(buffer)
    const cut = frames[2].start + Math.floor((frames[2].end - frames[2].start) / 2)
    const truncated = buffer.subarray(0, cut)

    const result = trimIncompleteTail(truncated)
    assert.equal(result.frames, 2, 'only the complete header and first event frame survive')
    assert.equal(result.trimmedBytes, cut - frames[2].start)
    assert.ok(result.buffer.equals(buffer.subarray(0, frames[2].start)))
    const inspected = inspectSessionFile(result.buffer)
    assert.equal(inspected.eventCount, 1)
    assert.equal(inspected.lastSeq, 0)
  })

  it('drops a checksummed frame truncated inside its checksum', () => {
    const buffer = buildZstdLog(makeHeader(), [makeEvents(2), makeEvents(2, { startSeq: 2 })], {
      checksum: true,
    })
    const frames = scanZstdFrames(buffer)
    const result = trimIncompleteTail(buffer.subarray(0, frames[2].end - 2))
    assert.equal(result.frames, 2)
    assert.equal(result.trimmedBytes, frames[2].end - 2 - frames[2].start)
    assert.deepEqual(inspectSessionFile(result.buffer).events, makeEvents(2))
  })

  it('drops trailing garbage after complete frames', () => {
    const complete = encodeSessionLog({ header: makeHeader(), events: makeEvents(2) })
    const frames = scanZstdFrames(complete)
    const result = trimIncompleteTail(Buffer.concat([complete, Buffer.from('not a frame')]))
    assert.equal(result.frames, frames.length)
    assert.equal(result.trimmedBytes, 'not a frame'.length)
    assert.ok(result.buffer.equals(complete))
  })

  it('throws when the first zstd frame itself is truncated', () => {
    const buffer = encodeSessionLog({ header: makeHeader(), events: makeEvents(1) })
    const frames = scanZstdFrames(buffer)
    assertSessionFileError(() => trimIncompleteTail(buffer.subarray(0, frames[0].end - 1)))
    assertSessionFileError(() => trimIncompleteTail(Buffer.from(ZSTD_MAGIC_BYTES)))
    assertSessionFileError(() => trimIncompleteTail(Buffer.alloc(0), { compression: 'zstd' }))
  })

  it('returns a complete text log unchanged', () => {
    const buffer = encodeSessionLog(
      { header: makeHeader(), events: makeEvents(3) },
      { compression: 'none' },
    )
    const result = trimIncompleteTail(buffer)
    assert.equal(result.buffer, buffer)
    assert.equal(result.trimmedBytes, 0)
    assert.equal(result.frames, 0)
  })

  it('drops a half-written final text line', () => {
    const buffer = encodeSessionLog(
      { header: makeHeader(), events: makeEvents(2) },
      { compression: 'none' },
    )
    const cut = buffer.length - 5
    const truncated = buffer.subarray(0, cut)
    const lastNewline = truncated.lastIndexOf(0x0a)
    const result = trimIncompleteTail(truncated)
    assert.equal(result.buffer.length, lastNewline + 1)
    assert.equal(result.trimmedBytes, cut - (lastNewline + 1))
    assert.equal(result.frames, 0)
    const inspected = inspectSessionFile(result.buffer)
    assert.equal(inspected.eventCount, 1)
    assert.equal(inspected.lastSeq, 0)
  })

  it('drops an unterminated final line even when it looks complete', () => {
    const events = makeEvents(2)
    const buffer = encodeSessionLog({ header: makeHeader(), events }, { compression: 'none' })
    // Remove only the trailing LF: the last event line is intact but unterminated.
    const result = trimIncompleteTail(buffer.subarray(0, buffer.length - 1))
    const expectedTrimmed = Buffer.byteLength(JSON.stringify(events[1]), 'utf8')
    assert.equal(result.trimmedBytes, expectedTrimmed)
    assert.equal(result.buffer[result.buffer.length - 1], 0x0a)
    assert.equal(inspectSessionFile(result.buffer).eventCount, 1)
  })

  it('throws when no complete line exists for a header', () => {
    assertSessionFileError(() => trimIncompleteTail(Buffer.from('{"type":"session"')))
    assertSessionFileError(() => trimIncompleteTail(Buffer.alloc(0)))
  })
})

describe('real session sample (read-only)', () => {
  it('inspects and rewrites a live JSONL.zstd snapshot', (t) => {
    if (!existsSync(REAL_SAMPLE_PATH)) {
      t.skip('real session sample is not available on this machine')
      return
    }

    // Read once: the backend may append between reads, so a snapshot can end in
    // the middle of a frame. A truly concurrent append is tolerated by skipping.
    const original = readFileSync(REAL_SAMPLE_PATH)
    let inspected
    try {
      inspected = inspectSessionFile(original)
    } catch (error) {
      if (error instanceof SessionFileError) {
        t.skip(`real sample snapshot is not a complete log: ${error.message}`)
        return
      }
      throw error
    }

    assert.equal(inspected.header.type, 'session')
    assert.equal(inspected.version, 4)
    assert.equal(typeof inspected.header.id, 'string')
    assert.ok(inspected.header.id.startsWith('session-'))
    assert.equal(typeof inspected.header.cwd, 'string')
    assert.ok(inspected.eventCount > 0)
    for (let index = 0; index < inspected.events.length; index++) {
      assert.equal(inspected.events[index].seq, index, `event ${index} has a contiguous seq`)
    }
    assert.equal(inspected.lastSeq, inspected.eventCount - 1)

    const frames = scanZstdFrames(original)
    assert.equal(frames.length, inspected.frameCount)
    assert.ok(frames.length > 1)
    const read = readHeader(original)
    assert.deepEqual(read.header, inspected.header)
    assert.equal(read.frameEnd, frames[0].end)

    const targetCwd = 'C:\\Users\\Seint\\Desktop\\restored-workspace'
    const restored = rewriteHeaderCwd(original, targetCwd)
    const restoredInspection = inspectSessionFile(restored)
    assert.equal(restoredInspection.header.cwd, targetCwd)
    assert.equal(restoredInspection.header.id, inspected.header.id)
    assert.equal(restoredInspection.header.createdAt, inspected.header.createdAt)
    assert.equal(restoredInspection.version, 4)
    assert.deepEqual(restoredInspection.events, inspected.events)
    assert.equal(restoredInspection.frameCount, inspected.frameCount)
    assertEventFramesUnchanged(original, restored)

    // Archiving a live snapshot: cutting inside the last frame must still leave
    // a complete, inspectable prefix that keeps the header and earlier events.
    const tailCut = frames.at(-1).start + 5
    const trimmedSnapshot = trimIncompleteTail(original.subarray(0, tailCut))
    assert.equal(trimmedSnapshot.frames, frames.length - 1)
    assert.equal(trimmedSnapshot.trimmedBytes, 5)
    const trimmedInspection = inspectSessionFile(trimmedSnapshot.buffer)
    assert.equal(trimmedInspection.header.id, inspected.header.id)
    assert.equal(trimmedInspection.frameCount, frames.length - 1)
    assert.ok(trimmedInspection.eventCount <= inspected.eventCount)
  })
})

describe('scale', () => {
  it('inspects and rewrites 500 frames x 20 lines', (t) => {
    const header = makeHeader()
    /** @type {Array<Array<Record<string, unknown>>>} */
    const groups = []
    let seq = 0
    for (let frameIndex = 0; frameIndex < 500; frameIndex++) {
      const group = []
      for (let lineIndex = 0; lineIndex < 20; lineIndex++) {
        group.push({
          type: 'step/start',
          seq: seq++,
          time: 1700000000000 + seq,
          data: { frame: frameIndex, line: lineIndex, text: `payload-${frameIndex}-${lineIndex}` },
        })
      }
      groups.push(group)
    }

    const buffer = buildZstdLog(header, groups)
    const startedAt = Date.now()
    const inspected = inspectSessionFile(buffer)
    const elapsedMs = Date.now() - startedAt

    assert.deepEqual(inspected.header, header)
    assert.equal(inspected.frameCount, 501)
    assert.equal(inspected.eventCount, 10000)
    assert.equal(inspected.lastSeq, 9999)
    assert.equal(inspected.events[0].seq, 0)
    assert.equal(inspected.events[19].seq, 19)
    assert.equal(inspected.events[20].data.frame, 1)
    assert.equal(inspected.events.at(-1).data.frame, 499)

    const restored = rewriteHeaderCwd(buffer, 'D:\\large\\workspace')
    const restoredInspection = inspectSessionFile(restored)
    assert.equal(restoredInspection.header.cwd, 'D:\\large\\workspace')
    assert.deepEqual(restoredInspection.events, inspected.events)
    assert.equal(restoredInspection.frameCount, 501)
    assertEventFramesUnchanged(buffer, restored)

    t.diagnostic(`inspected 500 frames / 10000 events in ${elapsedMs} ms`)
  })
})
