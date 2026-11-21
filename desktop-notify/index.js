/**
 * Desktop notifications bundle.
 *
 * Raises a Windows notification when a session finishes its work or needs the
 * user (an approval, a question, or an error), and routes a click on that
 * notification back to the session it came from.
 *
 * The toast itself is raised inside the .NET worker from the
 * `@local/dotnet-host` bundle: this plugin contributes a small .NET plugin
 * directory, so no PowerShell process is started per notification.
 *
 * Three pieces cooperate:
 * - This Host half observes agent status, approval and question events, and
 *   asks the .NET bridge to raise each toast.
 * - `dotnet-plugins/DshDotnet.Notify.dll` registers the AppUserModelID, Start
 *   Menu shortcut and `dshnotify:` URI scheme, then shows the toast.
 * - `dotnet-host`'s `--open` mode handles the click, and the Client half opens
 *   the session either from a `?session=` boot URL (no GUI was open) or from
 *   the `desktopNotify/events` Typert Remote stream (a GUI is open and switches
 *   to it). The stream runs over the connection the page already holds, so a
 *   click never opens a second window.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'desktop-notify'

/** The local HTTP routes need the Web carrier; the reminder tool needs the registry. */
export const inject = ['webServer', 'tools']

const OPEN_ROUTE = '/dsh-notify/open'
/** Read-only probe: how many GUIs are subscribed to the click handoff. */
const STATUS_ROUTE = '/dsh-notify/status'
/** Cordis service key the GUI reaches through `ctx.remote.desktopNotify`. */
const SERVICE_KEY = 'desktopNotify'
/** How long one handoff read waits before the stream re-checks cancellation. */
const HANDOFF_IDLE_MS = 15_000
/** Marker property the API Gateway's source-mode Remote discovery reads. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const ATTENTION_DEDUPE_MS = 8_000
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** Output rendering for the model-facing notification tool. */
const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const DEFAULTS = {
  notifyOnComplete: true,
  notifyOnAttention: true,
  notifyOnError: true,
  minTaskSeconds: 5,
  selfTestOnStart: false,
  dotnetPluginsDir: '',
}

/** Read the row configuration, ignoring values of the wrong shape. */
function resolveSettings(config) {
  const value = config !== null && typeof config === 'object' ? config : {}
  const flag = (key) => (typeof value[key] === 'boolean' ? value[key] : DEFAULTS[key])
  const seconds = Number(value.minTaskSeconds)
  return {
    notifyOnComplete: flag('notifyOnComplete'),
    notifyOnAttention: flag('notifyOnAttention'),
    notifyOnError: flag('notifyOnError'),
    selfTestOnStart: flag('selfTestOnStart'),
    minTaskSeconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULTS.minTaskSeconds,
    dotnetPluginsDir: typeof value.dotnetPluginsDir === 'string' && value.dotnetPluginsDir.trim() !== ''
      ? value.dotnetPluginsDir.trim()
      : join(PACKAGE_DIR, 'dotnet-plugins'),
  }
}

/** Best-effort loader log; a missing logger must not break notification delivery. */
function logNote(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('desktop-notify') : ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](message)
  } catch {
    // Advisory only.
  }
}

/** Human-readable elapsed time for the notification body. */
function describeDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** Clamp a value that reaches a one-line toast. */
function oneLine(value, limit) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Extract a readable message from anything an event carries as an error. */
function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * One-way handoff between a toast click and the GUI that is already open.
 *
 * The click arrives as an HTTP request from the .NET worker; the GUI listens
 * over the Typert Remote stream, so the session id travels on the connection
 * the page already holds. A click with no subscriber reports that so the
 * worker can fall back to opening a browser.
 */
function createHandoff() {
  /** Items waiting for the next read. */
  const queue = []
  /** Reads parked until a click or the idle timeout resolves them. */
  let waiters = []
  let live = 0
  let closed = false

  /** Resolve one parked read once and drop it from the list. */
  const settle = (waiter, item) => {
    const index = waiters.indexOf(waiter)
    if (index >= 0) waiters.splice(index, 1)
    waiter(item)
  }

  return {
    /** Number of subscribed GUIs; a click with none falls back to a browser. */
    get live() {
      return live
    },
    enter() {
      live += 1
    },
    leave() {
      live = Math.max(0, live - 1)
    },
    /**
     * Hand one clicked session to a subscribed GUI.
     * @param {{ sessionId: string }} item the wire value the stream yields.
     * @returns the number of live subscribers, which decides the click fallback.
     */
    push(item) {
      if (closed || live === 0) return live
      const waiter = waiters.shift()
      if (waiter === undefined) queue.push(item)
      else settle(waiter, item)
      return live
    },
    /**
     * Wait for the next click, waking up so the caller can re-check its signal.
     * @param {number} timeoutMs idle wake-up interval.
     * @returns the next item, or undefined when the wait expired or closed.
     */
    take(timeoutMs) {
      if (closed) return Promise.resolve(undefined)
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve) => {
        let timer
        const waiter = (item) => {
          clearTimeout(timer)
          resolve(item)
        }
        timer = setTimeout(() => settle(waiter, undefined), timeoutMs)
        timer.unref?.()
        waiters.push(waiter)
      })
    },
    /** Wake every read so the streams can finish with the plugin. */
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) waiter(undefined)
      queue.length = 0
    },
  }
}

/**
 * The Remote service the GUI subscribes to.
 *
 * The API Gateway discovers it through its source-mode path: the `typertRemote`
 * binding names the wire namespace, and the prototype marker below declares
 * `events` as a stream method. The getter keeps the binding consistent with
 * whichever view of this Service a call resolves.
 */
class DesktopNotifyRemote {
  constructor(handoff) {
    this.handoff = handoff
  }

  /** Visible binding the Gateway's source-mode discovery reads. */
  get typertRemote() {
    return { service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY }
  }

  /**
   * Yield each clicked session for as long as the GUI stays subscribed.
   * @param {AbortSignal} [signal] carrier cancellation, injected by the Gateway.
   * @yields the clicked session id.
   */
  async *events(signal) {
    this.handoff.enter()
    try {
      for (;;) {
        const item = await this.handoff.take(HANDOFF_IDLE_MS)
        if (signal?.aborted === true) return
        if (item !== undefined) yield item
      }
    } finally {
      this.handoff.leave()
    }
  }
}

Object.defineProperty(DesktopNotifyRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'events', mode: 'stream', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})

/**
 * Register desktop notifications.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context.
 * @param {Record<string, unknown>} [config] row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const token = randomUUID()
  const runningSince = new Map()
  const recentAttention = new Map()
  const handoff = createHandoff()
  let disposed = false
  let dotnetHost
  let warnedUnavailable = false

  if (!existsSync(settings.dotnetPluginsDir)) {
    logNote(
      ctx,
      'warn',
      'desktop notifications are inactive: the .NET notification plugin is missing at '
        + `"${settings.dotnetPluginsDir}". Build it with ` +
        '`npm run build:dotnet` at the repository root (needs the .NET 10 SDK).',
    )
    return
  }

  /** The loopback origin the click handler calls back. */
  const origin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return ''
    }
  }

  /**
   * The URL a browser may actually open: the bare origin is refused with
   * "dsh web authentication required", while this one carries the credential.
   */
  const browserUrl = () => {
    const base = origin()
    if (base === '') return ''
    try {
      return ctx.get('connection')?.authenticatedUrl(base) ?? base
    } catch {
      return base
    }
  }

  /** The session title, used as the notification heading when it exists. */
  const titleOf = (sessionId) => {
    try {
      const session = ctx.get('sessions')?.get(sessionId)
      if (session === undefined) return ''
      const snapshot = ctx.get('sessionTitle')?.get(session)
      if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') return snapshot.title.trim()
      const header = session.header
      return typeof header?.title === 'string' ? header.title.trim() : ''
    } catch {
      return ''
    }
  }

  /** Raise one toast through the .NET bridge; never throws into an event handler. */
  const notify = (options) => {
    if (disposed) return
    const url = origin()
    if (url === '') return

    if (dotnetHost === undefined) {
      if (!warnedUnavailable) {
        warnedUnavailable = true
        logNote(ctx, 'warn', 'no .NET bridge is mounted, so no notification can be raised; install and enable @local/dotnet-host')
      }
      return
    }

    const toast = {
      title: oneLine(options.title, 96),
      body: oneLine(options.body, 220),
      kind: options.kind,
      session: options.sessionId ?? '',
      origin: url,
      url: browserUrl(),
      token,
      action: options.action,
      app: process.execPath,
    }

    dotnetHost.call('desktop_toast', toast).then((result) => {
      if (result?.shown === true) return
      logNote(ctx, 'warn', `the .NET toast sender reported no notification: ${JSON.stringify(result ?? null)}`)
    }, (error) => {
      logNote(ctx, 'warn', `the .NET toast sender failed: ${errorText(error)}`)
    })
  }

  /** Keep one notification per session and reason from repeating within a few seconds. */
  const allowAttention = (key) => {
    const now = Date.now()
    const last = recentAttention.get(key) ?? 0
    if (now - last < ATTENTION_DEDUPE_MS) return false
    recentAttention.set(key, now)
    return true
  }

  // ------------------------------------------------------------------ routes

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_ROUTE,
    handler: (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const session = url.searchParams.get('session') ?? ''
      const supplied = url.searchParams.get('token') ?? ''
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      if (supplied !== token) {
        response.statusCode = 403
        response.end(JSON.stringify({ delivered: false, reason: 'token' }))
        return
      }

      if (session === '') {
        response.statusCode = 400
        response.end(JSON.stringify({ delivered: false, reason: 'session' }))
        return
      }

      const subscribers = handoff.push({ sessionId: session })
      response.end(JSON.stringify({ delivered: subscribers > 0, subscribers }))
    },
  }), 'desktop-notify: open route')

  // The GUI reaches the click handoff through `ctx.remote.desktopNotify`.
  const remoteService = new DesktopNotifyRemote(handoff)
  ctx.effect(() => ctx.provide(SERVICE_KEY, remoteService), 'desktop-notify: handoff service')

  // Read-only probe: a subscribed GUI proves the Remote stream is live.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_ROUTE,
    handler: (_request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify({ subscribers: handoff.live }))
    },
  }), 'desktop-notify: status route')

  ctx.effect(() => () => {
    disposed = true
    handoff.close()
  }, 'desktop-notify: handoff shutdown')

  // A model-facing way to raise a notification for the current session.
  ctx.effect(() => ctx.tools.register({
    name: 'desktop_notify',
    description: 'Raise a Windows notification for the current session; clicking it returns to this session. '
      + 'Use it when the user asks to be reminded, or to notify them that something needs attention.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Notification heading, kept to one line.' },
        body: { type: 'string', description: 'Optional second line shown under the heading.' },
      },
      required: ['title'],
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const sessionId = ctx.get('agents')?.currentInitiator()?.id ?? ''
      const url = origin()
      if (url === '' || dotnetHost === undefined) {
        throw new Error('desktop notifications are unavailable: no .NET bridge or Web origin')
      }

      const result = await dotnetHost.call('desktop_toast', {
        title: oneLine(args?.title ?? '', 96),
        body: oneLine(args?.body ?? '', 220),
        kind: 'complete',
        session: sessionId,
        origin: url,
        url: browserUrl(),
        token,
        action: '打开会话',
        app: process.execPath,
      })

      return {
        sent: result?.shown === true,
        sessionId,
        ...(result?.shown === true ? {} : { result }),
      }
    },
  }), 'desktop-notify: notify tool')

  // The .NET bridge is required: it owns the toast and the click handler.
  ctx.effect(() => {
    let releaseDirectory
    const disposeInject = ctx.inject(['dotnetHost'], (scoped) => {
      dotnetHost = scoped.dotnetHost
      warnedUnavailable = false
      try {
        releaseDirectory = dotnetHost.registerPluginDir(settings.dotnetPluginsDir)
      } catch (error) {
        logNote(ctx, 'warn', `could not register the .NET notification plugin: ${errorText(error)}`)
      }

      return () => {
        releaseDirectory?.()
        releaseDirectory = undefined
      }
    })

    return () => {
      try {
        disposeInject?.()
      } catch {
        // The injection was already disposed with the context.
      }
      dotnetHost = undefined
    }
  }, 'desktop-notify: .NET bridge')

  // --------------------------------------------------------------- listeners

  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      const sessionId = agent?.id
      if (typeof sessionId !== 'string') return
      if (status === 'running') {
        runningSince.set(sessionId, Date.now())
        return
      }

      const startedAt = runningSince.get(sessionId)
      runningSince.delete(sessionId)
      if (!settings.notifyOnComplete) return
      const elapsed = startedAt === undefined ? undefined : Date.now() - startedAt
      if (elapsed !== undefined && elapsed < settings.minTaskSeconds * 1000) return

      notify({
        title: titleOf(sessionId) || '会话已完成',
        body: elapsed === undefined ? '任务已结束，可以继续对话。' : `任务已完成，用时 ${describeDuration(elapsed)}。`,
        kind: 'complete',
        action: '打开会话',
        sessionId,
      })
    })

    const offError = ctx.on('agent/error', ({ agent, error }) => {
      const sessionId = agent?.id
      if (typeof sessionId !== 'string' || !settings.notifyOnError) return
      if (!allowAttention(sessionId)) return
      notify({
        title: titleOf(sessionId) || '任务出错',
        body: oneLine(errorText(error), 200) || '会话执行过程中出现错误。',
        kind: 'error',
        action: '查看会话',
        sessionId,
      })
    })

    const offApproval = ctx.on('approval/request', (request, next) => {
      const sessionId = request?.agent?.id
      if (typeof sessionId === 'string' && settings.notifyOnAttention && allowAttention(sessionId)) {
        const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason ?? ''
        const tool = request.toolName ? `工具 ${request.toolName}` : '一个操作'
        notify({
          title: titleOf(sessionId) || '需要你确认',
          body: reason === '' ? `${tool} 正在等待你的确认。` : oneLine(reason, 200),
          kind: 'attention',
          action: '去确认',
          sessionId,
        })
      }
      return next()
    })

    const offQuestions = ctx.on('user-questions/request', (request, next) => {
      const sessionId = request?.agent?.id
      if (typeof sessionId === 'string' && settings.notifyOnAttention && allowAttention(sessionId)) {
        const questions = Array.isArray(request.questions) ? request.questions : []
        const first = questions[0]
        const text = typeof first?.question === 'string'
          ? first.question
          : typeof first?.header === 'string' ? first.header : ''
        notify({
          title: titleOf(sessionId) || '需要你回答',
          body: text === '' ? `有 ${questions.length} 个问题等待你的回答。` : oneLine(text, 200),
          kind: 'attention',
          action: '去回答',
          sessionId,
        })
      }
      return next()
    })

    return () => {
      offStatus()
      offError()
      offApproval()
      offQuestions()
    }
  }, 'desktop-notify: agent listeners')

  if (settings.selfTestOnStart) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        const first = ctx.get('sessions')?.list?.()[0]
        notify({
          title: '桌面通知已启用',
          body: '这条通知来自 DeepSeek Harness；点击它可以回到发起通知的会话。',
          kind: 'complete',
          action: '打开会话',
          sessionId: first?.id ?? '',
        })
      }, 1_200)
      return () => clearTimeout(timer)
    }, 'desktop-notify: self test')
  }
}






