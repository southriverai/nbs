import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts'
import 'leaflet/dist/leaflet.css'
import './App.css'

interface PopulationRow {
  year: number
  cumulative_population: number
  life_expectancy: number
}

interface RegionalRow {
  year: number
  region: string
  population: number
}

const REGION_BOUNDS: Record<string, { lat: [number, number]; lng: [number, number] }> = {
  Africa: { lat: [-35, 37], lng: [-18, 52] },
  Asia: { lat: [-10, 55], lng: [25, 145] },
  Europe: { lat: [35, 71], lng: [-25, 40] },
  'Latin America and Caribbean': { lat: [-55, 32], lng: [-120, -35] },
  'Northern America': { lat: [25, 72], lng: [-170, -50] },
  Oceania: { lat: [-50, 25], lng: [110, 180] },
}

interface SiteConfig {
  repositoryUrl: string
  aboutTitle: string
  aboutBody: string
}

const DEFAULT_SITE: SiteConfig = {
  repositoryUrl: '',
  aboutTitle: '90 Billion Stories',
  aboutBody:
    "Since the first person in history was named, about 90 billion humans have lived and died on this planet. All of them had life stories as vivid and worthy as that of any king or religious leader. This app tries to fill in the blanks of these vast untold histories. We don't know the stories of these 90 billion people, but we can make some educated guesses.",
}

interface FamousPick {
  number: number
  name: string
}

function parseFamousPicks(raw: unknown): FamousPick[] {
  if (!Array.isArray(raw)) return []
  const out: FamousPick[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const n = Number(o.number)
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!Number.isInteger(n) || n < 1 || !name) continue
    out.push({ number: n, name })
  }
  return out
}

const markerIcon = L.divIcon({
  className: 'custom-marker',
  html: '<div style="background:#fbbf24;width:12px;height:12px;border-radius:50%;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
})

function seededRandom(seed: number): number {
  seed = (seed >>> 0) || 1
  seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca77)
  seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae3d)
  return ((seed ^ (seed >>> 16)) >>> 0) / 0xffffffff
}

function sampleRegion(seed: number, percentages: { region: string; percentage: number }[]): string {
  if (percentages.length === 0) return ''
  const r = seededRandom(seed)
  let cum = 0
  for (const { region, percentage } of percentages) {
    cum += percentage / 100
    if (r < cum) return region
  }
  return percentages[percentages.length - 1].region
}

function sampleGender(seed: number): 'Male' | 'Female' {
  return seededRandom(seed + 2) < 0.5 ? 'Male' : 'Female'
}

function sampleDeathAge(seed: number, lifeExpectancy: number): number {
  const r = seededRandom(seed + 4)
  const age = lifeExpectancy * (0.3 + 0.9 * r)
  return Math.max(1, Math.min(100, Math.round(age)))
}

function sampleRegionCoords(seed: number, region: string): { lat: number; lng: number } | null {
  const bounds = REGION_BOUNDS[region]
  if (!bounds) return null
  const lat = bounds.lat[0] + seededRandom(seed) * (bounds.lat[1] - bounds.lat[0])
  const lng = bounds.lng[0] + seededRandom(seed + 1) * (bounds.lng[1] - bounds.lng[0])
  return { lat, lng }
}

function MapCenter({ coords, zoom }: { coords: { lat: number; lng: number } | null; zoom: number }) {
  const map = useMap()
  useEffect(() => {
    if (coords) {
      map.setView([coords.lat, coords.lng], zoom)
    }
  }, [map, coords, zoom])
  return null
}

interface LocationInfo {
  town: string
  state: string | null
  country: string | null
}

/** Curated story JSON files under `public/` (see person_stories_manifest.json). */
interface ArchivedStoryFile {
  person_number?: number
  story_source?: 'wikipedia_summary' | 'algorithm_generated'
  title?: string
  name?: string
  wikipedia?: string
  born?: number | null
  birthplace?: string | null
  died?: number | null
  death_place?: string | null
  age_at_death?: number | null
  gender?: 'Male' | 'Female' | null
  source_birth_year?: number | null
  /** Optional explicit map position (e.g. birthplace); otherwise place strings are geocoded. */
  birth_latitude?: number | null
  birth_longitude?: number | null
  death_latitude?: number | null
  death_longitude?: number | null
  story: string[] | string
}

function formatArchivedStoryBody(data: ArchivedStoryFile): string {
  const body = Array.isArray(data.story) ? data.story.join('\n\n') : String(data.story ?? '')
  if (data.title) return `${data.title}\n\n${body}`
  return body
}

const API_KEY_STORAGE = 'nbs_openai_api_key'

async function fetchLifeStory(
  apiKey: string,
  summary: string,
  personNumber: number
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You write brief, evocative life stories (2-4 paragraphs) for historical people. Write in past tense, third person. Be historically plausible for the time and place. Focus on the human experience.',
        },
        {
          role: 'user',
          content: `Write a short life story for person #${personNumber.toLocaleString()}. Facts: ${summary}. Generate a plausible biography based on these facts.`,
        },
      ],
      temperature: 0,
      max_tokens: 500,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || res.statusText || 'API request failed')
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

async function geocodePlace(query: string): Promise<{ lat: number; lng: number } | null> {
  const q = query.trim()
  if (!q) return null
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': '90BillionStories/1.0 (educational; contact: site maintainer)' },
    })
    if (!res.ok) return null
    const arr: unknown = await res.json()
    if (!Array.isArray(arr) || arr.length === 0) return null
    const row = arr[0] as { lat?: string; lon?: string }
    const lat = Number(row.lat)
    const lng = Number(row.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng }
  } catch {
    return null
  }
}

async function fetchNearestTown(lat: number, lng: number): Promise<LocationInfo | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': '90BillionStories/1.0 (educational; contact: site maintainer)' },
    })
    const data = await res.json()
    const addr = data?.address
    if (!addr) return null
    const town = addr.village ?? addr.town ?? addr.city ?? addr.municipality ?? addr.county ?? addr.state ?? addr.country ?? null
    const state = addr.state ?? addr.state_district ?? addr.county ?? null
    const country = addr.country ?? null
    if (!town) return null
    return { town, state, country }
  } catch {
    return null
  }
}

function App() {
  const [number, setNumber] = useState<number | null>(null)
  const [inputNumber, setInputNumber] = useState('')
  const [birthYear, setBirthYear] = useState<number | null>(null)
  const [deathYear, setDeathYear] = useState<number | null>(null)
  const [ageAtDeath, setAgeAtDeath] = useState<number | null>(null)
  const [gender, setGender] = useState<'Male' | 'Female' | null>(null)
  const [region, setRegion] = useState<string | null>(null)
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locationInfo, setLocationInfo] = useState<LocationInfo | null>(null)
  const [deathLocationInfo, setDeathLocationInfo] = useState<LocationInfo | null>(null)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '')
  const [story, setStory] = useState<string | null>(null)
  const [storyLoading, setStoryLoading] = useState(false)
  const [storyError, setStoryError] = useState<string | null>(null)
  const [storySource, setStorySource] = useState<'archive' | 'ai' | null>(null)
  const [storyManifest, setStoryManifest] = useState<Record<number, string>>({})
  const [data, setData] = useState<PopulationRow[]>([])
  const [regionalData, setRegionalData] = useState<RegionalRow[]>([])
  const [maxPopulation, setMaxPopulation] = useState(0)
  const [site, setSite] = useState<SiteConfig>(DEFAULT_SITE)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [archivedRawRecord, setArchivedRawRecord] = useState<ArchivedStoryFile | null>(null)
  const [famousPicks, setFamousPicks] = useState<FamousPick[]>([])
  const [mapZoom, setMapZoom] = useState(4)
  const loadPersonCancelRef = useRef(0)

  useEffect(() => {
    const assetBase = import.meta.env.BASE_URL
    Promise.all([
      fetch(`${assetBase}total_population.csv`).then((res) => res.text()),
      fetch(`${assetBase}regional_population.csv`).then((res) => res.text()),
    ]).then(([popText, regionalText]) => {
      const popLines = popText.trim().split('\n')
      const popRows: PopulationRow[] = popLines.slice(1).map((line) => {
        const parts = line.split(',')
        const year = Number(parts[0])
        const cumulative_population = Number(parts[1])
        const life_expectancy = Number(parts[2]) || 30
        return { year, cumulative_population, life_expectancy }
      })
      const sorted = popRows.sort((a, b) => a.year - b.year)
      setData(sorted)
      const max = sorted.length > 0 ? Math.max(...sorted.map((r) => r.cumulative_population)) : 0
      setMaxPopulation(max)

      const regLines = regionalText.trim().split('\n')
      const regRows: RegionalRow[] = regLines.slice(1).map((line) => {
        const [year, region, population] = line.split(',')
        return { year: Number(year), region, population: Number(population) }
      })
      setRegionalData(regRows)
    })
  }, [])

  useEffect(() => {
    const assetBase = import.meta.env.BASE_URL
    fetch(`${assetBase}famous_picks.json?v=${Date.now()}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((raw) => setFamousPicks(parseFamousPicks(raw)))
      .catch(() => setFamousPicks([]))
  }, [])

  useEffect(() => {
    const assetBase = import.meta.env.BASE_URL
    fetch(`${assetBase}site.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return
        const o = raw as Record<string, unknown>
        const repositoryUrl = typeof o.repositoryUrl === 'string' ? o.repositoryUrl.trim() : ''
        const aboutTitle = typeof o.aboutTitle === 'string' ? o.aboutTitle.trim() : DEFAULT_SITE.aboutTitle
        const aboutBody = typeof o.aboutBody === 'string' ? o.aboutBody.trim() : DEFAULT_SITE.aboutBody
        setSite({ repositoryUrl, aboutTitle: aboutTitle || DEFAULT_SITE.aboutTitle, aboutBody: aboutBody || DEFAULT_SITE.aboutBody })
      })
      .catch(() => setSite(DEFAULT_SITE))
  }, [])

  useEffect(() => {
    if (!aboutOpen && !rawOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAboutOpen(false)
        setRawOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aboutOpen, rawOpen])

  useEffect(() => {
    const assetBase = import.meta.env.BASE_URL
    fetch(`${assetBase}person_stories_manifest.json`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((obj: Record<string, string>) => {
        const m: Record<number, string> = {}
        for (const [k, v] of Object.entries(obj)) {
          const n = Number(k)
          if (!Number.isNaN(n) && typeof v === 'string' && v.trim()) m[n] = v.trim()
        }
        setStoryManifest(m)
      })
      .catch(() => setStoryManifest({}))
  }, [])

  const interpolateLifeExpectancy = (year: number): number => {
    const sorted = [...data].sort((a, b) => a.year - b.year)
    if (sorted.length === 0) return 30
    if (year <= sorted[0].year) return sorted[0].life_expectancy
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].year >= year) {
        const [y1, le1] = [sorted[i - 1].year, sorted[i - 1].life_expectancy]
        const [y2, le2] = [sorted[i].year, sorted[i].life_expectancy]
        const t = (year - y1) / (y2 - y1)
        return le1 + t * (le2 - le1)
      }
    }
    return sorted[sorted.length - 1].life_expectancy
  }

  const interpolateYear = (n: number): number => {
    const sorted = [...data].sort((a, b) => a.year - b.year)
    if (n <= sorted[0].cumulative_population) return sorted[0].year
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].cumulative_population >= n) {
        const [y1, c1] = [sorted[i - 1].year, sorted[i - 1].cumulative_population]
        const [y2, c2] = [sorted[i].year, sorted[i].cumulative_population]
        const t = (n - c1) / (c2 - c1)
        return y1 + t * (y2 - y1)
      }
    }
    return sorted[sorted.length - 1].year
  }

  const getRegionalPercentages = (year: number): { region: string; percentage: number }[] => {
    const years = [...new Set(regionalData.map((r) => r.year))].sort((a, b) => a - b)
    if (years.length === 0) return []
    if (year <= years[0]) return getRegionalAtYear(years[0])
    if (year >= years[years.length - 1]) return getRegionalAtYear(years[years.length - 1])

    let i = 0
    while (i < years.length - 1 && years[i + 1] < year) i++
    const [y1, y2] = [years[i], years[i + 1]]
    const t = (year - y1) / (y2 - y1)

    const atY1 = regionalData.filter((r) => r.year === y1)
    const atY2 = regionalData.filter((r) => r.year === y2)
    const regions = [...new Set(atY1.map((r) => r.region))]

    let total = 0
    const populations: Record<string, number> = {}
    for (const region of regions) {
      const p1 = atY1.find((r) => r.region === region)?.population ?? 0
      const p2 = atY2.find((r) => r.region === region)?.population ?? 0
      const p = p1 + t * (p2 - p1)
      populations[region] = p
      total += p
    }

    if (total === 0) return []
    return regions
      .map((region) => ({ region, percentage: (populations[region] / total) * 100 }))
      .filter((r) => r.percentage > 0)
      .sort((a, b) => b.percentage - a.percentage)
  }

  const getRegionalAtYear = (year: number): { region: string; percentage: number }[] => {
    const atYear = regionalData.filter((r) => r.year === year)
    const total = atYear.reduce((s, r) => s + r.population, 0)
    if (total === 0) return []
    return atYear
      .map((r) => ({ region: r.region, percentage: (r.population / total) * 100 }))
      .filter((r) => r.percentage > 0)
      .sort((a, b) => b.percentage - a.percentage)
  }

  const applyAlgorithmForPerson = (clamped: number) => {
    const requestId = loadPersonCancelRef.current
    setArchivedRawRecord(null)
    setInputNumber(String(clamped))
    setNumber(clamped)
    setMapZoom(4)
    const year = interpolateYear(clamped)
    setBirthYear(year)
    const lifeExp = interpolateLifeExpectancy(year)
    const age = sampleDeathAge(clamped, lifeExp)
    setAgeAtDeath(age)
    const deathFraction = seededRandom(clamped + 5)
    setDeathYear(Math.floor(year) + age + deathFraction)
    setGender(sampleGender(clamped))
    const percentages = getRegionalPercentages(year)
    const r = sampleRegion(clamped, percentages)
    setRegion(r)
    const c = r ? sampleRegionCoords(clamped, r) : null
    const cDeath = r ? sampleRegionCoords(clamped + 7919, r) : null
    setCoords(c)
    setLocationInfo(null)
    setDeathLocationInfo(null)
    if (c) {
      fetchNearestTown(c.lat, c.lng).then((loc) => {
        if (loadPersonCancelRef.current !== requestId) return
        setLocationInfo(loc)
      })
    }
    if (cDeath) {
      fetchNearestTown(cDeath.lat, cDeath.lng).then((loc) => {
        if (loadPersonCancelRef.current !== requestId) return
        setDeathLocationInfo(loc)
      })
    }
  }

  const generateFromNumber = (n: number) => {
    if (maxPopulation === 0) return
    const clamped = Math.max(1, Math.min(Math.floor(n), maxPopulation))
    const req = ++loadPersonCancelRef.current
    const path = storyManifest[clamped]

    if (!path) {
      applyAlgorithmForPerson(clamped)
      setStory(null)
      setStorySource(null)
      setStoryError(null)
      setStoryLoading(false)
      return
    }

    setArchivedRawRecord(null)
    setInputNumber(String(clamped))
    setNumber(clamped)
    setStoryLoading(true)
    setStoryError(null)
    setStory(null)
    setStorySource(null)
    setBirthYear(null)
    setDeathYear(null)
    setAgeAtDeath(null)
    setGender(null)
    setRegion(null)
    setCoords(null)
    setLocationInfo(null)
    setDeathLocationInfo(null)

    const assetBase = import.meta.env.BASE_URL
    fetch(`${assetBase}${path}`)
      .then((res) => {
        if (!res.ok) throw new Error('Story file not found')
        return res.json() as Promise<ArchivedStoryFile>
      })
      .then(async (data) => {
        if (loadPersonCancelRef.current !== req) return

        const born =
          typeof data.born === 'number' && Number.isFinite(data.born) ? data.born : interpolateYear(clamped)
        setBirthYear(born)
        setDeathYear(typeof data.died === 'number' && Number.isFinite(data.died) ? data.died : null)
        setAgeAtDeath(
          typeof data.age_at_death === 'number' && Number.isFinite(data.age_at_death) ? data.age_at_death : null,
        )
        setGender(data.gender ?? null)
        const placeBits = [data.birthplace, data.death_place]
          .map((x) => (typeof x === 'string' ? x.trim() : ''))
          .filter(Boolean)
        setRegion(placeBits.join(' — ') || 'Historical region')

        setStory(formatArchivedStoryBody(data))
        setStorySource('archive')

        let nextCoords: { lat: number; lng: number } | null = null
        const lat0 = data.birth_latitude
        const lng0 = data.birth_longitude
        if (
          typeof lat0 === 'number' &&
          typeof lng0 === 'number' &&
          Number.isFinite(lat0) &&
          Number.isFinite(lng0)
        ) {
          nextCoords = { lat: lat0, lng: lng0 }
        } else {
          const dLat = data.death_latitude
          const dLng = data.death_longitude
          if (
            typeof dLat === 'number' &&
            typeof dLng === 'number' &&
            Number.isFinite(dLat) &&
            Number.isFinite(dLng)
          ) {
            nextCoords = { lat: dLat, lng: dLng }
          } else {
            const primary = typeof data.birthplace === 'string' ? data.birthplace.trim() : ''
            const secondary = typeof data.death_place === 'string' ? data.death_place.trim() : ''
            if (primary) nextCoords = await geocodePlace(primary)
            if (!nextCoords && secondary) nextCoords = await geocodePlace(secondary)
          }
        }

        if (loadPersonCancelRef.current !== req) return
        setCoords(nextCoords)
        setMapZoom(nextCoords ? 6 : 4)
        setArchivedRawRecord(data)
        if (nextCoords) {
          fetchNearestTown(nextCoords.lat, nextCoords.lng).then((loc) => {
            if (loadPersonCancelRef.current !== req) return
            setLocationInfo(loc)
          })
        } else {
          setLocationInfo(null)
        }
        setDeathLocationInfo(null)
      })
      .catch(() => {
        if (loadPersonCancelRef.current !== req) return
        setStoryError('Could not load archived story.')
        setStory(null)
        setStorySource(null)
        applyAlgorithmForPerson(clamped)
      })
      .finally(() => {
        if (loadPersonCancelRef.current !== req) return
        setStoryLoading(false)
      })
  }

  const commitPersonInput = () => {
    if (maxPopulation === 0) return
    const raw = inputNumber.trim()
    if (raw === '') {
      if (number !== null) setInputNumber(String(number))
      return
    }
    const v = Math.floor(Number(raw))
    if (!Number.isFinite(v) || v < 1) {
      if (number !== null) setInputNumber(String(number))
      return
    }
    const clamped = Math.max(1, Math.min(v, maxPopulation))
    if (number !== null && clamped === number) {
      setInputNumber(String(clamped))
      return
    }
    generateFromNumber(clamped)
  }

  const generateStory = async () => {
    if (!apiKey.trim() || number === null || birthYear === null) return
    if (storySource === 'archive') return
    setStoryLoading(true)
    setStoryError(null)
    try {
      const summary = formatFullResult()
      const text = await fetchLifeStory(apiKey, summary, number)
      setStory(text)
      setStorySource('ai')
    } catch (err) {
      setStoryError(err instanceof Error ? err.message : 'Failed to generate story')
    } finally {
      setStoryLoading(false)
    }
  }

  const saveApiKey = (key: string) => {
    setApiKey(key)
    if (key) localStorage.setItem(API_KEY_STORAGE, key)
    else localStorage.removeItem(API_KEY_STORAGE)
  }

  const roll = () => {
    if (maxPopulation === 0) return
    generateFromNumber(Math.floor(Math.random() * maxPopulation) + 1)
  }

  const formatYear = (year: number) => {
    const abs = Math.abs(year)
    const isWhole = Math.abs(year - Math.round(year)) < 0.01
    const str = isWhole ? String(Math.round(abs)) : abs.toFixed(1)
    if (year < 0) return `${str} BCE`
    return `${str} CE`
  }

  const birthYearToFullDate = (birthYear: number): { year: number; month: number; day: number; timestamp: number } => {
    const yearInt = Math.floor(birthYear)
    const fraction = Math.max(0, Math.min(1, birthYear - yearInt))
    const jsYear = yearInt <= 0 ? yearInt + 1 : yearInt
    const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
    const daysInYear = isLeap(jsYear) ? 366 : 365
    const dayOfYear = Math.min(Math.floor(fraction * daysInYear), daysInYear - 1)
    const cumDays = isLeap(jsYear)
      ? [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
      : [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    let month = 12
    let day = 31
    for (let m = 0; m < 11; m++) {
      if (dayOfYear < cumDays[m + 1]) {
        month = m + 1
        day = dayOfYear - cumDays[m] + 1
        break
      }
    }
    const timestamp = new Date(jsYear, month - 1, day).getTime()
    return { year: yearInt, month, day, timestamp }
  }

  const formatLocationPlace = (info: LocationInfo | null): string => {
    if (!info) return ''
    const bits = [info.town]
    if (info.state && info.state.toLowerCase() !== info.town.toLowerCase()) bits.push(info.state)
    if (info.country) bits.push(info.country)
    return bits.filter(Boolean).join(', ')
  }

  const formatFullDate = (birthYear: number): string => {
    const { year, month, day } = birthYearToFullDate(birthYear)
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const getOrdinal = (d: number) => {
      if (d >= 11 && d <= 13) return 'th'
      switch (d % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th' }
    }
    const suffix = getOrdinal(day)
    const era = year < 0 ? ' BCE' : ' CE'
    return `${day}${suffix} of ${months[month - 1]} ${Math.abs(year)}${era}`
  }

  const formatFullResult = (): string => {
    const parts: string[] = []
    if (gender) parts.push(gender)

    if (storySource === 'archive' && archivedRawRecord) {
      const bp = typeof archivedRawRecord.birthplace === 'string' ? archivedRawRecord.birthplace.trim() : ''
      const dp = typeof archivedRawRecord.death_place === 'string' ? archivedRawRecord.death_place.trim() : ''
      parts.push(`born ${formatFullDate(birthYear!)}${bp ? ` in ${bp}` : ''}`)
      if (deathYear !== null && ageAtDeath !== null) {
        parts.push(`died aged ${ageAtDeath} on ${formatFullDate(deathYear)}${dp ? ` in ${dp}` : ''}`)
      }
      return parts.join(', ')
    }

    const birthPlace = formatLocationPlace(locationInfo)
    parts.push(`born ${formatFullDate(birthYear!)}${birthPlace ? ` in ${birthPlace}` : ''}`)
    if (deathYear !== null && ageAtDeath !== null) {
      const deathPlace = formatLocationPlace(deathLocationInfo)
      parts.push(`died aged ${ageAtDeath} on ${formatFullDate(deathYear)}${deathPlace ? ` in ${deathPlace}` : ''}`)
    }
    return parts.join(', ')
  }

  const formatYearAxis = (value: number) => {
    if (value < 0) return `${Math.abs(value)} BCE`
    return `${value}`
  }

  const formatPopulation = (value: number) => {
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
    if (value >= 1e6) return `${(value / 1e6).toFixed(0)}M`
    if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`
    return String(value)
  }

  const highlightedPoint =
    birthYear !== null && number !== null
      ? { year: birthYear, cumulative_population: number }
      : null

  const personNavBase =
    number ??
    (() => {
      const v = Math.floor(Number(inputNumber))
      return Number.isFinite(v) && v >= 1 && v <= maxPopulation ? v : null
    })()

  const aboutParagraphs = site.aboutBody
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

  const getRawPayload = (): unknown => {
    if (number === null) return {}
    if (archivedRawRecord) {
      return {
        ...archivedRawRecord,
        _resolved_map_coordinates: coords,
        _nominatim_reverse_geocode: locationInfo,
      }
    }
    if (storyManifest[number] && storyLoading && birthYear === null) {
      return {
        status: 'loading_curated_person',
        person_number: number,
        story_file: storyManifest[number],
      }
    }
    if (birthYear !== null) {
      return {
        source: 'algorithm',
        person_number: number,
        story_manifest_path: storyManifest[number] ?? null,
        birth_year_interpolated: birthYear,
        death_year_model: deathYear,
        age_at_death_model: ageAtDeath,
        gender,
        region_sampled: region,
        coordinates: coords,
        nominatim_reverse_geocode_birth: locationInfo,
        nominatim_reverse_geocode_death: deathLocationInfo,
      }
    }
    return { person_number: number, status: 'pending' }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-spacer" aria-hidden="true" />
        <span className="app-header-brand">90 Billion Stories</span>
        <nav className="app-header-actions" aria-label="Project links">
          {site.repositoryUrl ? (
            <a className="app-header-link" href={site.repositoryUrl} target="_blank" rel="noopener noreferrer">
              Source on GitHub
            </a>
          ) : null}
          <button
            type="button"
            className="app-header-about"
            onClick={() => setRawOpen(true)}
            disabled={number === null}
          >
            Raw
          </button>
          <button type="button" className="app-header-about" onClick={() => setAboutOpen(true)}>
            About
          </button>
        </nav>
      </header>

      {rawOpen && (
        <div
          className="about-overlay"
          role="presentation"
          onClick={() => setRawOpen(false)}
          aria-hidden={!rawOpen}
        >
          <div
            className="about-dialog about-dialog--raw"
            role="dialog"
            aria-modal="true"
            aria-labelledby="raw-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="raw-dialog-title" className="about-dialog-title">
              Raw data
            </h2>
            <pre className="about-dialog-raw-pre">{JSON.stringify(getRawPayload(), null, 2)}</pre>
            <button type="button" className="about-dialog-close" onClick={() => setRawOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {aboutOpen && (
        <div
          className="about-overlay"
          role="presentation"
          onClick={() => setAboutOpen(false)}
          aria-hidden={!aboutOpen}
        >
          <div
            className="about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="about-dialog-title" className="about-dialog-title">
              {site.aboutTitle}
            </h2>
            <div className="about-dialog-body">
              {aboutParagraphs.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
            <button type="button" className="about-dialog-close" onClick={() => setAboutOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="app-main">
        <div className="app-main-chart">
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={196}>
              <AreaChart data={data} margin={{ top: 16, right: 32, left: 16, bottom: 40 }}>
                <defs>
                  <linearGradient id="populationGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#646cff" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#646cff" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis
                  dataKey="year"
                  type="number"
                  domain={[data[0]?.year ?? -3100, data[data.length - 1]?.year ?? 2025]}
                  ticks={[-3000, -2000, -1000, 0, 1000, 1500, 1800, 1900, 2000, 2025]}
                  tickFormatter={formatYearAxis}
                  stroke="rgba(255,255,255,0.8)"
                  tick={{ fill: 'rgba(255,255,255,0.9)', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.6)' }}
                  tickLine={{ stroke: 'rgba(255,255,255,0.6)' }}
                />
                <YAxis
                  tickFormatter={formatPopulation}
                  stroke="rgba(255,255,255,0.7)"
                  tick={{ fill: 'rgba(255,255,255,0.8)', fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }}
                  labelFormatter={(value) => formatYear(Number(value))}
                  formatter={(value: number | undefined) => [value != null ? value.toLocaleString() : '', 'Cumulative population']}
                />
                <Area
                  type="monotone"
                  dataKey="cumulative_population"
                  stroke="#646cff"
                  strokeWidth={2}
                  fill="url(#populationGradient)"
                />
                {birthYear !== null && (
                  <>
                    <ReferenceLine
                      x={birthYear}
                      stroke="#fbbf24"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                    />
                    {highlightedPoint && (
                      <ReferenceDot
                        x={highlightedPoint.year}
                        y={highlightedPoint.cumulative_population}
                        r={6}
                        fill="#fbbf24"
                        stroke="#fff"
                        strokeWidth={2}
                      />
                    )}
                  </>
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="app-main-below-chart">
          <div className="app-main-text">
            <div className="controls">
              <div className="api-key-section">
                <label htmlFor="api-key">OpenAI API key</label>
                <input
                  id="api-key"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => saveApiKey(e.target.value)}
                  className="api-key-input"
                />
              </div>
              <button className="random-button" onClick={roll} disabled={data.length === 0}>
                Random
              </button>
              <div className="lookup-controls" role="group" aria-label="Person number">
                <button
                  type="button"
                  className="person-nav-button person-nav-button--step"
                  onClick={() => personNavBase != null && generateFromNumber(personNavBase - 1)}
                  disabled={data.length === 0 || personNavBase == null || personNavBase <= 1}
                  aria-label="Previous person number"
                  title="Previous person number"
                >
                  {'<<'}
                </button>
                <div className="lookup-person-field">
                  <label htmlFor="person-number">Person #</label>
                  <input
                    id="person-number"
                    type="number"
                    min={1}
                    max={maxPopulation}
                    placeholder={`1–${maxPopulation.toLocaleString()}`}
                    value={inputNumber}
                    onChange={(e) => setInputNumber(e.target.value)}
                    onBlur={commitPersonInput}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commitPersonInput())}
                  />
                </div>
                <button
                  type="button"
                  className="person-nav-button person-nav-button--step"
                  onClick={() => personNavBase != null && generateFromNumber(personNavBase + 1)}
                  disabled={data.length === 0 || personNavBase == null || personNavBase >= maxPopulation}
                  aria-label="Next person number"
                  title="Next person number"
                >
                  {'>>'}
                </button>
              </div>
            </div>

            <section className="famous-picks" aria-labelledby="famous-picks-heading">
              <h2 id="famous-picks-heading" className="famous-picks-title">
                Famous people by person #
              </h2>
              <ul className="famous-picks-list">
                {famousPicks.map((pick) => {
                  const disabled = data.length === 0 || pick.number > maxPopulation
                  return (
                    <li key={pick.number}>
                      <button
                        type="button"
                        className="famous-pick-button"
                        disabled={disabled}
                        onClick={() => generateFromNumber(pick.number)}
                      >
                        <span className="famous-pick-name">{pick.name}</span>
                        <span className="famous-pick-number">#{pick.number.toLocaleString()}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>

            {number !== null && (birthYear !== null || (Boolean(storyManifest[number]) && storyLoading)) && (
              <div className="result">
                {birthYear !== null ? (
                  <p className="result-summary">{formatFullResult()}</p>
                ) : (
                  <p className="story-archive-label">Loading curated person…</p>
                )}
                <div className="story-section">
                  {(() => {
                    const hasManifestEntry = number !== null && Boolean(storyManifest[number])
                    const archiveLoading = hasManifestEntry && storyLoading && storySource !== 'archive'
                    const archiveShown = storySource === 'archive' && Boolean(story)
                    const showAiStoryButton =
                      !archiveShown && !archiveLoading && (!hasManifestEntry || (!story && storyError))
                    return (
                      <>
                        {showAiStoryButton && (
                          <button
                            className="generate-story-button"
                            onClick={generateStory}
                            disabled={!apiKey.trim() || storyLoading}
                          >
                            {storyLoading ? 'Generating…' : 'Generate life story'}
                          </button>
                        )}
                        {archiveLoading && birthYear !== null && (
                          <p className="story-archive-label">Loading archived story…</p>
                        )}
                        {storyError && <p className="story-error">{storyError}</p>}
                        {story && <div className="story-text">{story}</div>}
                      </>
                    )
                  })()}
                </div>
              </div>
            )}
          </div>

          <aside className="app-main-map" aria-label="Map">
            <div className="map-container">
              <MapContainer
                center={[20, 0]}
                zoom={2}
                style={{ height: '100%', width: '100%', minHeight: 400 }}
                attributionControl={false}
                zoomControl={false}
              >
                <MapCenter coords={coords} zoom={mapZoom} />
                <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png" />
                {coords && (
                  <Marker position={[coords.lat, coords.lng]} icon={markerIcon}>
                    <Popup>
                      {locationInfo && (
                        <>
                          <strong>{locationInfo.town}</strong>
                          {locationInfo.state && locationInfo.state.toLowerCase() !== locationInfo.town.toLowerCase() && `, ${locationInfo.state}`}
                          {locationInfo.country && `, ${locationInfo.country}`}
                          <br />
                        </>
                      )}
                      {region}<br />
                      {coords.lat.toFixed(2)}°{coords.lat >= 0 ? 'N' : 'S'}, {coords.lng.toFixed(2)}°{coords.lng >= 0 ? 'E' : 'W'}
                    </Popup>
                  </Marker>
                )}
              </MapContainer>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

export default App
