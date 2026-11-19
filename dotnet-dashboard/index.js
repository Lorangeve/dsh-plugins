/**
 * Host half of the .NET dashboard bundle.
 *
 * It collects one JSON snapshot of the local .NET SDK, NuGet configuration and
 * the current workspace's .NET project, then publishes it through two callers
 * that share the same collector:
 *
 * - `dotnet_status`, an agent tool, so the model can read the same facts;
 * - `GET /dotnet/status`, the read-only route the Client panel fetches.
 *
 * The route is authenticated with the browser credential when the Web
 * connection service is mounted; probe output is cached briefly because every
 * `dotnet` invocation costs about a second.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const inject = ['tools'];

const ROUTE_PATH = '/dotnet/status';
const PROBE_TIMEOUT_MS = 8000;
const SNAPSHOT_TTL_MS = 60_000;
const SDK_TTL_MS = 5 * 60_000;
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_ENTRIES = 4000;

const SKIP_DIRECTORIES = new Set([
  'node_modules', 'bin', 'obj', '.git', '.vs', '.idea', '.vscode',
  'packages', 'artifacts', 'TestResults', 'dist', 'build', '.dsh-src',
]);

const PROJECT_EXTENSIONS = ['.csproj', '.fsproj', '.vbproj'];
const SOLUTION_EXTENSIONS = ['.sln', '.slnx'];

const CHILD_ENV = {
  ...process.env,
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
};

/** @type {Map<string, {at: number, value: unknown}>} */
const sdkCache = new Map();
/** @type {Map<string, {at: number, value: unknown}>} */
const snapshotCache = new Map();

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Run one process without a shell, never rejecting on a non-zero exit.
 * @param {string} file executable name or absolute path.
 * @param {string[]} args arguments.
 * @param {{cwd?: string, timeout?: number}} options spawn options.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error: string|null}>}
 */
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const callback = (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        error: error === null || error === undefined ? null : String(error.message ?? error),
      });
    };
    try {
      execFile(
        file,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeout ?? PROBE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: CHILD_ENV,
        },
        callback,
      );
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: String(error instanceof Error ? error.message : error),
      });
    }
  });
}

/** Candidate executable paths for the .NET host, most authoritative first. */
function dotnetCandidates() {
  const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const candidates = ['dotnet'];
  if (process.env.DOTNET_ROOT) candidates.push(path.join(process.env.DOTNET_ROOT, exe));
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'dotnet', exe));
    candidates.push(path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'dotnet', exe));
  } else {
    candidates.push('/usr/local/share/dotnet/dotnet', '/usr/share/dotnet/dotnet', '/usr/bin/dotnet');
    candidates.push(path.join(homedir(), '.dotnet', 'dotnet'));
  }
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * Locate a working `dotnet` and read its version.
 * @returns {Promise<{found: boolean, executable: string|null, version: string|null}>}
 */
async function locateDotnet() {
  for (const candidate of dotnetCandidates()) {
    if (path.isAbsolute(candidate)) {
      const probe = await run(candidate, ['--version'], { timeout: 5000 });
      if (!probe.ok) continue;
      return { found: true, executable: candidate, version: firstLine(probe.stdout) ?? null };
    }
    const probe = await run(candidate, ['--version'], { timeout: 5000 });
    if (!probe.ok) continue;
    return { found: true, executable: candidate, version: firstLine(probe.stdout) ?? null };
  }
  return { found: false, executable: null, version: null };
}

/** @param {string} text @returns {string|undefined} */
function firstLine(text) {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0);
  return line;
}

// ---------------------------------------------------------------------------
// .NET environment probes
// ---------------------------------------------------------------------------

/**
 * Read the installed SDKs and runtimes, cached across calls.
 * @returns {Promise<object>} the SDK section of the snapshot.
 */
async function probeDotnet() {
  const cached = sdkCache.get('dotnet');
  if (cached !== undefined && Date.now() - cached.at < SDK_TTL_MS) return cached.value;

  const located = await locateDotnet();
  /** @type {{version: string, path: string}[]} */
  const sdks = [];
  /** @type {{name: string, version: string, path: string}[]} */
  const runtimes = [];
  let error = null;

  if (located.found) {
    const executable = located.executable ?? 'dotnet';
    const [sdkList, runtimeList] = await Promise.all([
      run(executable, ['--list-sdks']),
      run(executable, ['--list-runtimes']),
    ]);
    if (sdkList.ok) {
      for (const line of sdkList.stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+\[(.+)\]\s*$/.exec(line.trim());
        if (match) sdks.push({ version: match[1], path: match[2] });
      }
    } else if (sdkList.error) {
      error = sdkList.error;
    }
    if (runtimeList.ok) {
      for (const line of runtimeList.stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(\S+)\s+\[(.+)\]\s*$/.exec(line.trim());
        if (match) runtimes.push({ name: match[1], version: match[2], path: match[3] });
      }
    }
  } else {
    error = 'dotnet executable not found';
  }

  const value = {
    found: located.found,
    executable: located.executable,
    version: located.version ?? (sdks.length > 0 ? sdks[sdks.length - 1].version : null),
    sdks,
    runtimes,
    error,
  };
  sdkCache.set('dotnet', { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// NuGet configuration
// ---------------------------------------------------------------------------

/**
 * Directories from the filesystem root down to `target`, so configuration
 * files can be applied in NuGet's documented precedence order.
 * @param {string} target absolute directory.
 * @returns {string[]} the chain, outermost first.
 */
function directoryChain(target) {
  const chain = [];
  let current = path.resolve(target);
  for (let depth = 0; depth < 12; depth += 1) {
    chain.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

/** The machine-wide and user-level NuGet configuration candidates. */
function globalNugetConfigs() {
  const files = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) files.push(path.join(process.env.APPDATA, 'NuGet', 'NuGet.Config'));
    if (process.env.ProgramFiles) {
      files.push(path.join(process.env.ProgramFiles, 'NuGet', 'Config', 'Microsoft.VisualStudio.Offline.config'));
    }
  } else {
    files.push(path.join(homedir(), '.nuget', 'NuGet', 'NuGet.Config'));
    files.push(path.join(homedir(), '.config', 'NuGet', 'NuGet.Config'));
  }
  return files;
}

/**
 * Read one `NuGet.Config` and return its source declarations.
 * @param {string} file absolute path.
 * @returns {Promise<{sources: {name: string, value: string}[], clears: boolean, disabled: string[], globalPackagesFolder: string|null, hasCredentials: boolean} | null>}
 */
async function readNugetConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const sources = [];
  let clears = false;
  const sourceBlock = /<packageSources>([\s\S]*?)<\/packageSources>/i.exec(text);
  if (sourceBlock) {
    for (const tag of sourceBlock[1].match(/<(add|clear)\b[^>]*>/gi) ?? []) {
      if (/^<clear/i.test(tag)) {
        clears = true;
        continue;
      }
      const name = /\bkey\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
      const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
      if (name && value) sources.push({ name, value });
    }
  }
  const disabled = [];
  const disabledBlock = /<disabledPackageSources>([\s\S]*?)<\/disabledPackageSources>/i.exec(text);
  if (disabledBlock) {
    for (const tag of disabledBlock[1].match(/<add\b[^>]*>/gi) ?? []) {
      const name = /\bkey\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
      const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
      if (name && String(value).toLowerCase() === 'true') disabled.push(name);
    }
  }
  const globalPackagesFolder =
    /<config>[\s\S]*?<add\b[^>]*key\s*=\s*"globalPackagesFolder"[^>]*value\s*=\s*"([^"]*)"/i.exec(text)?.[1] ??
    null;
  return {
    sources,
    clears,
    disabled,
    globalPackagesFolder,
    hasCredentials: /<packageSourceCredentials>/i.test(text),
  };
}

/**
 * The effective NuGet sources for one directory.
 * @param {string} cwd absolute workspace directory.
 * @returns {Promise<object>} the NuGet section of the snapshot.
 */
async function probeNuget(cwd) {
  /** @type {string[]} */
  const configFiles = [];
  /** @type {Map<string, {name: string, url: string, enabled: boolean, configFile: string}>} */
  const sources = new Map();
  /** @type {Set<string>} */
  const disabled = new Set();
  let globalPackagesFolder = null;
  let hasCredentials = false;

  const candidates = [...globalNugetConfigs()];
  for (const dir of directoryChain(cwd)) {
    candidates.push(path.join(dir, 'NuGet.Config'));
    candidates.push(path.join(dir, 'nuget.config'));
  }

  for (const file of candidates) {
    const config = await readNugetConfig(file);
    if (config === null) continue;
    configFiles.push(file);
    if (config.clears) sources.clear();
    for (const source of config.sources) {
      sources.set(source.name, {
        name: source.name,
        url: source.value,
        enabled: true,
        configFile: file,
      });
    }
    for (const name of config.disabled) disabled.add(name);
    if (config.globalPackagesFolder) {
      globalPackagesFolder = path.isAbsolute(config.globalPackagesFolder)
        ? config.globalPackagesFolder
        : path.resolve(path.dirname(file), config.globalPackagesFolder);
    }
    if (config.hasCredentials) hasCredentials = true;
  }

  for (const name of disabled) {
    const source = sources.get(name);
    if (source) source.enabled = false;
  }

  let cliAvailable = false;
  let error = null;
  if (sources.size === 0) {
    // Fall back to the CLI's effective list when no configuration file was readable.
    const executable = (await locateDotnet()).executable ?? 'dotnet';
    const listed = await run(executable, ['nuget', 'list', 'source'], { cwd, timeout: 12_000 });
    if (listed.ok) {
      cliAvailable = true;
      const parsed = parseNugetSourceListing(listed.stdout);
      for (const source of parsed) {
        sources.set(source.name, { ...source, configFile: '' });
      }
    } else if (listed.error) {
      error = listed.error;
    }
  }

  const cacheFolder = globalPackagesFolder ?? defaultPackageFolder();
  let cachedPackageCount = null;
  try {
    const entries = await readdir(cacheFolder, { withFileTypes: true });
    cachedPackageCount = entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    cachedPackageCount = null;
  }

  return {
    sources: [...sources.values()].map((source) => ({
      name: source.name,
      url: source.url,
      enabled: source.enabled,
      configFile: source.configFile,
    })),
    configFiles: [...new Set(configFiles)],
    globalPackagesFolder: cacheFolder,
    cachedPackageCount,
    hasCredentials,
    cliAvailable,
    error,
  };
}

/** The default global packages folder for this user. */
function defaultPackageFolder() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE ?? homedir(), '.nuget', 'packages');
  }
  return path.join(homedir(), '.nuget', 'packages');
}

/**
 * Parse `dotnet nuget list source` output, tolerating localized status words.
 * @param {string} text CLI stdout.
 * @returns {{name: string, url: string, enabled: boolean}[]}
 */
function parseNugetSourceListing(text) {
  const lines = text.split(/\r?\n/);
  const sources = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*\d+\.\s+(.+?)\s*(\[[^\]]*\])?\s*$/.exec(lines[index]);
    if (!match) continue;
    const name = match[1].trim();
    const url = (lines[index + 1] ?? '').trim();
    if (!/^(https?:\/\/|ftp:\/\/|[A-Za-z]:\\|\/)/.test(url)) continue;
    sources.push({ name, url, enabled: !/disabled|禁用/i.test(match[2] ?? '') });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Workspace project inspection
// ---------------------------------------------------------------------------

/**
 * Breadth-first scan for files with one of the given extensions.
 * @param {string} root absolute directory.
 * @param {string[]} extensions lowercase extensions including the dot.
 * @returns {Promise<string[]>} paths relative to `root`, nearest first.
 */
async function findProjectFiles(root, extensions) {
  /** @type {{dir: string, depth: number}[]} */
  const queue = [{ dir: root, depth: 0 }];
  /** @type {string[]} */
  const found = [];
  let visited = 0;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SCAN_ENTRIES) return found;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (depth >= MAX_SCAN_DEPTH) continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (extensions.includes(extension)) found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** @param {string} file @returns {Promise<string|null>} */
async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} file @returns {Promise<import('node:fs').Stats|null>} */
async function statOf(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

/** @param {string} start absolute directory. @param {string} name file name. @returns {Promise<string|null>} */
async function findUpward(start, name) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(current, name);
    if (await statOf(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** @param {string} text @returns {string|null} */
function xmlValue(text, name) {
  const match = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Read the facts the guidance rules need from one project file.
 * @param {string} projectPath absolute path.
 * @returns {Promise<object>} project facts.
 */
async function readProject(projectPath) {
  const text = (await readText(projectPath)) ?? '';
  const dir = path.dirname(projectPath);
  const sdkMatch = /<Project\b[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(text);
  const frameworks = (xmlValue(text, 'TargetFrameworks') ?? xmlValue(text, 'TargetFramework') ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);

  /** @type {{id: string, version: string|null}[]} */
  const packageReferences = [];
  const referencePattern = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let referenceMatch;
  while ((referenceMatch = referencePattern.exec(text)) !== null) {
    const attributes = referenceMatch[1] ?? '';
    const id = /\bInclude\s*=\s*"([^"]+)"/i.exec(attributes)?.[1];
    if (!id) continue;
    const inlineVersion = /\bVersion\s*=\s*"([^"]+)"/i.exec(attributes)?.[1] ?? null;
    const childVersion = referenceMatch[2] ? xmlValue(referenceMatch[2], 'Version') : null;
    packageReferences.push({ id, version: inlineVersion ?? childVersion });
  }

  const projectReferences = (text.match(/<ProjectReference\b/gi) ?? []).length;
  const directoryPackagesProps = await findUpward(dir, 'Directory.Packages.props');
  const centralVersion = directoryPackagesProps ? await readText(directoryPackagesProps) : null;
  const globalJsonPath = await findUpward(dir, 'global.json');
  let globalJson = null;
  if (globalJsonPath) {
    const raw = await readText(globalJsonPath);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        globalJson = { path: globalJsonPath, version: typeof parsed?.sdk?.version === 'string' ? parsed.sdk.version : null };
      } catch {
        globalJson = { path: globalJsonPath, version: null };
      }
    }
  }

  const projectStat = await statOf(projectPath);
  const assetsStat = await statOf(path.join(dir, 'obj', 'project.assets.json'));

  return {
    path: projectPath,
    name: path.basename(projectPath, path.extname(projectPath)),
    dir,
    sdk: sdkMatch ? sdkMatch[1] : null,
    targetFrameworks: frameworks,
    outputType: xmlValue(text, 'OutputType'),
    isTestProject:
      String(xmlValue(text, 'IsTestProject') ?? '').toLowerCase() === 'true' ||
      packageReferences.some((reference) => /^(xunit|nunit|mstest\.|microsoft\.net\.test\.sdk)/i.test(reference.id)) ||
      /\.tests?$/i.test(path.basename(projectPath, path.extname(projectPath))),
    packageReferences,
    projectReferences,
    nullable: xmlValue(text, 'Nullable'),
    implicitUsings: xmlValue(text, 'ImplicitUsings'),
    treatWarningsAsErrors: xmlValue(text, 'TreatWarningsAsErrors'),
    centralPackageManagement:
      centralVersion !== null &&
      String(xmlValue(centralVersion, 'ManagePackageVersionsCentrally') ?? '').toLowerCase() === 'true',
    directoryPackagesProps,
    globalJson,
    editorConfig: Boolean(await statOf(path.join(dir, '.editorconfig'))),
    restore: {
      assets: assetsStat !== null,
      stale:
        assetsStat !== null &&
        projectStat !== null &&
        assetsStat.mtimeMs < projectStat.mtimeMs,
    },
    built: Boolean(await statOf(path.join(dir, 'bin'))),
  };
}

/**
 * Scan the workspace and read its primary .NET project.
 * @param {string} cwd absolute workspace directory.
 * @returns {Promise<object>} the project section of the snapshot.
 */
async function probeProject(cwd) {
  const [projectFiles, solutionFiles] = await Promise.all([
    findProjectFiles(cwd, PROJECT_EXTENSIONS),
    findProjectFiles(cwd, SOLUTION_EXTENSIONS),
  ]);
  const primaryPath = projectFiles[0] ?? null;
  const primary = primaryPath ? await readProject(primaryPath) : null;
  const projects = projectFiles.slice(0, 25).map((file) => ({
    path: file,
    name: path.basename(file, path.extname(file)),
    relative: path.relative(cwd, file),
  }));
  return {
    found: primaryPath !== null,
    cwd,
    solutions: solutionFiles.slice(0, 10).map((file) => ({
      path: file,
      name: path.basename(file),
      relative: path.relative(cwd, file),
    })),
    projects,
    projectCount: projectFiles.length,
    testProjects: projects.filter((project) => /\.tests?$/i.test(project.name)).length,
    primary,
    nugetConfig: await findUpward(cwd, 'NuGet.Config'),
  };
}

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

/**
 * Build the ordered guidance items from the collected facts.
 *
 * Items carry identifiers and interpolated values only: visible text comes from
 * the Client locale so the panel follows the page language.
 * @param {object} snapshot the collected sections.
 * @returns {{id: string, level: 'error'|'warn'|'info'|'ok', params?: object, commands?: string[]}[]}
 */
function buildGuidance(snapshot) {
  const { dotnet, nuget, project } = snapshot;
  /** @type {ReturnType<typeof buildGuidance>} */
  const items = [];

  if (!dotnet.found) {
    items.push({
      id: 'dotnet.missing',
      level: 'error',
      commands: [
        'winget install Microsoft.DotNet.SDK.8',
        'https://dotnet.microsoft.com/download',
      ],
    });
  } else if (dotnet.sdks.length > 0) {
    items.push({
      id: 'dotnet.ready',
      level: 'ok',
      params: { version: dotnet.version ?? dotnet.sdks[0].version, count: dotnet.sdks.length },
    });
  }

  const pinned = project.primary?.globalJson?.version ?? null;
  if (pinned && dotnet.found && !dotnet.sdks.some((sdk) => sdk.version === pinned)) {
    items.push({
      id: 'dotnet.global-json-mismatch',
      level: 'warn',
      params: { version: pinned, project: project.primary.name },
      commands: [`dotnet --version`, `dotnet --list-sdks`],
    });
  }

  if (nuget.sources.length === 0) {
    items.push({
      id: 'nuget.no-source',
      level: 'error',
      params: { cwd: shortPath(nuget.globalPackagesFolder ?? project.cwd) },
      commands: ['dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org'],
    });
  } else {
    const enabled = nuget.sources.filter((source) => source.enabled);
    items.push({
      id: 'nuget.ready',
      level: enabled.length > 0 ? 'ok' : 'warn',
      params: { enabled: enabled.length, total: nuget.sources.length },
    });
    if (!enabled.some((source) => /nuget\.org/i.test(source.url))) {
      items.push({
        id: 'nuget.no-nuget-org',
        level: 'warn',
        commands: ['dotnet nuget add source https://api.nuget.org/v3/index.json -n nuget.org'],
      });
    }
    if (nuget.sources.some((source) => !source.enabled)) {
      items.push({
        id: 'nuget.disabled-source',
        level: 'warn',
        params: {
          names: nuget.sources
            .filter((source) => !source.enabled)
            .map((source) => source.name)
            .join(', '),
        },
        commands: ['dotnet nuget list source'],
      });
    }
  }

  if (!project.found || project.primary === null) {
    items.push({
      id: 'project.none',
      level: 'info',
      params: { cwd: project.cwd },
      commands: ['dotnet new console -n MyApp', 'dotnet new sln -n MyApp', 'dotnet new xunit -n MyApp.Tests'],
    });
    return items;
  }

  const primary = project.primary;
  const framework = primary.targetFrameworks[0] ?? null;
  items.push({
    id: 'project.ready',
    level: 'ok',
    params: {
      project: primary.name,
      framework: primary.targetFrameworks.join(', ') || '未声明',
      packages: primary.packageReferences.length,
    },
  });

  if (framework && isOldFramework(framework)) {
    items.push({
      id: 'project.framework-old',
      level: 'warn',
      params: { framework },
      commands: ['dotnet list package --outdated'],
    });
  }

  if (primary.nullable !== 'enable' && primary.nullable !== 'annotations') {
    items.push({
      id: 'project.nullable-off',
      level: 'warn',
      params: { project: primary.name },
      commands: ['dotnet format'],
    });
  }

  if (!primary.restore.assets) {
    items.push({
      id: 'project.restore-missing',
      level: 'warn',
      commands: ['dotnet restore', 'dotnet build'],
    });
  } else if (primary.restore.stale) {
    items.push({
      id: 'project.restore-stale',
      level: 'warn',
      commands: ['dotnet restore'],
    });
  }

  if (project.projectCount > 0 && project.testProjects === 0) {
    items.push({
      id: 'project.no-tests',
      level: 'info',
      params: { project: primary.name },
      commands: [`dotnet new xunit -n ${primary.name}.Tests`, 'dotnet test'],
    });
  }

  if (!primary.centralPackageManagement && primary.packageReferences.length > 2) {
    items.push({
      id: 'project.no-central-packages',
      level: 'info',
      params: { count: primary.packageReferences.length },
      commands: ['dotnet new buildprops', 'dotnet new packagesprops'],
    });
  }

  if (primary.treatWarningsAsErrors !== 'true') {
    items.push({
      id: 'project.warnings-not-errors',
      level: 'info',
      commands: ['dotnet build -warnaserror'],
    });
  }

  if (!primary.editorConfig) {
    items.push({
      id: 'project.no-editorconfig',
      level: 'info',
      commands: ['dotnet new editorconfig'],
    });
  }

  items.push({
    id: 'project.audit',
    level: 'info',
    params: { project: primary.name },
    commands: ['dotnet list package --vulnerable --include-transitive', 'dotnet list package --outdated'],
  });

  items.push({
    id: 'project.build',
    level: 'info',
    commands: ['dotnet build', 'dotnet test', 'dotnet format --verify-no-changes'],
  });

  return items;
}

/** @param {string} framework a target framework moniker. */
function isOldFramework(framework) {
  const match = /^net(\d+)\.(\d+)$/i.exec(framework);
  if (!match) return false;
  const major = Number(match[1]);
  return major < 8;
}

/** Keep a path readable in a narrow panel. @param {string} value absolute path. */
function shortPath(value) {
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? String(value) : `…/${parts.slice(-2).join('/')}`;
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

/**
 * Collect one complete status snapshot.
 * @param {{cwd: string, refresh?: boolean}} options target directory and cache policy.
 * @returns {Promise<object>} the snapshot.
 */
async function collectSnapshot(options) {
  const cwd = options.cwd;
  const cached = snapshotCache.get(cwd);
  if (!options.refresh && cached !== undefined && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
    return cached.value;
  }
  const [dotnet, nuget, project] = await Promise.all([
    probeDotnet(),
    probeNuget(cwd),
    probeProject(cwd),
  ]);
  const snapshot = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    cwd,
    dotnet,
    nuget,
    project,
    guidance: [],
  };
  snapshot.guidance = buildGuidance(snapshot);
  snapshotCache.set(cwd, { at: Date.now(), value: snapshot });
  return snapshot;
}

/**
 * Resolve the directory a caller's session works in.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context.
 * @param {{session?: {id?: string}}|undefined} agent the calling agent, when present.
 * @param {string|undefined} sessionId a Session id from the route.
 */
function resolveDirectory(ctx, agent, sessionId) {
  const workingDirectory = ctx.get('workingDirectory');
  try {
    let resolvedAgent = agent;
    if (resolvedAgent === undefined && sessionId) {
      resolvedAgent = ctx.get('agents')?.get(sessionId);
    }
    if (resolvedAgent?.session && workingDirectory) {
      return workingDirectory.get(resolvedAgent.session);
    }
  } catch {
    // Fall through to the deployment default.
  }
  return workingDirectory?.defaultDirectory ?? process.cwd();
}

/** One-line summary for the tool result. @param {object} snapshot */
function summarize(snapshot) {
  const sdk = snapshot.dotnet.found
    ? `SDK ${snapshot.dotnet.sdks.map((entry) => entry.version).join(', ') || snapshot.dotnet.version || 'unknown'}`
    : 'no dotnet executable';
  const sources = snapshot.nuget.sources.length === 0
    ? 'no NuGet source'
    : `${snapshot.nuget.sources.filter((source) => source.enabled).length}/${snapshot.nuget.sources.length} NuGet source(s) enabled: ${snapshot.nuget.sources.map((source) => source.name).join(', ')}`;
  const project = snapshot.project.primary === null
    ? 'no .NET project in this directory'
    : `${snapshot.project.primary.name} (${snapshot.project.primary.targetFrameworks.join(', ') || 'no framework'}), ${snapshot.project.primary.packageReferences.length} package reference(s), ${snapshot.project.projectCount} project(s)`;
  const attention = snapshot.guidance.filter((item) => item.level === 'error' || item.level === 'warn');
  return [
    `Directory: ${snapshot.cwd}`,
    `dotnet: ${sdk}`,
    `NuGet: ${sources}`,
    `Project: ${project}`,
    attention.length === 0
      ? 'Guidance: no blocking issues.'
      : `Guidance: ${attention.length} item(s) need attention — ${attention.map((item) => item.id).join(', ')}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Register the collector's two callers.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'dotnet_status',
    description:
      'Read the local .NET SDK and runtime inventory, the effective NuGet sources, and the .NET project ' +
      'in the current working directory, with guidance items that name the next command to run. ' +
      'Use it before advising on build, restore, or package work instead of guessing toolchain versions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Bypass the one-minute cache and re-probe the toolchain.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          schemaVersion: { type: 'integer' },
          generatedAt: { type: 'integer' },
          cwd: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: summarize(value) }],
    },
    async execute(args, exec) {
      const cwd = resolveDirectory(ctx, exec?.agent);
      return collectSnapshot({ cwd, refresh: args?.refresh === true });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Inspect .NET environment',
      kind: 'execute',
      rawInput: args ?? {},
    }),
  }), 'dotnet-dashboard.tool');

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          resource: async (request) => {
            const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
            const connection = scope.get('connection');
            if (connection !== undefined) {
              try {
                const trust = connection.requestRejection({ headers: request.headers });
                if (trust !== undefined) {
                  return new Response(JSON.stringify({ error: 'unauthorized' }), { status: trust, headers });
                }
                const admission = connection.admit({ headers: request.headers });
                if ('rejection' in admission) {
                  return new Response(JSON.stringify({ error: 'unauthorized' }), {
                    status: admission.rejection,
                    headers,
                  });
                }
              } catch {
                return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers });
              }
            }
            const url = new URL(request.url);
            const cwd = resolveDirectory(scope, undefined, url.searchParams.get('sessionId') ?? undefined);
            try {
              const snapshot = await collectSnapshot({
                cwd,
                refresh: url.searchParams.get('refresh') === '1',
              });
              return new Response(JSON.stringify(snapshot), { status: 200, headers });
            } catch (error) {
              return new Response(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                { status: 500, headers },
              );
            }
          },
        }),
      'dotnet-dashboard.status-route',
    );
  });
}
