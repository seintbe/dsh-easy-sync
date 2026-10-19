// Session-log container codec for DeepSeek Harness JSONL session files.
//
// A compressed session generation (`session.vN.jsonl.zstd`) is a plain
// concatenation of independent zstd frames: the first frame carries exactly the
// header line, and every later frame carries one or more event lines. Node's
// one-shot `zstdDecompressSync()` stops after the first frame, so this module
// scans RFC 8878 frame boundaries itself and decompresses frame by frame.
//
// The shipped session persistence backend derives a session's on-disk path from
// the header's `id` and `cwd`, so restoring a session under a different
// workspace only has to rewrite the header's `cwd`. Every event frame is
// preserved byte for byte: its recorded data and content checksum stay as
// written by the original backend.
//
// Because a live session is appended to while it runs, `trimIncompleteTail()`
// can recover the longest complete prefix of a snapshot taken mid-write so the
// engine can still archive it.
//
// Keep this module dependency-free (node:buffer and node:zlib only) and
// synchronous; it is used by the plugin's restore path before services exist.

import { Buffer } from 'node:buffer'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/**
 * zstd frame magic bytes (`28 B5 2F FD`) as the conventional hexadecimal
 * number. On disk the bytes appear in this order, i.e. the little-endian
 * 32-bit value is `0xFD2FB528`.
 *
 * @type {number}
 */
export const ZSTD_FRAME_MAGIC = 0x28b52ffd

/** @typedef {'zstd' | 'none'} SessionCompression */

/**
 * @typedef {object} ZstdFrame
 * @property {number} start Offset of the frame's first magic byte.
 * @property {number} end Offset one past the frame's last byte (checksum included).
 */

/**
 * @typedef {object} SessionHeaderRead
 * @property {Record<string, unknown>} header Parsed session header object.
 * @property {number} frameEnd Offset where the bytes following the header begin.
 */

/**
 * @typedef {object} SessionInspection
 * @property {Record<string, unknown>} header Parsed session header object.
 * @property {Array<Record<string, unknown>>} events Parsed event objects in file order.
 * @property {number} eventCount Number of event lines, `events.length`.
 * @property {number | undefined} lastSeq `seq` of the last event whose `seq` is a number.
 * @property {number} frameCount Number of zstd frames (0 for uncompressed logs).
 * @property {SessionCompression} compression Compression of the inspected log.
 * @property {number | undefined} version Header format version, when it is a finite number.
 */

/** @type {ReadonlyArray<number>} */
const ZSTD_MAGIC_BYTES = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Frame_Content_Size field width for FCS_Field_Size 1..3. Flag 0 is special:
 * one byte when Single_Segment is set, otherwise the field is absent.
 *
 * @type {ReadonlyArray<number>}
 */
const FCS_FIELD_SIZES = Object.freeze([0, 2, 4, 8])

/** Dictionary_ID field width indexed by Dictionary_ID_flag. @type {ReadonlyArray<number>} */
const DICTIONARY_ID_SIZES = Object.freeze([0, 1, 2, 4])

/**
 * Error thrown for every malformed session log, header, or argument. Callers
 * can rely on this single type instead of decoding zlib error codes.
 */
export class SessionFileError extends Error {
  /**
   * @param {string} message Human-readable description including the byte offset
   *   or JSON line at fault.
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options)
    this.name = 'SessionFileError'
  }
}

/**
 * Sniff the container format from a session log's first bytes.
 *
 * A log is treated as zstd only when it starts with the zstd frame magic;
 * anything else is assumed to be plain UTF-8 JSONL. Callers that know the
 * format from the generation filename can pass `compression` explicitly
 * instead.
 *
 * @param {Buffer | Uint8Array} input Session log bytes.
 * @returns {SessionCompression}
 * @throws {SessionFileError} When `input` is not a Buffer or Uint8Array.
 */
export function detectCompression(input) {
  const buffer = asBuffer(input, 'session log')
  return hasZstdMagicAt(buffer, 0) ? 'zstd' : 'none'
}

/**
 * Locate every RFC 8878 zstd frame in a concatenated session log.
 *
 * The scanner walks frame headers and block headers without decompressing, so
 * it can be used to validate a log cheaply before allocating decoded output.
 * Skippable frames are not supported: DSH writes standard frames only.
 *
 * @param {Buffer | Uint8Array} input Concatenated zstd frames.
 * @returns {ZstdFrame[]} Frame boundaries in file order.
 * @throws {SessionFileError} On empty input, bad magic, reserved fields, or a
 *   frame truncated at any structural boundary.
 */
export function scanZstdFrames(input) {
  const buffer = asBuffer(input, 'session log')
  if (buffer.length === 0) {
    throw new SessionFileError('cannot scan zstd frames: session log is empty')
  }

  /** @type {ZstdFrame[]} */
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const end = scanZstdFrameAt(buffer, offset)
    frames.push({ start: offset, end })
    offset = end
  }
  return frames
}

/**
 * Parse exactly one zstd frame starting at `start` and return its end offset.
 *
 * @param {Buffer} buffer
 * @param {number} start Offset of the frame's first magic byte.
 * @returns {number} Offset one past the frame's last byte.
 * @throws {SessionFileError} On malformed or truncated frame data.
 */
function scanZstdFrameAt(buffer, start) {
  let offset = start

  if (buffer.length - offset < 4) {
    throw truncated('frame magic', offset, buffer.length, 4)
  }
  if (!hasZstdMagicAt(buffer, offset)) {
    throw new SessionFileError(
      `invalid zstd frame magic at byte ${offset}: expected 28 b5 2f fd, found ${buffer
        .subarray(offset, offset + 4)
        .toString('hex')}`,
    )
  }
  offset += 4

  if (offset >= buffer.length) {
    throw truncated('frame header descriptor', offset, buffer.length, 1)
  }
  const descriptor = buffer[offset]
  offset += 1
  // Bit 4 is unused and bit 3 is reserved by RFC 8878; both must be zero.
  if ((descriptor & 0x18) !== 0) {
    throw new SessionFileError(
      `reserved bits set in zstd frame header descriptor at byte ${offset - 1}: 0x${descriptor.toString(16)}`,
    )
  }
  const fcsFieldSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const contentChecksum = (descriptor & 0x04) !== 0
  const dictionaryIdFlag = descriptor & 0x03

  // Window_Descriptor exists only for non-single-segment frames. Its value
  // affects decompression only, not the byte offsets this scanner needs.
  if (!singleSegment) {
    if (offset >= buffer.length) {
      throw truncated('window descriptor', offset, buffer.length, 1)
    }
    offset += 1
  }

  const dictionaryIdSize = DICTIONARY_ID_SIZES[dictionaryIdFlag]
  if (offset + dictionaryIdSize > buffer.length) {
    throw truncated('dictionary id', offset, buffer.length, dictionaryIdSize)
  }
  offset += dictionaryIdSize

  const contentSizeSize =
    fcsFieldSizeFlag === 0 ? (singleSegment ? 1 : 0) : FCS_FIELD_SIZES[fcsFieldSizeFlag]
  if (offset + contentSizeSize > buffer.length) {
    throw truncated('frame content size', offset, buffer.length, contentSizeSize)
  }
  offset += contentSizeSize

  let lastBlock = false
  while (!lastBlock) {
    if (offset + 3 > buffer.length) {
      throw truncated('block header', offset, buffer.length, 3)
    }
    const blockHeaderOffset = offset
    const blockHeader =
      buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
    offset += 3

    lastBlock = (blockHeader & 0x01) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 3) {
      throw new SessionFileError(
        `reserved zstd block type at byte ${blockHeaderOffset}: 0x${(blockHeader & 0xffff)
          .toString(16)
          .padStart(6, '0')}`,
      )
    }
    // An RLE block stores its regenerated size in the header but only one
    // literal byte of payload; raw and compressed blocks store Block_Size bytes.
    const payloadSize = blockType === 1 ? 1 : blockSize
    if (offset + payloadSize > buffer.length) {
      throw truncated('block payload', offset, buffer.length, payloadSize)
    }
    offset += payloadSize
  }

  if (contentChecksum) {
    if (offset + 4 > buffer.length) {
      throw truncated('content checksum', offset, buffer.length, 4)
    }
    offset += 4
  }

  return offset
}

/**
 * Read only the session header of a log.
 *
 * For compressed logs `frameEnd` is the offset just past the first zstd frame;
 * for plain logs it is the offset just past the header line's terminator. Bytes
 * after `frameEnd` are untouched by {@link rewriteHeaderCwd}.
 *
 * The first frame normally contains exactly the header line. If a foreign
 * writer packed event lines into it, the first line is still returned here so
 * this function stays useful for inspection; rewriting refuses that layout
 * because it cannot preserve those events.
 *
 * @param {Buffer | Uint8Array} input Session log bytes.
 * @param {{ compression?: SessionCompression }} [options]
 * @returns {SessionHeaderRead}
 * @throws {SessionFileError} On malformed, truncated, or non-session logs.
 */
export function readHeader(input, { compression } = {}) {
  const buffer = asBuffer(input, 'session log')
  const mode = resolveCompression(buffer, compression)

  if (mode === 'none') {
    const firstLine = readFirstLine(buffer)
    return { header: parseHeaderLine(firstLine.line), frameEnd: firstLine.lineEnd }
  }

  const frames = scanZstdFrames(buffer)
  const firstFrameText = decodeFrame(buffer, frames[0], 0).toString('utf8')
  const lines = splitJsonLines(firstFrameText)
  if (lines.length === 0) {
    throw new SessionFileError('first zstd frame does not contain a session header line')
  }
  return {
    header: parseHeaderLine(Buffer.from(lines[0], 'utf8')),
    frameEnd: frames[0].end,
  }
}

/**
 * Trim a session log captured while it was still being appended to its longest
 * structurally complete prefix.
 *
 * Compressed logs keep whole frames only: a partially written trailing frame
 * (or arbitrary trailing bytes) is dropped, and `frames` reports how many
 * complete frames remain. Plain logs keep everything through the last LF, so a
 * half-written final line disappears. A fully complete input is returned by
 * identity with `trimmedBytes: 0`.
 *
 * Unlike {@link inspectSessionFile}, a broken tail never throws here: the tail
 * is exactly what this function exists to remove. It does throw when no usable
 * prefix exists at all (no complete first frame, no complete first line),
 * because such a file cannot yield a session header.
 *
 * @param {Buffer | Uint8Array} input Session log bytes.
 * @param {{ compression?: SessionCompression }} [options] Omit to auto-detect.
 * @returns {{ buffer: Buffer, trimmedBytes: number, frames: number }}
 * @throws {SessionFileError} On invalid arguments or when no complete header
 *   prefix can be recovered.
 */
export function trimIncompleteTail(input, { compression } = {}) {
  const buffer = asBuffer(input, 'session log')
  const mode = resolveCompression(buffer, compression)

  if (mode === 'none') {
    const lastNewline = buffer.lastIndexOf(0x0a)
    if (lastNewline === -1) {
      throw new SessionFileError(
        'session log has no complete line; cannot recover a header prefix',
      )
    }
    const end = lastNewline + 1
    return {
      buffer: end === buffer.length ? buffer : buffer.subarray(0, end),
      trimmedBytes: buffer.length - end,
      frames: 0,
    }
  }

  /** @type {ZstdFrame[]} */
  const frames = []
  let offset = 0
  /** @type {SessionFileError | undefined} */
  let failure
  while (offset < buffer.length) {
    try {
      const end = scanZstdFrameAt(buffer, offset)
      frames.push({ start: offset, end })
      offset = end
    } catch (error) {
      failure = error
      break
    }
  }

  if (frames.length === 0) {
    throw new SessionFileError(
      'session log has no complete zstd frame; cannot recover a header prefix',
      { cause: failure },
    )
  }
  if (offset === buffer.length) {
    return { buffer, trimmedBytes: 0, frames: frames.length }
  }
  return {
    buffer: buffer.subarray(0, offset),
    trimmedBytes: buffer.length - offset,
    frames: frames.length,
  }
}

/**
 * Decode and inspect a complete session log.
 *
 * @param {Buffer | Uint8Array} input Session log bytes.
 * @param {{ compression?: SessionCompression }} [options] Omit to auto-detect.
 * @returns {SessionInspection}
 * @throws {SessionFileError} On malformed headers, malformed event lines, or
 *   corrupt/truncated zstd frames.
 */
export function inspectSessionFile(input, { compression } = {}) {
  const buffer = asBuffer(input, 'session log')
  const mode = resolveCompression(buffer, compression)

  /** @type {string} */
  let text
  let frameCount = 0
  if (mode === 'zstd') {
    const frames = scanZstdFrames(buffer)
    frameCount = frames.length
    const chunks = new Array(frames.length)
    for (let index = 0; index < frames.length; index++) {
      chunks[index] = decodeFrame(buffer, frames[index], index)
    }
    text = Buffer.concat(chunks).toString('utf8')
  } else {
    text = buffer.toString('utf8')
  }

  const lines = splitJsonLines(text)
  if (lines.length === 0) {
    throw new SessionFileError('session log contains no header line')
  }
  const header = parseHeaderLine(Buffer.from(lines[0], 'utf8'))

  /** @type {Array<Record<string, unknown>>} */
  const events = []
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new SessionFileError(
        `event line ${index + 1} is not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new SessionFileError(`event line ${index + 1} must be a JSON object`)
    }
    events.push(event)
  }

  let lastSeq
  for (const event of events) {
    if (typeof event.seq === 'number') lastSeq = event.seq
  }

  return {
    header,
    events,
    eventCount: events.length,
    lastSeq,
    frameCount,
    compression: mode,
    version:
      typeof header.version === 'number' && Number.isFinite(header.version)
        ? header.version
        : undefined,
  }
}

/**
 * Rewrite the session header's `cwd` while preserving all event data.
 *
 * For compressed logs the first frame (header only) is re-compressed as a fresh
 * single zstd frame and every later byte is appended unchanged. For plain logs
 * only the first line is replaced. Any other header field keeps its value; a
 * missing `cwd` is added.
 *
 * @param {Buffer | Uint8Array} input Session log bytes.
 * @param {string} cwd New workspace path to store in the header.
 * @param {{ compression?: SessionCompression }} [options] Omit to auto-detect.
 * @returns {Buffer} A new log buffer; `input` is never mutated.
 * @throws {SessionFileError} On invalid arguments, malformed logs, or when the
 *   first zstd frame contains more than the header line (rewriting would drop
 *   event data).
 */
export function rewriteHeaderCwd(input, cwd, { compression } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new SessionFileError('cwd must be a non-empty string')
  }
  const buffer = asBuffer(input, 'session log')
  const mode = resolveCompression(buffer, compression)

  if (mode === 'none') {
    const firstLine = readFirstLine(buffer)
    const header = parseHeaderLine(firstLine.line)
    const terminator = firstLine.terminator === '' ? '\n' : firstLine.terminator
    const rewrittenFirstLine = JSON.stringify({ ...header, cwd }) + terminator
    return Buffer.concat([
      Buffer.from(rewrittenFirstLine, 'utf8'),
      buffer.subarray(firstLine.lineEnd),
    ])
  }

  const frames = scanZstdFrames(buffer)
  const firstFrameText = decodeFrame(buffer, frames[0], 0).toString('utf8')
  const firstFrameLines = splitJsonLines(firstFrameText)
  if (firstFrameLines.length !== 1) {
    throw new SessionFileError(
      `first zstd frame must contain exactly the session header line, found ${firstFrameLines.length} ` +
        'non-empty lines; refusing to rewrite because event data in that frame would be lost',
    )
  }
  const header = parseHeaderLine(Buffer.from(firstFrameLines[0], 'utf8'))
  const headerLine = JSON.stringify({ ...header, cwd }) + '\n'
  const firstFrame = zstdCompressSync(Buffer.from(headerLine, 'utf8'))
  return Buffer.concat([firstFrame, buffer.subarray(frames[0].end)])
}

/**
 * Encode a complete session log. Intended for tests and tooling, not for the
 * hot sync path; it always writes one zstd frame per line (header, then each
 * event) or one line per JSON object for uncompressed logs.
 *
 * @param {{ header: Record<string, unknown>, events: Array<Record<string, unknown>> }} log
 * @param {{ compression?: SessionCompression }} [options] Defaults to `'zstd'`.
 * @returns {Buffer}
 * @throws {SessionFileError} When the header is not a session object, an event
 *   is not a JSON object, or a value cannot be serialized to JSON.
 */
export function encodeSessionLog({ header, events } = {}, { compression = 'zstd' } = {}) {
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new SessionFileError('encodeSessionLog requires a header object')
  }
  if (header.type !== 'session') {
    throw new SessionFileError(
      `encodeSessionLog requires header.type === "session", got ${JSON.stringify(header.type)}`,
    )
  }
  if (!Array.isArray(events)) {
    throw new SessionFileError('encodeSessionLog requires an events array')
  }
  if (compression !== 'zstd' && compression !== 'none') {
    throw new SessionFileError(
      `unsupported compression ${JSON.stringify(compression)}; expected "zstd" or "none"`,
    )
  }

  const headerLine = `${stringifyJson(header, 'header')}\n`
  const eventLines = events.map((event, index) => {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new SessionFileError(`event ${index} must be a JSON object`)
    }
    return `${stringifyJson(event, `event ${index}`)}\n`
  })

  if (compression === 'none') {
    return Buffer.from(headerLine + eventLines.join(''), 'utf8')
  }

  const chunks = [zstdCompressSync(Buffer.from(headerLine, 'utf8'))]
  for (const line of eventLines) {
    chunks.push(zstdCompressSync(Buffer.from(line, 'utf8')))
  }
  return Buffer.concat(chunks)
}

/**
 * @param {Buffer | Uint8Array} input
 * @param {string} description
 * @returns {Buffer}
 */
function asBuffer(input, description) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new SessionFileError(`${description} must be a Buffer or Uint8Array`)
}

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {boolean}
 */
function hasZstdMagicAt(buffer, offset) {
  return (
    buffer.length - offset >= 4 &&
    buffer[offset] === ZSTD_MAGIC_BYTES[0] &&
    buffer[offset + 1] === ZSTD_MAGIC_BYTES[1] &&
    buffer[offset + 2] === ZSTD_MAGIC_BYTES[2] &&
    buffer[offset + 3] === ZSTD_MAGIC_BYTES[3]
  )
}

/**
 * @param {Buffer} buffer
 * @param {SessionCompression | undefined} compression
 * @returns {SessionCompression}
 */
function resolveCompression(buffer, compression) {
  if (compression === undefined) {
    return hasZstdMagicAt(buffer, 0) ? 'zstd' : 'none'
  }
  if (compression !== 'zstd' && compression !== 'none') {
    throw new SessionFileError(
      `unsupported compression ${JSON.stringify(compression)}; expected "zstd" or "none"`,
    )
  }
  if (compression === 'zstd' && !hasZstdMagicAt(buffer, 0)) {
    throw new SessionFileError(
      'session log does not start with a zstd frame magic (28 b5 2f fd)',
    )
  }
  return compression
}

/**
 * @param {Buffer} buffer
 * @param {ZstdFrame} frame
 * @param {number} index Frame index used in error messages.
 * @returns {Buffer}
 */
function decodeFrame(buffer, frame, index) {
  try {
    return zstdDecompressSync(buffer.subarray(frame.start, frame.end))
  } catch (error) {
    throw new SessionFileError(
      `failed to decompress zstd frame ${index} (bytes ${frame.start}-${frame.end}): ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

/**
 * Split decoded log text into non-blank lines, tolerating CRLF and trailing
 * newlines. Event JSON never spans lines, so joining frame output before
 * splitting is safe.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitJsonLines(text) {
  /** @type {string[]} */
  const lines = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim() !== '') lines.push(line)
  }
  return lines
}

/**
 * Read the first line of a plain-text log without copying the remainder.
 *
 * @param {Buffer} buffer
 * @returns {{ line: Buffer, lineEnd: number, terminator: '' | '\n' | '\r\n' }}
 */
function readFirstLine(buffer) {
  const newlineIndex = buffer.indexOf(0x0a)
  if (newlineIndex === -1) {
    return { line: buffer, lineEnd: buffer.length, terminator: '' }
  }
  let line = buffer.subarray(0, newlineIndex)
  let terminator = '\n'
  if (line.length > 0 && line[line.length - 1] === 0x0d) {
    line = line.subarray(0, line.length - 1)
    terminator = '\r\n'
  }
  return { line, lineEnd: newlineIndex + 1, terminator }
}

/**
 * Parse the first line of a log as a session header object.
 *
 * @param {Buffer | Uint8Array | string} line
 * @returns {Record<string, unknown>}
 * @throws {SessionFileError} When the line is empty, not JSON, not an object,
 *   or not a session header.
 */
function parseHeaderLine(line) {
  let text
  if (typeof line === 'string') {
    text = line
  } else if (Buffer.isBuffer(line) || line instanceof Uint8Array) {
    text = asBuffer(line, 'header line').toString('utf8')
  } else {
    throw new SessionFileError('header line must be a Buffer, Uint8Array, or string')
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.trim() === '') {
    throw new SessionFileError('session header line is empty')
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SessionFileError(`session header is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionFileError('session header must be a JSON object')
  }
  if (parsed.type !== 'session') {
    throw new SessionFileError(
      `session header type must be "session", got ${JSON.stringify(parsed.type)}`,
    )
  }
  return parsed
}

/**
 * @param {unknown} value
 * @param {string} description
 * @returns {string}
 */
function stringifyJson(value, description) {
  let text
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new SessionFileError(
      `${description} is not JSON-serializable: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  if (typeof text !== 'string') {
    throw new SessionFileError(`${description} is not JSON-serializable`)
  }
  return text
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build a truncation error that names the structural field that ran past EOF.
 *
 * @param {string} part Field name, e.g. `'block payload'`.
 * @param {number} offset First byte of the missing field.
 * @param {number} length Total buffer length.
 * @param {number} needed Field width in bytes.
 * @returns {SessionFileError}
 */
function truncated(part, offset, length, needed) {
  return new SessionFileError(
    `truncated zstd session log: incomplete ${part} at byte ${offset} of ${length} ` +
      `(need ${needed} byte${needed === 1 ? '' : 's'})`,
  )
}
