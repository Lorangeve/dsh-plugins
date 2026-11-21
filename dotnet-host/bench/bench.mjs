/**
 * Measure the worker bridge as the Harness would use it: one spawn, then warm
 * calls. Run with the Harness Node runtime:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" bench/bench.mjs [iterations]
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST = join(PACKAGE_DIR, 'bin', 'DshDotnet.Host.exe')
const PLUGINS = join(PACKAGE_DIR, 'bin', 'plugins')
const iterations = Number(process.argv[2] ?? 200)

const watchdog = setTimeout(() => {
  console.error('bench timed out')
  process.exit(2)
}, 40_000)

const started = performance.now()
const child = spawn(HOST, ['--plugins', PLUGINS], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('exit', (code) => {
  if (code !== 0) console.error(`worker exited with code ${code}`)
})

let buffer = ''
let nextId = 0
const waiters = new Map()
const typeWaiters = new Map()

/** Resolve with the next frame of one type. */
function next(type) {
  return new Promise((resolve) => {
    const list = typeWaiters.get(type) ?? []
    list.push(resolve)
    typeWaiters.set(type, list)
  })
}

/** Dispatch one frame to collectors and result waiters. */
function dispatch(frame) {
  if (frame.type === 'result') {
    const waiter = waiters.get(frame.id)
    if (waiter !== undefined) {
      waiters.delete(frame.id)
      const elapsed = performance.now() - waiter.startedAt
      if (frame.ok === true) waiter.resolve({ value: frame.value, elapsed })
      else waiter.reject(new Error(frame.error))
    }
    return
  }

  const list = typeWaiters.get(frame.type)
  if (list !== undefined && list.length > 0) {
    const resolve = list.shift()
    resolve(frame)
  }
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') dispatch(JSON.parse(line))
    index = buffer.indexOf('\n')
  }
})

function startCall(tool, args = {}) {
  const id = ++nextId
  const startedAt = performance.now()
  const promise = new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject, startedAt })
  })
  child.stdin.write(`${JSON.stringify({ type: 'call', id, tool, args })}\n`)
  return { id, promise }
}

async function call(tool, args = {}) {
  return await startCall(tool, args).promise
}

const hello = await next('hello')
child.stdin.write(`${JSON.stringify({ type: 'init', pluginsDir: PLUGINS })}\n`)
const ready = await next('ready')
const coldStart = performance.now() - started

console.log(`worker: node ${hello.runtime} ${hello.arch}, pid ${hello.pid}`)
console.log(`cold start (spawn -> ready): ${coldStart.toFixed(0)} ms`)
console.log(`tools: ${ready.tools.map((tool) => tool.name).join(', ')}`)

// One warm-up call so JIT does not skew the first measured sample.
await call('hello_dotnet', { name: 'warmup' })

const samples = []
for (let index = 0; index < iterations; index++) {
  const { elapsed } = await call('hello_dotnet', { name: `n${index}` })
  samples.push(elapsed)
}

samples.sort((a, b) => a - b)
const at = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length

console.log(`warm calls: ${iterations}`)
console.log(`  p50 ${at(50).toFixed(2)} ms   p95 ${at(95).toFixed(2)} ms   p99 ${at(99).toFixed(2)} ms   mean ${mean.toFixed(2)} ms`)

const sysinfo = await call('dotnet_sysinfo')
console.log(`dotnet_sysinfo: ${JSON.stringify(sysinfo.value).slice(0, 320)}`)

const registry = await call('dotnet_read_registry', {
  path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  name: 'AppsUseLightTheme',
})
console.log(`dotnet_read_registry: ${JSON.stringify(registry.value)}`)

// Cancellation + progress: abort a 3 s call and confirm the .NET side sees it.
const slow = startCall('dotnet_slow_work', { seconds: 3 })
const progress = await next('progress')
child.stdin.write(`${JSON.stringify({ type: 'cancel', id: slow.id })}\n`)
const cancelled = await slow.promise.then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, error: error.message }),
)
console.log(`cancel test: progress="${progress.message}" (${progress.percent}%) -> ${JSON.stringify(cancelled)}`)

clearTimeout(watchdog)
child.stdin.end()
child.kill()
