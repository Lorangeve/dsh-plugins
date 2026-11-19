/**
 * Everything 1.5 search tools for DeepSeek Harness.
 *
 * Registers `everything_search` (instant index queries using Everything's own search syntax) and
 * `everything_help` (syntax reference plus live connection status). Both read the Everything 1.5
 * named-pipe IPC directly, so hot results cost a few milliseconds and no child process is spawned.
 *
 * @module @local/dsh-tool-everything
 */

import { everythingSearch, everythingStatus, formatSize, shutdown } from './ipc.js'

export const name = 'tool-everything'
export const inject = ['tools']

const SEARCH_DESCRIPTION = [
  'Search every indexed file and folder on this Windows machine through the running Everything 1.5 index.',
  'The index already covers NTFS drives and configured folder indexes, so results return in milliseconds',
  'without walking the filesystem; use this instead of glob or recursive directory listing for "where is X" lookups.',
  '',
  '`query` is Everything search syntax, evaluated by Everything itself:',
  'space = AND, `|` = OR, `!` = NOT, `< >` = group, `"..."` = literal text, `*` and `?` = wildcards.',
  'Modifiers and filters include `folder:`, `file:`, `ext:`, `size:`, `dm:` (modified), `dc:`, `da:`,',
  '`attrib:`, `path:`, `parent:`, `child:`, `empty:`, `dupe:`, and the `audio:`/`video:`/`doc:`/',
  '`exe:`/`image:`/`zip:` macros. `content:` matches text inside files: it reads from disk and can be',
  'slow, so combine it with `ext:`, a path, or `dm:`.',
  '',
  'Call everything_help for a compact syntax reference; any Everything 1.5 search function or',
  'modifier is accepted. Results come one page at a time: keep `limit` small unless the match set is',
  'known to be small, and page with `offset`.',
].join('\n')

const HELP_DESCRIPTION =
  'Show the Everything search syntax reference (operators, wildcards, modifiers, functions, examples) '
  + 'together with the live Everything 1.5 IPC status. Load it before writing a complex query.'

const SYNTAX = `Everything search syntax (Everything 1.5) — the query string is parsed by Everything itself.

TERMS AND OPERATORS
  space          AND          abc 123
  |              OR           *.jpg|*.png        (spaces around | are ignored)
  !              NOT          !\\downloads
  < >            grouping     !<abc 123>
  " "            literal text "C:\\Program Files"
  Precedence     OR before AND: apple banana | orange = apple AND (banana OR orange)
                 Use < > to change it: <apple banana> | orange
  Paths          a backslash anywhere matches the full path: \\downloads, !\\appdata
                 A trailing backslash requires a folder: C:\\windows\\media\\
                 Drives: d:   c:|e:   !e:

WILDCARDS
  *   zero or more characters except \\      **  zero or more characters
  ?   one character                          Wildcards match the whole filename: *.mp3, foo*, **\\temp\\*
  Quoted text is literal; special characters can be written as entities:
  &sp: (space)  &vert: (|)  &excl: (!)  &lt: (<)  &gt: (>)  &quot: (")  &#<n>:  &#x<n>:

MODIFIERS (prefix a term)
  case:  no-case:                 match case
  diacritics:  no-diacritics:     match accent marks
  whole-words:                    match whole words only
  whole:                          match the entire filename or property value
  prefix:  no-prefix:             match the start of words
  suffix:  no-suffix:             match the end of words
  start-with:  end-with:          match the start/end of the name
  path:  no-path:                 match against the full path
  regex:                          PCRE for this term only: *.jpg regex:^IMG_\\d+
  ignore-punctuation:  ignore-whitespace:
  wildcards:  no-wildcards:
  file:  folder:                  files only / folders only

FUNCTIONS (property filters; a - in the name is optional)
  ext:mp3;flac                    whole extension, ; separated, . * and ? allowed
  extension:jpg                   extension contains text
  size:>100mb   size:10mb..50mb   size:==1kb   size:!1kb
  dm:today  dm:7days  dm:2026-09-04  dm:>2022  dm:2025-07-01..2026-06-30
  dc:  da:  date-modified:  date-created:  date-accessed:   (same value forms)
  len:>20   len:5..10             name length in UTF-16 characters
  attrib:rash  attributes:0x200   ALL listed attributes must match
  type:audio   type:video         file type category
  parent:C:\\Windows              direct children only
  ancestor:C:\\Windows            children at any depth
  child:*.mp3                     folders containing a matching child
  child-count:>10  depth:2        folder shape
  empty:                          empty folders
  dupe:  dupe:size;name           duplicates by property
  content:todo  content:"abc 123" text inside files (reads from disk: can be slow)
  length:>1hour                   duration for audio/video
  Numeric comparisons:  >  >=  <  <=  =  ==  !=  and ranges  a..b  or  a-b

MACROS
  audio:  video:  doc:  image:  exe:  zip:     audio:|video: combines them

EXAMPLES
  ext:ps1 size:>10kb !\\node_modules\\          large PowerShell files outside node_modules
  dm:thisweek ext:log C:\\Users\\                 logs touched this week under C:\\Users
  folder: parent:C:\\src                      direct child folders of C:\\src
  regex:^\\d{4}-\\d{2}-\\d{2} dm:thisyear         names starting with a date, modified this year
  dupe:size;name                               files sharing size and name
  *.docx content:invoice \\downloads             Word files containing "invoice"

NOTES
  This page lists common syntax; every Everything 1.5 search function and modifier is accepted.
  content: searches read file contents and can take seconds to minutes; combine them with ext:,
  path, or dm: filters. Indexed properties return instantly; unindexed ones may fall back to disk.
  An invalid regular expression reports 0 matches rather than an error.`

/** Normalize the row config into connection settings. */
function settingsFrom(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const settings = {}
  if (typeof source.pipe === 'string' && source.pipe.length > 0) settings.pipe = source.pipe
  if (typeof source.instance === 'string' && source.instance.length > 0) settings.instance = source.instance
  return settings
}

/** `1 file` / `2 files`. */
function countLabel(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

/** One result line: path plus size and modified time when known. */
function describeResult(result) {
  const details = []
  if (!result.folder && typeof result.size === 'number' && result.size >= 0) {
    const size = formatSize(result.size)
    if (size.length > 0) details.push(size)
  }
  if (typeof result.modified === 'string' && result.modified.length > 0) details.push(result.modified)
  if (result.folder) details.push('folder')
  const suffix = details.length > 0 ? `  (${details.join(', ')})` : ''
  return `${result.path}${suffix}`
}

/** Render one search result value for the model. */
function renderSearch(args, value) {
  const header = `${countLabel(value.total, 'match', 'matches')}`
    + ` (${countLabel(value.files, 'file', 'files')}, ${countLabel(value.folders, 'folder', 'folders')})`
    + ` in ${value.elapsedMs.toFixed(1)} ms`
  if (args.count_only === true) {
    return [{ type: 'text', text: `${header} — count only` }]
  }

  const lines = [header]
  for (const result of value.results) lines.push(describeResult(result))

  const next = value.offset + value.returned
  if (value.returned === 0 && value.offset > 0) {
    lines.push(`Offset ${value.offset} is past the last match; the query has ${value.total}.`)
  } else if (next < value.total) {
    lines.push(`Showing ${value.offset + 1}-${next} of ${value.total}. Call again with offset ${next} for the next page.`)
  } else if (value.returned > 0 && value.offset > 0) {
    lines.push(`Showing ${value.offset + 1}-${next} of ${value.total} (last page).`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render the help value: status line, then the syntax reference. */
function renderHelp(_args, value) {
  const status = value.connected
    ? `Everything ${value.version} — pipe ${value.pipe}`
    : `Everything is not reachable: ${value.error}`
  return [{ type: 'text', text: `${status}\n\n${value.syntax}` }]
}

/** Register the Everything tools on the calling context. */
export function apply(ctx, config) {
  const settings = settingsFrom(config)

  ctx.effect(() => () => {
    shutdown()
  })

  ctx.tools.register({
    name: 'everything_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'Everything search syntax. Example: `ext:ps1 size:>10kb dm:thisweek !\\node_modules\\`. '
            + 'An empty query matches every index entry.',
        },
        limit: {
          type: 'integer',
          description:
            'Maximum results to return, 1-1000. Default 30; raise it only when the match set is known to be small.',
          title: 'Result limit',
        },
        offset: {
          type: 'integer',
          description: 'Results to skip for paging. Default 0.',
        },
        sort: {
          type: 'string',
          enum: ['name', 'path', 'size', 'extension', 'date_modified', 'date_created'],
          description: 'Sort column. Omit to keep Everything\'s default name order.',
        },
        descending: {
          type: 'boolean',
          description: 'Sort descending. Only used with `sort`.',
        },
        match_path: {
          type: 'boolean',
          description: 'Match the whole query against full paths instead of names.',
        },
        regex: {
          type: 'boolean',
          description: 'Treat the whole query as one PCRE regular expression (disables the rest of the syntax).',
        },
        count_only: {
          type: 'boolean',
          description: 'Return only the match counts, without paths.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'total', 'files', 'folders', 'offset', 'returned', 'elapsedMs', 'results'],
        properties: {
          query: { type: 'string' },
          total: { type: 'integer' },
          files: { type: 'integer' },
          folders: { type: 'integer' },
          offset: { type: 'integer' },
          returned: { type: 'integer' },
          elapsedMs: { type: 'number' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'name', 'modified', 'folder'],
              properties: {
                path: { type: 'string' },
                name: { type: 'string' },
                size: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                modified: { type: 'string' },
                folder: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: renderSearch,
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: `Everything: ${typeof args.query === 'string' && args.query.length > 0 ? args.query : '(all)'}`,
      kind: 'search',
      rawInput: args,
    }),
    async execute(args) {
      const limit = args.limit === undefined ? 30 : args.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('limit must be an integer between 1 and 1000')
      }
      const offset = args.offset === undefined ? 0 : args.offset
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error('offset must be a non-negative integer')
      }
      const page = args.count_only === true ? 0 : limit
      return everythingSearch(
        {
          query: args.query,
          limit: page,
          offset,
          sort: args.sort,
          descending: args.descending === true,
          matchPath: args.match_path === true,
          regex: args.regex === true,
        },
        settings,
      )
    },
  })

  ctx.tools.register({
    name: 'everything_help',
    description: HELP_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['connected', 'syntax'],
        properties: {
          connected: { type: 'boolean' },
          pipe: { type: 'string' },
          version: { type: 'string' },
          error: { type: 'string' },
          syntax: { type: 'string' },
        },
      },
      render: renderHelp,
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Everything syntax and status', kind: 'other' }),
    async execute() {
      let status
      try {
        status = await everythingStatus(settings)
      } catch (error) {
        return {
          connected: false,
          error: error instanceof Error ? error.message : String(error),
          syntax: SYNTAX,
        }
      }
      return {
        connected: true,
        pipe: status.pipe,
        version: status.version,
        syntax: SYNTAX,
      }
    },
  })
}
