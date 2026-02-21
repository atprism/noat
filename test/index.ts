import { test } from '@substrate-system/tapzero'
import {
    appendBacklink,
    findFirstMarkdownImage,
    getNestedField,
    normalizeConfig,
    parseDotEnv,
    parsePostFields,
    resolveBacklinkUrl,
    resolveGitRelativePath,
    stripFrontmatterField,
    splitFrontmatter,
    toBlueskyPostUrl,
    upsertFrontmatterField
} from '../src/index.js'
import { parseCliArgs } from '../src/cli.js'

const TEST_CONFIG = {
    handle: 'abc.bsky.social',
    pdsUrl: 'https://bsky.social',
    postsDir: '/repo/posts',
    passwordEnvVar: 'NOAT_BLUESKY_APP_PASSWORD',
    postTextField: 'post',
    baseUrl: 'https://blog.example.com/blog'
}

test('parseDotEnv', t => {
    const env = parseDotEnv([
        '# comment',
        'NOAT_BLUESKY_APP_PASSWORD=abc123',
        'QUOTED="hello world"',
        'INLINE=value # inline',
        '',
        'SINGLE=\'ok\''
    ].join('\n'))

    t.equal(env.NOAT_BLUESKY_APP_PASSWORD, 'abc123', 'reads plain values')
    t.equal(env.QUOTED, 'hello world', 'reads quoted values')
    t.equal(env.INLINE, 'value', 'strips inline comment')
    t.equal(env.SINGLE, 'ok', 'reads single-quoted values')
})

test('splitFrontmatter + nested field access', t => {
    const markdown = [
        '---',
        'post: "Hello Bluesky"',
        'bluesky:',
        '  image: ./images/cover.png',
        '  imageAlt: Cover art',
        '---',
        'Markdown body'
    ].join('\n')

    const parsed = splitFrontmatter(markdown)
    t.equal(getNestedField(parsed.frontmatter, 'bluesky.image'),
        './images/cover.png', 'reads nested frontmatter')
    t.equal(parsed.content.trim(), 'Markdown body', 'returns body content')
})

test('splitFrontmatter supports folded YAML scalars', t => {
    const markdown = [
        '---',
        'post: >',
        '  Line one.',
        '  Line two.',
        '---',
        'Body'
    ].join('\n')

    const parsed = splitFrontmatter(markdown)
    t.equal(parsed.frontmatter.post, 'Line one. Line two.\n',
        'parses folded scalar syntax')
})

test('parsePostFields uses configured frontmatter fields', t => {
    const markdown = [
        '---',
        'post: "Ship update"',
        '---',
        'Body fallback with image',
        '',
        '![Screenshot](./images/update.png)'
    ].join('\n')

    const fields = parsePostFields(markdown, {
        postTextField: 'post'
    })

    t.equal(fields.text, 'Ship update', 'uses post text from frontmatter')
    t.equal(
        fields.imagePath,
        './images/update.png',
        'uses first body image path'
    )
    t.equal(fields.imageAlt, 'Screenshot', 'uses first body image alt text')
})

test('parsePostFields falls back to markdown content', t => {
    const markdown = [
        '---',
        'title: No explicit post field',
        '---',
        'Fallback body text',
        '',
        '![Diagram](./images/fallback.png)'
    ].join('\n')

    const fields = parsePostFields(markdown, {
        postTextField: 'post'
    })

    t.equal(fields.text, 'Fallback body text',
        'uses markdown body when post field is absent')
    t.equal(fields.imagePath, './images/fallback.png',
        'extracts image from markdown body')
})

test('findFirstMarkdownImage returns first image only', t => {
    const markdown = [
        'Intro',
        '![First](./images/first.png)',
        'Middle',
        '![Second](./images/second.png)'
    ].join('\n')

    const image = findFirstMarkdownImage(markdown)
    t.equal(image?.alt, 'First', 'returns first image alt')
    t.equal(image?.path, './images/first.png', 'returns first image path')
})

test('resolveBacklinkUrl derives url from baseUrl + slug', t => {
    const url = resolveBacklinkUrl({
        postPath: 'posts/2026-02-01-launch.md',
        postsRootSpec: 'posts',
        frontmatter: {
            slug: 'foo'
        },
        config: TEST_CONFIG
    })

    t.equal(url, 'https://blog.example.com/blog/foo')
})

test('resolveBacklinkUrl encodes and normalizes slug paths', t => {
    const url = resolveBacklinkUrl({
        postPath: 'posts/2026-02-01-launch.md',
        postsRootSpec: 'posts',
        frontmatter: {
            slug: '/updates/weekly note/'
        },
        config: TEST_CONFIG
    })

    t.equal(url, 'https://blog.example.com/blog/updates/weekly%20note')
})

test('resolveBacklinkUrl falls back to local path when slug is missing', t => {
    const url = resolveBacklinkUrl({
        postPath: 'posts/2026-02-01-launch.md',
        postsRootSpec: 'posts',
        frontmatter: {},
        config: TEST_CONFIG
    })

    t.equal(url, 'https://blog.example.com/blog/2026-02-01-launch')
})

test('appendBacklink adds link once', t => {
    const text = appendBacklink('Ship update', 'https://blog.example.com/ship/')
    t.equal(text, 'Ship update\n\nhttps://blog.example.com/ship/')

    const alreadyLinked = appendBacklink(
        text,
        'https://blog.example.com/ship/'
    )
    t.equal(
        alreadyLinked,
        'Ship update\n\nhttps://blog.example.com/ship/',
        'does not duplicate backlink'
    )
})

test('toBlueskyPostUrl converts AT URI to app URL', t => {
    const appUrl = toBlueskyPostUrl(
        'abc.bsky.social',
        'at://did:plc:123/app.bsky.feed.post/3laz2abc'
    )

    t.equal(
        appUrl,
        'https://bsky.app/profile/abc.bsky.social/post/3laz2abc'
    )
})

test('upsertFrontmatterField adds AT_URL to existing frontmatter', t => {
    const source = [
        '---',
        'title: Launch',
        'post: Hello',
        '---',
        'Body'
    ].join('\n')
    const next = upsertFrontmatterField(
        source,
        'AT_URL',
        'https://bsky.app/profile/abc.bsky.social/post/3laz2abc'
    )

    t.ok(
        next.includes(
            'AT_URL: ' +
            '"https://bsky.app/profile/abc.bsky.social/post/3laz2abc"'
        )
    )
    t.ok(next.includes('title: Launch'))
})

test('upsertFrontmatterField replaces AT_URL when present', t => {
    const source = [
        '---',
        'title: Launch',
        'AT_URL: "https://bsky.app/profile/abc.bsky.social/post/old123"',
        '---',
        'Body'
    ].join('\n')
    const next = upsertFrontmatterField(
        source,
        'AT_URL',
        'https://bsky.app/profile/abc.bsky.social/post/new456'
    )

    t.ok(!next.includes('/post/old123'))
    t.ok(next.includes('/post/new456'))
})

test('upsertFrontmatterField creates frontmatter when missing', t => {
    const source = '# Heading\n\nBody'
    const next = upsertFrontmatterField(
        source,
        'AT_URL',
        'https://bsky.app/profile/abc.bsky.social/post/3laz2abc'
    )

    t.ok(
        next.startsWith(
            '---\nAT_URL: ' +
            '"https://bsky.app/profile/abc.bsky.social/post/3laz2abc"\n---\n'
        )
    )
    t.ok(next.includes('# Heading'))
})

test('stripFrontmatterField removes managed AT_URL metadata', t => {
    const source = [
        '---',
        'title: Launch',
        'AT_URL: "https://bsky.app/profile/abc.bsky.social/post/3laz2abc"',
        'post: Hello',
        '---',
        'Body'
    ].join('\n')
    const next = stripFrontmatterField(source, 'AT_URL')

    t.ok(!next.includes('AT_URL:'))
    t.ok(next.includes('title: Launch'))
    t.ok(next.includes('post: Hello'))
})

test('resolveGitRelativePath', t => {
    const goodPath = resolveGitRelativePath(
        'example/posts/alpha.md',
        './images/pic.png'
    )
    t.equal(
        goodPath,
        'example/posts/images/pic.png',
        'resolves relative asset path'
    )

    t.throws(
        () => resolveGitRelativePath(
            'example/posts/alpha.md',
            'https://cdn.example.com/pic.png'
        ),
        /Only repository file paths/,
        'rejects non-repository URLs'
    )

    t.throws(
        () => resolveGitRelativePath(
            'example/posts/alpha.md',
            '../../../secrets.png'
        ),
        /outside repo root/,
        'rejects assets that traverse outside repo'
    )
})

test('parseCliArgs + normalizeConfig defaults', t => {
    const cli = parseCliArgs([
        'publish',
        '--dry-run',
        '--handle',
        'nick.bsky.social',
        '--posts',
        './example/posts',
        '--base-url',
        'https://blog.example.com'
    ])
    t.equal(cli.command, 'publish', 'parses publish command')
    t.ok(cli.options.dryRun, 'parses dry-run flag')
    t.equal(cli.options.handle, 'nick.bsky.social', 'parses handle option')
    t.equal(
        cli.options.postsDir,
        './example/posts',
        'parses posts directory option'
    )
    t.equal(
        cli.options.baseUrl,
        'https://blog.example.com',
        'parses base URL option'
    )

    const normalized = normalizeConfig({
        configDir: '/repo',
        env: {
            NOAT_BLUESKY_HANDLE: 'nick.bsky.social',
            NOAT_BASE_URL: 'https://blog.example.com'
        },
        config: {}
    })

    t.equal(normalized.handle, 'nick.bsky.social', 'uses env fallback handle')
    t.equal(normalized.pdsUrl, 'https://bsky.social', 'uses default PDS URL')
    t.equal(
        normalized.passwordEnvVar,
        'NOAT_BLUESKY_APP_PASSWORD',
        'uses default password env var'
    )
    t.equal(
        normalized.postsDir,
        '/repo/posts',
        'uses default postsDir relative to config dir'
    )
    t.equal(
        normalized.baseUrl,
        'https://blog.example.com',
        'uses baseUrl from env'
    )
})

test(
    'normalizeConfig resolves posts relative to config file directory',
    t => {
        const normalized = normalizeConfig({
            configDir: '/repo/example',
            env: {
                NOAT_BLUESKY_HANDLE: 'nick.bsky.social',
                NOAT_BASE_URL: 'https://blog.example.com'
            },
            config: {
                posts: 'posts'
            }
        })

        t.equal(
            normalized.postsDir,
            '/repo/example/posts',
            'resolves posts from configDir'
        )
    }
)

test('normalizeConfig requires baseUrl', t => {
    t.throws(
        () => normalizeConfig({
            configDir: '/repo',
            env: {
                NOAT_BLUESKY_HANDLE: 'nick.bsky.social'
            },
            config: {}
        }),
        /Missing baseUrl/,
        'fails when baseUrl cannot be resolved'
    )
})
