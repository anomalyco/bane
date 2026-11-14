#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { envNames, sdkPackage } from './brand.js'
import { uploadAttachmentBytes } from './upload.js'

function fail(message: string): never { console.error(message); process.exit(1) }
function value(args: string[], flag: string) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
const env = (name: string) => envNames(name).map(key => process.env[key]).find(Boolean)
const args = process.argv.slice(2)
if (args[0] !== 'upload' || !args[1] || args.includes('--help')) fail(`Usage: NIGHTMAIL_TOKEN=<temporary-token> npx ${sdkPackage} upload <file> --api <https-origin> [--inline --content-id <id>] [--content-type <mime>]`)
// A token on the command line shows up in `ps` and shell history; read it from the environment only.
if (args.includes('--token')) fail('Pass the token in the NIGHTMAIL_TOKEN environment variable, not with --token.')
const path = args[1]
const apiUrl = value(args, '--api') ?? env('API_URL')
const token = env('TOKEN')
if (!apiUrl || !token) fail('Set NIGHTMAIL_TOKEN and pass --api <https-origin> (or set NIGHTMAIL_API_URL).')
const inline = args.includes('--inline')
const contentId = value(args, '--content-id')
if (inline && !contentId) fail('--inline requires --content-id.')
const info = await stat(path).catch(() => null)
if (!info?.isFile()) fail('The upload path must be a readable file.')
if (!info.size || info.size > 8 * 1024 * 1024) fail('Attachments must be nonempty and at most 8 MiB.')
try {
  const attachment = await uploadAttachmentBytes({
    apiUrl, token, filename: value(args, '--filename') ?? basename(path), bytes: await readFile(path),
    contentType: value(args, '--content-type'), disposition: inline ? 'inline' : 'attachment', contentId,
    idempotencyKey: value(args, '--idempotency-key'),
  })
  process.stdout.write(`${JSON.stringify(attachment)}\n`)
} catch (error) { fail(error instanceof Error ? error.message : 'Attachment upload failed.') }
