// ─── SDUI forms, read and sent back ───────────────────────────────────────────
//
// LinkedIn's profile forms are SDUI. Opening one returns every field's current
// value (`modelStates`) and the server actions its buttons fire, each with the
// state keys it reads and its payload. A save is that action, those values,
// some replaced. Nothing here knows any particular form; sdui-profile.ts and
// sdui-position.ts do.
//
// The browser sends some values it COMPUTES from others (a company is
// required unless the role is freelance). Those are evaluated here from the
// expression the form ships, and an expression we do not recognise is refused:
// a guessed value is a save that quietly says something else.

export interface ModelValue {
  protoCase: string;
  value: unknown;
}

export type Model = Map<string, ModelValue>;

export interface RequestArgs {
  requestedStateKeys: { key: { value: { id: string } } }[];
  payload: Record<string, unknown>;
}

export type Failure = { ok: false; code: string; message: string; hint?: string };

/** The balanced JSON array or object starting at `start`. */
export function balanced(s: string, start: number): string | null {
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === open) depth++;
    else if (!inString && ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseAt<T>(s: string, start: number): T | null {
  const text = start < 0 ? null : balanced(s, start);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** A model state's value in the shape the browser sends it back. */
function plain(v: Record<string, unknown>): ModelValue {
  const protoCase = String(v.$case);
  const raw = v[protoCase];
  if (protoCase === 'stringListValue') {
    return { protoCase, value: (raw as { stringValues?: string[] })?.stringValues ?? [] };
  }
  // React Server Components encode a bigint as "$n<digits>".
  if (protoCase === 'signedLongValue' && typeof raw === 'string' && raw.startsWith('$n')) {
    return { protoCase, value: { type: 'bigint', value: raw.slice(2) } };
  }
  return { protoCase, value: raw };
}

/**
 * The form's initial values. The same keys reappear inside actions (a
 * checkbox's SetState, a reset); only `modelStates` holds what the profile
 * has now. Null when there is none — a form we no longer understand.
 */
export function readModel(stream: string): Model | null {
  const at = stream.indexOf('"modelStates":[');
  const entries = parseAt<
    { key?: { key?: { value?: { id?: string } } }; value?: Record<string, unknown> }[]
  >(stream, at === -1 ? -1 : stream.indexOf('[', at));
  if (entries === null) return null;
  const model: Model = new Map();
  for (const entry of entries) {
    const id = entry.key?.key?.value?.id;
    if (id !== undefined && entry.value !== undefined && !model.has(id)) {
      model.set(id, plain(entry.value));
    }
  }
  return model;
}

/** A server action's arguments, verbatim, or null when the stream has none. */
export function findRequest(stream: string, requestId: string): RequestArgs | null {
  const at = stream.indexOf(`"requestId":"${requestId}","requestedArguments":`);
  if (at === -1) return null;
  const args = parseAt<RequestArgs>(
    stream,
    stream.indexOf('{', stream.indexOf('"requestedArguments":', at)),
  );
  return args !== null && Array.isArray(args.requestedStateKeys) && args.payload !== undefined
    ? args
    : null;
}

type Evaluated = { ok: true; value: unknown } | Failure;
type Node = { expression?: { $case?: string } & Record<string, unknown> };

const unknownExpression = (what: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message: `the form computes a value with an expression this tool does not evaluate (${what})`,
  hint: 'Nothing was sent. Re-capture the form to see what it has become.',
});

function boundId(body: unknown): string | undefined {
  return (body as { key?: { key?: { value?: { id?: string } } } })?.key?.key?.value?.id;
}

function str(node: Node, model: Model): string | null {
  const e = node.expression;
  if (e?.$case === 'stringValue') return String(e.stringValue);
  if (e?.$case === 'bindableString') {
    const v = model.get(boundId(e.bindableString) ?? '')?.value;
    return typeof v === 'string' ? v : '';
  }
  return null;
}

function bool(node: Node, model: Model): boolean | null {
  const e = node.expression;
  const body = e?.[e?.$case ?? ''] as Record<string, Node> | undefined;
  switch (e?.$case) {
    case 'booleanExpression':
      return bool(body as Node, model);
    case 'booleanValue':
      return e.booleanValue === true;
    case 'bindableBoolean':
      return model.get(boundId(e.bindableBoolean) ?? '')?.value === true;
    case 'notExpression': {
      const a = bool(body?.a ?? {}, model);
      return a === null ? null : !a;
    }
    case 'orExpression':
    case 'andExpression': {
      const a = bool(body?.a ?? {}, model);
      const b = bool(body?.b ?? {}, model);
      if (a === null || b === null) return null;
      return e.$case === 'orExpression' ? a || b : a && b;
    }
    case 'stringEqualsExpression': {
      const a = str(body?.a ?? {}, model);
      const b = str(body?.b ?? {}, model);
      if (a === null || b === null) return null;
      return (body as { ignoreCase?: boolean }).ignoreCase === true
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    }
    default:
      return null;
  }
}

/** Evaluate a computed value the way the browser would. */
export function evaluate(expression: unknown, model: Model): Evaluated {
  const value = bool(expression as Node, model);
  return value === null
    ? unknownExpression(JSON.stringify(expression).slice(0, 80))
    : { ok: true, value };
}

/** A computed value the caller resolves itself; undefined to evaluate it here. */
export type Resolver = (key: string, value: ModelValue) => Evaluated | undefined;

export interface WireState {
  key: string;
  namespace: 'MemoryNamespace';
  value: unknown;
  originalProtoCase: string;
  protoKey: { $type: 'proto.sdui.Key'; value: { $case: 'id'; id: string } };
}

/**
 * The states a request sends: one per requested key the form has a value for
 * (the browser omits the rest), computed ones evaluated.
 */
export function wireStates(keys: string[], model: Model, resolve: Resolver): WireState[] | Failure {
  const out: WireState[] = [];
  for (const id of keys) {
    const state = model.get(id);
    if (state === undefined) continue;
    let value = state.value;
    if (state.protoCase === 'expression') {
      const r = resolve(id, state) ?? evaluate(state.value, model);
      if (!r.ok) return r;
      value = r.value;
    }
    out.push({
      key: id,
      namespace: 'MemoryNamespace',
      value,
      originalProtoCase: state.protoCase,
      protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id } },
    });
  }
  return out;
}

export const keysOf = (args: RequestArgs): string[] =>
  args.requestedStateKeys.map((k) => k.key.value.id);

/** A server-request body as the browser sends it. */
export function requestBody(
  requestId: string,
  args: RequestArgs,
  states: unknown[],
  screen: string,
) {
  const requestedArguments = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: args.requestedStateKeys,
    payload: args.payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  return {
    requestId,
    serverRequest: {
      requestId,
      requestedArguments,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states,
    requestedArguments: { ...requestedArguments, states, screenId: screen, knownTemplateIds: [] },
  };
}

/** Open a profile form as the browser does. A read, though it is issued as a POST. */
export function navBody(screen: string, payload: Record<string, unknown>) {
  return {
    clientArguments: {
      $type: 'proto.sdui.actions.requests.RequestedArguments',
      requestedStateKeys: [],
      payload,
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      states: [],
      screenId: screen,
      knownTemplateIds: [],
    },
    isModal: true,
  };
}

/** Errors a 200 can still carry: a non-empty `errors` list in the response. */
export function responseErrors(raw: string): string | null {
  return raw.match(/"errors":\[([^\]]+)\]/)?.[1]?.slice(0, 300) ?? null;
}
