import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const DEFAULT_PDS_URL = 'https://bsky.social'
const DEFAULT_POSTS_DIR = './posts'
const DEFAULT_PASSWORD_ENV_VAR = 'NOAT_BLUESKY_APP_PASSWORD'
const DEFAULT_POST_TEXT_FIELD = 'post'
const DEFAULT_AT_URL_FIELD = 'AT_URL'
const PUBLISH_COMMIT_PREFIX = 'AT proto publish '

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
    [key:string]:unknown
}

interface BlueskySession {
    accessJwt:string
    did:string
}

interface CreateRecordResponse {
    uri:string
    cid:string
}

export interface NoatConfig {
    cwd?:string
    handle?:string
    pdsUrl?:string
    posts?:string
    passwordEnvVar?:string
    postTextField?:string
    baseUrl?:string
    dryRun?:boolean
    verbose?:boolean
}

export interface ResolvedConfig {
    handle:string
    pdsUrl:string
    postsDir:string
    passwordEnvVar:string
    postTextField:string
    baseUrl:string
}

export interface PublishOptions {
    cwd?:string
    configPath?:string
    handle?:string
    pdsUrl?:string
    postsDir?:string
    passwordEnvVar?:string
    postTextField?:string
    baseUrl?:string
    dryRun?:boolean
    verbose?:boolean
}

export interface PublishSummary {
    dryRun:boolean
    totalPosts:number
    skippedPosts:number
    queuedPosts:number
    publishedPosts:number
}

export interface CliIO {
    log:(...args:any[])=>void
    error:(...args:any[])=>void
}

interface ParsedPostFields {
    text:string
    imagePath?:string
    imageAlt:string
}

interface DraftPost {
    path:string
    text:string
    image?:{
        path:string
        alt:string
        mimeType:string
        bytes:Buffer
    }
}

interface LoadConfigResult {
    path:string|null
    config:NoatConfig
}

type JsonRecord = Record<string, unknown>
type FetchLike = (url:string, init?:Record<string, unknown>)=>Promise<any>

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load:(source:string)=>unknown }

const DEFAULT_IO:CliIO = {
    log: (...args:any[]) => { console.log(...args) },
    error: (...args:any[]) => { console.error(...args) }
}

export async function publish (
    options:PublishOptions = {},
    io:CliIO = DEFAULT_IO
):Promise<PublishSummary> {
    const cwd = resolve(options.cwd ?? process.cwd())
    const envFromFile = await readEnvFile(cwd)
    const env = {
        ...envFromFile,
        ...process.env
    }

    const loaded = await loadConfig(cwd, options.configPath)
    const configDir = loaded.path == null ? cwd : dirname(loaded.path)
    const mergedConfig:NoatConfig = {
        ...loaded.config,
        ...extractConfigOverrides(options)
    }
    const config = normalizeConfig({
        configDir,
        env,
        config: mergedConfig
    })

    if (options.verbose) {
        const configuredPath = loaded.path ?? '(defaults only)'
        io.log(`[noat] config file: ${configuredPath}`)
        io.log(`[noat] posts dir: ${config.postsDir}`)
    }

    const repoRoot = getRepoRoot(cwd)
    const postsRelativeToRepo = toGitPath(relative(repoRoot, config.postsDir))

    if (postsRelativeToRepo.startsWith('../') || postsRelativeToRepo === '..') {
        throw new Error(
            'Configured postsDir must be inside the git repo. ' +
            `Received "${config.postsDir}"`
        )
    }

    const postsRootSpec = postsRelativeToRepo === '' ? '.' : postsRelativeToRepo
    const postPaths = listMarkdownPosts(repoRoot, postsRootSpec)
    const drafts = buildDrafts({
        repoRoot,
        config,
        postPaths,
        postsRootSpec
    })

    if (drafts.length === 0) {
        io.log('[noat] no new posts found to publish')
        return {
            dryRun: options.dryRun === true,
            totalPosts: postPaths.length,
            skippedPosts: postPaths.length,
            queuedPosts: 0,
            publishedPosts: 0
        }
    }

    if (options.dryRun === true) {
        for (const draft of drafts) {
            io.log(`[noat] dry-run would publish ${draft.path}`)
        }

        return {
            dryRun: true,
            totalPosts: postPaths.length,
            skippedPosts: postPaths.length - drafts.length,
            queuedPosts: drafts.length,
            publishedPosts: 0
        }
    }

    assertGitRepoClean(repoRoot)

    const password = resolveString(env[config.passwordEnvVar])
    if (password == null) {
        throw new Error(
            `Missing password. Set ${config.passwordEnvVar} ` +
            'in .env or environment.'
        )
    }

    const fetchImpl = resolveFetchImplementation()
    const session = await createSession({
        fetchImpl,
        handle: config.handle,
        password,
        pdsUrl: config.pdsUrl
    })

    let publishedCount = 0
    const changedPaths:string[] = []

    for (const draft of drafts) {
        const result = await publishDraft({
            fetchImpl,
            pdsUrl: config.pdsUrl,
            session,
            draft
        })
        const blueskyUrl = toBlueskyPostUrl(config.handle, result.uri)
        const changed = await writePublishedAtUrl({
            repoRoot,
            postPath: draft.path,
            atUrl: blueskyUrl
        })
        if (changed) changedPaths.push(draft.path)

        publishedCount += 1
        io.log(`[noat] published ${draft.path} -> ${blueskyUrl}`)
    }

    const commitMessage = commitPublishedPosts(repoRoot, changedPaths)
    io.log(`[noat] committed publish metadata: ${commitMessage}`)

    return {
        dryRun: false,
        totalPosts: postPaths.length,
        skippedPosts: postPaths.length - drafts.length,
        queuedPosts: drafts.length,
        publishedPosts: publishedCount
    }
}

function resolveFetchImplementation ():FetchLike {
    const fetchImpl = (globalThis as Record<string, unknown>).fetch
    if (typeof fetchImpl !== 'function') {
        throw new Error('Global fetch API is unavailable. Use Node.js 18+.')
    }

    return fetchImpl as FetchLike
}

async function createSession (params:{
    fetchImpl:FetchLike
    pdsUrl:string
    handle:string
    password:string
}):Promise<BlueskySession> {
    const url = `${trimTrailingSlash(params.pdsUrl)}` +
        '/xrpc/com.atproto.server.createSession'
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

async function publishDraft (params:{
    fetchImpl:FetchLike
    pdsUrl:string
    session:BlueskySession
    draft:DraftPost
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

    const url = `${trimTrailingSlash(params.pdsUrl)}` +
        '/xrpc/com.atproto.repo.createRecord'
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

    const context = `create record for ${params.draft.path}`
    const json = await parseJsonResponse(response, context)
    const uri = resolveString(json.uri)
    const cid = resolveString(json.cid)
    if (uri == null || cid == null) {
        throw new Error(
            'Unexpected createRecord response for ' +
            params.draft.path
        )
    }

    return { uri, cid }
}

async function uploadBlob (params:{
    fetchImpl:FetchLike
    pdsUrl:string
    session:BlueskySession
    bytes:Buffer
    mimeType:string
}):Promise<BlueskyBlob> {
    const url = `${trimTrailingSlash(params.pdsUrl)}` +
        '/xrpc/com.atproto.repo.uploadBlob'
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

async function parseJsonResponse (
    response:any,
    context:string
):Promise<JsonRecord> {
    const bodyText = await response.text()
    let parsed:unknown = {}

    if (bodyText.trim() !== '') {
        try {
            parsed = JSON.parse(bodyText)
        } catch (error) {
            const message = (error as Error).message
            throw new Error(
                `Could not parse JSON for ${context}: ${message}`
            )
        }
    }

    if (!response.ok) {
        const message = extractApiError(parsed) ?? response.statusText
        throw new Error(
            `Bluesky API error (${context}) ` +
            `[${response.status}]: ${message}`
        )
    }

    if (parsed == null || typeof parsed !== 'object') {
        throw new Error(`Expected JSON object for ${context}`)
    }

    return parsed as JsonRecord
}

export function toBlueskyPostUrl (handle:string, atUri:string):string {
    const match = /\/app\.bsky\.feed\.post\/([^/]+)$/.exec(atUri)
    if (match == null) {
        throw new Error(`Could not derive Bluesky post URL from "${atUri}"`)
    }

    const postId = encodeURIComponent(match[1])
    const encodedHandle = encodeURIComponent(handle)
    return `https://bsky.app/profile/${encodedHandle}/post/${postId}`
}

function extractApiError (payload:unknown):string|null {
    if (payload == null || typeof payload !== 'object') return null
    const message = resolveString((payload as JsonRecord).message)
    const error = resolveString((payload as JsonRecord).error)
    return message ?? error ?? null
}

function trimTrailingSlash (value:string):string {
    return value.endsWith('/') ? value.slice(0, -1) : value
}

function buildDrafts (params:{
    repoRoot:string
    config:ResolvedConfig
    postPaths:string[]
    postsRootSpec:string
}):DraftPost[] {
    const drafts:DraftPost[] = []

    for (const postPath of params.postPaths) {
        const markdown = readGitBytes(
            params.repoRoot,
            ['show', `HEAD:${postPath}`]
        ).toString('utf8')
        const frontmatter = splitFrontmatter(markdown).frontmatter
        const atUrl = getNestedField(frontmatter, DEFAULT_AT_URL_FIELD)
        if (atUrl !== undefined) continue

        const parsed = parsePostFields(markdown, {
            postTextField: params.config.postTextField
        })
        const backlinkUrl = resolveBacklinkUrl({
            postPath,
            postsRootSpec: params.postsRootSpec,
            frontmatter,
            config: params.config
        })

        if (backlinkUrl == null) {
            throw new Error(
                'Could not resolve backlink URL for "' +
                `${postPath}". Set "baseUrl" in noat.config.*.`
            )
        }

        const text = appendBacklink(parsed.text, backlinkUrl)
        assertPostLength(text, postPath)

        let imageRepoPath:string | undefined
        let imageBytes:Buffer | undefined
        let imageMimeType:string | undefined

        if (parsed.imagePath != null) {
            imageRepoPath = resolveGitRelativePath(postPath, parsed.imagePath)
            imageBytes = readGitBytes(
                params.repoRoot,
                ['show', `HEAD:${imageRepoPath}`]
            )
            imageMimeType = detectImageMimeType(imageRepoPath)
        }

        const draft:DraftPost = {
            path: postPath,
            text
        }

        if (
            imageRepoPath != null &&
            imageBytes != null &&
            imageMimeType != null
        ) {
            draft.image = {
                path: imageRepoPath,
                alt: parsed.imageAlt,
                mimeType: imageMimeType,
                bytes: imageBytes
            }
        }

        drafts.push(draft)
    }

    return drafts
}

function detectImageMimeType (filePath:string):string {
    const extension = extname(filePath).toLowerCase()
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension]
    if (mimeType == null) {
        const supported = Object.keys(IMAGE_MIME_BY_EXTENSION).join(', ')
        throw new Error(
            `Unsupported image type for "${filePath}". ` +
            `Supported: ${supported}`
        )
    }

    return mimeType
}

function listMarkdownPosts (repoRoot:string, postsDirSpec:string):string[] {
    const output = readGitText(repoRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        'HEAD',
        '--',
        postsDirSpec
    ]).trim()
    if (output === '') return []

    return output
        .split('\n')
        .map(path => path.trim())
        .filter(path => MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase()))
        .sort((a, b) => a.localeCompare(b))
}

function getRepoRoot (cwd:string):string {
    return readGitText(cwd, ['rev-parse', '--show-toplevel']).trim()
}

function assertGitRepoClean (repoRoot:string):void {
    const status = readGitText(repoRoot, ['status', '--porcelain']).trim()
    if (status !== '') {
        throw new Error(
            'Git repo is not clean. Commit or stash local changes before ' +
            'publishing.'
        )
    }
}

function commitPublishedPosts (repoRoot:string, postPaths:string[]):string {
    if (postPaths.length === 0) {
        throw new Error(
            'No post files changed after publishing; nothing to commit.'
        )
    }

    const commitNumber = getNextPublishCommitNumber(repoRoot)
    const message = `${PUBLISH_COMMIT_PREFIX}${commitNumber}`
    readGitText(repoRoot, ['add', '--', ...postPaths])
    readGitText(repoRoot, ['commit', '-m', message])
    return message
}

export function getNextPublishCommitNumber (repoRoot:string):number {
    const subjects = readGitText(repoRoot, ['log', '--format=%s']).trim()
    if (subjects === '') return 1

    for (const subject of subjects.split('\n')) {
        const match = /^AT proto publish (\d+)$/.exec(subject.trim())
        if (match == null) continue
        const previous = Number.parseInt(match[1], 10)
        return Number.isNaN(previous) ? 1 : previous + 1
    }

    return 1
}

function toGitPath (filePath:string):string {
    return filePath.replace(/\\/g, '/')
}

function readGitText (cwd:string, args:string[]):string {
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

function readGitBytes (cwd:string, args:string[]):Buffer {
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

function gitErrorMessage (error:unknown):string {
    if (error == null || typeof error !== 'object') return 'unknown git error'

    const maybeError = error as { stderr?:Buffer|string; message?:string }
    if (maybeError.stderr != null) {
        const stderr = maybeError.stderr.toString().trim()
        if (stderr !== '') return stderr
    }

    return maybeError.message ?? 'unknown git error'
}

export function parsePostFields (
    markdown:string,
    options:{ postTextField:string }
):ParsedPostFields {
    const parsed = splitFrontmatter(markdown)
    const frontmatter = parsed.frontmatter
    const firstImage = findFirstMarkdownImage(parsed.content)

    const text = firstString(frontmatter, uniquePaths([
        options.postTextField,
        'bluesky.text',
        'text',
        'post'
    ])) ?? stripMarkdownImages(parsed.content).trim()

    if (text == null || text.trim() === '') {
        throw new Error(
            'Missing post text. Set a frontmatter field ' +
            '(default "post") or markdown content.'
        )
    }

    const characterCount = Array.from(text).length
    if (characterCount > 300) {
        throw new Error(
            'Post text must be 300 characters or fewer. ' +
            `Received ${characterCount}.`
        )
    }

    const imagePath = firstImage?.path
    const imageAlt = firstImage?.alt ?? ''

    return {
        text,
        imagePath,
        imageAlt
    }
}

function assertPostLength (text:string, postPath:string):void {
    const characterCount = Array.from(text).length
    if (characterCount > 300) {
        throw new Error(
            'Post text must be 300 chars or fewer after adding backlink. ' +
            `Post "${postPath}" is ${characterCount}.`
        )
    }
}

interface MarkdownImageReference {
    alt:string
    path:string
}

export function findFirstMarkdownImage (
    content:string
):MarkdownImageReference | null {
    const match = /!\[([^\]]*)\]\(([^)\n]+)\)/.exec(content)
    if (match == null) return null

    const alt = match[1]?.trim() ?? ''
    const target = match[2]?.trim() ?? ''
    const path = parseMarkdownImagePath(target)
    if (path == null) return null

    return { alt, path }
}

export function appendBacklink (text:string, backlinkUrl:string):string {
    if (text.includes(backlinkUrl)) return text
    return `${text}\n\n${backlinkUrl}`
}

export function resolveBacklinkUrl (params:{
    postPath:string
    postsRootSpec:string
    frontmatter:Record<string, unknown>
    config:ResolvedConfig
}):string|null {
    const slug = firstString(params.frontmatter, uniquePaths([
        'slug',
        'bluesky.slug'
    ]))
    if (slug == null) {
        return backlinkFromPostPath(
            params.config.baseUrl,
            params.postsRootSpec,
            params.postPath
        )
    }

    const baseUrl = trimTrailingSlash(params.config.baseUrl)
    const normalizedSlug = slug.trim().replace(/^\/+|\/+$/g, '')
    if (normalizedSlug === '') return baseUrl

    const encodedSlug = normalizedSlug
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/')

    return `${baseUrl}/${encodedSlug}`
}

function backlinkFromPostPath (
    baseUrl:string,
    postsRootSpec:string,
    postPath:string
):string {
    const normalizedBaseUrl = trimTrailingSlash(baseUrl)
    const postsRoot = normalizePostsRoot(postsRootSpec)
    const postRelativePath = postsRoot === ''
        ? postPath
        : postPath.replace(`${postsRoot}/`, '')
    const pathWithoutExtension = postRelativePath
        .replace(/\.markdown$/i, '')
        .replace(/\.md$/i, '')
    const canonicalPath = pathWithoutExtension.endsWith('/index')
        ? pathWithoutExtension.slice(0, -('/index'.length))
        : pathWithoutExtension
    const encodedPath = canonicalPath
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/')

    if (encodedPath === '') return normalizedBaseUrl
    return `${normalizedBaseUrl}/${encodedPath}`
}

function normalizePostsRoot (postsRootSpec:string):string {
    if (postsRootSpec === '.') return ''
    return postsRootSpec.replace(/^\.\/+/, '').replace(/\/+$/, '')
}

function parseMarkdownImagePath (target:string):string|null {
    if (target === '') return null

    if (target.startsWith('<')) {
        const closing = target.indexOf('>')
        if (closing <= 1) return null
        return target.slice(1, closing).trim()
    }

    const firstToken = target.split(/\s+/)[0]?.trim()
    if (firstToken == null || firstToken === '') return null
    return firstToken
}

function stripMarkdownImages (content:string):string {
    return content.replace(/!\[[^\]]*\]\([^)\n]+\)/g, '').trim()
}

function uniquePaths (paths:string[]):string[] {
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

export function splitFrontmatter (markdown:string):{
    frontmatter:Record<string, unknown>
    content:string
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
        frontmatter: parseYamlFrontmatter(frontmatterText),
        content
    }
}

async function writePublishedAtUrl (params:{
    repoRoot:string
    postPath:string
    atUrl:string
}):Promise<boolean> {
    const absolutePath = resolve(params.repoRoot, params.postPath)
    const source = await readFile(absolutePath, 'utf8')
    const next = upsertFrontmatterField(
        source,
        DEFAULT_AT_URL_FIELD,
        params.atUrl
    )

    if (next === source) return false
    await writeFile(absolutePath, next, 'utf8')
    return true
}

export function upsertFrontmatterField (
    markdown:string,
    field:string,
    value:string
):string {
    const lines = markdown.split(/\r?\n/)
    const renderedField = `${field}: ${JSON.stringify(value)}`
    const hasTrailingNewline = markdown.endsWith('\n')

    if (lines[0]?.trim() === '---') {
        let closingIndex = -1
        for (let index = 1; index < lines.length; index += 1) {
            if (lines[index].trim() === '---') {
                closingIndex = index
                break
            }
        }

        if (closingIndex !== -1) {
            const fieldPattern = new RegExp(`^${escapeRegex(field)}\\s*:`)
            let didReplace = false
            for (let index = 1; index < closingIndex; index += 1) {
                if (fieldPattern.test(lines[index])) {
                    lines[index] = renderedField
                    didReplace = true
                    break
                }
            }

            if (!didReplace) {
                lines.splice(closingIndex, 0, renderedField)
            }

            return finalizeNewline(lines.join('\n'), hasTrailingNewline)
        }
    }

    const prefixed = [
        '---',
        renderedField,
        '---',
        markdown
    ].join('\n')

    return finalizeNewline(prefixed, hasTrailingNewline)
}

function finalizeNewline (
    text:string,
    hasTrailingNewline:boolean
):string {
    if (hasTrailingNewline) {
        return text.endsWith('\n') ? text : `${text}\n`
    }

    return text.endsWith('\n') ? text.slice(0, -1) : text
}

export function stripFrontmatterField (
    markdown:string,
    field:string
):string {
    const lines = markdown.split(/\r?\n/)
    if (lines[0]?.trim() !== '---') return markdown

    let closingIndex = -1
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].trim() === '---') {
            closingIndex = index
            break
        }
    }

    if (closingIndex === -1) return markdown

    const fieldPattern = new RegExp(`^${escapeRegex(field)}\\s*:`)
    const withoutField = lines
        .slice(1, closingIndex)
        .filter(line => !fieldPattern.test(line))
    const rebuilt = [
        '---',
        ...withoutField,
        '---',
        ...lines.slice(closingIndex + 1)
    ].join('\n')

    return finalizeNewline(rebuilt, markdown.endsWith('\n'))
}

function escapeRegex (value:string):string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseYamlFrontmatter (yamlText:string):Record<string, unknown> {
    try {
        const parsed = yaml.load(yamlText)
        if (parsed == null) return {}
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('frontmatter must be an object')
        }

        return parsed as Record<string, unknown>
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Invalid YAML frontmatter: ${message}`)
    }
}

function firstString (
    data:Record<string, unknown>,
    fieldPaths:string[]
):string | undefined {
    for (const fieldPath of fieldPaths) {
        const value = getNestedField(data, fieldPath)
        const text = resolveString(value)
        if (text != null) {
            return text
        }
    }

    return undefined
}

export function getNestedField (
    data:Record<string, unknown>,
    fieldPath:string
):unknown {
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

function resolveString (value:unknown):string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

export function resolveGitRelativePath (
    postPath:string,
    assetPath:string
):string {
    const normalizedInput = assetPath.replace(/\\/g, '/')

    if (
        /^[a-z]+:\/\//i.test(normalizedInput) ||
        normalizedInput.startsWith('data:')
    ) {
        throw new Error(
            'Only repository file paths are supported for images. ' +
            `Received "${assetPath}"`
        )
    }

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

export function parseDotEnv (source:string):Record<string, string> {
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
        } else if (
            value.startsWith('\'') &&
            value.endsWith('\'') &&
            value.length >= 2
        ) {
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

export async function readEnvFile (cwd:string):Promise<Record<string, string>> {
    const envPath = resolve(cwd, '.env')
    if (!existsSync(envPath)) return {}

    const source = await readFile(envPath, 'utf8')
    return parseDotEnv(source)
}

export async function loadConfig (
    cwd:string,
    explicitPath?:string
):Promise<LoadConfigResult> {
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
            throw new Error(
                `Config file "${resolvedPath}" must export an object`
            )
        }

        return {
            path: resolvedPath,
            config: json as NoatConfig
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

function findConfigPath (cwd:string):string | null {
    const candidates = [
        'noat.config.ts',
        'noat.config.js',
        'noat.config.json'
    ]

    for (const candidate of candidates) {
        const absolutePath = resolve(cwd, candidate)
        if (existsSync(absolutePath)) {
            return absolutePath
        }
    }

    return null
}

async function importTsConfig (
    configPath:string
):Promise<Record<string, unknown>> {
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
        `noat-config-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
    )

    await writeFile(temporaryPath, output, 'utf8')

    try {
        const cacheBust = `?t=${Date.now()}`
        const moduleUrl = pathToFileURL(temporaryPath).href + cacheBust
        return await import(moduleUrl) as Record<string, unknown>
    } finally {
        await rm(temporaryPath, { force: true })
    }
}

function extractConfigExport (
    moduleNamespace:Record<string, unknown>,
    filePath:string
):NoatConfig {
    const exported = moduleNamespace.default ?? moduleNamespace
    if (exported == null || typeof exported !== 'object') {
        throw new Error(`Config file "${filePath}" must export an object`)
    }

    return exported as NoatConfig
}

export function normalizeConfig (params:{
    configDir:string
    env:Record<string, string|undefined>
    config:NoatConfig
}):ResolvedConfig {
    const handle = resolveString(params.config.handle) ??
        resolveString(params.env.NOAT_BLUESKY_HANDLE)

    if (handle == null) {
        throw new Error(
            'Missing Bluesky handle. Configure "handle" in noat.config.* ' +
            'or NOAT_BLUESKY_HANDLE in env.'
        )
    }

    const pdsUrl = resolveString(params.config.pdsUrl) ??
        resolveString(params.env.NOAT_BLUESKY_PDS_URL) ??
        DEFAULT_PDS_URL

    const passwordEnvVar = resolveString(params.config.passwordEnvVar) ??
        DEFAULT_PASSWORD_ENV_VAR
    const baseUrl = resolveString(params.config.baseUrl) ??
        resolveString(params.env.NOAT_BASE_URL)
    if (baseUrl == null) {
        throw new Error(
            'Missing baseUrl. Configure "baseUrl" in noat.config.* ' +
            'or NOAT_BASE_URL in env.'
        )
    }

    const configuredPosts = resolveString(params.config.posts)
    const postsDir = configuredPosts != null
        ? resolve(params.configDir, configuredPosts)
        : resolve(params.configDir, DEFAULT_POSTS_DIR)

    return {
        handle,
        pdsUrl,
        postsDir,
        passwordEnvVar,
        baseUrl,
        postTextField:
            resolveString(params.config.postTextField) ??
            DEFAULT_POST_TEXT_FIELD
    }
}

function extractConfigOverrides (options:PublishOptions):NoatConfig {
    const config:NoatConfig = {}

    if (options.handle != null) config.handle = options.handle
    if (options.pdsUrl != null) config.pdsUrl = options.pdsUrl
    if (options.postsDir != null) config.posts = options.postsDir
    if (options.passwordEnvVar != null) {
        config.passwordEnvVar = options.passwordEnvVar
    }
    if (options.postTextField != null) {
        config.postTextField = options.postTextField
    }
    if (options.baseUrl != null) config.baseUrl = options.baseUrl

    return config
}
