/**
 * Normalizes raw LLM output into well-formed A2UI v0.9 protocol messages.
 *
 * Gemini (and other LLMs) frequently emit A2UI-ish variants instead of the
 * exact v0.9 schema. This module repairs the common deviations so that the
 * MessageProcessor can consume the result without failing validation:
 *
 * - streaming envelope messages (`type: "begin"|"end"`) are dropped
 * - flat `{type: "createSurface", ...}` messages become `{version, createSurface:{...}}`
 * - `dataModelUpdate`/`updateDataModel` variants are normalized
 * - `catalog` -> `catalogId`, `componentName`/`type` -> `component`
 * - `props`/`properties` wrappers are flattened onto the component
 * - `checked` -> `value` (CheckBox), `onClick`/`onPress` -> `action` (Button)
 * - unknown component fields are dropped (models invent props like `placeholder`)
 * - Card `children[]` -> single `child` (auto-wrapping in a Column if needed)
 * - malformed `action`s are removed instead of failing the whole UI
 * - invalid enum values (e.g. Text variant) are removed
 * - `createSurface` is injected if missing; all messages share one surfaceId
 */

const BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'

const KNOWN_KEYS = [
  'createSurface',
  'updateComponents',
  'updateComponentProperties',
  'deleteComponents',
  'updateDataModel',
  'deleteSurface',
] as const

const COMMON_FIELDS = new Set(['id', 'component', 'accessibility', 'weight'])

/** Allowed fields per component type (from basicCatalog v0.9 schemas). */
const COMPONENT_FIELDS: Record<string, Set<string>> = {
  Text: new Set(['text', 'variant']),
  Image: new Set(['url', 'description', 'fit', 'variant']),
  Icon: new Set(['name', 'svgPath']),
  Video: new Set(['url']),
  AudioPlayer: new Set(['url', 'description']),
  Row: new Set(['children', 'justify', 'align']),
  Column: new Set(['children', 'justify', 'align']),
  List: new Set(['children', 'direction', 'align', 'listStyle']),
  Card: new Set(['child']),
  Tabs: new Set(['tabs', 'title', 'child']),
  Modal: new Set(['trigger', 'content']),
  Divider: new Set(['axis']),
  Button: new Set(['child', 'variant', 'action']),
  TextField: new Set(['label', 'value', 'variant', 'validationRegexp']),
  CheckBox: new Set(['label', 'value']),
  ChoicePicker: new Set(['label', 'variant', 'options']),
  Slider: new Set(['label', 'min', 'max', 'value']),
  DateTimeInput: new Set(['value', 'enableDate', 'enableTime', 'min', 'max', 'label']),
}

const VARIANT_LISTS: Record<string, string[]> = {
  Text: ['h1', 'h2', 'h3', 'h4', 'h5', 'caption', 'body'],
  Button: ['default', 'primary', 'borderless'],
  TextField: ['shortText', 'longText', 'number', 'obscured'],
  ChoicePicker: ['multipleSelection', 'mutuallyExclusive'],
  Divider: ['horizontal', 'vertical'],
  Image: ['contain', 'cover', 'fill', 'none', 'scaleDown'],
}

type AnyRecord = Record<string, any>

function normalizeComponent(comp: AnyRecord): void {
  if (!comp || typeof comp !== 'object') return

  // Flatten props/properties wrappers.
  const wrapped = comp.props ?? comp.properties
  if (wrapped && typeof wrapped === 'object') {
    delete comp.props
    delete comp.properties
    Object.assign(comp, wrapped)
  }

  // component field aliases.
  if (typeof comp.component !== 'string' && typeof comp.componentName === 'string') {
    comp.component = comp.componentName
    delete comp.componentName
  } else if (typeof comp.component !== 'string' && typeof comp.type === 'string') {
    comp.component = comp.type
    delete comp.type
  }
  // Component name aliases (schema uses "CheckBox").
  if (comp.component === 'Checkbox') comp.component = 'CheckBox'

  const type = comp.component as string

  // Field aliases the models commonly use.
  if (type === 'Image' || type === 'Video' || type === 'AudioPlayer') {
    if ('src' in comp && !('url' in comp)) {
      comp.url = comp.src
      delete comp.src
    }
  }
  if (type === 'Icon') {
    if ('icon' in comp && !('name' in comp)) {
      comp.name = comp.icon
      delete comp.icon
    }
  }
  if (type === 'Modal' && 'children' in comp && !('content' in comp)) {
    comp.content = comp.children
    delete comp.children
  }

  // CheckBox: `checked` -> `value`.
  if (type === 'CheckBox' && 'checked' in comp && !('value' in comp)) {
    comp.value = comp.checked
    delete comp.checked
  }

  // Button: `onClick`/`onPress` -> `action`.
  if (type === 'Button') {
    const handler = comp.onClick ?? comp.onPress
    if (handler !== undefined && typeof handler === 'object' && handler !== null) {
      if (!('action' in comp)) comp.action = handler
      delete comp.onClick
      delete comp.onPress
    } else if (handler !== undefined) {
      delete comp.onClick
      delete comp.onPress
    }
    // Button requires a `child` component; models often use a `label`/`text`
    // string instead — synthesize a Text child.
    const btnText = comp.label ?? comp.text
    if (typeof comp.child !== 'string' && typeof btnText === 'string') {
      const childId = `${comp.id}_label`
      comp.child = childId
      comp.__injectedChild = { id: childId, component: 'Text', text: btnText }
      delete comp.label
      delete comp.text
    }
    // action: {type, event} -> {event:{name}}; drop uninformative actions.
    if (comp.action && typeof comp.action === 'object') {
      const a = comp.action
      if (typeof a.event === 'string') {
        comp.action = { event: { name: a.event } }
      } else if (
        !('functionCall' in a) &&
        !('event' in a) &&
        typeof a.type === 'string' &&
        !Object.keys(a).some((k) => k !== 'type')
      ) {
        delete comp.action
      }
    }
  }

  // Card: single `child`, not `children`.
  if (type === 'Card' && Array.isArray(comp.children)) {
    if (comp.children.length === 1) {
      comp.child = comp.children[0]
    } else if (comp.children.length > 1) {
      const wrapperId = `${comp.id}_content`
      comp.child = wrapperId
      comp.__injectedChildren = comp.children
    }
    delete comp.children
  }

  // Drop invalid enum values.
  const allowedVariants = VARIANT_LISTS[type]
  if (allowedVariants && typeof comp.variant === 'string' && !allowedVariants.includes(comp.variant)) {
    delete comp.variant
  }

  // `weight` must be a number (flex-grow); drop string values.
  if (comp.weight !== undefined && typeof comp.weight !== 'number') {
    delete comp.weight
  }

  // functionCall: `{name, args}` -> `{call, args}`.
  const fc = comp.action?.functionCall
  if (fc && typeof fc.call !== 'string' && typeof fc.name === 'string') {
    fc.call = fc.name
    delete fc.name
  }

  // Drop malformed actions.
  const action = comp.action
  if (
    action !== undefined &&
    (typeof action !== 'object' ||
      action === null ||
      (!('functionCall' in action) && !('event' in action)))
  ) {
    delete comp.action
  }

  // Drop unknown fields (models invent props like `placeholder`, `spacing`).
  const allowedFields = COMPONENT_FIELDS[type]
  if (allowedFields) {
    for (const key of Object.keys(comp)) {
      if (key === '__injectedChildren' || key === '__injectedChild') continue
      if (!COMMON_FIELDS.has(key) && !allowedFields.has(key)) {
        delete comp[key]
      }
    }
  }
}

function normalizeMessage(msg: AnyRecord): AnyRecord | null {
  if (!msg || typeof msg !== 'object') return null

  // Streaming control messages — drop.
  if (msg.type === 'begin' || msg.type === 'end' || msg.type === 'streaming') {
    return null
  }

  // Flat `{type: ...}` / `{op: ...}` / `{action: "..."}` style (AG-UI-ish)
  // -> v0.9 envelope. (Also handles messages that carry a version field but
  // still use the flat shape instead of a proper envelope key.)
  const flatType = msg.type ?? msg.op ?? msg.action
  if (typeof flatType === 'string' && !KNOWN_KEYS.some((k) => k in msg)) {
    const { type, op, action, surfaceId, componentId, componentIds, props, path, value, data, components } = msg
    const envelope: AnyRecord = { version: 'v0.9' }
    const kind = type ?? op ?? action
    switch (kind) {
      case 'createSurface':
      case 'create':
        envelope.createSurface = {
          surfaceId,
          // The renderer only registers the basic catalog — force its id.
          catalogId: BASIC_CATALOG_ID,
        }
        break
      case 'updateComponents':
      case 'update':
        envelope.updateComponents = { surfaceId, components }
        break
      case 'updateComponentProperties':
        envelope.updateComponentProperties = { surfaceId, componentId, props }
        break
      case 'deleteComponents':
        envelope.deleteComponents = { surfaceId, componentIds }
        break
      case 'dataModelUpdate':
      case 'updateDataModel':
        envelope.updateDataModel = {
          surfaceId,
          path: path ?? '/',
          value: value ?? data,
        }
        break
      case 'deleteSurface':
        envelope.deleteSurface = { surfaceId }
        break
      default:
        return null
    }
    return envelope
  }

  // Already enveloped — keep.
  return msg
}

/**
 * Turns a raw LLM response (any JSON array) into valid A2UI v0.9 messages.
 * Returns an array of messages; may be empty if nothing usable was found.
 */
export function normalizeMessages(raw: unknown): AnyRecord[] {
  if (!Array.isArray(raw)) return []

  // Normalize each message and collect injected Card children.
  const injectedChildren: AnyRecord[] = []
  const messages: AnyRecord[] = []
  for (const item of raw) {
    const msg = normalizeMessage(item as AnyRecord)
    if (!msg) continue

    const components = msg.updateComponents?.components
    if (Array.isArray(components)) {
      for (const comp of components) {
        normalizeComponent(comp as AnyRecord)
        if (comp && typeof comp === 'object') {
          if (comp.__injectedChild) {
            components.push(comp.__injectedChild)
            delete comp.__injectedChild
          }
          if (comp.__injectedChildren) {
            injectedChildren.push({
              id: comp.__injectedWrapperId ?? `${comp.id}_content`,
              component: 'Column',
              children: comp.__injectedChildren,
            })
            delete comp.__injectedChildren
          }
        }
      }
    }
    messages.push(msg)
  }

  // Keep only well-formed envelopes.
  let filtered = messages.filter((m) => {
    if (m.version !== 'v0.9' && m.version !== '0.9') return false
    m.version = 'v0.9'
    return KNOWN_KEYS.some((k) => k in m)
  })

  // Inject createSurface if missing. Prefer the surfaceId already used by
  // other messages so multi-turn sessions keep one surface (the client
  // dedupes createSurface for ids it has already seen).
  if (!filtered.some((m) => 'createSurface' in m)) {
    const existingId = filtered
      .map((m) => {
        for (const k of KNOWN_KEYS) {
          if (k !== 'createSurface' && m[k] && typeof m[k] === 'object') {
            return m[k].surfaceId
          }
        }
        return undefined
      })
      .find((id): id is string => typeof id === 'string')
    filtered = [
      {
        version: 'v0.9',
        createSurface: { surfaceId: existingId ?? 'main', catalogId: BASIC_CATALOG_ID },
      },
      ...filtered,
    ]
  }

  // Unify surfaceId.
  const firstSurfaceId = filtered.find((m) => m.createSurface)?.createSurface?.surfaceId
  if (firstSurfaceId) {
    for (const m of filtered) {
      for (const k of KNOWN_KEYS) {
        if (k !== 'createSurface' && m[k] && typeof m[k] === 'object') {
          m[k].surfaceId = firstSurfaceId
        }
      }
    }
  }

  // Attach injected Card wrapper columns to the first updateComponents message.
  if (injectedChildren.length > 0) {
    const uc = filtered.find((m) => m.updateComponents)?.updateComponents
    if (uc && Array.isArray(uc.components)) {
      uc.components.push(...injectedChildren)
    }
  }

  return filtered
}
