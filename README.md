# a2ui-chat-demo — A2UI React Demo

> **English** | [中文 (Chinese)](README.zh-CN.md)

A React 19 + TypeScript + Vite project that renders [A2UI](https://a2ui.org/) (Agent-to-User Interface) generated UI, powered by the Gemini API as a real message source.

## Tech Stack

- [Vite](https://vite.dev/) 8 + React 19 + TypeScript
- [@a2ui/react](https://www.npmjs.com/package/@a2ui/react) — A2UI React renderer
- [@a2ui/web_core](https://github.com/a2ui-project/a2ui) — A2UI core (message processing)
- [Gemini API](https://ai.google.dev/gemini-api/docs) (`gemini-3.7-flash`, configurable)
- Package manager: [pnpm](https://pnpm.io/)

## Quick Start

```bash
# 1. Configure your Gemini API key (free: https://aistudio.google.com/apikey)
cp .env.example .env
# Edit .env and fill in GEMINI_API_KEY

# 2. Install and start
pnpm install
pnpm dev        # http://localhost:5173
```

Type a description of the UI you want in the input box (e.g. "create a signup form with name, email fields, a terms checkbox, and a submit button"), and Gemini will generate A2UI protocol messages rendered live.

```bash
pnpm build      # Type-check + production build
pnpm preview    # Preview the production build
```

## Architecture

```
Browser (React) ──POST /api/gemini──> Vite dev middleware ──> Gemini API
      │                                      │
      │<────────── A2UI messages ────────────┘
      │
      ▼
MessageProcessor (@a2ui/web_core) → <A2uiSurface> render
```

- `middleware/gemini.ts` — Vite dev middleware that proxies Gemini requests; the **API key stays server-side** and is never exposed to the browser. Supports automatic **model failover**: if the primary model returns 429 (quota) or 503 (overload), it tries fallback models in order.
- `middleware/normalize.ts` — **LLM output normalization layer**: Gemini's A2UI output frequently deviates from the spec (`type`/`op`/`action` message variants, `props` nesting, `componentName` fields, invalid enums, `checked`→`value`, Button `label`→Text child, etc.). This layer repairs it into standard v0.9 protocol messages.
- `src/a2uiPrompt.ts` — The system prompt that steers Gemini toward valid A2UI messages (full component schema + worked example).
- `src/App.tsx` — Chat input + `MessageProcessor` + `<A2uiSurface>` rendering, with client-side dedupe of repeated `createSurface` messages for multi-turn conversations.

## How It Works

1. Create a `MessageProcessor` (`@a2ui/web_core/v0_9`) and register `basicCatalog`
2. Subscribe to `onSurfaceCreated` / `onSurfaceDeleted` to sync the surface list into React state
3. User input → `/api/gemini` → Gemini generates A2UI messages → normalized → `processor.processMessages(...)`
4. Render every surface with `<A2uiSurface surface={...} />` (`@a2ui/react/v0_9`)

## Architecture Design (Production SaaS)

This demo is a POC of a larger pattern: **AI-agent-driven conversational SaaS on Azure**. The full design document is at [`docs/architecture-design.md`](docs/architecture-design.md) — a generic, business-agnostic blueprint (food-ordering used as the worked example). Highlights:

### Layered Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       Client Layer (Browser)                       │
│  React SPA: A2UI Renderer (conversational UI)                      │
│            + regular React routes (auth / payment / settings)      │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ HTTPS (A2A/SSE/WebSocket streaming)
┌──────────────────────────────▼─────────────────────────────────────┐
│                       Edge Layer                                   │
│  Azure Front Door (CDN + WAF) + API Management (gateway/rate-limit)│
└──────────────┬──────────────────────────────┬──────────────────────┘
               │ A2A / SSE                    │ REST
┌──────────────▼───────────────┐   ┌──────────▼──────────────────────┐
│  Agent Service               │   │  Business API Service           │
│  - session mgmt (Redis)      │   │  - deterministic domain logic   │
│  - tool calling              │   │  - order/inventory/payment      │
│  - A2UI message generation   │   │    state machines               │
│  - Catalog contract (schema) │   │  - payment callback validation  │
└──────────────┬───────────────┘   └──────────┬──────────────────────┘
               │ events (Service Bus / Event Grid)
┌──────────────▼──────────────────────────────▼──────────────────────┐
│                       Data Layer                                  │
│  PostgreSQL (orders/users/menus) + Redis (sessions/cart/idempotency)│
└──────────────────────────────┬─────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────┐
│                       Platform Layer                               │
│  LLM (Azure OpenAI / Gemini) · Identity (B2C + Entra ID)           │
│  Key Vault · App Insights / Log Analytics                          │
└────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions (summary)

| # | Decision |
|---|---|
| 1 | **A2UI renders only conversational UI**; auth/payment/settings stay in regular React |
| 2 | **Agent deployed independently** (never frontend-to-LLM direct calls in production) |
| 3 | **Deterministic logic never enters the LLM** — pricing/inventory/payments live in the business service |
| 4 | **Catalog is the contract**: a small, strict Zod-schema component whitelist (6–10 components to start) |
| 5 | **Transport: A2A + SSE to start**, event-driven (Service Bus) for realtime status pushes |
| 6 | **Multi-tenant from day one**: `tenant_id` in every schema, shared agent + tenant context injection |

### A2UI Message Flow (worked example)

```
User: "Order a seafood pizza, delivery in 30 minutes"
  │
  ▼
Agent: getMenu("seafood pizza") → calcDeliveryFee → generate A2UI stream
  │  createSurface → updateComponents (dish cards + checkout form)
  │  → updateDataModel (dishes, total, delivery time)
  ▼
Frontend renders → user taps "Confirm order"
  │  action callback ──► Agent
  ▼
Agent: createOrder(...) → initiatePayment(...) → next UI round (status card + pay button)
  │
  ▼
order.paid event (Service Bus) ──► Agent pushes updateComponentProperties
  ──► status card updates reactively
```

See the full document for Catalog design patterns, security threat model (prompt injection / malicious UI), Azure service mapping, observability, and the evolution roadmap.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Required. Your Gemini API key |
| `GEMINI_MODEL` | `gemini-3.7-flash` | Primary model |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite,gemini-flash-latest` | Comma-separated models tried in order when the primary returns 429/503 |
| `A2UI_DEBUG` | — | Set to `1` to log raw/normalized messages server-side |

## Known Limitations

- The free Gemini tier is rate-limited (~20 requests/min); rapid testing may hit 429 — wait and retry
- The normalization layer covers common LLM output variants, but in edge cases the model may still produce unrenderable messages (the frontend shows an error)

## Protocol Version

Uses the A2UI **v0.9** protocol (recommended for new projects); all imports use the `*/v0_9` path.

## References

- [Architecture design document (production SaaS)](docs/architecture-design.md) — [中文版](docs/architecture-design.zh-CN.md)
- [A2UI official site](https://a2ui.org/)
- [React renderer README](https://github.com/a2ui-project/a2ui/blob/main/renderers/react/README.md)
- [Client Setup guide](https://a2ui.org/guides/client-setup/)
- [Gemini API docs](https://ai.google.dev/gemini-api/docs)
