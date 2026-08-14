/**
 * Vite dev middleware: proxies Gemini API calls so the API key stays on the
 * server side and is never exposed to the browser.
 *
 * Usage: POST /api/gemini  body: { "text": "user message" }
 * Response: { "messages": A2uiMessage[] }
 */
import type { Plugin } from 'vite'
import { normalizeMessages } from './normalize.js'

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models'

/** Model used for A2UI generation. Override with GEMINI_MODEL env var. */
const MODEL =
  process.env.GEMINI_MODEL && process.env.GEMINI_MODEL !== 'undefined'
    ? process.env.GEMINI_MODEL
    : 'gemini-3.7-flash'

/** Fallback models tried in order when the primary model is unavailable
 *  (quota exhausted / high demand). Override with GEMINI_FALLBACK_MODELS. */
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.1-flash-lite,gemini-flash-latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((m) => m !== 'undefined')

export function geminiProxy(): Plugin {
  return {
    name: 'gemini-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gemini', async (req, res, next) => {
        if (req.method !== 'POST') return next()

        const apiKey = process.env.GEMINI_API_KEY
        if (!apiKey) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              error:
                'GEMINI_API_KEY is not set. Create a .env file with GEMINI_API_KEY=your_key',
            }),
          )
          return
        }

        // Read request body.
        let body = ''
        req.on('data', (chunk) => (body += chunk.toString()))
        req.on('end', async () => {
          try {
            const { text, systemPrompt } = JSON.parse(body || '{}')
            if (typeof text !== 'string' || text.length === 0) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Missing "text" in request body' }))
              return
            }

            // Try the primary model, then fallbacks in order.
            const attempts = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)]
            let lastError = ''
            let geminiRes: Response | null = null

            for (const model of attempts) {
              geminiRes = await fetch(
                `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [
                      {
                        role: 'user',
                        parts: [{ text: `User request: ${text}` }],
                      },
                    ],
                    systemInstruction: {
                      parts: [{ text: systemPrompt }],
                    },
                    generationConfig: {
                      responseMimeType: 'application/json',
                      temperature: 0.4,
                    },
                  }),
                },
              )

              if (geminiRes.ok) break

              // Only fail over on transient errors (429 quota / 503 overload).
              lastError = `Gemini API error ${geminiRes.status}: ${(await geminiRes.text()).slice(0, 300)}`
              if (geminiRes.status !== 429 && geminiRes.status !== 503) break
              console.log(`[gemini-proxy] model ${model} unavailable (${geminiRes.status}), trying next...`)
            }

            if (!geminiRes || !geminiRes.ok) {
              res.statusCode = geminiRes?.status ?? 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: lastError }))
              return
            }

            const data = (await geminiRes.json()) as {
              candidates?: { content?: { parts?: { text?: string }[] } }[]
            }
            const rawText =
              data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

            // Strip any code fences the model might add, then parse JSON.
            const cleaned = rawText
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```$/, '')
              .trim()

            let rawJson: unknown
            try {
              rawJson = JSON.parse(cleaned)
            } catch {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: `Model did not return valid JSON: ${cleaned.slice(0, 300)}`,
                }),
              )
              return
            }

            const messages = normalizeMessages(rawJson)

            if (process.env.A2UI_DEBUG === '1') {
              console.log('[a2ui-debug] raw:', cleaned.slice(0, 600))
              console.log('[a2ui-debug] normalized:', JSON.stringify(messages).slice(0, 600))
            }

            if (messages.length === 0) {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: 'Model returned no usable A2UI messages.',
                }),
              )
              return
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ messages }))
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: errorMessage }))
          }
        })
      })
    },
  }
}
