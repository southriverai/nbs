# 90 Billion Stories

A random generated life story for every person that has ever lived and is alive today.

**Live site:** [southriverai.github.io/nbs](https://southriverai.github.io/nbs/)

## Getting Started

```bash
npm install   # already done
npm run dev   # start dev server
```

## Tech Stack

- **Vite** + **React** + **TypeScript**
- Fast HMR, modern tooling

## Known people (Wikipedia and curated stories)

Curated archive stories live under `public/people/{number}/story.json` and are registered in `public/person_stories_manifest.json`.

### Add someone from a Wikipedia URL

**Script:** `scripts/add-person-from-wikipedia.mjs` · **Command:** `npm run add-person`

Use the helper script (needs network). It reads **date of birth (P569)**, **place of birth (P19)**, and when available **date/place of death (P570/P20)** from **Wikidata** (linked to the Wikipedia article), infers **person #** by inverting the same cumulative-population curve as the app (`public/total_population.csv`), pulls the Wikipedia **summary** lede into `story.json`, then updates `person_stories_manifest.json`.

After building the story document, it calls **OpenStreetMap Nominatim** (forward search) on the **birth place** label, waits about a second, then on the **death place** label when present. Successful lookups add **`birth_latitude` / `birth_longitude`** and **`death_latitude` / `death_longitude`** to `story.json`. The app uses these for the map when present (with fallbacks to live geocoding of the place strings). Nominatim may return **429** if requests are too fast; the script retries with backoff. Space out runs if you add many people in one session.

```bash
npm run add-person -- --url "https://en.wikipedia.org/wiki/Alan_Turing"
```

- **`--url`** — Wikipedia article URL on a language subdomain (e.g. `en.wikipedia.org/wiki/…`). Wikidata must have a linked item with P569 (birth date); P19/P20 are used for place fields when present.
- **`--name`** (optional) — Override the display name; default is the article title from the Wikipedia API.
- **`--dry-run`** — Log inferred metadata and JSON; no files changed.

If the inferred person # is already used in the manifest, the script picks the **next free** higher number and prints a warning.

Always **edit the generated story** in `public/people/{number}/story.json` if you want something longer or more narrative than the Wikipedia lede. The script is a starting point, not a full biography.

### Refresh coordinates on existing curated stories

**Script:** `scripts/geocode-existing-stories.mjs` · **Command:** `npm run geocode-stories`

Reads **`public/person_stories_manifest.json`**, loads each listed `story.json`, and tries to fill or update **`birth_latitude` / `birth_longitude`** and **`death_latitude` / `death_longitude`** from Nominatim using the existing **`birthplace`** and **`death_place`** strings. It does **not** change **`person_number`**, manifest keys, or paths—only the coordinate fields when a geocode succeeds.

```bash
npm run geocode-stories
```

- Waits **~2.6 seconds** between Nominatim requests to reduce **429** rate limits.
- If the full place string fails, it retries with the substring **before the first comma** (e.g. city-only).
- If Nominatim still rate-limits your IP, wait and rerun later, or set coordinates manually in each `story.json` (same field names as above).
