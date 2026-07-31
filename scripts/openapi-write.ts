import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildOpenApiDocument } from '@/server/openapi/document'

/**
 * Write `openapi/v1.json`.
 *
 * Run with `npm run openapi:write`. It imports the builder directly, so it needs
 * no server, no database and no secrets — which is the point: the spec has to be
 * regenerable in CI and on a fresh clone, or it stops being regenerated and
 * starts being edited by hand.
 *
 * It also audits itself. The registry is a hand-written declaration of what the
 * API offers, so nothing stops somebody adding a route handler and forgetting to
 * register it — and a spec that quietly omits an endpoint is worse than no spec,
 * because the web repo will believe it. Every `route.ts` under `src/app/api/v1`
 * is therefore compared against the documented operations, and a mismatch in
 * either direction fails the run.
 */

const API_ROOT = 'src/app/api/v1'
const OUTPUT_PATH = 'openapi/v1.json'

/**
 * The methods Next will route and we expect to document. `HEAD` and `OPTIONS`
 * are synthesised by the framework, so their absence from the spec is correct.
 */
const HANDLER_EXPORT =
  /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g

/** Every `route.ts` beneath `dir`, as absolute paths. */
async function findRouteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await findRouteFiles(full)))
    else if (entry.name === 'route.ts') found.push(full)
  }

  return found.sort()
}

/**
 * `<root>/auth/password/forgot/route.ts` → `/api/v1/auth/password/forgot`.
 * `<root>/activities/[id]/route.ts`      → `/api/v1/activities/{id}`.
 *
 * Two normalisations, both so that the filesystem and the document can be
 * compared as plain strings:
 *
 *   • Route groups — `(marketing)` — never reach the URL, so they are dropped.
 *   • Next spells a dynamic segment `[id]`; OpenAPI spells it `{id}`. The
 *     document has to use the OpenAPI form, because that is what path templating
 *     means and what a generated client substitutes into — a spec claiming
 *     `/activities/[id]` would have the web repo requesting a literal `[id]`.
 *     Catch-alls (`[...slug]`, `[[...slug]]`) collapse to a single `{slug}`:
 *     OpenAPI has no notion of one variable spanning several segments, so the
 *     day one appears it will need describing by hand rather than deriving.
 */
function toTemplateSegment(segment: string): string {
  if (!segment.startsWith('[') || !segment.endsWith(']')) return segment

  const name = segment
    .replace(/^\[+/, '')
    .replace(/\]+$/, '')
    .replace(/^\.{3}/, '')

  return `{${name}}`
}

function urlPathFor(routeFile: string, apiRoot: string): string {
  const segments = path
    .relative(apiRoot, path.dirname(routeFile))
    .split(path.sep)
    .filter((segment) => segment.length > 0 && !segment.startsWith('('))
    .map(toTemplateSegment)

  return ['/api/v1', ...segments].join('/')
}

/** `POST /api/v1/auth/login` — the key both sides of the audit are compared on. */
async function operationsOnDisk(apiRoot: string): Promise<Set<string>> {
  const operations = new Set<string>()

  for (const file of await findRouteFiles(apiRoot)) {
    const source = await readFile(file, 'utf8')
    const urlPath = urlPathFor(file, apiRoot)

    for (const match of source.matchAll(HANDLER_EXPORT)) {
      operations.add(`${match[1]} ${urlPath}`)
    }
  }

  return operations
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => !b.has(value)).sort()
}

async function main(): Promise<void> {
  const repoRoot = process.cwd()
  const apiRoot = path.join(repoRoot, ...API_ROOT.split('/'))
  const outputFile = path.join(repoRoot, ...OUTPUT_PATH.split('/'))

  const document = buildOpenApiDocument()

  const documented = new Set<string>()
  for (const [urlPath, operations] of Object.entries(document.paths)) {
    for (const method of Object.keys(operations)) {
      documented.add(`${method.toUpperCase()} ${urlPath}`)
    }
  }

  const onDisk = await operationsOnDisk(apiRoot)
  const undocumented = difference(onDisk, documented)
  const phantom = difference(documented, onDisk)

  // Written before the audit is enforced: seeing the output is more useful than
  // withholding it, and the exit code is what stops CI either way.
  await mkdir(path.dirname(outputFile), { recursive: true })
  await writeFile(outputFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  console.log(`openapi: wrote ${path.relative(repoRoot, outputFile).replace(/\\/g, '/')}`)
  console.log(
    `openapi: ${Object.keys(document.paths).length} paths, ${documented.size} operations, ` +
      `${Object.keys(document.components.schemas).length} component schemas`
  )
  console.log('')

  for (const [urlPath, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const statuses = Object.keys(operation.responses).join(',')
      console.log(`  ${method.toUpperCase().padEnd(6)} ${urlPath.padEnd(34)} [${statuses}]`)
    }
  }

  if (undocumented.length === 0 && phantom.length === 0) {
    console.log('')
    console.log(`openapi: every handler under ${API_ROOT} is documented.`)
    return
  }

  console.error('')
  for (const operation of undocumented) {
    console.error(`openapi: ${operation} has a handler but no registration in openapi/routes.ts`)
  }
  for (const operation of phantom) {
    console.error(`openapi: ${operation} is documented but has no handler under ${API_ROOT}`)
  }

  process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
