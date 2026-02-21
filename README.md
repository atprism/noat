# noat

[![tests](https://img.shields.io/github/actions/workflow/status/atprism/noat/nodejs.yml?style=flat-square)](https://github.com/atprism/noat/actions/workflows/nodejs.yml)
[![types](https://img.shields.io/npm/types/@atprism/icons?style=flat-square)](README.md)
[![module](https://img.shields.io/badge/module-ESM-blue?style=flat-square)](README.md)
[![semantic versioning](https://img.shields.io/badge/semver-2.0.0-blue?logo=semver&style=flat-square)](https://semver.org/)
[![Common Changelog](https://nichoth.github.io/badge/common-changelog.svg)](./CHANGELOG.md)
[![install size](https://flat.badgen.net/packagephobia/install/@atprism/noat)](https://packagephobia.com/result?p=@atprism/noat)
[![gzip size](https://flat.badgen.net/bundlephobia/minzip/@atprism/noat)](https://bundlephobia.com/package/@atprism/noat)
[![license](https://img.shields.io/badge/license-Big_Time-blue?style=flat-square)](LICENSE)


Node + AT protocol. Publish your blog posts to bluesky via a command line tool.

The `noat` command (pronounced like "note") reads posts from a git repo and
publishes any markdown files that do not have `AT_URL` in frontmatter.
It uploads a post excerpt plus a backlink to your blog URL.


<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Install](#install)
- [Example](#example)
- [Publish](#publish)
- [CLI](#cli)
  * [Help](#help)
- [Config](#config)
  * [Options](#options)
  * [Path resolution rules:](#path-resolution-rules)
- [Environment Variables](#environment-variables)
- [Post format](#post-format)
- [Publishing rules](#publishing-rules)
- [Example](#example-1)
- [Notes](#notes)

<!-- tocstop -->

</details>

## Install

```sh
npm i -S @atprism/noat
```

## Example

```sh
npx noat publish
```

This will publish all posts to bluesky using the defaults for everything.
This assumes you have a `noat.config.js` file in the root with a
value for `handle`, and a `.env` file with a variable
`NOAT_BLUESKY_APP_PASSWORD` defined.


---


## Publish

State is kept in the markdown files' frontmatter. Any file with a field
`AT_URL` is considered to have been published already.

* Requires a clean git state (no uncommited changes)
* Posts with an `AT_URL` frontmatter field are treated as already published.
* Only posts missing `AT_URL` are published.
* All local state is kept in the markdown frontmatter
* After publishing, `noat` writes `AT_URL` into the frontmatter for each file,
  and creates a commit: `AT proto publish <n>`.


## CLI

```sh
npx noat publish
```

### Help

```sh
npx noat help
```


## Config

`noat` auto-loads the first file found in this order:

1. `noat.config.ts`
2. `noat.config.js`
3. `noat.config.json`


### Options

`noat` reads config first, then applies CLI flags on top.
If both are set, the CLI value wins.

* `--config <path>`: Explicit config file path (CLI-only).
* `--handle <value>`: Bluesky handle.
* `--pds-url <value>`: Bluesky PDS URL.
* `--posts <path>`: Markdown posts directory.
* `--password-env-var <value>`: Env var name containing app password.
* `--post-text-field <value>`: Frontmatter field used for post text.
* `--base-url <value>`: Base URL prepended to frontmatter `slug`.
* `--dry-run`: Show what would publish without sending API requests.
* `--verbose`: Print resolved config details.
* `--cwd <path>`: Run as if launched from another working directory.



Example `noat.config.js`:

```js
export default {
    cwd: '.',
    handle: 'your-handle.bsky.social',
    pdsUrl: 'https://bsky.social',  // <-- default
    posts: './posts',  // <-- default
    postTextField: 'post',  // <-- excerpt field, default is post text
    baseUrl: 'https://blog.example.com/blog',
    passwordEnvVar: 'NOAT_BLUESKY_APP_PASSWORD',  // <-- default
    dryRun: false,
    verbose: false
}
```

#### Config fields

* `handle` (required): account handle.
* `pdsUrl` (optional): defaults to `https://bsky.social`.
* `passwordEnvVar` (optional): defaults to `NOAT_BLUESKY_APP_PASSWORD`.
* `posts` (optional): defaults to `./posts`.
* `postTextField` (optional): frontmatter field used for post text, defaults to `post`.
* `baseUrl` (required): base URL prefixed to frontmatter `slug`
  to build the post backlink.
* `cwd` (optional): working directory for publish operations.
* `dryRun` (optional): same behavior as `--dry-run`.
* `verbose` (optional): same behavior as `--verbose`.

#### Config-file keys and matching CLI flags

* `handle` -> `--handle`
* `pdsUrl` -> `--pds-url`
* `posts` -> `--posts`
* `passwordEnvVar` -> `--password-env-var`
* `postTextField` -> `--post-text-field`
* `baseUrl` -> `--base-url`
* `cwd` -> `--cwd`
* `dryRun` -> `--dry-run`
* `verbose` -> `--verbose`


### Path resolution rules:

* `posts` is resolved relative to the config file directory.
* If no config file is loaded, `posts` is resolved relative to current
  working directory.


## Environment Variables

Store the app password in a local `.env` file (not committed):

```bash
NOAT_BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

## Post format

Posts are markdown files with YAML frontmatter.

Example:

```md
---
title: Launch post
post: "Git is now the source of truth for publishing."
slug: "launch"
---

Body content for your static site.

![Diagram alt text](./images/launch.png)
```

## Publishing rules

* Bluesky text comes from frontmatter field `post`
  (or your configured `postTextField`).
* If that field is missing, fallback text is derived from markdown
  body with image markdown removed.
* A backlink to the blog post is inserted into every Bluesky post.
* Backlink URL is built as `<baseUrl>/<slug>` when `slug` exists.
* If `slug` is missing, backlink URL falls back to the markdown file's
  local path + filename (without extension) relative to `posts`.
* If no backlink URL can be resolved, publish fails for that post.
* If the backlink is already in the text, it is not duplicated.
* `AT_URL` is the publish marker. If present, that post is skipped.
* After a successful publish, `noat` writes `AT_URL` with the Bluesky app URL
  (for example `https://bsky.app/profile/<handle>/post/<id>`).
* The first markdown image in the body (`![alt](path)`) is used as the
  uploaded blob.
* Image alt text comes from that markdown image's alt text.
* Only repository file paths are supported for images
  (no `http://`, `https://`, or `data:` URLs).
* Supported image types: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.avif`.

Frontmatter after publish includes:

```yaml
AT_URL: "https://bsky.app/profile/your-handle.bsky.social/post/3laz2abc"
```

Backlink examples:

* `baseUrl: "https://abc.com/blog"` with frontmatter `slug: "foo"`
  becomes `https://abc.com/blog/foo`.
* `baseUrl: "https://abc.com/blog/"` with frontmatter `slug: "/weekly note/"`
  becomes `https://abc.com/blog/weekly%20note`.
* With no `slug`, `posts/2026-02-01-launch.md` becomes
  `https://abc.com/blog/2026-02-01-launch`.


## Example

See [./example](./example/).

Run from repo root:

```sh
node ./dist/cli.js publish --config ./example/noat.config.js --dry-run --verbose
```

Then run without `--dry-run` to publish.

## Notes

* Requires Node.js 18+ (uses global `fetch`).
* If git is dirty, publish exits with an error and does not post.
