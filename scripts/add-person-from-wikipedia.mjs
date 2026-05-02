/**
 * Add a curated person story from a Wikipedia article URL.
 *
 * Usage:
 *   node scripts/add-person-from-wikipedia.mjs --url "https://en.wikipedia.org/wiki/Anne_Frank"
 *
 * Reads birth date (P569) and place of birth (P19) from Wikidata, infers person # from
 * public/total_population.csv using the same curve as the app (inverse of interpolateYear),
 * pulls the article lede for story.json, then updates person_stories_manifest.json.
 * Geocodes birthplace and place of death (OpenStreetMap Nominatim) when possible and
 * writes birth_latitude/birth_longitude and death_latitude/death_longitude into story.json.
 *
 * Optional: --name "..."  --dry-run
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const WD_API = 'https://www.wikidata.org/w/api.php'

const UA = '90BillionStories/1.0 (add-person-from-wikipedia.mjs; educational)'
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function wikiFromUrl(input) {
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
  const titlePath = u.pathname.slice(idx + '/wiki/'.length)
  if (!titlePath) throw new Error('Missing article title after /wiki/')
  const hostLower = u.hostname.toLowerCase()
  const m = hostLower.match(/^([a-z]{2,3})(?:\.m)?\.wikipedia\.org$/)
  if (!m) throw new Error('Expected hostname like en.wikipedia.org or en.m.wikipedia.org')
  const lang = m[1]
  const site = `${lang}wiki`
  return { host: u.hostname, titlePath, site, lang }
}

function wikidataTimeToDecimalYear(value) {
  if (!value || typeof value.time !== 'string') return null
  const time = value.time
  const neg = time.startsWith('-')
  const body = time.replace(/^[-+]/, '')
  const datePart = body.split('T')[0] ?? ''
  const dp = datePart.split('-')
  const yStr = (dp[0] ?? '0').replace(/^0+(?=\d)/, '') || '0'
  let Y = parseInt(yStr, 10)
  if (neg) Y = -Y
  const prec = typeof value.precision === 'number' ? value.precision : 11
  if (prec <= 9) return Y
  const moRaw = parseInt(dp[1] ?? '1', 10)
  const month = Number.isFinite(moRaw) && moRaw > 0 ? moRaw : 1
  const dRaw = parseInt(dp[2] ?? '1', 10)
  const day = Number.isFinite(dRaw) && dRaw > 0 ? dRaw : 1
  if (prec === 10) return Y + (month - 1) / 12
  return Y + (month - 1) / 12 + (day - 1) / 365.25
}

function rosterYearFromDecimal(decimalY) {
  if (!Number.isFinite(decimalY)) return 0
  return Math.round(decimalY)
}

/**
 * Forward geocode a place label (same service as the app). Respects Nominatim usage policy
 * (callers should wait ~1s between requests).
 */
async function geocodePlace(query) {
  const q = (query || '').trim()
  if (!q || q === 'Unknown') return null
  const url = `${NOMINATIM_SEARCH}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) {
      const arr = await res.json()
      if (!Array.isArray(arr) || arr.length === 0) return null
      const lat = Number(arr[0].lat)
      const lon = Number(arr[0].lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
      return { lat, lon }
    }
    if (res.status !== 429 && res.status < 500) return null
    lastErr = new Error(`Nominatim HTTP ${res.status}`)
    const retryAfter = Number(res.headers.get('retry-after') || 0)
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * Math.pow(2, attempt)
    await sleep(waitMs)
  }
  if (lastErr) console.warn(String(lastErr))
  return null
}

async function fetchJson(url) {
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) return res.json()
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`HTTP ${res.status} for ${url}`)
    }
    lastErr = new Error(`HTTP ${res.status} for ${url}`)
    const retryAfter = Number(res.headers.get('retry-after') || 0)
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * Math.pow(2, attempt)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  throw lastErr ?? new Error(`HTTP error for ${url}`)
}

async function fetchEntityById(id) {
  const q = new URLSearchParams({
    action: 'wbgetentities',
    ids: id,
    props: 'labels|claims',
    languages: 'en',
    format: 'json',
  })
  const data = await fetchJson(`${WD_API}?${q}`)
  return data.entities?.[id] ?? null
}

function entityLabel(ent) {
  if (!ent) return ''
  return (ent?.labels?.en?.value || ent?.labels?.[Object.keys(ent?.labels || {})[0]]?.value || '').trim()
}

function claimEntityIds(ent, prop) {
  const claims = ent?.claims?.[prop] ?? []
  const out = []
  for (const c of claims) {
    const v = c?.mainsnak?.datavalue?.value
    if (v && v['entity-type'] === 'item' && v.id) out.push(v.id)
  }
  return out
}

async function normalizePlaceLabel(entityId, fallbackLabel) {
  if (!entityId) return fallbackLabel || 'Unknown'
  const placeEnt = await fetchEntityById(entityId)
  if (!placeEnt) return fallbackLabel || 'Unknown'
  const base = entityLabel(placeEnt) || fallbackLabel || 'Unknown'

  const lower = base.toLowerCase()
  const isFacility =
    lower.includes('clinic') ||
    lower.includes('hospital') ||
    lower.includes('medical center') ||
    lower.includes('infirmary') ||
    lower.includes('concentration camp') ||
    lower.endsWith(' camp')
  if (!isFacility) return base

  const adminId = claimEntityIds(placeEnt, 'P131')[0] || null
  const countryId = claimEntityIds(placeEnt, 'P17')[0] || null
  if (!adminId && !countryId) return base

  const ids = [adminId, countryId].filter(Boolean)
  const q = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels',
    languages: 'en',
    format: 'json',
  })
  const data = await fetchJson(`${WD_API}?${q}`)
  const admin = adminId ? entityLabel(data.entities?.[adminId]) : ''
  const country = countryId ? entityLabel(data.entities?.[countryId]) : ''

  if (lower.includes('concentration camp')) {
    const campName = base.replace(/\s+concentration camp$/i, '').trim()
    if (campName && country) return `${campName}, ${country}`
    return campName || base
  }

  const parts = [admin, country].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : base
}

async function wikidataBirthDeathAndPlaces(site, titlePath) {
  const title = decodeURIComponent(titlePath).replace(/ /g, '_')
  const q = new URLSearchParams({
    action: 'wbgetentities',
    sites: site,
    titles: title,
    props: 'claims',
    format: 'json',
  })
  const data = await fetchJson(`${WD_API}?${q}`)
  const entities = data.entities ?? {}
  const id = Object.keys(entities)[0]
  if (!id || id === '-1') throw new Error('No Wikidata item linked to this Wikipedia page.')
  const claims = entities[id].claims ?? {}
  const p569 = claims.P569?.[0]?.mainsnak?.datavalue?.value
  const decimalBirth = wikidataTimeToDecimalYear(p569)
  if (decimalBirth == null || !Number.isFinite(decimalBirth)) {
    throw new Error('Wikidata has no usable date of birth (P569) for this item.')
  }
  const p570 = claims.P570?.[0]?.mainsnak?.datavalue?.value
  const decimalDeath = wikidataTimeToDecimalYear(p570)
  const p21 = claims.P21?.[0]?.mainsnak?.datavalue?.value

  const entityIds = []
  const p19 = claims.P19?.[0]?.mainsnak?.datavalue?.value
  if (p19 && p19['entity-type'] === 'item' && p19.id) entityIds.push(p19.id)
  const p20 = claims.P20?.[0]?.mainsnak?.datavalue?.value
  if (p20 && p20['entity-type'] === 'item' && p20.id) entityIds.push(p20.id)
  if (p21 && p21['entity-type'] === 'item' && p21.id) entityIds.push(p21.id)

  const labelById = {}
  if (entityIds.length > 0) {
    const lq = new URLSearchParams({
      action: 'wbgetentities',
      ids: entityIds.join('|'),
      props: 'labels',
      languages: 'en',
      format: 'json',
    })
    const ld = await fetchJson(`${WD_API}?${lq}`)
    for (const id of entityIds) {
      const ent = ld.entities?.[id]
      labelById[id] = (ent?.labels?.en?.value || ent?.labels?.[Object.keys(ent?.labels || {})[0]]?.value || '').trim()
    }
  }

  let birthPlace = ''
  if (p19 && p19.id) birthPlace = labelById[p19.id] || ''
  birthPlace = await normalizePlaceLabel(p19?.id ?? null, birthPlace || 'Unknown')
  let deathPlace = null
  if (p20 && p20.id) {
    const rawDeath = labelById[p20.id] || null
    deathPlace = await normalizePlaceLabel(p20.id, rawDeath)
  }
  let gender = null
  if (p21 && p21.id) {
    const g = labelById[p21.id] || null
    if (g === 'male') gender = 'Male'
    else if (g === 'female') gender = 'Female'
  }
  return {
    decimalBirth,
    decimalDeath: Number.isFinite(decimalDeath) ? decimalDeath : null,
    birthPlace,
    deathPlace,
    gender,
    rosterYear: rosterYearFromDecimal(decimalBirth),
  }
}

async function loadPopulationRows() {
  const text = await fs.readFile(path.join(PUBLIC, 'total_population.csv'), 'utf8')
  const lines = text.trim().split('\n')
  return lines.slice(1).map((line) => {
    const parts = line.split(',')
    return {
      year: Number(parts[0]),
      cumulative_population: Number(parts[1]),
      life_expectancy: Number(parts[2]) || 30,
    }
  })
}

/** Same as App.tsx `interpolateYear` (n = person index on cumulative curve). */
function interpolateYear(n, sorted) {
  const s = [...sorted].sort((a, b) => a.year - b.year)
  if (s.length === 0) return 0
  if (n <= s[0].cumulative_population) return s[0].year
  for (let i = 1; i < s.length; i++) {
    if (s[i].cumulative_population >= n) {
      const y1 = s[i - 1].year
      const c1 = s[i - 1].cumulative_population
      const y2 = s[i].year
      const c2 = s[i].cumulative_population
      const t = (n - c1) / (c2 - c1)
      return y1 + t * (y2 - y1)
    }
  }
  return s[s.length - 1].year
}

/**
 * Smallest n in [1, maxN] that best matches target birth year on the population curve
 * (interpolateYear is non-decreasing in n).
 */
function personNumberFromBirthYear(targetY, sorted) {
  const s = [...sorted].sort((a, b) => a.year - b.year)
  if (s.length === 0) return 1
  const maxN = s[s.length - 1].cumulative_population
  if (targetY <= s[0].year) return 1
  if (targetY >= s[s.length - 1].year) return Math.floor(maxN)

  let lo = 1
  let hi = maxN
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const yMid = interpolateYear(mid, s)
    if (yMid < targetY) lo = mid + 1
    else hi = mid
  }
  let best = lo
  let bestErr = Math.abs(interpolateYear(lo, s) - targetY)
  for (const cand of [lo - 1, lo + 1]) {
    if (cand < 1 || cand > maxN) continue
    const err = Math.abs(interpolateYear(cand, s) - targetY)
    if (err < bestErr) {
      bestErr = err
      best = cand
    }
  }
  return Math.max(1, Math.min(best, maxN))
}

function findFreePersonNumber(startN, manifest, maxPop) {
  for (let d = 0; d < 500000; d++) {
    const n = startN + d
    if (n < 1 || n > maxPop) break
    if (!manifest[String(n)]) return n
  }
  return null
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
  const nameOverride = args.name

  if (!url) {
    console.error('Usage: node scripts/add-person-from-wikipedia.mjs --url "https://en.wikipedia.org/wiki/Title" [--name "Display name"] [--dry-run]')
    process.exit(1)
  }

  const { host, titlePath, site } = wikiFromUrl(url)
  const summaryUrl = `https://${host}/api/rest_v1/page/summary/${titlePath}`

  const [wikiSummary, birthMeta, popRows] = await Promise.all([
    fetch(summaryUrl, { headers: { 'User-Agent': UA } }).then(async (res) => {
      if (!res.ok) throw new Error(`Wikipedia summary HTTP ${res.status}`)
      return res.json()
    }),
    wikidataBirthDeathAndPlaces(site, titlePath),
    loadPopulationRows(),
  ])

  if (wikiSummary.type === 'disambiguation') {
    console.error('That page is a disambiguation page. Use a specific article URL.')
    process.exit(1)
  }

  const displayName = (nameOverride || wikiSummary.title || titlePath.replace(/_/g, ' ')).trim()
  const canonicalUrl = wikiSummary.content_urls?.desktop?.page || url.split('#')[0]
  const extract = (wikiSummary.extract || '').trim()
  if (!extract) {
    console.error('No extract text from Wikipedia summary.')
    process.exit(1)
  }

  const sortedPop = [...popRows].sort((a, b) => a.year - b.year)
  const maxPop = sortedPop.length > 0 ? sortedPop[sortedPop.length - 1].cumulative_population : 0
  const startN = personNumberFromBirthYear(birthMeta.decimalBirth, sortedPop)
  const manifestPath = path.join(PUBLIC, 'person_stories_manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  const number = findFreePersonNumber(startN, manifest, maxPop)
  if (number == null) {
    console.error('Could not find a free person number slot near the inferred index (manifest + CSV full?).')
    process.exit(1)
  }

  if (number !== startN) {
    console.warn(`Note: inferred #${startN} is already taken; using next free slot #${number}.`)
  }

  const story = extractToStoryParagraphs(extract)
  const curveBirthYear = interpolateYear(number, sortedPop)
  const bornYear = birthMeta.decimalBirth
  const deathYear = birthMeta.decimalDeath
  const ageAtDeath = deathYear == null ? null : Math.max(1, Math.round(deathYear - bornYear))

  const storyDoc = {
    person_number: number,
    story_source: 'wikipedia_summary',
    name: displayName,
    wikipedia: canonicalUrl,
    born: bornYear,
    birthplace: birthMeta.birthPlace,
    died: deathYear,
    death_place: birthMeta.deathPlace,
    age_at_death: ageAtDeath,
    gender: birthMeta.gender,
    title: `A Brief Life of ${displayName}`,
    story,
    source_birth_year: birthMeta.decimalBirth,
  }

  console.log('Geocoding birth place (Nominatim)…')
  const birthGeo = await geocodePlace(birthMeta.birthPlace)
  if (birthGeo) {
    storyDoc.birth_latitude = birthGeo.lat
    storyDoc.birth_longitude = birthGeo.lon
  }
  let deathGeo = null
  if (birthMeta.deathPlace && String(birthMeta.deathPlace).trim()) {
    await sleep(1100)
    console.log('Geocoding death place…')
    deathGeo = await geocodePlace(birthMeta.deathPlace)
    if (deathGeo) {
      storyDoc.death_latitude = deathGeo.lat
      storyDoc.death_longitude = deathGeo.lon
    }
  }

  const peopleDir = path.join(PUBLIC, 'people', String(number))
  const storyPath = path.join(peopleDir, 'story.json')

  if (manifest[String(number)]) {
    console.error(`Person #${number} already exists in person_stories_manifest.json.`)
    process.exit(1)
  }

  const yearOnCurve = interpolateYear(number, sortedPop)
  console.log(
    JSON.stringify(
      {
        wikidataBirthDecimalYear: birthMeta.decimalBirth,
        rosterYear: birthMeta.rosterYear,
        placeOfBirth: birthMeta.birthPlace,
        inferredPersonNumber: startN,
        assignedPersonNumber: number,
        birthYearOnCurveAtAssignedN: yearOnCurve,
        bornYearFromWikidata: bornYear,
        deathYear: deathYear,
        ageAtDeath: ageAtDeath,
        birthGeocode: birthGeo ? { lat: birthGeo.lat, lon: birthGeo.lon } : null,
        deathGeocode: deathGeo ? { lat: deathGeo.lat, lon: deathGeo.lon } : null,
      },
      null,
      2,
    ),
  )

  if (dryRun) {
    console.log(JSON.stringify({ storyDoc, storyPath, manifestEntry: `people/${number}/story.json` }, null, 2))
    return
  }

  await fs.mkdir(peopleDir, { recursive: true })
  await fs.writeFile(storyPath, JSON.stringify(storyDoc, null, 2) + '\n', 'utf8')

  manifest[String(number)] = `people/${number}/story.json`
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(`Wrote ${path.relative(ROOT, storyPath)}`)
  console.log(`Updated ${path.relative(ROOT, manifestPath)}`)
  console.log(`Review the generated story; Wikipedia ledes are factual summaries, not full biographies.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
