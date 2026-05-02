/**
 * Add / refresh birth_latitude, birth_longitude, death_latitude, death_longitude
 * on existing curated story.json files listed in public/person_stories_manifest.json.
 * Does not change person_number or manifest paths. Uses Nominatim (strict pacing).
 *
 *   node scripts/geocode-existing-stories.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search'
const UA = '90BillionStories/1.0 (geocode-existing-stories.mjs; batch refresh)'

/** Minimum milliseconds between Nominatim HTTP requests (public policy: ~1/sec). */
const MIN_INTERVAL_MS = 2600

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let lastNominatimRequestAt = 0

async function waitForNominatimSlot() {
  const now = Date.now()
  const wait = lastNominatimRequestAt + MIN_INTERVAL_MS - now
  if (wait > 0) await sleep(wait)
  lastNominatimRequestAt = Date.now()
}

/**
 * @param {string} query
 * @returns {Promise<{ lat: number, lon: number } | null>}
 */
async function geocodeOnce(query) {
  const q = (query || '').trim()
  if (!q || q === 'Unknown') return null
  const url = `${NOMINATIM_SEARCH}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`
  let lastErr = null
  for (let attempt = 0; attempt < 6; attempt++) {
    await waitForNominatimSlot()
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    lastNominatimRequestAt = Date.now()
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
    const waitMs = Math.max(
      8000,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
      3000 * Math.pow(2, attempt),
    )
    console.warn(`Nominatim ${res.status}, waiting ${Math.round(waitMs / 1000)}s…`)
    await sleep(waitMs)
  }
  if (lastErr) console.warn(String(lastErr))
  return null
}

/** Try full label, then first segment before comma (e.g. city from "City, Region"). */
async function geocodePlaceSmart(label) {
  const t = (label || '').trim()
  if (!t) return null
  const variants = [t]
  const comma = t.indexOf(',')
  if (comma > 1) variants.push(t.slice(0, comma).trim())
  const seen = new Set()
  for (const v of variants) {
    if (!v || seen.has(v)) continue
    seen.add(v)
    const r = await geocodeOnce(v)
    if (r) return r
  }
  return null
}

async function main() {
  console.log(`Waiting ${MIN_INTERVAL_MS / 1000}s before first request…`)
  await sleep(MIN_INTERVAL_MS)

  const manifestPath = path.join(PUBLIC, 'person_stories_manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const entries = Object.entries(manifest).sort(([a], [b]) => Number(a) - Number(b))

  for (const [numStr, relPath] of entries) {
    if (typeof relPath !== 'string' || !relPath.trim()) continue
    const filePath = path.join(PUBLIC, relPath)
    let doc
    try {
      doc = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch (e) {
      console.warn(`Skip ${relPath}: ${e}`)
      continue
    }

    const birthLabel = typeof doc.birthplace === 'string' ? doc.birthplace.trim() : ''
    if (birthLabel && birthLabel !== 'Unknown') {
      const g = await geocodePlaceSmart(birthLabel)
      if (g) {
        doc.birth_latitude = g.lat
        doc.birth_longitude = g.lon
        console.log(`  #${numStr} birth → ${g.lat}, ${g.lon}`)
      } else {
        console.warn(`  #${numStr} birth: no result for ${JSON.stringify(birthLabel)}`)
      }
    }

    const deathLabel = typeof doc.death_place === 'string' ? doc.death_place.trim() : ''
    if (deathLabel) {
      const g = await geocodePlaceSmart(deathLabel)
      if (g) {
        doc.death_latitude = g.lat
        doc.death_longitude = g.lon
        console.log(`  #${numStr} death → ${g.lat}, ${g.lon}`)
      } else {
        console.warn(`  #${numStr} death: no result for ${JSON.stringify(deathLabel)}`)
      }
    }

    await fs.writeFile(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    console.log(`Wrote ${relPath}`)
  }

  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
