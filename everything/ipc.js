/**
 * Everything 1.5 IPC client over the named pipe.
 *
 * Everything 1.5 serves queries on `\\.\pipe\Everything IPC [Session <sid>] [(<instance>)]`.
 * A request is a little-endian header { code: u32, size: u32 } followed by `size` payload bytes.
 * A response is one or more messages: repeated 100 ("ok, more data") then one 200 ("ok, last").
 * Sizes inside the payload are variable-length quantities (VLQ) or 32/64-bit SIZE_T.
 *
 * This module is self-contained: no Harness imports, no native addons.
 */

import net from 'node:net'
import { readdirSync } from 'node:fs'

/** Pipe command ids accepted by Everything 1.5. */
const CMD = {
  PIPE_VERSION: 0,
  MAJOR: 1,
  MINOR: 2,
  REVISION: 3,
  BUILD: 4,
  SEARCH: 7,
}

/** Search flag bits. */
const FLAG = {
  MATCH_CASE: 0x00000001,
  MATCH_WHOLE_WORD: 0x00000002,
  MATCH_PATH: 0x00000004,
  REGEX: 0x00000008,
  MATCH_DIACRITICS: 0x00000010,
  MATCH_PREFIX: 0x00000020,
  MATCH_SUFFIX: 0x00000040,
  IGNORE_PUNCTUATION: 0x00000080,
  IGNORE_WHITESPACE: 0x00000100,
  TOTAL_SIZE: 0x00000800,
  SORT_MIX: 0x00002000,
  SIZE_T_64: 0x00004000,
}

/** Result property ids (stable for Everything 1.5). */
const PROPERTY = {
  NAME: 0,
  PATH: 1,
  SIZE: 2,
  EXTENSION: 3,
  TYPE: 4,
  DATE_MODIFIED: 5,
  DATE_CREATED: 6,
  DATE_ACCESSED: 7,
  ATTRIBUTES: 8,
  FULL_PATH: 240,
}

/** Property ids accepted by the `sort` argument. */
export const SORT_PROPERTIES = {
  name: PROPERTY.NAME,
  path: PROPERTY.PATH,
  size: PROPERTY.SIZE,
  extension: PROPERTY.EXTENSION,
  date_modified: PROPERTY.DATE_MODIFIED,
  date_created: PROPERTY.DATE_CREATED,
}

/** Everything result value types (EVERYTHING3_PROPERTY_VALUE_TYPE_*). */
const VALUE_TYPE = {
  NULL: 0,
  BYTE: 1,
  WORD: 2,
  DWORD: 3,
  DWORD_Q1K: 4,
  UINT64: 5,
  UINT128: 6,
  DIMENSIONS: 7,
  PSTRING: 8,
  PSTRING_MULTI: 9,
  PSTRING_STRING_REF: 10,
  SIZE_T: 11,
  INT32_Q1K: 12,
  INT32_Q1M: 13,
  PSTRING_FOLDER_REF: 14,
  PSTRING_FILE_OR_FOLDER_REF: 15,
  BLOB8: 16,
  DWORD_TEXT: 17,
  WORD_TEXT: 18,
  BLOB16: 19,
  BYTE_TEXT: 20,
}

/** Requests made per tool call are expected to settle well inside this budget. */
const REQUEST_TIMEOUT_MS = 60_000
const CONNECT_TIMEOUT_MS = 3_000

/** Encode one non-negative integer as an Everything variable-length quantity. */
export function encodeVlq(value) {
  if (value < 0xff) return Buffer.from([value])
  if (value < 0xff + 0xffff) {
    const buffer = Buffer.alloc(3)
    buffer[0] = 0xff
    buffer.writeUInt16LE(value - 0xff, 1)
    return buffer
  }
  const buffer = Buffer.alloc(7)
  buffer[0] = 0xff
  buffer.writeUInt16LE(0xffff, 1)
  buffer.writeUInt32LE(value - 0xff - 0xffff, 3)
  return buffer
}

/** Sequential reader over one response payload. */
class Reader {
  constructor(buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  need(count) {
    if (this.offset + count > this.buffer.length) {
      throw new Error(`Everything IPC response ended early (${this.offset}+${count} > ${this.buffer.length})`)
    }
  }

  u8() {
    this.need(1)
    return this.buffer[this.offset++]
  }

  u16() {
    this.need(2)
    const value = this.buffer.readUInt16LE(this.offset)
    this.offset += 2
    return value
  }

  u32() {
    this.need(4)
    const value = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return value
  }

  u64() {
    this.need(8)
    const value = this.buffer.readBigUInt64LE(this.offset)
    this.offset += 8
    return value
  }

  sizeT(is64) {
    return is64 ? Number(this.u64()) : this.u32()
  }

  vlq() {
    let value = this.u8()
    if (value < 0xff) return value
    value = this.u16()
    if (value < 0xffff) return 0xff + value
    value = this.u32()
    if (value < 0xffffffff) return 0xff + 0xffff + value
    return 0xff + 0xffff + 0xffffffff + Number(this.u64())
  }

  bytes(count) {
    this.need(count)
    const value = this.buffer.subarray(this.offset, this.offset + count)
    this.offset += count
    return value
  }

  pstring() {
    const length = this.vlq()
    return length > 0 ? this.bytes(length).toString('utf8') : ''
  }
}

/** One request/response pipe connection. */
class PipeConnection {
  constructor(pipePath) {
    this.pipePath = pipePath
    this.socket = null
    this.received = Buffer.alloc(0)
    this.pending = null
    this.failure = null
  }

  connect() {
    if (this.socket !== null) return Promise.resolve(this)
    if (this.connecting !== undefined) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.pipePath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`timed out connecting to ${this.pipePath}`))
      }, CONNECT_TIMEOUT_MS)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.failure = null
        socket.on('data', (chunk) => this.onData(chunk))
        socket.on('error', (error) => this.onClose(error))
        socket.on('close', () => this.onClose())
        resolve(this)
      })
    }).finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  onData(chunk) {
    this.received = Buffer.concat([this.received, chunk])
    for (;;) {
      if (this.pending === null) {
        this.received = Buffer.alloc(0)
        return
      }
      if (this.received.length < 8) return
      const code = this.received.readUInt32LE(0)
      const size = this.received.readUInt32LE(4)
      if (this.received.length < 8 + size) return
      const data = this.received.subarray(8, 8 + size)
      this.received = this.received.subarray(8 + size)
      if (code === 100) {
        this.pending.chunks.push(data)
        continue
      }
      const pending = this.pending
      this.pending = null
      if (code === 200) {
        pending.chunks.push(data)
        pending.resolve(Buffer.concat(pending.chunks))
      } else {
        pending.reject(new Error(`Everything IPC rejected the request (code ${code})`))
      }
    }
  }

  onClose(error) {
    if (this.socket !== null) {
      this.socket.destroy()
      this.socket = null
    }
    if (this.pending !== null) {
      const pending = this.pending
      this.pending = null
      pending.reject(error instanceof Error ? error : new Error('Everything IPC pipe closed'))
    }
  }

  request(code, payload) {
    return new Promise((resolve, reject) => {
      if (this.socket === null) {
        reject(new Error('Everything IPC pipe is not connected'))
        return
      }
      const body = Buffer.alloc(8 + payload.length)
      body.writeUInt32LE(code, 0)
      body.writeUInt32LE(payload.length, 4)
      payload.copy(body, 8)
      const timer = setTimeout(() => {
        this.onClose(new Error('Everything IPC request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending = {
        chunks: [],
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.socket.write(body)
    })
  }

  close() {
    this.onClose()
  }
}

/** Candidate pipe names, most specific first. */
function candidatePipes(settings) {
  // An explicit pipe is the whole answer: never silently query a different Everything instance.
  if (typeof settings.pipe === 'string' && settings.pipe.length > 0) return [settings.pipe]

  let names = []
  try {
    names = readdirSync('\\\\.\\pipe\\')
  } catch {
    names = []
  }
  const everything = names.filter((name) => name.startsWith('Everything IPC'))

  if (typeof settings.instance === 'string' && settings.instance.length > 0) {
    // The 1.5 alpha exposes its instance as `Everything IPC (1.5a)`.
    return everything
      .filter((name) => name.includes(`(${settings.instance})`))
      .map((name) => `\\\\.\\pipe\\${name}`)
  }

  const exact = everything.filter((name) => name === 'Everything IPC')
  const named = everything.filter((name) => name !== 'Everything IPC')
  return [...exact, ...named].map((name) => `\\\\.\\pipe\\${name}`)
}

/** Live connection plus the serialization chain that keeps one request in flight. */
let connection = null
let connectionKey = ''
let chain = Promise.resolve()

/** Identity of the settings a connection was opened for. */
function settingsKey(settings) {
  return `${settings.pipe ?? ''}|${settings.instance ?? ''}`
}

/** Serialize work so concurrent tool calls never interleave on one pipe. */
function serialize(task) {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Connect to the first reachable Everything pipe. */
async function openConnection(settings) {
  const candidates = candidatePipes(settings)
  if (candidates.length === 0) {
    throw new Error(
      'Everything IPC pipe not found. Start Everything 1.5, or set config.instance/config.pipe to the instance to query.',
    )
  }
  const failures = []
  for (const pipePath of candidates) {
    const pipe = new PipeConnection(pipePath)
    try {
      await pipe.connect()
      return pipe
    } catch (error) {
      failures.push(`${pipePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `Everything IPC pipe not found. Everything 1.5 must be running. Tried: ${failures.join('; ')}`,
  )
}

/** Return the shared connection, reopening it when the target settings changed or Everything restarted. */
async function getConnection(settings) {
  const key = settingsKey(settings)
  if (connection !== null && connection.socket !== null && connectionKey === key) return connection
  if (connection !== null) connection.close()
  connection = await openConnection(settings)
  connectionKey = key
  return connection
}

/** Read one value of one property-request column. */
function readValue(reader, valueType, sizeTIs64) {
  switch (valueType) {
    case VALUE_TYPE.NULL:
      return null
    case VALUE_TYPE.BYTE:
    case VALUE_TYPE.BYTE_TEXT:
      return reader.u8()
    case VALUE_TYPE.WORD:
    case VALUE_TYPE.WORD_TEXT:
      return reader.u16()
    case VALUE_TYPE.DWORD:
    case VALUE_TYPE.DWORD_Q1K:
    case VALUE_TYPE.DWORD_TEXT:
    case VALUE_TYPE.INT32_Q1K:
    case VALUE_TYPE.INT32_Q1M:
      return reader.u32()
    case VALUE_TYPE.UINT64:
      return reader.u64()
    case VALUE_TYPE.UINT128:
      return reader.bytes(16)
    case VALUE_TYPE.DIMENSIONS:
      return { width: reader.u32(), height: reader.u32() }
    case VALUE_TYPE.PSTRING:
    case VALUE_TYPE.PSTRING_MULTI:
    case VALUE_TYPE.PSTRING_STRING_REF:
    case VALUE_TYPE.PSTRING_FOLDER_REF:
    case VALUE_TYPE.PSTRING_FILE_OR_FOLDER_REF:
      return reader.pstring()
    case VALUE_TYPE.SIZE_T:
      return reader.sizeT(sizeTIs64)
    case VALUE_TYPE.BLOB8: {
      const length = reader.u8()
      return length > 0 ? reader.bytes(length) : null
    }
    case VALUE_TYPE.BLOB16: {
      const length = reader.u16()
      return length > 0 ? reader.bytes(length) : null
    }
    default:
      throw new Error(`Everything returned an unsupported property value type (${valueType})`)
  }
}

/** Windows FILETIME (100 ns since 1601) to a local `YYYY-MM-DD HH:mm` label. */
function formatFiletime(value) {
  if (typeof value !== 'bigint' || value <= 0n || value >= 0xffffffffffffffffn) return ''
  const milliseconds = Number(value / 10000n) - 11_644_473_600_000
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return ''
  const date = new Date(milliseconds)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Human-readable byte size. */
export function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Query the Everything index.
 * @param options - query text, paging, sorting, and search flags.
 * @param settings - connection settings (`pipe`, `instance`).
 * @returns match counts and the requested page of results.
 */
export async function everythingSearch(options, settings = {}) {
  const query = typeof options.query === 'string' ? options.query : ''
  const limit = Number.isInteger(options.limit) ? options.limit : 30
  const offset = Number.isInteger(options.offset) ? options.offset : 0
  let flags = FLAG.SIZE_T_64
  if (options.matchPath === true) flags |= FLAG.MATCH_PATH
  if (options.regex === true) flags |= FLAG.REGEX
  if (options.matchCase === true) flags |= FLAG.MATCH_CASE
  if (options.wholeWord === true) flags |= FLAG.MATCH_WHOLE_WORD

  const sortId = typeof options.sort === 'string' ? SORT_PROPERTIES[options.sort] : undefined
  if (options.sort !== undefined && sortId === undefined) {
    throw new Error(`unsupported sort ${JSON.stringify(options.sort)}; use one of ${Object.keys(SORT_PROPERTIES).join(', ')}`)
  }

  const properties = [PROPERTY.NAME, PROPERTY.FULL_PATH, PROPERTY.SIZE, PROPERTY.DATE_MODIFIED]
  const parts = []

  const flagsBuffer = Buffer.alloc(4)
  flagsBuffer.writeUInt32LE(flags, 0)
  parts.push(flagsBuffer)

  const queryBuffer = Buffer.from(query, 'utf8')
  parts.push(encodeVlq(queryBuffer.length), queryBuffer)

  const viewport = Buffer.alloc(16)
  viewport.writeBigUInt64LE(BigInt(offset), 0)
  viewport.writeBigUInt64LE(BigInt(limit), 8)
  parts.push(viewport)

  if (sortId !== undefined) {
    parts.push(encodeVlq(1))
    const sort = Buffer.alloc(8)
    sort.writeUInt32LE(sortId, 0)
    sort.writeUInt32LE(options.descending === true ? 1 : 0, 4)
    parts.push(sort)
  } else {
    parts.push(encodeVlq(0))
  }

  parts.push(encodeVlq(properties.length))
  for (const propertyId of properties) {
    const entry = Buffer.alloc(8)
    entry.writeUInt32LE(propertyId, 0)
    entry.writeUInt32LE(0, 4)
    parts.push(entry)
  }

  const payload = Buffer.concat(parts)
  // Measure the query itself: queueing behind another call is not search latency.
  let elapsedMs = 0
  const response = await serialize(async () => {
    const pipe = await getConnection(settings)
    const startedAt = performance.now()
    try {
      const reply = await pipe.request(CMD.SEARCH, payload)
      elapsedMs = performance.now() - startedAt
      return reply
    } catch (error) {
      pipe.close()
      if (connection === pipe) connection = null
      throw error
    }
  })

  const reader = new Reader(response)
  const validFlags = reader.u32()
  const sizeTIs64 = (validFlags & FLAG.SIZE_T_64) !== 0
  const folders = reader.sizeT(sizeTIs64)
  const files = reader.sizeT(sizeTIs64)
  if ((validFlags & FLAG.TOTAL_SIZE) !== 0) reader.u64()
  const returnedOffset = reader.sizeT(sizeTIs64)
  const returnedCount = reader.sizeT(sizeTIs64)

  const sortCount = reader.vlq()
  for (let index = 0; index < sortCount; index += 1) {
    reader.u32()
    reader.u32()
  }

  const columnCount = reader.vlq()
  const columns = []
  for (let index = 0; index < columnCount; index += 1) {
    columns.push({ id: reader.u32(), flags: reader.u32(), valueType: reader.u8() })
  }

  const results = []
  for (let index = 0; index < returnedCount; index += 1) {
    const itemFlags = reader.u8()
    const item = {}
    for (const column of columns) item[column.id] = readValue(reader, column.valueType, sizeTIs64)
    const path = typeof item[PROPERTY.FULL_PATH] === 'string' ? item[PROPERTY.FULL_PATH] : ''
    results.push({
      path,
      name: typeof item[PROPERTY.NAME] === 'string' ? item[PROPERTY.NAME] : '',
      size: typeof item[PROPERTY.SIZE] === 'bigint' ? Number(item[PROPERTY.SIZE]) : null,
      modified: formatFiletime(item[PROPERTY.DATE_MODIFIED]),
      folder: (itemFlags & 0x01) !== 0,
    })
  }

  return {
    query,
    total: folders + files,
    files,
    folders,
    offset: returnedOffset,
    returned: returnedCount,
    elapsedMs,
    results,
  }
}

/** Report the reachable pipe and the Everything build behind it. */
export async function everythingStatus(settings = {}) {
  return serialize(async () => {
    const pipe = await getConnection(settings)
    const readDword = async (code) => {
      const payload = await pipe.request(code, Buffer.alloc(0))
      if (payload.length < 4) throw new Error('malformed Everything IPC reply')
      return payload.readUInt32LE(0)
    }
    try {
      const pipeVersion = await readDword(CMD.PIPE_VERSION)
      const major = await readDword(CMD.MAJOR)
      const minor = await readDword(CMD.MINOR)
      const revision = await readDword(CMD.REVISION)
      const build = await readDword(CMD.BUILD)
      return {
        pipe: pipe.pipePath,
        pipeVersion,
        version: `${major}.${minor}.${revision}.${build}`,
      }
    } catch (error) {
      pipe.close()
      if (connection === pipe) connection = null
      throw error
    }
  })
}

/** Drop the shared connection; used when the plugin unloads. */
export function shutdown() {
  if (connection !== null) connection.close()
  connection = null
  connectionKey = ''
}
