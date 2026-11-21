#!/usr/bin/env node
/**
 * Build the .NET halves of the plugins.
 *
 * The repository ships no binaries: `dotnet-host/bin/` and
 * `desktop-notify/dotnet-plugins/` are produced here from the C# sources and
 * are git-ignored. Requires the .NET 10 SDK (to build) — the runtime alone is
 * enough to run the result, which `npm run doctor` verifies.
 *
 * Usage: node scripts/build-dotnet.mjs [--clean] [--project <id>]...
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Projects to publish, in dependency order. */
const TARGETS = [
  {
    id: 'dotnet-host',
    project: 'dotnet-host/src/DshDotnet.Host/DshDotnet.Host.csproj',
    output: 'dotnet-host/bin',
    expects: [
      'DshDotnet.Abstractions.dll',
      'DshDotnet.Host.dll',
      'DshDotnet.Host.deps.json',
      'DshDotnet.Host.runtimeconfig.json',
      ...(process.platform === 'win32' ? ['DshDotnet.Host.exe'] : []),
    ],
  },
  {
    id: 'example-plugin',
    project: 'dotnet-host/src/Example.Plugin/Example.Plugin.csproj',
    output: 'dotnet-host/bin/plugins',
    expects: ['Example.Plugin.dll', 'Example.Plugin.deps.json'],
  },
  {
    id: 'desktop-notify',
    project: 'desktop-notify/src/DshDotnet.Notify/DshDotnet.Notify.csproj',
    output: 'desktop-notify/dotnet-plugins',
    expects: [
      'DshDotnet.Notify.dll',
      'DshDotnet.Notify.deps.json',
      'WinRT.Runtime.dll',
      'Microsoft.Windows.SDK.NET.dll',
    ],
  },
]

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/build-dotnet.mjs [--clean] [--project <id>]...')
  console.log(`Projects: ${TARGETS.map((target) => target.id).join(', ')}`)
  process.exit(0)
}

const clean = args.includes('--clean')
const selected = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--project') {
    const id = args[index + 1]
    if (!id) fail('--project needs a project id')
    selected.push(id)
    index += 1
  }
}

const targets = selected.length === 0 ? TARGETS : TARGETS.filter((target) => selected.includes(target.id))
const unknown = selected.filter((id) => !TARGETS.some((target) => target.id === id))
if (unknown.length > 0) fail(`unknown project ${unknown.map((id) => `"${id}"`).join(', ')}`)
if (targets.length === 0) fail('no project matched')

/** Stop with a one-line explanation, no stack trace. */
function fail(message) {
  console.error(`build-dotnet: ${message}`)
  process.exit(1)
}

/** Run a command and return { status, stdout, stderr } with utf8 text. */
function run(command, argv, options = {}) {
  return spawnSync(command, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  })
}

const probe = run('dotnet', ['--list-sdks'], { quiet: true })
if (probe.error) {
  fail(
    'the `dotnet` CLI was not found. Install the .NET 10 SDK: ' +
      'https://dotnet.microsoft.com/download/dotnet/10.0',
  )
}
if (probe.status !== 0) fail(`\`dotnet --list-sdks\` failed: ${(probe.stderr || probe.stdout).trim()}`)

const sdks = probe.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => ({ version: line.split(/\s+/)[0], root: line.replace(/^[^\[]*\[?/, '').replace(/\]$/, '') }))
const usable = sdks.filter((sdk) => Number(sdk.version.split('.')[0]) >= 10)
if (usable.length === 0) {
  fail(
    `no .NET 10 SDK found (have: ${sdks.map((sdk) => sdk.version).join(', ') || 'none'}). ` +
      'The projects target net10.0; install it from https://dotnet.microsoft.com/download/dotnet/10.0',
  )
}

console.log(`build-dotnet: SDK ${usable[usable.length - 1].version}, ${targets.length} project(s)${clean ? ', clean' : ''}`)

const built = []
for (const target of targets) {
  const projectPath = path.join(ROOT, target.project)
  const outputPath = path.join(ROOT, target.output)
  if (!existsSync(projectPath)) fail(`missing project file ${target.project}`)

  if (clean) rmSync(outputPath, { recursive: true, force: true })
  mkdirSync(outputPath, { recursive: true })

  console.log(`\nbuild-dotnet: publishing ${target.id} -> ${target.output}`)
  const result = run('dotnet', ['publish', projectPath, '-c', 'Release', '-o', outputPath])
  if (result.status !== 0) {
    console.error(
      `\nbuild-dotnet: ${target.id} failed (exit ${result.status ?? 'signal'}).\n` +
        'If the error says a file is in use, the .NET worker is still running: disable ' +
        '"@local/dotnet-host" in the plugin page (or restart DSH), then build again.',
    )
    process.exit(result.status ?? 1)
  }

  const missing = target.expects.filter((name) => !existsSync(path.join(outputPath, name)))
  if (missing.length > 0) fail(`${target.id}: publish finished but ${missing.join(', ')} is missing`)

  built.push({ id: target.id, output: target.output, bytes: directorySize(outputPath) })
}

console.log('\nbuild-dotnet: done')
for (const item of built) {
  console.log(`  ${item.id.padEnd(15)} ${formatMb(item.bytes).padStart(9)}  ${item.output}`)
}
console.log('\nNext: reload the plugins in DSH (or restart it), then run `npm run doctor`.')

/** Sum the size of every regular file below a directory. */
function directorySize(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) total += directorySize(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

/** Pretty-print a byte count. */
function formatMb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
