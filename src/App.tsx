import { useState, useEffect } from 'react'
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

function MapCenter({ coords }: { coords: { lat: number; lng: number } | null }) {
  const map = useMap()
  useEffect(() => {
    if (coords) {
      map.setView([coords.lat, coords.lng], 4)
    }
  }, [map, coords])
  return null
}

interface LocationInfo {
  town: string
  state: string | null
  country: string | null
}

interface KnownPerson {
  number: number
  name: string
  year: number
  location: string
  wikipedia: string
}

/** Last CSV column is always a `https://` Wikipedia URL. */
function parseNamedPeopleLine(line: string): Omit<KnownPerson, 'year'> & { year: string } | null {
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

/** Curated story JSON files under `public/` (see person_stories_manifest.json). */
interface ArchivedStoryFile {
  title?: string
  name?: string
  wikipedia?: string
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

async function fetchNearestTown(lat: number, lng: number): Promise<LocationInfo | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NineBillionStories/1.0' },
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
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? '')
  const [story, setStory] = useState<string | null>(null)
  const [storyLoading, setStoryLoading] = useState(false)
  const [storyError, setStoryError] = useState<string | null>(null)
  const [storySource, setStorySource] = useState<'archive' | 'ai' | null>(null)
  const [storyManifest, setStoryManifest] = useState<Record<number, string>>({})
  const [data, setData] = useState<PopulationRow[]>([])
  const [regionalData, setRegionalData] = useState<RegionalRow[]>([])
  const [maxPopulation, setMaxPopulation] = useState(0)
  const [knownPeople, setKnownPeople] = useState<Record<number, KnownPerson>>({})

  useEffect(() => {
    const assetBase = import.meta.env.BASE_URL
    Promise.all([
      fetch(`${assetBase}total_population.csv`).then((res) => res.text()),
      fetch(`${assetBase}regional_population.csv`).then((res) => res.text()),
      fetch(`${assetBase}named_people.csv`).then((res) => (res.ok ? res.text() : '')),
    ]).then(([popText, regionalText, namedText]) => {
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

      const namedLines = namedText.trim().split('\n')
      const byNumber: Record<number, KnownPerson> = {}
      for (const line of namedLines.slice(1)) {
        const row = parseNamedPeopleLine(line)
        if (!row || Number.isNaN(row.number)) continue
        const y = Number(row.year)
        byNumber[row.number] = {
          number: row.number,
          name: row.name,
          year: Number.isFinite(y) ? y : 0,
          location: row.location,
          wikipedia: row.wikipedia,
        }
      }
      setKnownPeople(byNumber)
    })
  }, [])

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

  useEffect(() => {
    if (number === null) return
    const path = storyManifest[number]
    if (!path) {
      setStory(null)
      setStorySource(null)
      setStoryError(null)
      return
    }
    const assetBase = import.meta.env.BASE_URL
    let cancelled = false
    setStoryLoading(true)
    setStoryError(null)
    setStory(null)
    setStorySource(null)
    fetch(`${assetBase}${path}`)
      .then((res) => {
        if (!res.ok) throw new Error('Story file not found')
        return res.json() as Promise<ArchivedStoryFile>
      })
      .then((data) => {
        if (cancelled) return
        setStory(formatArchivedStoryBody(data))
        setStorySource('archive')
      })
      .catch(() => {
        if (cancelled) return
        setStory(null)
        setStorySource(null)
        setStoryError('Could not load archived story.')
      })
      .finally(() => {
        if (!cancelled) setStoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [number, storyManifest])

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

  const generateFromNumber = (n: number) => {
    if (maxPopulation === 0) return
    const clamped = Math.max(1, Math.min(Math.floor(n), maxPopulation))
    setInputNumber(String(clamped))
    setNumber(clamped)
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
    setCoords(c)
    setLocationInfo(null)
    setStory(null)
    setStorySource(null)
    setStoryError(null)
    if (c) {
      fetchNearestTown(c.lat, c.lng).then(setLocationInfo)
    }
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
    parts.push(`born ${formatFullDate(birthYear!)}`)
    if (deathYear !== null && ageAtDeath !== null) {
      parts.push(`died aged ${ageAtDeath} on ${formatFullDate(deathYear)}`)
    }
    if (locationInfo) {
      const locParts = ['near', locationInfo.town]
      if (locationInfo.state && locationInfo.state.toLowerCase() !== locationInfo.town.toLowerCase()) {
        locParts.push(locationInfo.state)
      }
      locParts.push('modern day')
      if (locationInfo.country) locParts.push(locationInfo.country)
      parts.push(locParts.join(', '))
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

  return (
    <div className="app">
      <div className="map-container">
        <MapContainer
          center={[20, 0]}
          zoom={2}
          style={{ height: '100%', width: '100%', minHeight: 450 }}
          attributionControl={false}
          zoomControl={false}
        >
          <MapCenter coords={coords} />
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
      <div className="chart-container">
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data} margin={{ top: 20, right: 40, left: 20, bottom: 50 }}>
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
              tick={{ fill: 'rgba(255,255,255,0.9)', fontSize: 11 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.6)' }}
              tickLine={{ stroke: 'rgba(255,255,255,0.6)' }}
            />
            <YAxis
              tickFormatter={formatPopulation}
              stroke="rgba(255,255,255,0.7)"
              tick={{ fill: 'rgba(255,255,255,0.8)' }}
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
        <div className="lookup-controls">
          <label htmlFor="person-number">Person #</label>
          <input
            id="person-number"
            type="number"
            min={1}
            max={maxPopulation}
            placeholder={`1–${maxPopulation.toLocaleString()}`}
            value={inputNumber}
            onChange={(e) => setInputNumber(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && generateFromNumber(Number(inputNumber) || 1)}
          />
          <button
            className="lookup-button"
            onClick={() => generateFromNumber(Number(inputNumber) || 1)}
            disabled={data.length === 0}
          >
            Generate
          </button>
        </div>
      </div>
      {number !== null && birthYear !== null && (
        <div className="result">
          <p className="result-number">#{number.toLocaleString()}</p>
          {knownPeople[number]?.wikipedia && (
            <p className="result-wikipedia">
              <a href={knownPeople[number].wikipedia} target="_blank" rel="noopener noreferrer">
                Wikipedia — {knownPeople[number].name}
              </a>
            </p>
          )}
          <p className="result-summary">{formatFullResult()}</p>
          {coords && (
            <p className="result-coords">
              {coords.lat.toFixed(2)}°{coords.lat >= 0 ? 'N' : 'S'}, {coords.lng.toFixed(2)}°{coords.lng >= 0 ? 'E' : 'W'}
            </p>
          )}
          <p className="result-timestamp">{birthYearToFullDate(birthYear).timestamp}</p>
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
                  {archiveLoading && <p className="story-archive-label">Loading archived story…</p>}
                  {archiveShown && <p className="story-archive-label">Archived story</p>}
                  {storyError && <p className="story-error">{storyError}</p>}
                  {story && <div className="story-text">{story}</div>}
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
