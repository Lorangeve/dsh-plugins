/**
 * Client half of the desktop-notifications bundle.
 *
 * A click on a Windows toast has to reach the GUI that is already open. The
 * Host publishes the clicked session on the `desktopNotify/events` Typert
 * Remote stream, which runs over the connection the page already holds, so a
 * click switches the open window instead of opening a second one. The boot URL
 * path (`?session=<id>`) stays as the fallback for when no GUI was listening.
 */

window.__ModuleLoader__.load({
  id: '@local/desktop-notify',
  factory(require) {
    /** How long the boot URL keeps retrying while the session store warms up. */
    const BOOT_RETRY_DELAYS = [0, 300, 800, 1500, 2500, 4000]
    /** Delay before a dropped handoff stream is reopened. */
    const STREAM_RETRY_MS = 2000
    /** Wire namespace the Host serves the click handoff on. */
    const NAMESPACE = 'desktopNotify'
    /** Cordis key the mounted namespace service lives under. */
    const SERVICE = `remote.${NAMESPACE}`

    /**
     * Consumer descriptor for `desktopNotify/events`.
     *
     * The Host declares the method on its own side; this half describes how to
     * call it: a direct stream method that takes no wire arguments and yields
     * the clicked session. The Typert registry requires the invocation id and
     * accepts the source-JSON result codec, which streams do not encode with.
     */
    const DESCRIPTOR = Object.freeze({
      id: '@local/desktop-notify#desktopNotify/events',
      namespace: NAMESPACE,
      method: 'events',
      service: NAMESPACE,
      mode: 'stream',
      invocation: Object.freeze({ kind: 'direct' }),
      parameters: Object.freeze([]),
      result: Object.freeze({ mode: 'src-json' }),
    })

    const CONTRIBUTION = Object.freeze({
      package: '@local/desktop-notify',
      descriptors: Object.freeze([DESCRIPTOR]),
    })

    return {
      inject: ['uiWorkspace', 'remote'],
      apply(ctx) {
        let stopped = false

        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

        const warn = (message, error) => {
          console.warn(`[desktop-notify] ${message}`, error instanceof Error ? error.message : error)
        }

        const bindingOf = (id) => {
          try {
            return ctx.get('sessions')?.binding?.(id)
          } catch {
            return undefined
          }
        }

        /** Open a session in the main view, tolerating both target spellings. */
        const openSession = (id) => {
          if (typeof id !== 'string' || id === '') return false
          if (bindingOf(id) !== undefined) return true
          try {
            ctx.uiWorkspace.openSession(id)
            return true
          } catch (bareFailure) {
            try {
              ctx.uiWorkspace.openSession({ kind: 'session', sessionId: id })
              return true
            } catch (objectFailure) {
              warn(`could not open session ${id}:`, objectFailure)
              return false
            }
          }
        }

        /** Retry until the session store knows the session named by the boot URL. */
        const openAfterBoot = (id) => {
          let attempt = 0
          const step = () => {
            if (attempt >= BOOT_RETRY_DELAYS.length) return
            const delayMs = BOOT_RETRY_DELAYS[attempt]
            attempt += 1
            const run = () => {
              if (openSession(id)) return
              step()
            }
            if (delayMs === 0) run()
            else setTimeout(run, delayMs)
          }
          step()
        }

        /** The mounted namespace service, through either Cordis spelling. */
        const resolveNamespace = () => {
          try {
            const direct = ctx.get(SERVICE)
            if (direct !== undefined) return direct
          } catch {
            // Fall through to the parent service below.
          }
          try {
            return ctx.get('remote')?.[NAMESPACE]
          } catch {
            return undefined
          }
        }

        /** Subscribe to the Host handoff and open every session it publishes. */
        const follow = async () => {
          try {
            await ctx.remote.$mount(CONTRIBUTION)
          } catch (error) {
            warn('live session switching is unavailable:', error)
            return
          }

          let missed = 0
          while (!stopped) {
            const service = resolveNamespace()
            if (service === undefined || typeof service.events !== 'function') {
              missed += 1
              if (missed === 5) warn(`the ${SERVICE} namespace never appeared; falling back to the boot URL`)
              await delay(STREAM_RETRY_MS)
              continue
            }
            missed = 0

            try {
              for await (const item of service.events()) {
                if (stopped) return
                if (typeof item?.sessionId === 'string') openSession(item.sessionId)
              }
            } catch (error) {
              if (!stopped) warn('the notification handoff stream dropped:', error)
            }

            if (!stopped) await delay(STREAM_RETRY_MS)
          }
        }

        ctx.effect(() => {
          let initial = ''
          try {
            const url = new URL(location.href)
            initial = url.searchParams.get('session') ?? ''
            if (initial !== '') {
              url.searchParams.delete('session')
              history.replaceState(null, '', url.pathname + url.search + url.hash)
            }
          } catch {
            initial = ''
          }

          if (initial !== '') openAfterBoot(initial)

          void follow()

          return () => {
            stopped = true
          }
        }, 'desktop-notify: session routing')
      },
    }
  },
})
