import { test } from '@substrate-system/tapzero'
import {
    getNestedField,
    normalizeConfig,
    parseCliArgs,
    parseDotEnv,
    parsePostFields,
    resolveGitRelativePath,
    splitFrontmatter
} from '../src/index.js'

test('parseDotEnv', t => {
    const env = parseDotEnv([
        '# comment',
        'NAT_BLUESKY_APP_PASSWORD=abc123',
        'QUOTED="hello world"',
        'INLINE=value # inline',
        '',
        'SINGLE=\'ok\''
    ].join('\n'))

    t.equal(env.NAT_BLUESKY_APP_PASSWORD, 'abc123', 'reads plain values')
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
    t.equal(getNestedField(parsed.frontmatter, 'bluesky.image'), './images/cover.png', 'reads nested frontmatter')
    t.equal(parsed.content.trim(), 'Markdown body', 'returns body content')
})

test('parsePostFields uses configured frontmatter fields', t => {
    const markdown = [
        '---',
        'post: "Ship update"',
        'image: ./images/update.png',
        'imageAlt: Screenshot',
        '---',
        'Body fallback'
    ].join('\n')

    const fields = parsePostFields(markdown, {
        postTextField: 'post',
        imageField: 'image',
        imageAltField: 'imageAlt'
    })

    t.equal(fields.text, 'Ship update', 'uses post text from frontmatter')
    t.equal(fields.imagePath, './images/update.png', 'uses image path from frontmatter')
    t.equal(fields.imageAlt, 'Screenshot', 'uses image alt from frontmatter')
})

test('parsePostFields falls back to markdown content', t => {
    const markdown = [
        '---',
        'title: No explicit post field',
        '---',
        'Fallback body text'
    ].join('\n')

    const fields = parsePostFields(markdown, {
        postTextField: 'post',
        imageField: 'image',
        imageAltField: 'imageAlt'
    })

    t.equal(fields.text, 'Fallback body text', 'uses markdown body when post field is absent')
    t.equal(fields.imagePath, undefined, 'image is optional')
})

test('resolveGitRelativePath', t => {
    const goodPath = resolveGitRelativePath('example/posts/alpha.md', './images/pic.png')
    t.equal(goodPath, 'example/posts/images/pic.png', 'resolves relative asset path')

    t.throws(
        () => resolveGitRelativePath('example/posts/alpha.md', '../../../secrets.png'),
        /outside repo root/,
        'rejects assets that traverse outside repo'
    )
})

test('parseCliArgs + normalizeConfig defaults', t => {
    const cli = parseCliArgs(['publish', '--dry-run', '--posts-dir', './example/posts'])
    t.equal(cli.command, 'publish', 'parses publish command')
    t.ok(cli.options.dryRun, 'parses dry-run flag')
    t.equal(cli.options.postsDir, './example/posts', 'parses posts directory option')

    const normalized = normalizeConfig({
        cwd: '/repo',
        env: {
            NAT_BLUESKY_HANDLE: 'nick.bsky.social'
        },
        config: {}
    })

    t.equal(normalized.handle, 'nick.bsky.social', 'uses env fallback handle')
    t.equal(normalized.pdsUrl, 'https://bsky.social', 'uses default PDS URL')
    t.equal(normalized.passwordEnvVar, 'NAT_BLUESKY_APP_PASSWORD', 'uses default password env var')
})
