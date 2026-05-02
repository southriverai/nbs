# Nine Billion Stories

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

`public/named_people.csv` lists notable person slots (`number`, `name`, `year`, `location`, **`wikipedia`**). The app shows a Wikipedia link when the selected person number matches a row.

Curated archive stories live under `public/people/{number}/story.json` and are registered in `public/person_stories_manifest.json`.

### Add someone from a Wikipedia URL

Use the helper script (needs network). It pulls the article **summary** from the Wikipedia REST API, splits it into short paragraphs for `story.json`, then updates the manifest and appends `named_people.csv`.

```bash
npm run add-person -- --url "https://en.wikipedia.org/wiki/Anne_Frank" --number 14 --year 1929 --location "Amsterdam"
```

- **`--url`** — English Wikipedia article URL (must include `/wiki/Article_title`).
- **`--number`** — Person index (must not already exist in the manifest or CSV).
- **`--year`** — Birth or anchor year for the CSV index (any number you want shown in the roster).
- **`--location`** — Short place label for the CSV.
- **`--name`** (optional) — Override the display name; default is the article title from the API.
- **`--dry-run`** — Print what would be written; no files changed.

Always **edit the generated story** in `public/people/{number}/story.json` if you want something longer or more narrative than the Wikipedia lede. The script is a starting point, not a full biography.
