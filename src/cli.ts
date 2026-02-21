#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
    loadConfig,
    publish,
    type CliIO,
    type NoatConfig,
    type PublishOptions
} from './index.js'

interface ParsedCli {
    command:'publish' | 'help'
    options:PublishOptions
}

interface YargsCliResult {
    _:Array<string | number>
    config?:string
    cwd?:string
    handle?:string
    pdsUrl?:string
    posts?:string
    passwordEnvVar?:string
    postTextField?:string
    baseUrl?:string
    dryRun?:boolean
    verbose?:boolean
    help?:boolean
}

const DEFAULT_IO:CliIO = {
    log: (...args:any[]) => { console.log(...args) },
    error: (...args:any[]) => { console.error(...args) }
}

function createParser (argv:string[]) {
    return yargs(argv)
        .scriptName('noat')
        .usage('Usage: $0 [publish] [options]')
        .command('publish', 'Publish markdown posts to Bluesky')
        .option('config', {
            type: 'string',
            describe: 'Path to noat.config.*'
        })
        .option('handle', {
            type: 'string',
            describe: 'Bluesky handle'
        })
        .option('pdsUrl', {
            alias: 'pds-url',
            type: 'string',
            describe: 'Bluesky PDS URL'
        })
        .option('posts', {
            type: 'string',
            describe: 'Directory containing markdown posts'
        })
        .option('passwordEnvVar', {
            alias: 'password-env-var',
            type: 'string',
            describe: 'Env var that stores the Bluesky app password'
        })
        .option('postTextField', {
            alias: 'post-text-field',
            type: 'string',
            describe: 'Frontmatter field used for Bluesky text'
        })
        .option('baseUrl', {
            alias: 'base-url',
            type: 'string',
            describe: 'Base URL prefixed to each post slug'
        })
        .option('cwd', {
            type: 'string',
            describe: 'Working directory'
        })
        .option('dryRun', {
            alias: 'dry-run',
            type: 'boolean',
            describe: 'Preview publishes without posting'
        })
        .option('verbose', {
            type: 'boolean',
            describe: 'Print additional debug info'
        })
        .option('help', {
            alias: 'h',
            type: 'boolean',
            default: false,
            describe: 'Show help'
        })
        .strictCommands()
        .strictOptions()
        .exitProcess(false)
        .fail((message, error) => {
            if (error != null) throw error
            throw new Error(message)
        })
}

export function parseCliArgs (argv:string[]):ParsedCli {
    const normalizedArgv = argv[0] === 'help'
        ? ['--help', ...argv.slice(1)]
        : argv
    const parser = createParser(normalizedArgv)
    const parsed = parser.parseSync() as unknown as YargsCliResult

    const command = parsed._[0] == null
        ? 'publish'
        : String(parsed._[0])

    if (parsed.help === true || command === 'help') {
        return {
            command: 'help',
            options: {}
        }
    }

    if (command !== 'publish') {
        throw new Error(`Unknown command "${command}". Use "noat --help".`)
    }

    const options:PublishOptions = {}

    if (typeof parsed.config === 'string' && parsed.config.trim() !== '') {
        options.configPath = parsed.config
    }
    if (typeof parsed.cwd === 'string' && parsed.cwd.trim() !== '') {
        options.cwd = parsed.cwd
    }
    if (typeof parsed.handle === 'string' && parsed.handle.trim() !== '') {
        options.handle = parsed.handle
    }
    if (typeof parsed.pdsUrl === 'string' && parsed.pdsUrl.trim() !== '') {
        options.pdsUrl = parsed.pdsUrl
    }
    if (typeof parsed.posts === 'string' && parsed.posts.trim() !== '') {
        options.postsDir = parsed.posts
    }
    if (
        typeof parsed.passwordEnvVar === 'string' &&
        parsed.passwordEnvVar.trim() !== ''
    ) {
        options.passwordEnvVar = parsed.passwordEnvVar
    }
    if (
        typeof parsed.postTextField === 'string' &&
        parsed.postTextField.trim() !== ''
    ) {
        options.postTextField = parsed.postTextField
    }
    if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() !== '') {
        options.baseUrl = parsed.baseUrl
    }
    if (typeof parsed.dryRun === 'boolean') {
        options.dryRun = parsed.dryRun
    }
    if (typeof parsed.verbose === 'boolean') {
        options.verbose = parsed.verbose
    }

    return {
        command: 'publish',
        options
    }
}

export async function runCli (
    argv:string[],
    io:CliIO = DEFAULT_IO
):Promise<void> {
    const parsed = parseCliArgs(argv)

    if (parsed.command === 'help') {
        return
    }

    const loadCwd = resolve(parsed.options.cwd ?? process.cwd())
    const loaded = await loadConfig(loadCwd, parsed.options.configPath)
    const configOptions = optionsFromConfig(loaded.config)
    const mergedOptions:PublishOptions = {
        ...configOptions,
        ...parsed.options
    }

    mergedOptions.cwd = resolve(mergedOptions.cwd ?? loadCwd)
    if (loaded.path != null) {
        mergedOptions.configPath = loaded.path
    }

    const summary = await publish(mergedOptions, io)
    const mode = summary.dryRun ? 'dry run complete' : 'publish complete'
    const counts = [
        `queued=${summary.queuedPosts}`,
        `published=${summary.publishedPosts}`,
        `skipped=${summary.skippedPosts}`
    ].join(', ')
    io.log(`[noat] ${mode}. ${counts}`)
}

function optionsFromConfig (config:NoatConfig):PublishOptions {
    const options:PublishOptions = {}
    const raw = config as Record<string, unknown>

    const cwd = resolveString(raw.cwd)
    if (cwd != null) options.cwd = cwd

    const handle = resolveString(config.handle)
    if (handle != null) options.handle = handle

    const pdsUrl = resolveString(config.pdsUrl)
    if (pdsUrl != null) options.pdsUrl = pdsUrl

    const posts = resolveString(raw.posts)
    if (posts != null) options.postsDir = posts

    const passwordEnvVar = resolveString(config.passwordEnvVar)
    if (passwordEnvVar != null) options.passwordEnvVar = passwordEnvVar

    const postTextField = resolveString(config.postTextField)
    if (postTextField != null) options.postTextField = postTextField

    const baseUrl = resolveString(config.baseUrl)
    if (baseUrl != null) options.baseUrl = baseUrl

    const dryRun = resolveBoolean(raw.dryRun)
    if (dryRun != null) options.dryRun = dryRun

    const verbose = resolveBoolean(raw.verbose)
    if (verbose != null) options.verbose = verbose

    return options
}

function resolveString (value:unknown):string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

function resolveBoolean (value:unknown):boolean | undefined {
    return typeof value === 'boolean' ? value : undefined
}

function isExecutedDirectly (importMetaUrl:string):boolean {
    const entryPoint = process.argv[1]
    if (entryPoint == null) return false
    return resolve(entryPoint) === fileURLToPath(importMetaUrl)
}

if (isExecutedDirectly(import.meta.url)) {
    runCli(hideBin(process.argv)).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[noat] ${message}`)
        process.exitCode = 1
    })
}
