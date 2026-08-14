import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { geminiProxy } from './middleware/gemini.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env so GEMINI_API_KEY is available to the dev middleware.
  // NOTE: only assign truthy values — assigning `undefined` to process.env
  // stringifies it to the literal "undefined", breaking model URLs.
  const env = loadEnv(mode, process.cwd(), '')
  if (env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = env.GEMINI_API_KEY
  if (env.GEMINI_MODEL) process.env.GEMINI_MODEL = env.GEMINI_MODEL

  return {
    plugins: [react(), geminiProxy()],
  }
})
