# nat

`nat` is a CLI for a git-first publishing pipeline. It treats your committed markdown posts as the source of truth, and publishes new/changed posts to Bluesky.

## What It Does

1. Loads config from `nat.config.ts`, `nat.config.js`, or `nat.config.json`.
2. Reads `.env` for your Bluesky app password.
3. Scans markdown files in a configured directory (`./posts` by default) from `HEAD`.
4. Publishes only files that are new/changed since the last publish state.
5. Uploads one referenced image blob per post (when configured).

Only files committed in `HEAD` are considered publishable.

## Install + Build

```sh
npm install
npm run build
```

## CLI Usage

```sh
node ./dist/cli.js publish
```

Optional flags:

- `--config <path>`
- `--posts-dir <path>`
- `--dry-run`
- `--verbose`

## Config

Create one of:

- `nat.config.ts`
- `nat.config.js`
- `nat.config.json`

Example:

```js
export default {
    bluesky: {
        handle: 'your-handle.bsky.social',
        pdsUrl: 'https://bsky.social'
    },
    postsDir: './posts',
    stateFile: './.nat/published.json',
    postTextField: 'post',
    imageField: 'image',
    imageAltField: 'imageAlt'
}
```

Defaults:

- `pdsUrl`: `https://bsky.social`
- `postsDir`: `./posts`
- `stateFile`: `./.nat/published.json`
- `postTextField`: `post`
- `imageField`: `image`
- `imageAltField`: `imageAlt`
- `passwordEnvVar`: `NAT_BLUESKY_APP_PASSWORD`

## .env

```bash
NAT_BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

## Markdown Format

Each post is markdown with frontmatter. The `post` field is used as Bluesky text by default.

```md
---
title: Launch post
post: "Git is now the source of truth for publishing."
image: ./images/launch.png
imageAlt: Flow from markdown to Bluesky
---
Website body content goes here.
```

## Build Pipeline

Use this in your site build/deploy flow:

```sh
npm run build
node ./dist/cli.js publish
```

## Example Folder

See `example/` for a working sample:

- `example/nat.config.js`
- `example/.env.example`
- `example/posts/*.md`
- `example/.nat/published.json`
