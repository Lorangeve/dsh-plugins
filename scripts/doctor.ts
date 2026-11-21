#!/usr/bin/env node
/**
 * Doctor for the .NET halves of these plugins.
 *
 * Answers one question: on this machine, can `@local/dotnet-host` and
 * `@local/desktop-notify` actually run — and if not, what is missing?
 *
 * TypeScript, executed directly through Node's type stripping (Node >= 22.18,
 * or 23.6+ where it is enabled by default), so there is no build step and no
 * dependency. Usage: node scripts/doctor.ts [--json]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Level = 'ok' | 'warn' | 'fail'

interface Finding {
  id: string
  level: Level
  title: string
  detail: string
  fix?: string
}

interface CommandResult {
  found: boolean
  status: number | null
  stdout: string
  stderr: string
}

/** One published payload the plugins need at run time. */
interface Payload {
  id: string
  directory: string
  files: string[]
  marker: string
  sources: string[]
}

const PAYLOADS: Payload[] = [
  {
    id: 'dotnet-host',
    directory: 'dotnet-host/bin',
    files: [
      'DshDotnet.Abstractions.dll',
      'DshDotnet.Host.dll',
      'DshDotnet.Host.deps.json',
      'DshDotnet.Host.runtimeconfig.json',
      ...(process.platform === 'win32' ? ['DshDotnet.Host.exe'] : []),
    ],
    marker: 'DshDotnet.Host.dll',
    sources: ['dotnet-host/src'],
  },
  {
    id: 'example-plugin',
    directory: 'dotnet-host/bin/plugins',
    files: ['Example.Plugin.dll', 'Example.Plugin.deps.json'],
    marker: 'Example.Plugin.dll',
    sources: ['dotnet-host/src/Example.Plugin'],
  },
  {
    id: 'desktop-notify',
    directory: 'desktop-notify/dotnet-plugins',
    files: ['DshDotnet.Notify.dll', 'WinRT.Runtime.dll', 'Microsoft.Windows.SDK.NET.dll'],
    marker: 'DshDotnet.Notify.dll',
    sources: ['desktop-notify/src'],
  },
]

const JSON_MODE = process.argv.includes('--json')

const findings: Finding[] = []
const add = (finding: Finding): void => {
  findings.push(finding)
}

/** Run a command without throwing; tolerate a missing executable. */
function capture(command: string, argv: string[]): CommandResult {
  const result = spawnSync(command, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  return {
    found: !result.error,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/** PIDs of running DshDotnet.Host workers, if the OS can tell us. */
function runningWorkers(): string[] {
  if (process.platform === 'win32') {
    const result = capture('tasklist', ['/FI', 'IMAGENAME eq DshDotnet.Host.exe', '/FO', 'CSV', '/NH'])
    if (!result.found) return []
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.split(','))
      .filter((fields) => fields.length > 1 && fields[0].includes('DshDotnet.Host.exe'))
      .map((fields) => fields[1].replaceAll('"', '').trim())
  }
  const result = capture('ps', ['-A', '-o', 'pid=,comm='])
  if (!result.found) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1]?.includes('DshDotnet.Host') === true)
    .map((fields) => fields[0])
}

/** Every regular file below a directory, depth-first. */
function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** Latest modification time of the C# sources below the given directories. */
function newestSource(directories: string[]): number {
  let newest = 0
  for (const directory of directories) {
    const full = path.join(ROOT, directory)
    if (!existsSync(full)) continue
    for (const file of walk(full)) {
      if (!/\.(cs|csproj|props|targets)$/i.test(file)) continue
      newest = Math.max(newest, statSync(file).mtimeMs)
    }
  }
  return newest
}

/** Pretty-print a byte count. */
function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Spawn the published worker and wait for its `hello` frame, which proves the
 * binary starts, finds the runtime and speaks the protocol the bridge expects.
 */
async function probeWorker(executable: string): Promise<{ ok: boolean; detail: string }> {
  const pluginDirectory = path.join(ROOT, 'dotnet-host/bin/plugins')
  return await new Promise((resolve) => {
    const child = spawn(executable, ['--plugins', pluginDirectory], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    let settled = false
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // The worker may already be gone.
      }
      resolve({ ok, detail })
    }
    const timer = setTimeout(() => finish(false, 'worker did not answer within 15 s'), 15_000)
    let stderrTail = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') {
          try {
            const frame = JSON.parse(line) as Record<string, unknown>
            if (frame.type === 'hello') {
              const protocol = frame.protocol ?? '?'
              const runtime = typeof frame.runtime === 'string' ? frame.runtime : 'runtime unknown'
              finish(true, `protocol ${protocol}, ${runtime}`)
            }
          } catch {
            // A non-JSON line before hello is not fatal.
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-400)
    })
    child.on('error', (error: Error) => finish(false, error.message))
    child.on('exit', (code: number | null) =>
      finish(false, stderrTail.trim() === '' ? `worker exited with code ${code ?? 'null'}` : `worker exited with code ${code ?? 'null'}: ${stderrTail.trim()}`),
    )
  })
}

/** Check the DSH desktop profile wiring, if the profile exists at all. */
function checkProfile(): void {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profile = path.join(home, 'profiles', 'desktop')
  const manifest = path.join(profile, 'package.json')
  const bundles = ['@local/dotnet-host', '@local/desktop-notify']

  if (!existsSync(manifest)) {
    add({
      id: 'profile',
      level: 'warn',
      title: 'profile',
      detail: `desktop profile not found at ${profile}; install the plugins once DSH has been started`,
      fix: 'start the DSH desktop app, then install the bundles from Settings → Plugins',
    })
    return
  }

  let manifestJson: Record<string, unknown>
  try {
    manifestJson = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  } catch (error) {
    add({
      id: 'profile',
      level: 'fail',
      title: 'profile',
      detail: `${manifest} does not parse: ${(error as Error).message}`,
      fix: 'repair or restore the profile package.json before installing plugins',
    })
    return
  }

  const dependencies = (manifestJson.dependencies ?? {}) as Record<string, string>
  const profileBlock = (manifestJson.dsh as Record<string, unknown> | undefined)?.profile as
    | { bundles?: string[] }
    | undefined
  const installedBundles = profileBlock?.bundles ?? []
  const missingBundles = bundles.filter((name) => !installedBundles.includes(name))
  const missingLinks = bundles.filter((name) => !existsSync(path.join(profile, 'node_modules', name)))

  if (missingBundles.length > 0) {
    add({
      id: 'profile',
      level: 'warn',
      title: 'profile',
      detail: `not in dsh.profile.bundles: ${missingBundles.join(', ')}`,
      fix: 'install the bundles from Settings → Plugins (local directory), then restart DSH',
    })
  } else if (missingLinks.length > 0) {
    add({
      id: 'profile',
      level: 'fail',
      title: 'profile',
      detail: `bundle listed but not linked into node_modules: ${missingLinks.join(', ')}`,
      fix: 'reinstall the bundle from Settings → Plugins; the link is missing',
    })
  } else {
    const linked = bundles.filter((name) => typeof dependencies[name] === 'string')
    add({
      id: 'profile',
      level: 'ok',
      title: 'profile',
      detail: `${bundles.length} bundles installed and linked${linked.length === bundles.length ? '' : ' (check dependencies)'}`,
    })
  }
}

// --- checks -----------------------------------------------------------------

add({
  id: 'platform',
  level: process.platform === 'win32' ? 'ok' : 'warn',
  title: 'platform',
  detail: `${os.type()} ${os.release()} ${process.arch}`,
  ...(process.platform === 'win32'
    ? {}
    : { fix: 'the worker and the toast sender are verified on Windows only' }),
})

add({
  id: 'node',
  level: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'warn',
  title: 'node',
  detail: `v${process.versions.node}`,
  ...(Number(process.versions.node.split('.')[0]) >= 22
    ? {}
    : { fix: 'use the Node that ships with DSH (24.x) or any Node >= 22.18' }),
})

const sdkProbe = capture('dotnet', ['--list-sdks'])
if (!sdkProbe.found) {
  add({
    id: 'dotnet-sdk',
    level: 'fail',
    title: '.NET SDK',
    detail: 'the `dotnet` CLI was not found',
    fix: 'install the .NET 10 SDK: https://dotnet.microsoft.com/download/dotnet/10.0',
  })
} else {
  const versions = sdkProbe.stdout
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[0])
    .filter((version) => version !== '')
  const modern = versions.filter((version) => Number(version.split('.')[0]) >= 10)
  add({
    id: 'dotnet-sdk',
    level: modern.length > 0 ? 'ok' : 'fail',
    title: '.NET SDK',
    detail: modern.length > 0 ? modern[modern.length - 1] : `none of ${versions.join(', ') || 'none'} is 10.x`,
    ...(modern.length > 0
      ? {}
      : { fix: 'install the .NET 10 SDK to build the payloads: https://dotnet.microsoft.com/download/dotnet/10.0' }),
  })
}

const runtimeProbe = capture('dotnet', ['--list-runtimes'])
const runtimes = runtimeProbe.found
  ? runtimeProbe.stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^Microsoft\.NETCore\.App\s+(\S+)/)?.[1])
      .filter((version): version is string => typeof version === 'string')
  : []
const modernRuntimes = runtimes.filter((version) => Number(version.split('.')[0]) >= 10)
add({
  id: 'dotnet-runtime',
  level: modernRuntimes.length > 0 ? 'ok' : 'fail',
  title: '.NET runtime',
  detail:
    modernRuntimes.length > 0
      ? `Microsoft.NETCore.App ${modernRuntimes[modernRuntimes.length - 1]}`
      : 'no .NET 10 runtime',
  ...(modernRuntimes.length > 0
    ? {}
    : { fix: 'the worker is framework-dependent; install the .NET 10 runtime' }),
})

let needsBuild = false
for (const payload of PAYLOADS) {
  const directory = path.join(ROOT, payload.directory)
  if (!existsSync(directory)) {
    needsBuild = true
    add({
      id: `payload:${payload.id}`,
      level: 'fail',
      title: 'payload',
      detail: `${payload.directory} does not exist`,
      fix: 'run `npm run build:dotnet` (needs the .NET 10 SDK)',
    })
    continue
  }

  const missing = payload.files.filter((file) => !existsSync(path.join(directory, file)))
  if (missing.length > 0) {
    needsBuild = true
    add({
      id: `payload:${payload.id}`,
      level: 'fail',
      title: 'payload',
      detail: `${payload.directory} is missing ${missing.join(', ')}`,
      fix: 'run `npm run build:dotnet` (needs the .NET 10 SDK)',
    })
    continue
  }

  const total = walk(directory).reduce((sum, file) => sum + statSync(file).size, 0)
  const payloadTime = statSync(path.join(directory, payload.marker)).mtimeMs
  const sourceTime = newestSource(payload.sources)
  if (sourceTime > payloadTime) {
    needsBuild = true
    add({
      id: `payload:${payload.id}`,
      level: 'warn',
      title: 'payload',
      detail: `${payload.directory} (${size(total)}) is older than its C# sources`,
      fix: 'rebuild with `npm run build:dotnet`',
    })
  } else {
    add({ id: `payload:${payload.id}`, level: 'ok', title: 'payload', detail: `${payload.directory} (${size(total)})` })
  }
}

if (needsBuild) {
  const workers = runningWorkers()
  if (workers.length > 0) {
    add({
      id: 'worker-lock',
      level: 'warn',
      title: 'worker lock',
      detail: `DshDotnet.Host is running (pid ${workers.join(', ')}); its plugin DLLs are in use`,
      fix: 'disable @local/dotnet-host in the plugin page (or quit DSH) before `npm run build:dotnet`',
    })
  }
}

const executable = path.join(ROOT, 'dotnet-host/bin', process.platform === 'win32' ? 'DshDotnet.Host.exe' : 'DshDotnet.Host')
if (process.platform === 'win32' && existsSync(executable) && modernRuntimes.length > 0) {
  const worker = await probeWorker(executable)
  add({
    id: 'worker',
    level: worker.ok ? 'ok' : 'fail',
    title: 'worker',
    detail: worker.detail,
    ...(worker.ok ? {} : { fix: 'run `npm run build:dotnet --clean`, then retry; check the DSH log for the worker stderr' }),
  })
}

checkProfile()

// --- report -----------------------------------------------------------------

const failed = findings.filter((finding) => finding.level === 'fail')
const warned = findings.filter((finding) => finding.level === 'warn')
const ok = findings.filter((finding) => finding.level === 'ok')

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: failed.length === 0, findings }, null, 2))
} else {
  const symbols: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' }
  console.log(`dsh-plugins doctor · ${os.type()} ${os.release()} ${process.arch} · node v${process.versions.node}`)
  console.log('')
  for (const finding of findings) {
    console.log(`${symbols[finding.level]} ${finding.title.padEnd(13)} ${finding.detail}`)
    if (finding.fix !== undefined) console.log(`  ${' '.repeat(14)}→ ${finding.fix}`)
  }
  console.log('')
  const summary = `${failed.length} failure(s), ${warned.length} warning(s), ${ok.length} ok`
  console.log(failed.length === 0 ? `doctor: ${summary} — the .NET plugins can run` : `doctor: ${summary}`)
}

process.exit(failed.length === 0 ? 0 : 1)
