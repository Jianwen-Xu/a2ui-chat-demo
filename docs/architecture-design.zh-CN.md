# AI 对话式 SaaS 架构设计文档（React + A2UI + Azure）

> 版本：v1.0 · 状态：设计稿
> 适用范围：以 AI Agent 驱动的对话式用户界面（A2UI）为核心交互形态的 SaaS 应用
> 贯穿示例：在线订餐系统（消费者点餐 + 商家接单）
> 说明：本文档是**通用设计模式**，所有章节先给出通用原则，再用订餐系统作为实例化说明。

---

## 目录

1. [背景与设计目标](#1-背景与设计目标)
2. [核心概念](#2-核心概念)
3. [总体架构](#3-总体架构)
4. [架构决策记录（ADR 摘要）](#4-架构决策记录adr-摘要)
5. [前端层设计（React + A2UI Renderer）](#5-前端层设计react--a2ui-renderer)
6. [Agent 层设计](#6-agent-层设计)
7. [传输层设计](#7-传输层设计)
8. [业务服务层设计](#8-业务服务层设计)
9. [数据层设计](#9-数据层设计)
10. [多租户 SaaS 设计](#10-多租户-saas-设计)
11. [Azure 部署架构](#11-azure-部署架构)
12. [安全设计](#12-安全设计)
13. [可观测性与运维](#13-可观测性与运维)
14. [演进路线](#14-演进路线)
15. [附录 A：Catalog 设计模式](#附录-acatalog-设计模式)
16. [附录 B：订餐系统消息流示例](#附录-b订餐系统消息流示例)

---

## 1. 背景与设计目标

### 1.1 背景

传统 SaaS 的交互是**预先编写好的页面流**（表单 → 校验 → 提交 → 结果页）。当业务流程复杂（多步骤、多条件分支、个性化）时，页面数量爆炸，维护成本高，且无法覆盖长尾需求。

A2UI（Agent-to-User Interface）改变了这一范式：**AI Agent 根据用户意图和业务上下文，实时生成 UI 定义（JSON 消息），前端按消息渲染**。UI 从"写死的页面"变成"Agent 生成的结果"。

### 1.2 设计目标

| 目标 | 说明 |
|---|---|
| **通用性** | 本文档描述的架构模式适用于任意"对话式 + 表单式"混合业务，不绑定具体行业 |
| **确定性优先** | LLM 只负责意图理解与 UI 生成；价格、库存、支付等确定性逻辑永不进入 LLM |
| **可演进** | 起步单租户 + 单体 Agent，逐步演进为多租户 + 多 Agent 编排 |
| **可观测** | 从第一行代码就有全链路追踪与评估（LLM 输出质量、UI 生成延迟） |
| **安全默认** | Agent 输出视为不可信输入；密钥托管；租户隔离 |

### 1.3 非目标（本期不做）

- 多 Agent 复杂编排（规划、反思、多角色）— 后期
- 跨租户数据联邦分析
- 离线 / 弱网模式

---

## 2. 核心概念

### 2.1 A2UI 协议（v0.9）

A2UI 定义了一组 JSON 消息，描述"UI 应该如何呈现"。关键消息类型：

| 消息 | 作用 | 典型触发 |
|---|---|---|
| `createSurface` | 创建一个渲染区域（surface） | Agent 首次响应 |
| `updateComponents` | 定义/更新组件树 | 每次 UI 变化 |
| `updateComponentProperties` | 增量更新单个组件的属性 | 状态变化（如订单状态） |
| `updateDataModel` | 更新数据模型（组件通过 path 绑定引用） | 数据变化 |
| `deleteComponents` / `deleteSurface` | 清理 | 会话结束 |

**关键设计**：组件属性通过 **path 绑定**（`{"path": "/order/status"}`）引用数据模型，实现**数据与 UI 解耦**——数据更新时 UI 自动响应。

### 2.2 Catalog（组件目录）—— 核心契约

Catalog 是"Agent 能生成哪些 UI 组件"的**白名单契约**，包含：

- **组件 Schema**（Zod/JSON Schema）：组件名 + 属性类型约束，严格模式（`.strict()`）
- **逻辑函数**（Functions）：Agent 可调用的服务端函数（如 `getMenu`、`createOrder`）

> **核心洞察**：UI 契约 = 工具契约。同一个 Schema 既约束"Agent 生成什么 UI 组件"，也约束"Agent 能调什么工具"。这是 A2UI 区别于普通 UI 框架的关键。

### 2.3 Surface（渲染区域）

一个 surface 是独立渲染的 UI 区域，由字符串 ID 标识。多 surface 支持：

- 同一页面多个区域（消费者面板 + 商家面板）
- 多窗口 / 多设备（Web + 移动端各自 surface）

### 2.4 Action（用户动作回传）

用户与生成的 UI 交互（点击按钮、提交表单）产生 `action`，通过 `actionHandler` 捕获并回传 Agent，触发下一轮生成。**这是双向闭环的关键**。

---

## 3. 总体架构

### 3.1 分层视图

```
┌──────────────────────────────────────────────────────────────────────┐
│                        客户端层 (Browser)                              │
│   React SPA                                                           │
│   ├─ A2UI Renderer（@a2ui/react）：渲染 Agent 生成的 UI               │
│   └─ 业务页面（Auth / 支付 / 设置）：确定性 UI 仍用常规 React 路由      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTPS（WebSocket/SSE 流式）
┌──────────────────────────────▼───────────────────────────────────────┐
│                        边缘层                                         │
│   Azure Front Door（CDN + WAF）                                       │
│   Azure API Management（网关：路由/限流/订阅鉴权/计量）                 │
└──────────────┬──────────────────────────────┬────────────────────────┘
               │ A2A / SSE                    │ REST
┌──────────────▼───────────────┐   ┌──────────▼────────────────────────┐
│  Agent 服务                   │   │  业务 API 服务                     │
│  (Container Apps)             │   │  (Container Apps)                 │
│  - 会话管理（上下文 + 状态）   │   │  - 领域 CRUD（确定性逻辑）          │
│  - 工具调用（Tool Calling）   │   │  - 订单/库存/支付状态机             │
│  - A2UI 消息生成              │   │  - 支付回调验证                    │
│  - Catalog 契约（schema）     │   │                                    │
└──────────────┬───────────────┘   └──────────┬────────────────────────┘
               │ 事件订阅（Service Bus）       │ 事件发布
┌──────────────▼──────────────────────────────▼────────────────────────┐
│                        消息层                                         │
│   Azure Service Bus / Event Grid                                      │
│   领域事件：order.created / order.paid / order.accepted / ...          │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│                        数据层                                         │
│   PostgreSQL：订单/用户/菜单/商家（关系数据，强一致）                   │
│   Redis：会话上下文/购物车/幂等锁/实时状态                              │
│   Cosmos DB（可选）：事件溯源/审计/推荐特征                            │
└──────────────┬───────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│                        平台层                                         │
│   LLM：Azure OpenAI 或 Gemini（经网关）                               │
│   身份：Azure AD B2C（消费者）+ Entra ID（商家员工）                    │
│   密钥：Key Vault | 可观测：App Insights + Log Analytics               │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 请求主链路（一次对话式交互）

```
用户输入 ──► Front Door ──► APIM ──► Agent 服务
              │
              │ 1. 会话上下文（Redis 取）
              │ 2. 调用工具（getMenu → 业务服务）
              │ 3. LLM 生成 A2UI 消息（Catalog schema 约束）
              ▼
        SSE 流式返回：createSurface → updateComponents → updateDataModel
              │
              ▼
        前端 A2UI Renderer 渲染 ──► 用户交互
              │
              └──► action 回传 ──► Agent ──► 调用工具（createOrder）──► 业务服务
                      ──► 生成下一轮 UI ──► 前端
```

---

## 4. 架构决策记录（ADR 摘要）

| # | 决策 | 理由 | 备选 |
|---|---|---|---|
| ADR-1 | **A2UI 只渲染会话 UI**；登录/支付/后台框架用常规 React | Agent 生成 UI 有延迟与不确定性，不适合承载强确定性、高安全要求的页面 | 全部 A2UI（否定：支付页等不可接受 LLM 生成） |
| ADR-2 | **Agent 独立部署**（不前端直连 LLM） | 工具调用、会话管理、审计、key 安全需要服务端 | 前端直连 + 代理（POC 可，生产否） |
| ADR-3 | **确定性逻辑在业务服务，LLM 只做意图+UI** | 价格/库存/支付错误不可接受，LLM 无保证 | LLM 直接算价（否定：幻觉风险） |
| ADR-4 | **Catalog 组件少而精（6-10 个起步）** | LLM 在越小的动作空间越稳定 | 大而全（否定：生成质量差） |
| ADR-5 | **传输层 A2A + SSE 起步，事件驱动补实时** | 官方推荐、实现简单；实时状态靠事件推送 | WebSocket 全双工（后期可演进） |
| ADR-6 | **Agent 服务用 Python ADK + 官方 a2ui-agent-sdk** | SDK 自动把 Catalog schema 编译进 prompt 并校验输出，解决 LLM 输出跑偏问题 | 手写 prompt + normalize 层（demo 已验证，可作兜底） |
| ADR-7 | **单租户起步，tenant_id 从第一天进入 schema** | 多租户后置但数据模型不返工 | 纯单租户（否定：SaaS 需可演进） |
| ADR-8 | **共享 Agent 实例 + 租户上下文注入** | 成本低，起步够用 | 每租户独立实例（规模后按需） |

---

## 5. 前端层设计（React + A2UI Renderer）

### 5.1 职责边界

| 层 | 内容 | 技术 |
|---|---|---|
| 页面骨架 | 布局、导航、主题、路由 | React Router |
| 确定性页面 | 登录、支付、账号设置 | 常规 React 组件 |
| **会话 UI** | 对话式订餐、推荐、确认、跟踪 | **A2UI Renderer** |
| 桥接层 | transport 客户端 + MessageProcessor 生命周期 | `@a2ui/react` + `@a2ui/web_core` |

### 5.2 A2UI 集成模式（通用模板）

```tsx
// A2UIProvider.tsx —— 通用封装，业务无关
export function A2UIProvider({ catalog, transport, children }) {
  const processor = useMemo(
    () => new MessageProcessor([catalog], (action) => transport.sendAction(action)),
    [catalog, transport]
  );

  // 监听 surface 生命周期，同步到 React 状态
  const [surfaces, setSurfaces] = useState(() => [...processor.model.surfacesMap.values()]);
  useEffect(() => {
    const sync = () => setSurfaces([...processor.model.surfacesMap.values()]);
    const s1 = processor.onSurfaceCreated(sync);
    const s2 = processor.onSurfaceDeleted(sync);
    return () => { s1.unsubscribe(); s2.unsubscribe(); };
  }, [processor]);

  // 订阅 transport 的消息流，喂给 processor
  useEffect(() => transport.onMessages((msgs) => processor.processMessages(msgs)), [processor]);

  return (
    <A2UIContext.Provider value={{ processor, surfaces }}>
      {children}
    </A2UIContext.Provider>
  );
}

// 使用
<div className="chat-surface">
  {surfaces.map((s) => <A2uiSurface key={s.id} surface={s} />)}
</div>
```

**要点**：
- `MessageProcessor` 单例持有，避免重复创建
- `actionHandler` 统一走 transport 回传
- 多 surface 用 `<A2uiSurface surface={s}>` 列表渲染

### 5.3 多 Surface 策略（通用）

| 场景 | 方案 |
|---|---|
| 同页多区域（消费者看板 + 状态面板） | 同页面多个 `<A2uiSurface>` |
| 双端（C 端订餐 / B 端接单） | 独立路由/应用，各自 surface |
| 多设备同步 | surfaceId 含 deviceId 维度 |

### 5.4 前端兜底

- Agent 无响应 / 超时 → 显示降级提示（"助手暂时不可用"）
- 消息校验失败 → 保留上一份有效 UI + 记录错误（可观测）
- 网络断开 → 队列未发送 action，重连后重放

---

## 6. Agent 层设计

### 6.1 通用 Agent 循环（Tool Loop）

```
接收用户消息 / action
  │
  ├─ 1. 加载会话上下文（Redis）
  ├─ 2. LLM 推理（system prompt 含 Catalog schema + 业务规则）
  ├─ 3. 若需要工具 → 调用（getMenu/createOrder/...）
  │        → 工具结果回填 prompt → 再次推理（循环，上限 N 次）
  ├─ 4. 生成 A2UI 消息流（createSurface/updateComponents/updateDataModel）
  ├─ 5. 流式推送给前端
  └─ 6. 持久化会话上下文
```

### 6.2 会话状态设计

| 状态 | 存储 | 说明 |
|---|---|---|
| 对话历史（截断后） | Redis（TTL） | 供 LLM 上下文；超过窗口做摘要压缩 |
| 业务草稿状态（购物车/表单草稿） | Redis | 结构化，业务服务可读 |
| 幂等键 | Redis | 防重复下单/重复支付 |
| 会话元数据（租户/用户/设备） | Redis + JWT claim | 上下文注入 |

**上下文压缩策略**：对话超长时，用 LLM 将旧对话压缩为摘要（保留：已选菜品、已确认信息、用户偏好）。

### 6.3 Catalog 与工具的一致性（核心设计）

每个业务能力 = 一对定义：

```ts
// 1. UI 组件 Schema（Zod，严格模式）
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

// 2. 服务端工具（同一领域的操作）
const getMenuTool = {
  name: 'getMenu',
  schema: z.object({
    query: z.string().optional(),      // 关键词/菜系
    category: z.string().optional(),
    limit: z.number().default(10),
  }),
  handler: async (args, ctx) => businessService.getMenu(args, ctx.tenantId),
};
```

**设计规则**：
1. **组件只展示，工具只操作**——UI 组件不直接改业务数据，通过 action → 工具完成
2. **Schema 前后端一致**——同一份定义，Agent 生成 UI 时知道字段，前端校验时用同一 schema
3. **工具返回值 = 数据模型**——`getMenu` 返回的数组直接作为 `updateDataModel` 的 value，组件用 `{"path": "/dishes"}` 绑定
4. **每个组件配一个"意图说明"**（describe 字段），帮助 LLM 正确选用

### 6.4 LLM 输出保障（三层防线）

| 层 | 手段 | 归属 |
|---|---|---|
| 1. Prompt 约束 | Catalog schema + 完整示例编译进 system prompt | `a2ui-agent-sdk` 的 `DirectJsonFormat`（推荐）或手写 prompt |
| 2. 输出校验 | 消息通过 Schema 校验，失败重试一次（带错误信息） | Agent 服务 |
| 3. 归一化兜底 | 修复协议变体（type/op/action 混用、props 嵌套、字段别名、非法枚举） | normalize 层（我们 demo 已验证的模式，见 `middleware/normalize.ts`） |

---

## 7. 传输层设计

### 7.1 选型对比

| 方案 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| **A2A + SSE**（推荐起步） | 官方支持、消息封装、鉴权扩展、流式 | 单向为主，双向需事件补 | 大多数场景 |
| WebSocket | 真双向、低延迟 | 自建协议、连接管理成本 | 实时协作/多端同步 |
| AG-UI | CopilotKit 全栈托管 | 绑定 CopilotKit 生态 | 已用 CopilotKit 的团队 |

### 7.2 推荐组合

```
主通道：A2A（POST /a2a + SSE 流式）
  前端 ──A2A 请求──► Agent ──SSE 流（A2UI 消息）──► 前端

实时补通道：Service Bus 事件 → Agent 订阅 → 主动推送 updateComponents
  业务服务 ──order.paid──► Service Bus ──► Agent ──► 前端（状态卡更新）
```

### 7.3 消息格式规范

- 流式：JSONL（每行一个 A2UI 消息）或 SSE `data:` 帧
- 每条消息带 `version: "v0.9"`，`surfaceId` 全链路一致
- action 回传：`{ version, action: { event: { name, context } } }`

---

## 8. 业务服务层设计

### 8.1 原则：LLM 与确定逻辑的边界

```
┌─────────────────────────────┐   ┌──────────────────────────────┐
│  Agent 层（LLM 决定）        │   │  业务服务层（代码决定）        │
│  - 理解用户意图              │   │  - 价格计算                  │
│  - 决定用哪个工具/组件        │──►│  - 库存扣减（事务）           │
│  - 编排 UI 呈现              │   │  - 订单状态机                │
│  - 生成 A2UI 消息            │   │  - 支付回调验证（签名）       │
└─────────────────────────────┘   │  - 权限校验                  │
                                  └──────────────────────────────┘
```

### 8.2 业务 API 清单（通用划分）

| 类别 | 示例 | 说明 |
|---|---|---|
| 查询 API | `GET /menu`、`GET /orders/:id` | 供工具调用 |
| 命令 API | `POST /orders`、`PATCH /orders/:id/status` | 供工具调用，幂等 |
| 回调 API | `POST /payments/webhook` | 外部系统回调，签名验证 |
| 管理 API | 商家端菜单/库存管理 | 供常规前端 |

### 8.3 幂等与一致性

- 命令 API 要求幂等键（`Idempotency-Key`），Redis 存储
- 库存扣减：乐观锁 / 行级锁 + 事务
- 支付与订单：状态机 + 事件驱动补偿

---

## 9. 数据层设计

### 9.1 数据模型（通用 ER 概念）

```
Tenant（租户）1──N User（用户）1──N Order（订单）
                                │
                                ├── OrderItem（订单项）── Dish（菜品/商品）
                                └── Payment（支付）

Order: id, tenantId, userId, status(状态机), items[], totalAmount,
        currency, address, timestamps
```

### 9.2 存储选型（通用）

| 数据 | 存储 | 理由 |
|---|---|---|
| 核心业务（订单/用户/商品） | PostgreSQL | 事务、强一致、SQL 查询 |
| 会话/草稿/幂等 | Redis | 低延迟、TTL |
| 事件溯源/审计（可选） | Cosmos DB / 事件表 | 可回放、合规 |
| 全文搜索（菜单/商品） | PostgreSQL FTS / Azure AI Search | 起步可 FTS |

### 9.3 事件驱动

```
订单状态机：pending → paid → accepted → preparing → out_for_delivery → delivered
                     ↘ cancelled / refunded

每个状态迁移发布领域事件（Service Bus）：
  order.paid ──► 触发 Agent 推送"待支付→备餐中"状态卡更新
  order.accepted ──► 商家端 surface 更新
```

**模式**：事件表（PostgreSQL 内）双写 + 总线发布（Outbox 模式），保证不丢事件。

---

## 10. 多租户 SaaS 设计

### 10.1 租户模型

| 维度 | 决策 |
|---|---|
| 隔离粒度 | 起步：共享库 + `tenant_id` 列 + PostgreSQL RLS；大租户可选独立 schema |
| Agent 实例 | 共享实例 + 租户上下文注入（起步）；高价值租户独立实例（后期） |
| 数据访问 | 所有查询强制 `WHERE tenant_id = ?`（RLS 兜底） |
| 身份 | 每个租户一套 B2C 租户配置 / 自定义域 |

### 10.2 租户上下文在 A2UI 中的传递

```
前端请求头: Authorization: Bearer <JWT>（含 tenantId claim）
    │
Agent 服务: 解析 JWT → ctx.tenantId → 注入所有工具调用
    │
Catalog 运行时: 组件渲染所需数据（菜单/价格/规则）按 tenantId 查询
```

### 10.3 计量与限流

- APIM 按订阅（租户）限流
- LLM token 用量按租户计量（成本分摊）
- 会话数/并发限制防滥用

---

## 11. Azure 部署架构

### 11.1 服务映射

| 需求 | Azure 服务 | 备注 |
|---|---|---|
| 前端托管 | Azure Static Web Apps / Container Apps + Front Door | SWA 适合纯前端；CA 适合 SSR |
| Agent 服务 | Azure Container Apps | 起步；规模后 AKS |
| 业务 API | Azure Container Apps | 与 Agent 分离部署 |
| 网关 | Azure API Management | 路由/限流/订阅/计量 |
| CDN/WAF | Azure Front Door | 全局加速 + 安全 |
| LLM | Azure OpenAI（GPT-4o 系）或 Gemini | 经网关，模型可替换 |
| 关系库 | Azure Database for PostgreSQL Flexible | 主数据 |
| 缓存 | Azure Cache for Redis | 会话/幂等 |
| 消息 | Azure Service Bus + Event Grid | 领域事件 |
| 身份 | Azure AD B2C + Entra ID | 消费者/员工 |
| 密钥 | Azure Key Vault + 托管身份 | 无明文密钥 |
| 可观测 | Application Insights + Log Analytics | 全链路 |
| 日志归档 | Azure Storage（冷） | 合规 |

### 11.2 部署拓扑（按环境）

```
dev ──► 单 Container App + 共享资源（最小成本）
staging ──► 独立 CA + 独立 Redis/DB（近似生产）
prod ──► Front Door + APIM + 多副本 CA + 高可用 DB/Redis
```

### 11.3 扩展与弹性

- Agent 服务：无状态（会话在 Redis）→ 水平扩展；LLM 调用有速率限制，需本地队列/退避
- 冷启动：Container Apps 最少实例 ≥1，预热 prompt/模型连接
- 地域：Front Door 多区域；起步单区域 + 灾难恢复计划

---

## 12. 安全设计

### 12.1 威胁模型（A2UI 特有）

| 威胁 | 场景 | 缓解 |
|---|---|---|
| **Prompt Injection** | 用户消息注入指令，让 Agent 泄露其他租户数据/执行危险操作 | 工具层权限校验；Agent 输出与工具结果视为不可信；系统指令与用户输入严格分离 |
| **恶意 UI（XSS）** | Agent 生成带恶意属性的组件（如 `<img onerror>`、伪造链接） | 渲染器沙箱；CSP 严格；Catalog schema 白名单（组件外的标签不渲染） |
| **UI 拒绝服务** | Agent 生成超大组件树/无限循环 | Catalog 限制组件数、嵌套深度；消息大小限制 |
| **数据泄露** | 工具返回超租户数据 | 工具层强制 tenantId；RLS 兜底 |
| **密钥泄露** | LLM key / 数据库凭据 | Key Vault + 托管身份；禁止前端直连 LLM |

### 12.2 安全基线（通用清单）

- [ ] 前后端 HTTPS + HSTS；CSP 严格（禁 inline script）
- [ ] 前端永不持有 LLM/DB 密钥
- [ ] Agent 输出经 schema 校验后才渲染
- [ ] 所有工具调用带租户+用户上下文，权限校验在业务服务
- [ ] 支付回调验签；幂等防重放
- [ ] 审计日志（谁在何时让 Agent 做了什么）
- [ ] APIM 限流 + Front Door WAF

---

## 13. 可观测性与运维

### 13.1 全链路追踪

```
前端（浏览器）──► APIM ──► Agent ──► 工具调用 ──► 业务服务 ──► LLM
     └──────────── 统一 traceId 贯穿 ────────────┘
```

### 13.2 关键指标

| 类别 | 指标 |
|---|---|
| 体验 | UI 生成首帧延迟（TTFU）、流式完成延迟、Action 回传→UI 更新延迟 |
| 质量 | LLM 输出 schema 校验失败率、工具调用失败率、用户重试率 |
| 成本 | token 用量（按租户/会话）、LLM 调用次数/会话 |
| 业务 | 会话转化率（对话→下单）、平均订单价值、Agent 介入率 |

### 13.3 LLM 评估（生产必做）

- **离线评测集**：典型用户请求 + 期望的 A2UI 输出（组件正确性、数据绑定正确性）
- **线上采样**：随机采样会话，人工/LLM 评审 UI 质量
- **回归门禁**：Catalog schema 变更必须跑评测集

---

## 14. 演进路线

| 阶段 | 内容 | 关键成果 |
|---|---|---|
| **Phase 0（POC）** | 前端直连 LLM + normalize 层（我们已完成） | 验证 A2UI 渲染闭环 |
| **Phase 1（MVP）** | Agent 服务独立部署（ADK + a2ui-agent-sdk）+ A2A/SSE + 业务服务（下单/支付桩） | 真实对话订餐闭环 |
| **Phase 2（多租户）** | tenant_id + RLS + B2C 多租户 + APIM 计量 | SaaS 化 |
| **Phase 3（规模）** | 多 Agent（接单/推荐/售后）+ AKS + 多区域 | 弹性与智能升级 |
| **Phase 4（生态）** | 开放 Catalog 给第三方租户自定义组件 | 平台化 |

---

## 附录 A：Catalog 设计模式

### A.1 组件设计通用规则

1. **组件只承载"呈现 + 轻交互"**，业务副作用走 action → 工具
2. **数据全部走 path 绑定**，不内嵌业务值（`{"path": "/order/total"}` 而非 `128`）
3. **Schema 严格模式**，字段少而语义清晰（LLM 的可用性随字段数下降）
4. **每个组件配 describe**（何时用、怎么用），这是 LLM 的"组件文档"

### A.2 起步组件集（通用推荐，6-10 个）

| 组件 | 用途 | 关键 props |
|---|---|---|
| `Text` | 文本/富文本 | text, variant |
| `Button` | 操作触发 | child, variant, action |
| `Form`（组合） | 收集输入 | TextField/ChoicePicker/DateTimeInput |
| `List` | 列表展示（可绑定数组） | children / path 模板 |
| `Card` | 分组容器 | child |
| `StatusCard` | 状态展示（订单/任务） | status, steps[] |
| `ConfirmDialog` | 确认操作 | trigger, content, action |

### A.3 从现有设计系统生成 Catalog（方法论）

```
现有组件（React）──► 1. 筛选"适合 Agent 生成"的组件（有清晰 props 契约的）
                 ──► 2. 为每个组件写 Zod schema（严格模式）+ describe
                 ──► 3. 定义配套工具（该组件对应的业务操作）
                 ──► 4. 注册到 catalog：createComponentImplementation(api, render)
                 ──► 5. 用官方 a2ui-agent-sdk 编译 schema 进 prompt
                 ──► 6. 跑评测集验证 LLM 能正确使用
```

---

## 附录 B：订餐系统消息流示例

### B.1 会话开始：用户表达意图

**用户**：`帮我订一份海鲜披萨，30 分钟后送到`

**Agent 处理**：
1. 调 `getMenu(query: "海鲜披萨")` → 返回候选菜品
2. 调 `calcDeliveryFee(distance)` → 价格
3. 生成 A2UI 消息流：

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
      { "id": "address-input", "component": "TextField", "label": "送餐地址", "value": {"path": "/address"} },
      { "id": "time-input", "component": "DateTimeInput", "label": "送达时间", "value": {"path": "/deliveryTime"} },
      { "id": "confirm-btn", "component": "Button", "child": "confirm-label", "variant": "primary",
        "action": { "event": { "name": "confirmOrder", "context": { "items": {"path": "/selectedDishes"} } } } },
      { "id": "confirm-label", "component": "Text", "text": "确认下单" }
    ]
  } },

  { "version": "v0.9", "updateDataModel": {
    "surfaceId": "order-flow", "path": "/",
    "value": {
      "dishes": [ { "name": "海鲜披萨", "price": 88, "imageUrl": "..." } ],
      "address": "", "deliveryTime": "30分钟后", "selectedDishes": []
    }
  } }
]
```

### B.2 用户确认 → 下单

**用户动作**：点击"确认下单" → `action: { event: { name: "confirmOrder", context: { items: [...] } } }`

**Agent 处理**：
1. 调 `createOrder(items, address, userId, tenantId)` → 业务服务扣库存、建订单 → 返回 `orderId` + 待支付金额
2. 调 `initiatePayment(orderId)` → 返回支付 URL
3. 生成下一轮 UI：

```json
{ "version": "v0.9", "updateComponents": {
  "surfaceId": "order-flow",
  "components": [
    { "id": "order-card", "component": "StatusCard", "status": "pending_payment", "steps": ["待支付","备餐中","配送中","已送达"] },
    { "id": "pay-btn", "component": "Button", "child": "pay-label", "variant": "primary",
      "action": { "functionCall": { "call": "openUrl", "args": { "url": {"path": "/payUrl"} } } } }
  ]
} },
{ "version": "v0.9", "updateDataModel": { "surfaceId": "order-flow", "path": "/", "value": { "orderId": "ORD-20250101-001", "payUrl": "https://pay.example.com/..." } } }
```

### B.3 状态实时更新（事件驱动）

```
支付成功 ──► 业务服务发布 order.paid ──► Service Bus ──► Agent 订阅
    ──► Agent 推送：updateComponentProperties { componentId: "order-card", props: { status: "preparing" } }
    ──► 前端自动更新状态卡（数据绑定响应）
```

---

## 附：文档维护

- 本文件随架构演进更新，重大变更走 ADR 记录
- Catalog 组件清单是**活文档**，与代码中的 schema 保持一致（可用脚本从代码生成）
