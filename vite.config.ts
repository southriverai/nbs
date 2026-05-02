import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub project pages live under /<repo>/; set GITHUB_PAGES_BASE_URL in CI (see .github/workflows).
const base = process.env.GITHUB_PAGES_BASE_URL ?? '/'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
})
