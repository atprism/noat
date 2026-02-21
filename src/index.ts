import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const DEFAULT_PDS_URL = 'https://bsky.social'
const DEFAULT_POSTS_DIR = './posts'
const DEFAULT_STATE_FILE = '.nat/published.json'
const DEFAULT_PASSWORD_ENV_VAR = 'NAT_BLUESKY_APP_PASSWORD'
const DEFAULT_POST_TEXT_FIELD = 'post'
const DEFAULT_IMAGE_FIELD = 'image'
const DEFAULT_IMAGE_ALT_FIELD = 'imageAlt'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

const IMAGE_MIME_BY_EXTENSION:Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif'
}

interface BlueskyBlob {
    [key: string]: unknown
}

interface BlueskySession {
    accessJwt: string
    did: string
}

interface CreateRecordResponse {
    uri: string
    cid: string
}

export interface NatConfig {
    handle?: string
    pdsUrl?: string
    postsDir?: string
    stateFile?: string
    passwordEnvVar?: string
    postTextField?: string
    imageField?: string
    imageAltField?: string
    bluesky?: {
        handle?: string
        pdsUrl?: string
        passwordEnvVar?: string
    }
}

export interface ResolvedConfig {
    handle: string
    pdsUrl: string
    postsDir: string
    stateFile: string
    passwordEnvVar: string
    postTextField: string
    imageField: string
    imageAltField: string
}

export interface PublishedPostState {
    sourceHash: string
    uri: string
    cid: string
    publishedAt: string
}

export interface PublishState {
    version: number
    posts: Record<string, PublishedPostState>
}

export interface PublishOptions {
    cwd?: string
    configPath?: string
    postsDir?: string
    dryRun?: boolean
    verbose?: boolean
}

export interface PublishSummary {
    dryRun: boolean
    totalPosts: number
    skippedPosts: number
    queuedPosts: number
    publishedPosts: number
    stateFile: string
}

export interface CliIO {
    log: (...args: any[]) => void
    error: (...args: any[]) => void
}

interface ParsedPostFields {
    text: string
    imagePath?: string
    imageAlt: string
}

interface DraftPost {
    path: string
    sourceHash: string
    text: string
    image?: {
        path: string
        alt: string
        mimeType: string
        bytes: Buffer
    }
}

interface ParsedCli {
    command: 'publish' | 'help'
    options: PublishOptions
}

interface LoadConfigResult {
    path: string | null
    config: NatConfig
}

type JsonRecord = Record<string, unknown>
type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<any>

const DEFAULT_IO:CliIO = {
    log: (...args: any[]) => { console.log(...args) },
    error: (...args: any[]) => { console.error(...args) }
}

export async function runCli (argv: string[], io: CliIO = DEFAULT_IO):Promise<void> {
    const parsed = parseCliArgs(argv)

    if (parsed.command === 'help') {
        io.log(getHelpText())
        return
    }

    const summary = await runPublish(parsed.options, io)
    const mode = summary.dryRun ? 'dry run complete' : 'publish complete'
    io.log(`[nat] ${mode}. queued=${summary.queuedPosts}, published=${summary.publishedPosts}, skipped=${summary.skippedPosts}`)
}

export function parseCliArgs (argv: string[]):ParsedCli {
    const args = [...argv]
    let command:ParsedCli['command'] = 'publish'

    if (args[0] != null && !args[0].startsWith('-')) {
        const maybeCommand = args.shift()
        if (maybeCommand === 'publish') {
            command = 'publish'
        } else if (maybeCommand === 'help') {
            command = 'help'
        } else {
            throw new Error(`Unknown command "${maybeCommand}". Use "nat help" for usage.`)
        }
    }

    const options:PublishOptions = {}

    while (args.length > 0) {
        const arg = args.shift() as string

        if (arg === '--help' || arg === '-h') {
            return { command: 'help', options }
        }

        if (arg === '--dry-run') {
            options.dryRun = true
            continue
        }

        if (arg === '--verbose') {
            options.verbose = true
            continue
        }

        if (arg === '--config') {
            options.configPath = expectFlagValue('--config', args.shift())
            continue
        }

        if (arg.startsWith('--config=')) {
            options.configPath = arg.slice('--config='.length)
            continue
        }

        if (arg === '--posts-dir') {
            options.postsDir = expectFlagValue('--posts-dir', args.shift())
            continue
        }

        if (arg.startsWith('--posts-dir=')) {
            options.postsDir = arg.slice('--posts-dir='.length)
            continue
        }

        if (arg === '--cwd') {
            options.cwd = expectFlagValue('--cwd', args.shift())
            continue
        }

        if (arg.startsWith('--cwd=')) {
            options.cwd = arg.slice('--cwd='.length)
            continue
        }

        throw new Error(`Unknown argument "${arg}". Use "nat help" for usage.`)
    }

    return { command, options }
}

function expectFlagValue (flag: string, value: string | undefined):string {
    if (value == null || value.trim() === '') {
        throw new Error(`Flag ${flag} expects a value`)
    }
    return value
}

function getHelpText ():string {
    return [
        'nat - Bluesky one-to-many publishing CLI',
        '',
        'Usage:',
        '  nat publish [--config path] [--posts-dir path] [--dry-run] [--verbose]',
        '  nat help',
        '',
        'Notes:',
        '  - Config file lookup: nat.config.ts, nat.config.js, nat.config.json',
        '  - Password source: .env file and/or process env',
        '  - Default posts directory: ./posts'
    ].join('\n')
}

export async function runPublish (options: PublishOptions = {}, io: CliIO = DEFAULT_IO):Promise<PublishSummary> {
    const cwd = resolve(options.cwd ?? process.cwd())
    const envFromFile = await readEnvFile(cwd)
    const env = {
        ...envFromFile,
        ...process.env
    }

    const loaded = await loadConfig(cwd, options.configPath)
    const config = normalizeConfig({
        cwd,
        env,
        config: loaded.config,
        postsDirOverride: options.postsDir
    })

    if (options.verbose) {
        const configuredPath = loaded.path ?? '(defaults only)'
        io.log(`[nat] config file: ${configuredPath}`)
        io.log(`[nat] posts dir: ${config.postsDir}`)
        io.log(`[nat] state file: ${config.stateFile}`)
    }

    const repoRoot = getRepoRoot(cwd)
    const postsRelativeToRepo = toGitPath(relative(repoRoot, config.postsDir))

    if (postsRelativeToRepo.startsWith('../') || postsRelativeToRepo === '..') {
        throw new Error(`Configured postsDir must be inside the git repo. Received "${config.postsDir}"`)
    }

    const postsRootSpec = postsRelativeToRepo === '' ? '.' : postsRelativeToRepo
    const postPaths = listMarkdownPosts(repoRoot, postsRootSpec)
    const state = await loadState(config.stateFile)
    const drafts = buildDrafts({
        repoRoot,
        config,
        postPaths,
        state
    })

    if (drafts.length === 0) {
        io.log('[nat] no new posts found to publish')
        return {
            dryRun: options.dryRun === true,
            totalPosts: postPaths.length,
            skippedPosts: postPaths.length,
            queuedPosts: 0,
            publishedPosts: 0,
            stateFile: config.stateFile
        }
    }

    if (options.dryRun === true) {
        for (const draft of drafts) {
            io.log(`[nat] dry-run would publish ${draft.path}`)
        }

        return {
            dryRun: true,
            totalPosts: postPaths.length,
            skippedPosts: postPaths.length - drafts.length,
            queuedPosts: drafts.length,
            publishedPosts: 0,
            stateFile: config.stateFile
        }
    }

    const password = resolveString(env[config.passwordEnvVar])
    if (password == null) {
        throw new Error(`Missing password. Set ${config.passwordEnvVar} in .env or environment.`)
    }

    const fetchImpl = resolveFetchImplementation()
    const session = await createSession({
        fetchImpl,
        handle: config.handle,
        password,
        pdsUrl: config.pdsUrl
    })

    let publishedCount = 0

    for (const draft of drafts) {
        const result = await publishDraft({
            fetchImpl,
            pdsUrl: config.pdsUrl,
            session,
            draft
        })

        state.posts[draft.path] = {
            sourceHash: draft.sourceHash,
            uri: result.uri,
            cid: result.cid,
            publishedAt: new Date().toISOString()
        }

        publishedCount += 1
        io.log(`[nat] published ${draft.path} -> ${result.uri}`)
    }

    await saveState(config.stateFile, state)
    io.log(`[nat] updated publish state at ${config.stateFile}`)

    return {
        dryRun: false,
        totalPosts: postPaths.length,
        skippedPosts: postPaths.length - drafts.length,
        queuedPosts: drafts.length,
        publishedPosts: publishedCount,
        stateFile: config.stateFile
    }
}

function resolveFetchImplementation ():FetchLike {
    const fetchImpl = (globalThis as Record<string, unknown>).fetch
    if (typeof fetchImpl !== 'function') {
        throw new Error('Global fetch API is unavailable. Use Node.js 18+.')
    }

    return fetchImpl as FetchLike
}

async function createSession (params: {
    fetchImpl: FetchLike
    pdsUrl: string
    handle: string
    password: string
}):Promise<BlueskySession> {
    const url = `${trimTrailingSlash(params.pdsUrl)}/xrpc/com.atproto.server.createSession`
    const response = await params.fetchImpl(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            identifier: params.handle,
            password: params.password
        })
    })

    const json = await parseJsonResponse(response, 'create session')
    const accessJwt = resolveString(json.accessJwt)
    const did = resolveString(json.did)

    if (accessJwt == null || did == null) {
        throw new Error('Bluesky session response missing "accessJwt" or "did"')
    }

    return { accessJwt, did }
}

async function publishDraft (params: {
    fetchImpl: FetchLike
    pdsUrl: string
    session: BlueskySession
    draft: DraftPost
}):Promise<CreateRecordResponse> {
    let blob:BlueskyBlob | undefined

    if (params.draft.image != null) {
        blob = await uploadBlob({
            fetchImpl: params.fetchImpl,
            pdsUrl: params.pdsUrl,
            session: params.session,
            bytes: params.draft.image.bytes,
            mimeType: params.draft.image.mimeType
        })
    }

    const record:JsonRecord = {
        $type: 'app.bsky.feed.post',
        text: params.draft.text,
        createdAt: new Date().toISOString()
    }

    if (params.draft.image != null && blob != null) {
        record.embed = {
            $type: 'app.bsky.embed.images',
            images: [
                {
                    alt: params.draft.image.alt,
                    image: blob
                }
            ]
        }
    }

    const url = `${trimTrailingSlash(params.pdsUrl)}/xrpc/com.atproto.repo.createRecord`
    const response = await params.fetchImpl(url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${params.session.accessJwt}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            repo: params.session.did,
            collection: 'app.bsky.feed.post',
            record
        })
    })

    const json = await parseJsonResponse(response, `create record for ${params.draft.path}`)
    const uri = resolveString(json.uri)
    const cid = resolveString(json.cid)
    if (uri == null || cid == null) {
        throw new Error(`Unexpected createRecord response for ${params.draft.path}`)
    }

    return { uri, cid }
}

async function uploadBlob (params: {
    fetchImpl: FetchLike
    pdsUrl: string
    session: BlueskySession
    bytes: Buffer
    mimeType: string
}):Promise<BlueskyBlob> {
    const url = `${trimTrailingSlash(params.pdsUrl)}/xrpc/com.atproto.repo.uploadBlob`
    const response = await params.fetchImpl(url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${params.session.accessJwt}`,
            'content-type': params.mimeType
        },
        body: params.bytes
    })

    const json = await parseJsonResponse(response, 'upload blob')
    if (json.blob == null || typeof json.blob !== 'object') {
        throw new Error('Unexpected uploadBlob response: missing "blob" object')
    }

    return json.blob as BlueskyBlob
}

async function parseJsonResponse (response: any, context: string):Promise<JsonRecord> {
    const bodyText = await response.text()
    let parsed:unknown = {}

    if (bodyText.trim() !== '') {
        try {
            parsed = JSON.parse(bodyText)
        } catch (error) {
            throw new Error(`Could not parse JSON for ${context}: ${(error as Error).message}`)
        }
    }

    if (!response.ok) {
        const message = extractApiError(parsed) ?? response.statusText
        throw new Error(`Bluesky API error (${context}) [${response.status}]: ${message}`)
    }

    if (parsed == null || typeof parsed !== 'object') {
        throw new Error(`Expected JSON object for ${context}`)
    }

    return parsed as JsonRecord
}

function extractApiError (payload: unknown):string | null {
    if (payload == null || typeof payload !== 'object') return null
    const message = resolveString((payload as JsonRecord).message)
    const error = resolveString((payload as JsonRecord).error)
    return message ?? error ?? null
}

function trimTrailingSlash (value: string):string {
    return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildDrafts (params: {
    repoRoot: string
    config: ResolvedConfig
    postPaths: string[]
    state: PublishState
}):DraftPost[] {
    const drafts:DraftPost[] = []

    for (const postPath of params.postPaths) {
        const sourceHash = readGitText(params.repoRoot, ['rev-parse', `HEAD:${postPath}`]).trim()
        const stateEntry = params.state.posts[postPath]
        if (stateEntry != null && stateEntry.sourceHash === sourceHash) {
            continue
        }

        const markdown = readGitBytes(params.repoRoot, ['cat-file', '-p', sourceHash]).toString('utf8')
        const parsed = parsePostFields(markdown, {
            postTextField: params.config.postTextField,
            imageField: params.config.imageField,
            imageAltField: params.config.imageAltField
        })

        const draft:DraftPost = {
            path: postPath,
            sourceHash,
            text: parsed.text
        }

        if (parsed.imagePath != null) {
            const imageRepoPath = resolveGitRelativePath(postPath, parsed.imagePath)
            const imageHash = readGitText(params.repoRoot, ['rev-parse', `HEAD:${imageRepoPath}`]).trim()
            const imageBytes = readGitBytes(params.repoRoot, ['cat-file', '-p', imageHash])

            draft.image = {
                path: imageRepoPath,
                alt: parsed.imageAlt,
                mimeType: detectImageMimeType(imageRepoPath),
                bytes: imageBytes
            }
        }

        drafts.push(draft)
    }

    return drafts
}

function detectImageMimeType (filePath: string):string {
    const extension = extname(filePath).toLowerCase()
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension]
    if (mimeType == null) {
        throw new Error(`Unsupported image type for "${filePath}". Supported: ${Object.keys(IMAGE_MIME_BY_EXTENSION).join(', ')}`)
    }

    return mimeType
}

function listMarkdownPosts (repoRoot: string, postsDirSpec: string):string[] {
    const output = readGitText(repoRoot, ['ls-tree', '-r', '--name-only', 'HEAD', '--', postsDirSpec]).trim()
    if (output === '') return []

    return output
        .split('\n')
        .map(path => path.trim())
        .filter(path => MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase()))
        .sort((a, b) => a.localeCompare(b))
}

function getRepoRoot (cwd: string):string {
    return readGitText(cwd, ['rev-parse', '--show-toplevel']).trim()
}

function toGitPath (filePath: string):string {
    return filePath.replace(/\\/g, '/')
}

function readGitText (cwd: string, args: string[]):string {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        })
    } catch (error) {
        const message = gitErrorMessage(error)
        throw new Error(`git ${args.join(' ')} failed: ${message}`)
    }
}

function readGitBytes (cwd: string, args: string[]):Buffer {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: null,
            stdio: ['ignore', 'pipe', 'pipe']
        })
    } catch (error) {
        const message = gitErrorMessage(error)
        throw new Error(`git ${args.join(' ')} failed: ${message}`)
    }
}

function gitErrorMessage (error: unknown):string {
    if (error == null || typeof error !== 'object') return 'unknown git error'

    const maybeError = error as { stderr?: Buffer | string; message?: string }
    if (maybeError.stderr != null) {
        const stderr = maybeError.stderr.toString().trim()
        if (stderr !== '') return stderr
    }

    return maybeError.message ?? 'unknown git error'
}

export function parsePostFields (
    markdown: string,
    options: { postTextField: string, imageField: string, imageAltField: string }
):ParsedPostFields {
    const parsed = splitFrontmatter(markdown)
    const frontmatter = parsed.frontmatter

    const text = firstString(frontmatter, uniquePaths([
        options.postTextField,
        'bluesky.text',
        'text',
        'post'
    ])) ?? parsed.content.trim()

    if (text == null || text.trim() === '') {
        throw new Error('Missing post text. Set a frontmatter field (default "post") or markdown content.')
    }

    const characterCount = Array.from(text).length
    if (characterCount > 300) {
        throw new Error(`Post text must be 300 characters or fewer. Received ${characterCount}.`)
    }

    const imagePath = firstString(frontmatter, uniquePaths([
        options.imageField,
        'bluesky.image',
        'image'
    ]))

    const imageAlt = firstString(frontmatter, uniquePaths([
        options.imageAltField,
        'bluesky.imageAlt',
        'imageAlt',
        'alt'
    ])) ?? ''

    return {
        text,
        imagePath,
        imageAlt
    }
}

function uniquePaths (paths: string[]):string[] {
    const seen = new Set<string>()
    const output:string[] = []

    for (const value of paths) {
        if (value.trim() === '') continue
        if (seen.has(value)) continue
        seen.add(value)
        output.push(value)
    }

    return output
}

export function splitFrontmatter (markdown: string):{
    frontmatter: Record<string, unknown>
    content: string
} {
    const lines = markdown.split(/\r?\n/)
    if (lines[0]?.trim() !== '---') {
        return {
            frontmatter: {},
            content: markdown
        }
    }

    let closingIndex = -1
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].trim() === '---') {
            closingIndex = index
            break
        }
    }

    if (closingIndex === -1) {
        return {
            frontmatter: {},
            content: markdown
        }
    }

    const frontmatterText = lines.slice(1, closingIndex).join('\n')
    const content = lines.slice(closingIndex + 1).join('\n')

    return {
        frontmatter: parseSimpleYaml(frontmatterText),
        content
    }
}

function parseSimpleYaml (yamlText: string):Record<string, unknown> {
    const root:Record<string, unknown> = {}
    const stack:Array<{ indent: number, value: Record<string, unknown> }> = [
        { indent: -1, value: root }
    ]

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue

        const indent = countIndent(line)
        const content = line.slice(indent)

        const separator = content.indexOf(':')
        if (separator === -1) {
            throw new Error(`Invalid frontmatter line "${content}"`)
        }

        const key = content.slice(0, separator).trim()
        const valueText = content.slice(separator + 1).trim()
        if (key === '') {
            throw new Error(`Invalid frontmatter key in "${content}"`)
        }

        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            stack.pop()
        }

        const parent = stack[stack.length - 1].value

        if (valueText === '') {
            const nested:Record<string, unknown> = {}
            parent[key] = nested
            stack.push({ indent, value: nested })
            continue
        }

        parent[key] = parseYamlScalar(valueText)
    }

    return root
}

function countIndent (line: string):number {
    let count = 0
    for (let index = 0; index < line.length; index += 1) {
        if (line[index] === ' ') {
            count += 1
            continue
        }
        break
    }
    return count
}

function parseYamlScalar (value: string):unknown {
    if (value === 'true') return true
    if (value === 'false') return false
    if (value === 'null') return null

    if (/^-?\d+$/.test(value)) {
        return Number.parseInt(value, 10)
    }

    if (/^-?\d+\.\d+$/.test(value)) {
        return Number.parseFloat(value)
    }

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        const inner = value.slice(1, -1)
        return inner
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
    }

    if (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2) {
        return value.slice(1, -1)
    }

    return value
}

function firstString (data: Record<string, unknown>, fieldPaths: string[]):string | undefined {
    for (const fieldPath of fieldPaths) {
        const value = getNestedField(data, fieldPath)
        const text = resolveString(value)
        if (text != null) {
            return text
        }
    }

    return undefined
}

export function getNestedField (data: Record<string, unknown>, fieldPath: string):unknown {
    const segments = fieldPath.split('.').filter(Boolean)
    let current:unknown = data

    for (const segment of segments) {
        if (current == null || typeof current !== 'object') {
            return undefined
        }

        current = (current as Record<string, unknown>)[segment]
    }

    return current
}

function resolveString (value: unknown):string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

export function resolveGitRelativePath (postPath: string, assetPath: string):string {
    const normalizedInput = assetPath.replace(/\\/g, '/')
    const resolvedPath = normalizedInput.startsWith('/')
        ? posix.normalize(normalizedInput.slice(1))
        : posix.normalize(posix.join(posix.dirname(postPath), normalizedInput))

    if (
        resolvedPath === '' ||
        resolvedPath === '.' ||
        resolvedPath.startsWith('../') ||
        resolvedPath === '..'
    ) {
        throw new Error(`Asset path "${assetPath}" resolves outside repo root`)
    }

    return resolvedPath
}

export function parseDotEnv (source: string):Record<string, string> {
    const env:Record<string, string> = {}

    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (line === '' || line.startsWith('#')) continue

        const separator = line.indexOf('=')
        if (separator === -1) continue

        const key = line.slice(0, separator).trim()
        if (key === '') continue

        let value = line.slice(separator + 1).trim()
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            value = value
                .slice(1, -1)
                .replace(/\\n/g, '\n')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
        } else if (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2) {
            value = value.slice(1, -1)
        } else {
            const commentIndex = value.indexOf(' #')
            if (commentIndex !== -1) {
                value = value.slice(0, commentIndex).trim()
            }
        }

        env[key] = value
    }

    return env
}

export async function readEnvFile (cwd: string):Promise<Record<string, string>> {
    const envPath = resolve(cwd, '.env')
    if (!existsSync(envPath)) return {}

    const source = await readFile(envPath, 'utf8')
    return parseDotEnv(source)
}

export async function loadConfig (cwd: string, explicitPath?: string):Promise<LoadConfigResult> {
    const resolvedPath = explicitPath != null
        ? resolve(cwd, explicitPath)
        : findConfigPath(cwd)

    if (resolvedPath == null) {
        return { path: null, config: {} }
    }

    const extension = extname(resolvedPath).toLowerCase()

    if (extension === '.json') {
        const content = await readFile(resolvedPath, 'utf8')
        const json = JSON.parse(content)
        if (json == null || typeof json !== 'object') {
            throw new Error(`Config file "${resolvedPath}" must export an object`)
        }

        return {
            path: resolvedPath,
            config: json as NatConfig
        }
    }

    const moduleNamespace = extension === '.ts'
        ? await importTsConfig(resolvedPath)
        : await import(pathToFileURL(resolvedPath).href + `?t=${Date.now()}`)

    const config = extractConfigExport(moduleNamespace, resolvedPath)
    return {
        path: resolvedPath,
        config
    }
}

function findConfigPath (cwd: string):string | null {
    const candidates = [
        'nat.config.ts',
        'nat.config.js',
        'nat.config.json'
    ]

    for (const candidate of candidates) {
        const absolutePath = resolve(cwd, candidate)
        if (existsSync(absolutePath)) {
            return absolutePath
        }
    }

    return null
}

async function importTsConfig (configPath: string):Promise<Record<string, unknown>> {
    const bundle = await build({
        entryPoints: [configPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        logLevel: 'silent'
    })

    const output = bundle.outputFiles[0]?.text
    if (output == null) {
        throw new Error(`Failed to compile config file "${configPath}"`)
    }

    const temporaryPath = resolve(
        tmpdir(),
        `nat-config-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
    )

    await writeFile(temporaryPath, output, 'utf8')

    try {
        return await import(pathToFileURL(temporaryPath).href + `?t=${Date.now()}`) as Record<string, unknown>
    } finally {
        await rm(temporaryPath, { force: true })
    }
}

function extractConfigExport (moduleNamespace: Record<string, unknown>, filePath: string):NatConfig {
    const exported = moduleNamespace.default ?? moduleNamespace
    if (exported == null || typeof exported !== 'object') {
        throw new Error(`Config file "${filePath}" must export an object`)
    }

    return exported as NatConfig
}

export function normalizeConfig (params: {
    cwd: string
    env: Record<string, string | undefined>
    config: NatConfig
    postsDirOverride?: string
}):ResolvedConfig {
    const handle = resolveString(params.config.bluesky?.handle) ??
        resolveString(params.config.handle) ??
        resolveString(params.env.NAT_BLUESKY_HANDLE)

    if (handle == null) {
        throw new Error('Missing Bluesky handle. Configure "handle" in nat.config.* or NAT_BLUESKY_HANDLE in env.')
    }

    const pdsUrl = resolveString(params.config.bluesky?.pdsUrl) ??
        resolveString(params.config.pdsUrl) ??
        resolveString(params.env.NAT_BLUESKY_PDS_URL) ??
        DEFAULT_PDS_URL

    const passwordEnvVar = resolveString(params.config.bluesky?.passwordEnvVar) ??
        resolveString(params.config.passwordEnvVar) ??
        DEFAULT_PASSWORD_ENV_VAR

    const postsDir = resolve(
        params.cwd,
        params.postsDirOverride ??
            resolveString(params.config.postsDir) ??
            DEFAULT_POSTS_DIR
    )

    const stateFile = resolve(
        params.cwd,
        resolveString(params.config.stateFile) ?? DEFAULT_STATE_FILE
    )

    return {
        handle,
        pdsUrl,
        postsDir,
        stateFile,
        passwordEnvVar,
        postTextField: resolveString(params.config.postTextField) ?? DEFAULT_POST_TEXT_FIELD,
        imageField: resolveString(params.config.imageField) ?? DEFAULT_IMAGE_FIELD,
        imageAltField: resolveString(params.config.imageAltField) ?? DEFAULT_IMAGE_ALT_FIELD
    }
}

export async function loadState (stateFilePath: string):Promise<PublishState> {
    if (!existsSync(stateFilePath)) {
        return { version: 1, posts: {} }
    }

    const source = await readFile(stateFilePath, 'utf8')
    const parsed = JSON.parse(source)

    if (parsed == null || typeof parsed !== 'object') {
        throw new Error(`State file "${stateFilePath}" is invalid`)
    }

    const posts = (parsed as JsonRecord).posts
    if (posts == null || typeof posts !== 'object') {
        return { version: 1, posts: {} }
    }

    return {
        version: 1,
        posts: posts as Record<string, PublishedPostState>
    }
}

export async function saveState (stateFilePath: string, state: PublishState):Promise<void> {
    await mkdir(dirname(stateFilePath), { recursive: true })
    await writeFile(
        stateFilePath,
        `${JSON.stringify(state, null, 4)}\n`,
        'utf8'
    )
}
