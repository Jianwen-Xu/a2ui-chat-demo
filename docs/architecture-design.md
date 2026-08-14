# AI Conversational SaaS Architecture Design (React + A2UI + Azure)

> Version: v1.0 · Status: Design Draft
> Scope: SaaS applications whose core interaction model is AI-agent-driven conversational UI (A2UI)
> Worked example: online food-ordering system (consumer ordering + merchant fulfillment)
> Note: This document describes **generic design patterns**. Every section first states the general principle, then uses the food-ordering system as a concrete instantiation.

---

## Table of Contents

1. [Background & Design Goals](#1-background--design-goals)
2. [Core Concepts](#2-core-concepts)
3. [Overall Architecture](#3-overall-architecture)
4. [Architecture Decision Records (ADR Summary)](#4-architecture-decision-records-adr-summary)
5. [Frontend Layer Design (React + A2UI Renderer)](#5-frontend-layer-design-react--a2ui-renderer)
6. [Agent Layer Design](#6-agent-layer-design)
7. [Transport Layer Design](#7-transport-layer-design)
8. [Business Service Layer Design](#8-business-service-layer-design)
9. [Data Layer Design](#9-data-layer-design)
10. [Multi-tenant SaaS Design](#10-multi-tenant-saas-design)
11. [Azure Deployment Architecture](#11-azure-deployment-architecture)
12. [Security Design](#12-security-design)
13. [Observability & Operations](#13-observability--operations)
14. [Evolution Roadmap](#14-evolution-roadmap)
15. [Appendix A: Catalog Design Patterns](#appendix-acatalog-design-patterns)
16. [Appendix B: Food-Ordering Message Flow Example](#appendix-bfood-ordering-message-flow-example)

---

## 1. Background & Design Goals

### 1.1 Background

Traditional SaaS interaction is built from **pre-authored page flows** (form → validation → submit → result page). When business processes are complex (multi-step, multi-branch, personalized), the number of pages explodes, maintenance cost grows, and long-tail requirements cannot be covered.

A2UI (Agent-to-User Interface) changes this paradigm: **the AI Agent generates UI definitions (JSON messages) in real time based on user intent and business context, and the frontend renders from those messages**. UI shifts from "hard-coded pages" to "agent-generated results".

### 1.2 Design Goals

| Goal | Description |
|---|---|
| **Generality** | The architectural patterns here apply to any "conversational + form-based" hybrid business, not bound to a specific industry |
| **Determinism first** | The LLM is only responsible for intent understanding and UI generation; deterministic logic such as pricing, inventory, and payments never enters the LLM |
| **Evolvable** | Start single-tenant with a monolithic agent, evolve toward multi-tenant and multi-agent orchestration |
| **Observable** | End-to-end tracing and evaluation (LLM output quality, UI generation latency) from the first line of code |
| **Secure by default** | Agent output is treated as untrusted input; secrets are managed; tenant isolation |

### 1.3 Non-Goals (out of scope for now)

- Complex multi-agent orchestration (planning, reflection, multi-role) — later phase
- Cross-tenant federated data analytics
- Offline / low-connectivity mode

---

## 2. Core Concepts

### 2.1 A2UI Protocol (v0.9)

A2UI defines a set of JSON messages describing "how the UI should be presented". Key message types:

| Message | Purpose | Typical Trigger |
|---|---|---|
| `createSurface` | Create a rendering region (surface) | Agent's first response |
| `updateComponents` | Define/update the component tree | Every UI change |
| `updateComponentProperties` | Incrementally update a single component's props | State change (e.g. order status) |
| `updateDataModel` | Update the data model (components reference it via path bindings) | Data change |
| `deleteComponents` / `deleteSurface` | Cleanup | Session end |

**Key design**: component props reference the data model through **path bindings** (`{"path": "/order/status"}`), achieving **data/UI decoupling** — when data updates, the UI responds automatically.

### 2.2 Catalog — The Core Contract

The Catalog is the **whitelist contract** of "which UI components the agent is allowed to generate". It contains:

- **Component Schemas** (Zod/JSON Schema): component name + property type constraints, in strict mode (`.strict()`)
- **Functions**: server-side functions the agent may call (e.g. `getMenu`, `createOrder`)

> **Core insight**: UI contract = tool contract. The same Schema constrains both "what UI components the agent can generate" and "what tools the agent can call". This is what distinguishes A2UI from ordinary UI frameworks.

### 2.3 Surface (Rendering Region)

A surface is an independently rendered UI region identified by a string ID. Multi-surface support enables:

- Multiple regions on the same page (consumer panel + merchant panel)
- Multiple windows / devices (separate surfaces for web and mobile)

### 2.4 Action (User Action Callback)

User interaction with generated UI (button clicks, form submits) produces an `action`, captured by the `actionHandler` and sent back to the agent, triggering the next round of generation. **This is the key to the bidirectional loop.**

---

## 3. Overall Architecture

### 3.1 Layered View

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Client Layer (Browser)                        │
│   React SPA                                                          │
│   ├─ A2UI Renderer (@a2ui/react): renders agent-generated UI         │
│   └─ Business pages (Auth / Payment / Settings): deterministic UI    │
│      still uses regular React routing                                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTPS (WebSocket/SSE streaming)
┌──────────────────────────────▼───────────────────────────────────────┐
│                        Edge Layer                                    │
│   Azure Front Door (CDN + WAF)                                       │
│   Azure API Management (gateway: routing/rate-limit/subscription     │
│   auth/metering)                                                     │
└──────────────┬──────────────────────────────┬────────────────────────┘
               │ A2A / SSE                    │ REST
┌──────────────▼───────────────┐   ┌──────────▼────────────────────────┐
│  Agent Service               │   │  Business API Service             │
│  (Container Apps)            │   │  (Container Apps)                 │
│  - Session management        │   │  - Domain CRUD (deterministic)    │
│    (context + state)         │   │  - Order/inventory/payment state  │
│  - Tool calling              │   │    machine                         │
│  - A2UI message generation   │   │  - Payment callback verification  │
│  - Catalog contract (schema) │   │                                    │
└──────────────┬───────────────┘   └──────────┬────────────────────────┘
               │ event subscription (Service  │ event publishing
               │ Bus)                         │
┌──────────────▼──────────────────────────────▼────────────────────────┐
│                        Message Layer                                 │
│   Azure Service Bus / Event Grid                                     │
│   Domain events: order.created / order.paid / order.accepted / ...    │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│                        Data Layer                                    │
│   PostgreSQL: orders/users/menus/merchants (relational, strong       │
│   consistency)                                                       │
│   Redis: session context/cart/idempotency locks/real-time state      │
│   Cosmos DB (optional): event sourcing/audit/recommendation features │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│                        Platform Layer                                │
│   LLM: Azure OpenAI or Gemini (through the gateway)                  │
│   Identity: Azure AD B2C (consumers) + Entra ID (merchant staff)     │
│   Secrets: Key Vault | Observability: App Insights + Log Analytics   │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 Primary Request Flow (One Conversational Interaction)

```
user input ──► Front Door ──► APIM ──► Agent Service
              │
              │ 1. load session context (from Redis)
              │ 2. call tool (getMenu → business service)
              │ 3. LLM generates A2UI messages (constrained by Catalog schema)
              ▼
        SSE streaming response: createSurface → updateComponents → updateDataModel
              │
              ▼
        Frontend A2UI Renderer renders ──► user interaction
              │
              └──► action callback ──► Agent ──► call tool (createOrder) ──► business service
                      ──► generate next UI round ──► frontend
```

---

## 4. Architecture Decision Records (ADR Summary)

| # | Decision | Rationale | Alternatives |
|---|---|---|---|
| ADR-1 | **A2UI renders only conversational UI**; login/payment/admin shells use regular React | Agent-generated UI has latency and uncertainty; unsuitable for pages with strict determinism and high security requirements | Everything in A2UI (rejected: payment pages must not be LLM-generated) |
| ADR-2 | **Agent deployed independently** (no frontend-to-LLM direct calls) | Tool calling, session management, auditing, and key security require a server | Frontend direct + proxy (fine for POC, not production) |
| ADR-3 | **Deterministic logic in the business service; LLM does intent + UI only** | Pricing/inventory/payment errors are unacceptable; LLM offers no guarantees | LLM computes prices (rejected: hallucination risk) |
| ADR-4 | **Catalog stays small and focused (6–10 components to start)** | LLMs are more stable in smaller action spaces | Big and complete (rejected: poor generation quality) |
| ADR-5 | **Transport: A2A + SSE to start, event-driven for realtime** | Officially recommended and simple to implement; realtime state via event push | Full-duplex WebSocket (can evolve later) |
| ADR-6 | **Agent service in Python ADK + official a2ui-agent-sdk** | The SDK compiles Catalog schemas into the prompt and validates output, solving LLM output drift | Hand-written prompt + normalize layer (validated in our demo; usable as fallback) |
| ADR-7 | **Single-tenant to start, but tenant_id in the schema from day one** | Multi-tenancy can be deferred without reworking the data model | Purely single-tenant (rejected: SaaS must evolve) |
| ADR-8 | **Shared agent instance + tenant context injection** | Low cost, sufficient to start | Per-tenant instances (on demand at scale) |

---

## 5. Frontend Layer Design (React + A2UI Renderer)

### 5.1 Responsibility Boundaries

| Layer | Content | Technology |
|---|---|---|
| App shell | Layout, navigation, theme, routing | React Router |
| Deterministic pages | Login, payment, account settings | Regular React components |
| **Conversational UI** | Conversational ordering, recommendations, confirmations, tracking | **A2UI Renderer** |
| Bridge layer | Transport client + MessageProcessor lifecycle | `@a2ui/react` + `@a2ui/web_core` |

### 5.2 A2UI Integration Pattern (Generic Template)

```tsx
// A2UIProvider.tsx — generic wrapper, business-agnostic
export function A2UIProvider({ catalog, transport, children }) {
  const processor = useMemo(
    () => new MessageProcessor([catalog], (action) => transport.sendAction(action)),
    [catalog, transport]
  );

  // Listen to surface lifecycle, sync into React state
  const [surfaces, setSurfaces] = useState(() => [...processor.model.surfacesMap.values()]);
  useEffect(() => {
    const sync = () => setSurfaces([...processor.model.surfacesMap.values()]);
    const s1 = processor.onSurfaceCreated(sync);
    const s2 = processor.onSurfaceDeleted(sync);
    return () => { s1.unsubscribe(); s2.unsubscribe(); };
  }, [processor]);

  // Subscribe to the transport message stream, feed the processor
  useEffect(() => transport.onMessages((msgs) => processor.processMessages(msgs)), [processor]);

  return (
    <A2UIContext.Provider value={{ processor, surfaces }}>
      {children}
    </A2UIContext.Provider>
  );
}

// Usage
<div className="chat-surface">
  {surfaces.map((s) => <A2uiSurface key={s.id} surface={s} />)}
</div>
```

**Key points**:
- Hold a single `MessageProcessor` instance to avoid recreation
- `actionHandler` uniformly routes through the transport
- Multi-surface rendering via a `<A2uiSurface surface={s}>` list

### 5.3 Multi-Surface Strategy (Generic)

| Scenario | Approach |
|---|---|
| Multiple regions on one page (consumer dashboard + status panel) | Multiple `<A2uiSurface>` on the same page |
| Two ends (C-end ordering / B-end fulfillment) | Separate routes/apps, each with its own surface |
| Multi-device sync | surfaceId includes a deviceId dimension |

### 5.4 Frontend Fallbacks

- Agent unresponsive / timeout → show a degraded notice ("assistant temporarily unavailable")
- Message validation failure → keep the last valid UI + log the error (observability)
- Network disconnect → queue unsent actions, replay after reconnect

---

## 6. Agent Layer Design

### 6.1 Generic Agent Loop (Tool Loop)

```
receive user message / action
  │
  ├─ 1. load session context (Redis)
  ├─ 2. LLM inference (system prompt includes Catalog schema + business rules)
  ├─ 3. if tools needed → call (getMenu/createOrder/...)
  │        → feed tool results back into the prompt → infer again
  │          (loop, capped at N iterations)
  ├─ 4. generate A2UI message stream (createSurface/updateComponents/updateDataModel)
  ├─ 5. stream to the frontend
  └─ 6. persist session context
```

### 6.2 Session State Design

| State | Storage | Description |
|---|---|---|
| Conversation history (truncated) | Redis (TTL) | For LLM context; summarize-compress when beyond the window |
| Business draft state (cart/form drafts) | Redis | Structured, readable by the business service |
| Idempotency keys | Redis | Prevent duplicate orders/payments |
| Session metadata (tenant/user/device) | Redis + JWT claims | Context injection |

**Context compaction strategy**: when a conversation grows too long, use the LLM to compress older turns into a summary (retaining: selected dishes, confirmed information, user preferences).

### 6.3 Catalog/Tool Consistency (Core Design)

Each business capability = one pair of definitions:

```ts
// 1. UI component schema (Zod, strict mode)
const DishCardApi = {
  name: 'DishCard',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    imageUrl: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).strict(),
};

// 2. Server-side tool (operations in the same domain)
const getMenuTool = {
  name: 'getMenu',
  schema: z.object({
    query: z.string().optional(),      // keyword/cuisine
    category: z.string().optional(),
    limit: z.number().default(10),
  }),
  handler: async (args, ctx) => businessService.getMenu(args, ctx.tenantId),
};
```

**Design rules**:
1. **Components present, tools operate** — UI components never mutate business data directly; they go through action → tool
2. **Schema consistent across frontend/backend** — the same definition: the agent knows the fields when generating UI, the frontend validates with the same schema
3. **Tool return value = data model** — the array returned by `getMenu` becomes the `updateDataModel` value directly; components bind with `{"path": "/dishes"}`
4. **Every component gets an "intent description"** (describe field) to help the LLM pick correctly

### 6.4 LLM Output Safeguards (Three Defensive Layers)

| Layer | Mechanism | Owner |
|---|---|---|
| 1. Prompt constraint | Catalog schema + full examples compiled into the system prompt | `a2ui-agent-sdk`'s `DirectJsonFormat` (recommended) or hand-written prompt |
| 2. Output validation | Messages validated against the schema; one retry with error feedback on failure | Agent service |
| 3. Normalization fallback | Repair protocol variants (type/op/action mixing, props nesting, field aliases, invalid enums) | Normalize layer (pattern validated in our demo, see `middleware/normalize.ts`) |

---

## 7. Transport Layer Design

### 7.1 Options Comparison

| Option | Pros | Cons | Fit |
|---|---|---|---|
| **A2A + SSE** (recommended to start) | Official support, message encapsulation, auth extensions, streaming | Mostly one-way; events needed for bidirectional | Most scenarios |
| WebSocket | Truly bidirectional, low latency | Custom protocol, connection management cost | Real-time collaboration / multi-end sync |
| AG-UI | CopilotKit full-stack hosting | Tied to the CopilotKit ecosystem | Teams already using CopilotKit |

### 7.2 Recommended Combination

```
Primary channel: A2A (POST /a2a + SSE streaming)
  frontend ──A2A request──► Agent ──SSE stream (A2UI messages)──► frontend

Realtime supplement: Service Bus events → Agent subscription → proactive push of updateComponents
  business service ──order.paid──► Service Bus ──► Agent ──► frontend (status card update)
```

### 7.3 Message Format Conventions

- Streaming: JSONL (one A2UI message per line) or SSE `data:` frames
- Every message carries `version: "v0.9"`; `surfaceId` stays consistent across the whole chain
- Action callback: `{ version, action: { event: { name, context } } }`

---

## 8. Business Service Layer Design

### 8.1 Principle: The LLM/Deterministic-Logic Boundary

```
┌─────────────────────────────┐   ┌──────────────────────────────┐
│  Agent Layer (LLM decides)  │   │  Business Service Layer      │
│                             │   │  (code decides)              │
│  - understand user intent   │   │  - price calculation         │
│  - choose tool/component    │──►│  - inventory deduction (txn) │
│  - orchestrate UI          │   │  - order state machine       │
│  - generate A2UI messages   │   │  - payment callback verify   │
└─────────────────────────────┘   │    (signature)               │
                                  │  - permission checks         │
                                  └──────────────────────────────┘
```

### 8.2 Business API Inventory (Generic Partitioning)

| Category | Examples | Description |
|---|---|---|
| Query APIs | `GET /menu`, `GET /orders/:id` | For tool calls |
| Command APIs | `POST /orders`, `PATCH /orders/:id/status` | For tool calls, idempotent |
| Callback APIs | `POST /payments/webhook` | External system callbacks, signature-verified |
| Admin APIs | Merchant-side menu/inventory management | For the regular frontend |

### 8.3 Idempotency & Consistency

- Command APIs require an idempotency key (`Idempotency-Key`), stored in Redis
- Inventory deduction: optimistic locking / row locking + transactions
- Payment and orders: state machine + event-driven compensation

---

## 9. Data Layer Design

### 9.1 Data Model (Generic ER Concepts)

```
Tenant 1──N User 1──N Order
                        │
                        ├── OrderItem ── Dish (product)
                        └── Payment

Order: id, tenantId, userId, status(state machine), items[], totalAmount,
        currency, address, timestamps
```

### 9.2 Storage Selection (Generic)

| Data | Storage | Rationale |
|---|---|---|
| Core business (orders/users/products) | PostgreSQL | Transactions, strong consistency, SQL queries |
| Sessions/drafts/idempotency | Redis | Low latency, TTL |
| Event sourcing/audit (optional) | Cosmos DB / event tables | Replayable, compliance |
| Full-text search (menus/products) | PostgreSQL FTS / Azure AI Search | FTS is enough to start |

### 9.3 Event-Driven

```
Order state machine: pending → paid → accepted → preparing → out_for_delivery → delivered
                             ↘ cancelled / refunded

Each state transition publishes a domain event (Service Bus):
  order.paid ──► triggers Agent to push "pending payment → preparing" status card update
  order.accepted ──► merchant-side surface update
```

**Pattern**: dual-write to an event table (inside PostgreSQL) + bus publishing (Outbox pattern) to guarantee no lost events.

---

## 10. Multi-tenant SaaS Design

### 10.1 Tenant Model

| Dimension | Decision |
|---|---|
| Isolation granularity | Start: shared database + `tenant_id` column + PostgreSQL RLS; optional dedicated schema for large tenants |
| Agent instances | Shared instance + tenant context injection (start); dedicated instances for high-value tenants (later) |
| Data access | Every query enforces `WHERE tenant_id = ?` (RLS as backstop) |
| Identity | One B2C tenant configuration / custom domain per tenant |

### 10.2 Tenant Context Propagation Through A2UI

```
Frontend request header: Authorization: Bearer <JWT> (with tenantId claim)
    │
Agent service: parse JWT → ctx.tenantId → inject into all tool calls
    │
Catalog runtime: data needed to render components (menu/pricing/rules) queried by tenantId
```

### 10.3 Metering & Rate Limiting

- APIM rate-limits by subscription (tenant)
- LLM token usage metered per tenant (cost allocation)
- Session count/concurrency limits to prevent abuse

---

## 11. Azure Deployment Architecture

### 11.1 Service Mapping

| Need | Azure Service | Notes |
|---|---|---|
| Frontend hosting | Azure Static Web Apps / Container Apps + Front Door | SWA for pure frontend; CA for SSR |
| Agent service | Azure Container Apps | Start here; AKS at scale |
| Business APIs | Azure Container Apps | Deployed separately from the agent |
| Gateway | Azure API Management | Routing/rate-limit/subscription/metering |
| CDN/WAF | Azure Front Door | Global acceleration + security |
| LLM | Azure OpenAI (GPT-4o family) or Gemini | Through the gateway, model-swappable |
| Relational DB | Azure Database for PostgreSQL Flexible | Primary data |
| Cache | Azure Cache for Redis | Sessions/idempotency |
| Messaging | Azure Service Bus + Event Grid | Domain events |
| Identity | Azure AD B2C + Entra ID | Consumers/employees |
| Secrets | Azure Key Vault + managed identity | No plaintext keys |
| Observability | Application Insights + Log Analytics | End-to-end |
| Log archiving | Azure Storage (cold) | Compliance |

### 11.2 Deployment Topology (by Environment)

```
dev ──► single Container App + shared resources (minimal cost)
staging ──► separate CA + separate Redis/DB (approximates production)
prod ──► Front Door + APIM + multi-replica CA + HA DB/Redis
```

### 11.3 Scaling & Resilience

- Agent service: stateless (sessions in Redis) → horizontal scaling; LLM calls are rate-limited, requiring a local queue/backoff
- Cold start: Container Apps min instances ≥ 1; pre-warm prompt/model connections
- Regions: Front Door multi-region; start single-region + disaster-recovery plan

---

## 12. Security Design

### 12.1 Threat Model (A2UI-Specific)

| Threat | Scenario | Mitigation |
|---|---|---|
| **Prompt Injection** | User message injects instructions, causing the agent to leak other tenants' data or perform dangerous actions | Tool-layer permission checks; treat agent output and tool results as untrusted; strictly separate system instructions from user input |
| **Malicious UI (XSS)** | Agent generates components with malicious props (e.g. `<img onerror>`, forged links) | Renderer sandbox; strict CSP; Catalog schema whitelist (tags outside the components are not rendered) |
| **UI Denial of Service** | Agent generates an oversized component tree / infinite loops | Catalog limits on component count and nesting depth; message size limits |
| **Data Leakage** | Tools return data beyond the tenant's scope | Enforce tenantId at the tool layer; RLS as backstop |
| **Secret Leakage** | LLM key / DB credentials | Key Vault + managed identity; forbid frontend-to-LLM direct calls |

### 12.2 Security Baseline (Generic Checklist)

- [ ] HTTPS + HSTS on frontend/backend; strict CSP (no inline scripts)
- [ ] Frontend never holds LLM/DB keys
- [ ] Agent output is schema-validated before rendering
- [ ] Every tool call carries tenant+user context; permission checks in the business service
- [ ] Payment callbacks signature-verified; idempotency prevents replay
- [ ] Audit logging (who asked the agent to do what, when)
- [ ] APIM rate limiting + Front Door WAF

---

## 13. Observability & Operations

### 13.1 End-to-End Tracing

```
frontend (browser) ──► APIM ──► Agent ──► tool calls ──► business service ──► LLM
     └──────────────── one traceId across the whole chain ────────────────┘
```

### 13.2 Key Metrics

| Category | Metrics |
|---|---|
| Experience | Time-to-first-UI (TTFU), streaming completion latency, action-callback→UI-update latency |
| Quality | LLM output schema validation failure rate, tool-call failure rate, user retry rate |
| Cost | Token usage (per tenant/session), LLM calls per session |
| Business | Session conversion rate (conversation→order), average order value, agent intervention rate |

### 13.3 LLM Evaluation (Required for Production)

- **Offline eval set**: typical user requests + expected A2UI output (component correctness, data-binding correctness)
- **Online sampling**: randomly sample sessions; human/LLM review of UI quality
- **Regression gate**: Catalog schema changes must pass the eval set

---

## 14. Evolution Roadmap

| Phase | Content | Key Outcome |
|---|---|---|
| **Phase 0 (POC)** | Frontend direct-to-LLM + normalize layer (already done in our demo) | Validate the A2UI render loop |
| **Phase 1 (MVP)** | Agent service deployed independently (ADK + a2ui-agent-sdk) + A2A/SSE + business service (order/payment stubs) | Real conversational ordering loop |
| **Phase 2 (Multi-tenant)** | tenant_id + RLS + B2C multi-tenant + APIM metering | SaaS-ification |
| **Phase 3 (Scale)** | Multiple agents (fulfillment/recommendation/support) + AKS + multi-region | Elasticity & intelligence upgrade |
| **Phase 4 (Ecosystem)** | Open the Catalog so third-party tenants can define custom components | Platform-ization |

---

## Appendix A: Catalog Design Patterns

### A.1 Generic Rules for Component Design

1. **Components carry "presentation + light interaction" only**; business side effects go through action → tool
2. **All data flows through path bindings**, never inline business values (`{"path": "/order/total"}` instead of `128`)
3. **Strict schema**, few fields with clear semantics (LLM usability degrades as field count grows)
4. **Every component gets a describe** (when to use, how to use) — it is the LLM's "component documentation"

### A.2 Starter Component Set (Generic Recommendation, 6–10)

| Component | Purpose | Key props |
|---|---|---|
| `Text` | Text/rich text | text, variant |
| `Button` | Trigger actions | child, variant, action |
| `Form` (composite) | Collect input | TextField/ChoicePicker/DateTimeInput |
| `List` | List display (bindable to arrays) | children / path template |
| `Card` | Grouping container | child |
| `StatusCard` | Status display (order/task) | status, steps[] |
| `ConfirmDialog` | Confirm actions | trigger, content, action |

### A.3 Deriving a Catalog from an Existing Design System (Methodology)

```
existing components (React) ──► 1. select components "suitable for agent
                                    generation" (clear props contracts)
                            ──► 2. write a Zod schema (strict) + describe
                                    for each
                            ──► 3. define companion tools (business ops
                                    for that component)
                            ──► 4. register into the catalog:
                                    createComponentImplementation(api, render)
                            ──► 5. compile schemas into the prompt with the
                                    official a2ui-agent-sdk
                            ──► 6. run the eval set to verify the LLM uses
                                    them correctly
```

---

## Appendix B: Food-Ordering Message Flow Example

### B.1 Session Start: User Expresses Intent

**User**: `Order a seafood pizza, delivery in 30 minutes`

**Agent processing**:
1. Call `getMenu(query: "seafood pizza")` → returns candidate dishes
2. Call `calcDeliveryFee(distance)` → pricing
3. Generate the A2UI message stream:

```json
[
  { "version": "v0.9", "createSurface": { "surfaceId": "order-flow", "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json" } },

  { "version": "v0.9", "updateComponents": {
    "surfaceId": "order-flow",
    "components": [
      { "id": "root", "component": "Column", "children": ["menu-list", "checkout-form"] },
      { "id": "menu-list", "component": "List", "componentId": "dish-card", "path": "/dishes" },
      { "id": "dish-card", "component": "DishCard", "name": {"path": "/name"}, "price": {"path": "/price"}, "imageUrl": {"path": "/imageUrl"} },
      { "id": "checkout-form", "component": "Column", "children": ["address-input", "time-input", "confirm-btn"] },
      { "id": "address-input", "component": "TextField", "label": "Delivery address", "value": {"path": "/address"} },
      { "id": "time-input", "component": "DateTimeInput", "label": "Delivery time", "value": {"path": "/deliveryTime"} },
      { "id": "confirm-btn", "component": "Button", "child": "confirm-label", "variant": "primary",
        "action": { "event": { "name": "confirmOrder", "context": { "items": {"path": "/selectedDishes"} } } } },
      { "id": "confirm-label", "component": "Text", "text": "Confirm order" }
    ]
  } },

  { "version": "v0.9", "updateDataModel": {
    "surfaceId": "order-flow", "path": "/",
    "value": {
      "dishes": [ { "name": "Seafood Pizza", "price": 88, "imageUrl": "..." } ],
      "address": "", "deliveryTime": "in 30 minutes", "selectedDishes": []
    }
  } }
]
```

### B.2 User Confirms → Place Order

**User action**: click "Confirm order" → `action: { event: { name: "confirmOrder", context: { items: [...] } } }`

**Agent processing**:
1. Call `createOrder(items, address, userId, tenantId)` → business service deducts inventory, creates the order → returns `orderId` + amount due
2. Call `initiatePayment(orderId)` → returns the payment URL
3. Generate the next UI round:

```json
{ "version": "v0.9", "updateComponents": {
  "surfaceId": "order-flow",
  "components": [
    { "id": "order-card", "component": "StatusCard", "status": "pending_payment", "steps": ["Pending payment","Preparing","Delivering","Delivered"] },
    { "id": "pay-btn", "component": "Button", "child": "pay-label", "variant": "primary",
      "action": { "functionCall": { "call": "openUrl", "args": { "url": {"path": "/payUrl"} } } } }
  ]
} },
{ "version": "v0.9", "updateDataModel": { "surfaceId": "order-flow", "path": "/", "value": { "orderId": "ORD-20250101-001", "payUrl": "https://pay.example.com/..." } } }
```

### B.3 Real-time Status Updates (Event-Driven)

```
payment success ──► business service publishes order.paid ──► Service Bus ──► Agent subscription
    ──► Agent pushes: updateComponentProperties { componentId: "order-card", props: { status: "preparing" } }
    ──► frontend updates the status card automatically (reactive data binding)
```

---

## Appendix: Document Maintenance

- This document evolves with the architecture; major changes go through ADR records
- The Catalog component list is a **living document**; keep it in sync with the schemas in code (can be generated from code with a script)
