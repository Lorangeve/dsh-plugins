/**
 * DeepSeek Harness bridge for .NET plugins.
 *
 * Starts one long-lived .NET worker, hands it a list of plugin directories, and
 * registers every tool the worker reports as a Harness tool. Calls travel as
 * newline JSON frames over the worker's stdio, so a warm call costs one
 * round-trip instead of a process start.
 *
 * Other bundles add their own plugin directories through the `dotnetHost`
 * service this plugin provides, which is how the desktop-notifications bundle
 * runs its toast sender inside .NET without shipping a worker of its own.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dotnet-host'

/** Tools are the only Harness capability the bridge needs. */
export const inject = ['tools']

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const INIT_TIMEOUT_MS = 20_000
const HEARTBEAT_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 45_000
const MAX_RESTARTS = 3

const DEFAULTS = {
  enabled: true,
  hostPath: '',
  pluginsDir: '',
  requestTimeoutMs: 30_000,
  forwardEvents: ['agent/status', 'agent/error'],
}

/**
 * The worker is a process-wide singleton: a plugin reload replaces the bridge
 * instance, so a fresh instance must reap any worker the previous one left.
 */
const LIVE_WORKERS = globalThis.__dshDotnetWorkers ??= new Set()

/** Kill every worker a previous bridge instance spawned. */
function reapWorkers() {
  for (const process of LIVE_WORKERS) {
    try {
      process.kill()
    } catch {
      // Already gone.
    }
  }
  LIVE_WORKERS.clear()
}

/** Read the row configuration. */
function resolveSettings(config) {
  const value = config !== null && typeof config === 'object' ? config : {}
  const flag = (key) => (typeof value[key] === 'boolean' ? value[key] : DEFAULTS[key])
  const text = (key, fallback) => (typeof value[key] === 'string' && value[key].trim() !== ''
    ? value[key].trim()
    : fallback)
  const positive = (key) => {
    const candidate = Number(value[key])
    return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULTS[key]
  }
  const events = Array.isArray(value.forwardEvents)
    ? value.forwardEvents.filter((entry) => typeof entry === 'string')
    : DEFAULTS.forwardEvents

  return {
    enabled: flag('enabled'),
    hostPath: text('hostPath', join(PACKAGE_DIR, 'bin', 'DshDotnet.Host.exe')),
    hostPathOverridden: typeof value.hostPath === 'string' && value.hostPath.trim() !== '',
    pluginsDir: text('pluginsDir', join(PACKAGE_DIR, 'bin', 'plugins')),
    requestTimeoutMs: positive('requestTimeoutMs'),
    forwardEvents: events,
    workerDirectory: text('workerDirectory', ''),
  }
}

/**
 * Files the worker needs beside its own executable. The rest of `bin/` (plugin
 * assemblies, WinRT projection) is only read, so it stays where the bundle was
 * installed.
 */
const WORKER_FILES = [
  'DshDotnet.Host.exe',
  'DshDotnet.Host.dll',
  'DshDotnet.Host.deps.json',
  'DshDotnet.Host.runtimeconfig.json',
  'DshDotnet.Abstractions.dll',
]

/**
 * Some endpoint-security policies drop programs launched from a development
 * drive into a restricted token: the process then cannot write `HKCU`, `%TEMP%`
 * or the Start Menu, which silently breaks toast registration. Mirroring the
 * worker into the user profile keeps it out of that policy, so the fix does not
 * depend on the bundle's checkout location.
 */
function mirroredWorkerPath(settings) {
  if (settings.hostPathOverridden) return settings.hostPath

  const source = dirname(settings.hostPath)
  const base = settings.workerDirectory
    !== ''
    ? settings.workerDirectory
    : join(process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? source, 'DeepSeekHarness', 'dotnet-host')

  try {
    mkdirSync(base, { recursive: true })
    for (const name of WORKER_FILES) {
      const from = join(source, name)
      if (!existsSync(from)) continue
      const to = join(base, name)
      const copy = !existsSync(to)
        || statSync(to).size !== statSync(from).size
        || statSync(to).mtimeMs < statSync(from).mtimeMs
      if (copy) copyFileSync(from, to)
    }
    const mirrored = join(base, 'DshDotnet.Host.exe')
    return existsSync(mirrored) ? mirrored : settings.hostPath
  } catch {
    return settings.hostPath
  }
}

/** Best-effort loader log. */
function logNote(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('dotnet-host') : ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](message)
  } catch {
    // Advisory only.
  }
}

/** Render any JSON value as readable text blocks. */
const renderJson = (_args, value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}]

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: renderJson }
const NO_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false }

/**
 * Register the bridge.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context.
 * @param {Record<string, unknown>} [config] row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  if (!settings.enabled) {
    logNote(ctx, 'info', 'the .NET bridge is disabled in this row')
    return
  }

  if (!existsSync(settings.hostPath)) {
    logNote(
      ctx,
      'warn',
      `the .NET worker is missing at ${settings.hostPath}; publish it with ` +
        '`dotnet publish src/DshDotnet.Host -c Release -o ../bin`.',
    )
    return
  }

  const extraDirectories = new Set()
  const counters = { calls: 0, failures: 0, restarts: 0, startedAt: 0, lastError: '' }

  let child
  let disposed = false
  let restarts = 0
  let sequence = 0
  let buffer = ''
  let stderrTail = ''
  let initTimer
  let heartbeat
  let lastPong = 0
  let runtime = ''
  let workerPid = 0
  let readyDeferred
  let disposers = []
  const pending = new Map()

  /** Directories the worker scans, in load order. */
  const pluginDirectories = () => {
    const directories = []
    for (const directory of [settings.pluginsDir, ...extraDirectories]) {
      if (typeof directory === 'string' && directory !== '' && !directories.includes(directory)) {
        directories.push(directory)
      }
    }
    return directories
  }

  const settleReady = () => {
    readyDeferred?.resolve()
    readyDeferred = undefined
  }

  const failReady = (reason) => {
    readyDeferred?.reject(new Error(reason))
    readyDeferred = undefined
  }

  /** Resolve once the worker has registered its tools. */
  const whenReady = async (signal) => {
    if (child !== undefined && readyDeferred === undefined) return
    if (readyDeferred === undefined) throw new Error('the .NET worker is not running')
    const timer = setTimeout(() => failReady('the .NET worker did not become ready'), INIT_TIMEOUT_MS)
    try {
      await Promise.race([
        readyDeferred.promise,
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Send one frame; false when the worker is gone. */
  const send = (frame) => {
    if (child === undefined || child.killed || child.stdin === null || !child.stdin.writable) return false
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** Call one tool and resolve with its JSON value. */
  const call = async (tool, args, signal) => {
    await whenReady(signal)
    if (child === undefined) throw new Error('the .NET worker is not running')

    return await new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        send({ type: 'cancel', id })
        reject(new Error(`'${tool}' timed out after ${settings.requestTimeoutMs} ms`))
      }, settings.requestTimeoutMs)

      const finish = (settle) => (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        settle(value)
      }

      const onAbort = () => {
        pending.delete(id)
        send({ type: 'cancel', id })
        finish(reject)(new Error(`'${tool}' was cancelled`))
      }

      if (signal?.aborted) {
        clearTimeout(timer)
        reject(new Error(`'${tool}' was cancelled`))
        return
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { resolve: finish(resolve), reject: finish(reject), tool })

      counters.calls += 1
      if (!send({ type: 'call', id, tool, args })) {
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        counters.failures += 1
        reject(new Error('the .NET worker is not accepting calls'))
      }
    })
  }

  /** Register every tool the worker reported; replaces a previous generation. */
  const publishTools = (tools) => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }

    const registered = []
    const taken = new Set()
    for (const tool of tools) {
      if (typeof tool?.name !== 'string' || taken.has(tool.name)) continue
      taken.add(tool.name)

      try {
        registered.push(ctx.tools.register({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : `${tool.name} (from the .NET worker)`,
          parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true },
          output: OUTPUT,
          timeoutMs: settings.requestTimeoutMs + 5_000,
          async execute(args, exec) {
            try {
              const value = await call(tool.name, args ?? {}, exec?.signal)
              return { ok: true, value: value ?? null }
            } catch (error) {
              counters.failures += 1
              counters.lastError = error instanceof Error ? error.message : String(error)
              throw error
            }
          },
        }))
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        logNote(ctx, 'warn', `could not register .NET tool '${tool.name}': ${message}`)
      }
    }

    disposers = registered
    logNote(ctx, 'info', `registering ${registered.length} .NET tool(s) from ${pluginDirectories().join(', ')}`)
  }

  /** Handle one protocol frame. */
  const handleFrame = (frame) => {
    switch (frame?.type) {
      case 'hello':
        runtime = `${frame.runtime ?? '?'} ${frame.arch ?? ''}`.trim()
        workerPid = Number(frame.pid) || 0
        send({ type: 'init', pluginsDirs: pluginDirectories() })
        break
      case 'ready':
        clearTimeout(initTimer)
        lastPong = Date.now()
        restarts = 0
        publishTools(Array.isArray(frame.tools) ? frame.tools : [])
        settleReady()
        break
      case 'result': {
        const waiter = pending.get(frame.id)
        if (waiter === undefined) break
        pending.delete(frame.id)
        if (frame.ok === true) {
          waiter.resolve(frame.value ?? null)
        } else {
          counters.failures += 1
          counters.lastError = typeof frame.error === 'string' ? frame.error : 'the .NET plugin failed'
          waiter.reject(new Error(counters.lastError))
        }
        break
      }
      case 'progress': {
        const waiter = pending.get(frame.id)
        const label = typeof frame.message === 'string' ? frame.message : ''
        const percent = Number.isFinite(frame.percent) ? ` (${frame.percent}%)` : ''
        logNote(ctx, 'info', `[worker] ${waiter?.tool ?? 'call'}: ${label}${percent}`)
        break
      }
      case 'log':
        logNote(ctx, frame.level === 'warn' || frame.level === 'error' ? 'warn' : 'info', `[worker] ${frame.message}`)
        break
      case 'pong':
        lastPong = Date.now()
        break
      default:
        logNote(ctx, 'info', `[worker] unrecognized frame ${JSON.stringify(frame).slice(0, 200)}`)
    }
  }

  /** Read newline frames off stdout. */
  const onStdout = (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        try {
          handleFrame(JSON.parse(line))
        } catch (error) {
          logNote(ctx, 'warn', `[worker] unreadable frame: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      index = buffer.indexOf('\n')
    }
  }

  const failPending = (reason) => {
    for (const waiter of pending.values()) waiter.reject(new Error(reason))
    pending.clear()
  }

  const retireTools = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
    disposers = []
  }

  const stop = () => {
    clearInterval(heartbeat)
    heartbeat = undefined
    clearTimeout(initTimer)
    const running = child
    child = undefined
    if (running !== undefined) LIVE_WORKERS.delete(running)
    failReady('the .NET worker stopped')
    failPending('the .NET worker stopped')
    if (running === undefined) return
    try {
      running.stdin?.end()
      running.kill()
    } catch {
      // Already gone.
    }
  }

  const start = () => {
    // One worker at a time: a registration that arrives before the life-cycle
    // effect must not leave a second, untracked process behind.
    if (disposed || child !== undefined) return
    reapWorkers()
    buffer = ''
    stderrTail = ''
    readyDeferred = { promise: undefined, resolve: undefined, reject: undefined }
    readyDeferred.promise = new Promise((resolve, reject) => {
      readyDeferred.resolve = resolve
      readyDeferred.reject = reject
    })
    // A rejection nobody awaited must not surface as an unhandled rejection.
    readyDeferred.promise.catch(() => {})

    const workerPath = mirroredWorkerPath(settings)
    if (workerPath !== settings.hostPath) {
      logNote(ctx, 'info', `the .NET worker runs from ${workerPath} (mirrored out of the bundle directory)`)
    }

    const started = spawn(workerPath, ['--plugins', settings.pluginsDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = started
    LIVE_WORKERS.add(started)
    counters.startedAt = Date.now()

    started.stdout.setEncoding('utf8')
    started.stdout.on('data', onStdout)
    started.stderr.setEncoding('utf8')
    started.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000)
    })

    initTimer = setTimeout(() => {
      const missing = pluginDirectories().filter((directory) => !existsSync(directory))
      const reason = missing.length > 0 ? ` (missing plugins directory: ${missing.join(', ')})` : ''
      logNote(ctx, 'warn', `the .NET worker did not initialize within ${INIT_TIMEOUT_MS} ms${reason}`)
      stop()
    }, INIT_TIMEOUT_MS)

    heartbeat = setInterval(() => {
      if (child === undefined) return
      if (lastPong !== 0 && Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
        logNote(ctx, 'warn', 'the .NET worker stopped answering; restarting it')
        restart()
        return
      }
      send({ type: 'ping' })
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    started.on('error', (error) => {
      clearTimeout(initTimer)
      logNote(ctx, 'warn', `the .NET worker failed to start: ${error.message}`)
    })

    started.on('exit', (code) => {
      clearTimeout(initTimer)
      // A superseded worker must not tear down the one that replaced it.
      if (child !== started) return
      LIVE_WORKERS.delete(started)
      clearInterval(heartbeat)
      heartbeat = undefined
      child = undefined
      failReady(`the .NET worker exited (code ${code})`)
      failPending(`the .NET worker exited (code ${code})`)
      retireTools()
      if (disposed) return

      if (stderrTail.trim() !== '') logNote(ctx, 'warn', `[worker stderr] ${stderrTail.trim().slice(-800)}`)
      restarts += 1
      counters.restarts += 1
      if (restarts > MAX_RESTARTS) {
        logNote(ctx, 'warn', `the .NET worker stopped ${restarts} times; giving up until the plugin reloads`)
        return
      }

      logNote(ctx, 'warn', `the .NET worker exited (code ${code}); restarting (${restarts}/${MAX_RESTARTS})`)
      setTimeout(start, 500 * restarts)
    })
  }

  const restart = () => {
    if (disposed) return
    retireTools()
    stop()
    start()
  }

  // ------------------------------------------------------------- status tool

  ctx.effect(() => ctx.tools.register({
    name: 'dotnet_host_status',
    description: 'Report the .NET worker: pid, runtime, registered tools, call counters and plugin directories. Use it when a .NET tool misbehaves.',
    parameters: NO_PARAMETERS,
    output: OUTPUT,
    async execute() {
      return {
        running: child !== undefined,
        ready: child !== undefined && readyDeferred === undefined,
        pid: workerPid,
        runtime,
        uptimeSeconds: counters.startedAt === 0 ? 0 : Math.round((Date.now() - counters.startedAt) / 1000),
        tools: disposers.length,
        calls: counters.calls,
        failures: counters.failures,
        restarts: counters.restarts,
        lastError: counters.lastError,
        pluginsDirs: pluginDirectories(),
      }
    },
  }), 'dotnet-host: status tool')

  // ----------------------------------------------------------------- service

  ctx.provide('dotnetHost', {
    /** Call one worker tool without going through the model's tool list. */
    call,
    /** Add a plugin directory; the worker restarts so the new assemblies load. */
    registerPluginDir(directory) {
      if (typeof directory !== 'string' || directory === '' || extraDirectories.has(directory)) {
        return () => {}
      }
      extraDirectories.add(directory)
      logNote(ctx, 'info', `registering extra .NET plugin directory: ${directory}`)
      restart()
      return () => {
        if (disposed) return
        if (!extraDirectories.delete(directory)) return
        restart()
      }
    },
    /** Snapshot of the bridge state. */
    status() {
      return {
        running: child !== undefined,
        pid: workerPid,
        runtime,
        tools: disposers.length,
        pluginsDirs: pluginDirectories(),
      }
    },
  })

  // -------------------------------------------------------------- life cycle

  ctx.effect(() => {
    start()
    return () => {
      disposed = true
      retireTools()
      stop()
      reapWorkers()
    }
  }, 'dotnet-host: worker')

  ctx.effect(() => {
    const handlers = settings.forwardEvents.map((eventName) => ctx.on(eventName, (...args) => {
      // Listener signatures differ; the payload is always the plain object argument.
      const payload = args.find((value) => value !== null && typeof value === 'object' && typeof value.then !== 'function')
      send({ type: 'event', name: eventName, data: payload ?? null })
    }))
    return () => {
      for (const off of handlers) off()
    }
  }, 'dotnet-host: event forwarding')
}


