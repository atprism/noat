#!/usr/bin/env node
import { runCli } from './index.js'

runCli(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[nat] ${message}`)
    process.exitCode = 1
})
