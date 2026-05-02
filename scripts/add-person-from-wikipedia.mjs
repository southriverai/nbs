/**
 * Add a curated person story from an English Wikipedia article URL.
 *
 * Usage:
 *   node scripts/add-person-from-wikipedia.mjs --url "https://en.wikipedia.org/wiki/..." --number 14 --year 1900 --location "City"
 *
 * Requires network. Writes public/people/{number}/story.json, updates
 * person_stories_manifest.json, and appends public/named_people.csv.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function csvEscape(value) {
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Last field is always https://… */
function parseNamedPeopleLine(line) {
  const httpStart = line.indexOf('http')
  if (httpStart === -1) return null
  const wikipedia = line.slice(httpStart).trim()
  const prefix = line.slice(0, httpStart).replace(/,\s*$/, '')
  const first = prefix.indexOf(',')
  const second = prefix.indexOf(',', first + 1)
  const third = prefix.indexOf(',', second + 1)
  if (first === -1 || second === -1 || third === -1) return null
  return {
    number: Number(prefix.slice(0, first)),
    name: prefix.slice(first + 1, second),
    year: prefix.slice(second + 1, third),
    location: prefix.slice(third + 1),
    wikipedia,
  }
}

function wikiApiTitleFromUrl(input) {
  let u
  try {
    u = new URL(input.trim())
  } catch {
    throw new Error('Invalid --url')
  }
  if (!/\.wikipedia\.org$/i.test(u.hostname)) {
    throw new Error('URL must be a Wikipedia article link (e.g. en.wikipedia.org/wiki/…)')
  }
  const idx = u.pathname.indexOf('/wiki/')
  if (idx === -1) throw new Error('URL must contain /wiki/Article_title')
  const raw = u.pathname.slice(idx + '/wiki/'.length)
  if (!raw) throw new Error('Missing article title after /wiki/')
  return { host: u.hostname, titlePath: raw }
}

function extractToStoryParagraphs(extract) {
  const chunks = extract
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (chunks.length >= 2) return chunks
  const text = chunks[0] ?? extract
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
  const out = []
  let buf = []
  let len = 0
  for (const s of sentences) {
    const t = s.trim()
    if (!t) continue
    buf.push(t)
    len += t.length
    if (len >= 320 || buf.length >= 4) {
      out.push(buf.join(' '))
      buf = []
      len = 0
    }
  }
  if (buf.length) out.push(buf.join(' '))
  return out.length ? out : [text.trim()]
}

async function main() {
  const args = parseArgs(process.argv)
  const dryRun = Boolean(args['dry-run'])
  const url = args.url
  const number = args.number != null ? Number(args.number) : NaN
  const year = args.year
  const location = args.location
  const nameOverride = args.name

  if (!url || !Number.isInteger(number) || number < 1) {
    console.error(
      'Usage: node scripts/add-person-from-wikipedia.mjs --url "https://en.wikipedia.org/wiki/Title" --number N --year Y --location "Place" [--name "Display name"] [--dry-run]',
    )
    process.exit(1)
  }
  if (year === undefined || location === undefined) {
    console.error('Required: --year and --location (for named_people.csv index row).')
    process.exit(1)
  }

  const { host, titlePath } = wikiApiTitleFromUrl(url)
  const summaryUrl = `https://${host}/api/rest_v1/page/summary/${titlePath}`

  const res = await fetch(summaryUrl, {
    headers: { 'User-Agent': 'NineBillionStories/1.0 (https://github.com; add-person script)' },
  })
  if (!res.ok) {
    console.error(`Wikipedia API error ${res.status} for ${summaryUrl}`)
    process.exit(1)
  }
  const data = await res.json()
  if (data.type === 'disambiguation') {
    console.error('That page is a disambiguation page. Use a specific article URL.')
    process.exit(1)
  }

  const displayName = (nameOverride || data.title || titlePath.replace(/_/g, ' ')).trim()
  const canonicalUrl = data.content_urls?.desktop?.page || url.split('#')[0]
  const extract = (data.extract || '').trim()
  if (!extract) {
    console.error('No extract text from Wikipedia summary.')
    process.exit(1)
  }

  const story = extractToStoryParagraphs(extract)
  const storyDoc = {
    name: displayName,
    title: `A Brief Life of ${displayName}`,
    wikipedia: canonicalUrl,
    story,
  }

  const peopleDir = path.join(PUBLIC, 'people', String(number))
  const storyPath = path.join(peopleDir, 'story.json')
  const manifestPath = path.join(PUBLIC, 'person_stories_manifest.json')
  const csvPath = path.join(PUBLIC, 'named_people.csv')

  const csvText = await fs.readFile(csvPath, 'utf8')
  const lines = csvText.trim().split(/\n/)
  const existing = lines.slice(1).map(parseNamedPeopleLine).filter(Boolean)
  if (existing.some((r) => r.number === number)) {
    console.error(`Person #${number} already exists in named_people.csv. Choose another --number.`)
    process.exit(1)
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest[String(number)]) {
    console.error(`Person #${number} already exists in person_stories_manifest.json.`)
    process.exit(1)
  }

  if (dryRun) {
    console.log(JSON.stringify({ storyDoc, storyPath, manifestEntry: `people/${number}/story.json` }, null, 2))
    return
  }

  await fs.mkdir(peopleDir, { recursive: true })
  await fs.writeFile(storyPath, JSON.stringify(storyDoc, null, 2) + '\n', 'utf8')

  manifest[String(number)] = `people/${number}/story.json`
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const row = [csvEscape(number), csvEscape(displayName), csvEscape(year), csvEscape(location), csvEscape(canonicalUrl)].join(
    ',',
  )
  await fs.appendFile(csvPath, row + '\n', 'utf8')

  console.log(`Wrote ${path.relative(ROOT, storyPath)}`)
  console.log(`Updated ${path.relative(ROOT, manifestPath)}`)
  console.log(`Appended row to ${path.relative(ROOT, csvPath)}`)
  console.log(`Review the generated story; Wikipedia ledes are factual summaries, not full biographies.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
