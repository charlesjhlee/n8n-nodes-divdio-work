#!/usr/bin/env node
// divdio Work n8n node generator (KAN-10451): reads Work's /v1 OpenAPI document and writes the action node's
// resources, operations and fields (nodes/DivdioWork/generated/operations.ts). The node's runtime (auth, the
// Idempotency-Key, paging, binary renders, errors) and the webhook trigger are hand-written next to it.
//
//   node products/work/integrations/n8n/scripts/generate.mjs                 from the in-repo document
//   node products/work/integrations/n8n/scripts/generate.mjs --check         exit 1 if the written file is out of date
//   node products/work/integrations/n8n/scripts/generate.mjs --from <url|file>   from a running board or a saved document
//
// Every operationId in the document is either listed in ACTIONS (it becomes an n8n operation) or in SKIP with the
// reason. A new operation that is in neither makes the generator stop, so the node never silently falls behind the API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '../nodes/DivdioWork/generated/operations.ts');
const SDK = path.join(HERE, '../../../sdk/generate.mjs'); // the shared OpenAPI reader (KAN-8403), monorepo only

/** The resources the action node shows, in this order. */
export const RESOURCES = [
  { value: 'card', name: 'Card' },
  { value: 'decision', name: 'Decision' },
  { value: 'event', name: 'Event' },
  { value: 'docsPage', name: 'Docs Page' },
  { value: 'render', name: 'Render' },
  { value: 'board', name: 'Board' },
  { value: 'account', name: 'Account' },
];

/** operationId → the n8n resource, operation value, its name and action text. */
export const ACTIONS = {
  addCard: { resource: 'card', op: 'create', name: 'Create', action: 'Create a card' },
  getCard: { resource: 'card', op: 'get', name: 'Get', action: 'Get a card' },
  updateCard: { resource: 'card', op: 'update', name: 'Update', action: 'Move or change a card' },
  messageCard: { resource: 'card', op: 'message', name: 'Message Agent', action: "Tell a card's agent something" },
  reviewCard: { resource: 'card', op: 'review', name: 'Review', action: 'Approve or reject a card in review' },
  queryCards: { resource: 'card', op: 'search', name: 'Search', action: 'Search cards with a query' },
  bulk: { resource: 'card', op: 'bulk', name: 'Bulk Change', action: 'Move, message or discard several cards' },
  answerDecision: { resource: 'decision', op: 'answer', name: 'Answer', action: 'Answer a decision' },
  listEvents: { resource: 'event', op: 'getMany', name: 'Get Many', action: 'Get many events' },
  listDocsPages: { resource: 'docsPage', op: 'getMany', name: 'Get Many', action: 'Get the docs tree' },
  addDocsPage: { resource: 'docsPage', op: 'create', name: 'Create', action: 'Create a docs page' },
  renderBoard: { resource: 'render', op: 'board', name: 'Board', action: 'Render the board as PNG or PDF' },
  renderRoadmap: { resource: 'render', op: 'roadmap', name: 'Roadmap', action: 'Render the roadmap as PNG or PDF' },
  renderGantt: { resource: 'render', op: 'gantt', name: 'Gantt', action: 'Render the Gantt chart as PNG or PDF' },
  renderCard: { resource: 'render', op: 'card', name: 'Card', action: "Render a card's page as PNG or PDF" },
  getBoard: { resource: 'board', op: 'get', name: 'Get', action: 'Get the board' },
  getMe: { resource: 'account', op: 'getMe', name: 'Get Token Owner', action: 'Get the token and the person it acts as' },
};

/** operationIds the action node leaves out, and why. */
export const SKIP = {
  getIndex: 'API description, not an action',
  getOpenApi: 'the document itself',
  getProto: 'the gRPC description',
  getContract: 'board contract version, for tooling',
  getAttention: 'a 25 s long poll; the trigger covers it with webhooks',
  openLive: 'a server-sent event stream; the trigger covers it with webhooks',
  openEventStream: 'a server-sent event stream; the trigger covers it with webhooks',
  getBoardA11y: 'accessibility tree for assistive tools',
  getRoadmapA11y: 'accessibility tree for assistive tools',
  getGanttA11y: 'accessibility tree for assistive tools',
  getCardA11y: 'accessibility tree for assistive tools',
  listWebhooks: 'managed by the trigger node',
  createWebhook: 'managed by the trigger node',
  getWebhook: 'managed by the trigger node',
  updateWebhook: 'managed by the trigger node',
  deleteWebhook: 'managed by the trigger node',
  listWebhookDeliveries: 'webhook admin, done in Work settings',
  testWebhook: 'webhook admin, done in Work settings',
  redeliverFailedWebhookDeliveries: 'webhook admin, done in Work settings',
  getWebhookDelivery: 'webhook admin, done in Work settings',
  redeliverWebhookDelivery: 'webhook admin, done in Work settings',
  listApiTokens: 'admin-only token management stays in Work',
  createApiToken: 'admin-only token management stays in Work',
  revokeApiToken: 'admin-only token management stays in Work',
};

/** Query parameters a binary render does not offer (the node always asks for the image or PDF itself). */
const RENDER_OMIT = new Set(['encoding']);
const RENDER_FORMATS = new Set(['png', 'pdf']);

/** Query parameters shown as their own field rather than under Options. */
const TOP_QUERY = {
  q: { label: 'Query', description: 'Cards matching this query, in the card query language' },
};

const titleCase = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/\bId\b/g, 'ID');
const sentence = (s) => { const t = String(s ?? '').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };

function baseType(schema) {
  if (Array.isArray(schema?.type)) return schema.type.find((t) => t !== 'null') ?? 'string';
  return schema?.type ?? 'string';
}

/** One schema as an n8n field: { type, options?, array?, default }. */
export function fieldOf(schema) {
  if (schema?.enum) return { type: 'options', options: schema.enum, default: schema.default ?? schema.enum[0] };
  switch (baseType(schema)) {
    case 'integer': case 'number': {
      const range = { ...(schema.minimum != null ? { minValue: schema.minimum } : {}), ...(schema.maximum != null ? { maxValue: schema.maximum } : {}) };
      return { type: 'number', default: schema.default ?? schema.minimum ?? 0, ...(Object.keys(range).length ? { typeOptions: range } : {}) };
    }
    case 'boolean': return { type: 'boolean', default: schema.default ?? false };
    case 'array': return { type: 'string', array: true, default: '' };
    default: return { type: 'string', default: schema?.default ?? '' };
  }
}

function property(name, displayName, field, extra = {}) {
  const p = { displayName, name, type: field.type, default: field.default, ...extra };
  if (field.typeOptions) p.typeOptions = field.typeOptions;
  if (field.type === 'options') p.options = field.options.map((v) => ({ name: titleCase(String(v)), value: v }));
  if (field.array) p.description = [p.description, 'Comma-separated'].filter(Boolean).join('. ');
  if (!p.description) delete p.description;
  return p;
}

/** The node's metadata and n8n properties from a document's normalised operations. */
export function build(ops) {
  const unknown = ops.filter((o) => !ACTIONS[o.id] && !SKIP[o.id]).map((o) => `${o.id} (${o.method.toUpperCase()} ${o.path})`);
  if (unknown.length) throw new Error(`New operations not mapped in ACTIONS or SKIP: ${unknown.join(', ')}`);
  const gone = Object.keys(ACTIONS).filter((id) => !ops.some((o) => o.id === id));
  if (gone.length) throw new Error(`ACTIONS names operations the document no longer has: ${gone.join(', ')}`);

  const meta = {};
  const properties = [];
  properties.push({ displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, options: RESOURCES, default: 'card' });
  for (const r of RESOURCES) {
    const mine = ops.filter((o) => ACTIONS[o.id]?.resource === r.value);
    properties.push({
      displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true,
      displayOptions: { show: { resource: [r.value] } },
      options: mine.map((o) => ({ name: ACTIONS[o.id].name, value: ACTIONS[o.id].op, description: sentence(o.summary), action: ACTIONS[o.id].action })),
      default: ACTIONS[mine[0].id].op,
    });
  }

  for (const o of ops) {
    const a = ACTIONS[o.id];
    if (!a) continue;
    const show = { displayOptions: { show: { resource: [a.resource], operation: [a.op] } } };
    const m = { operationId: o.id, method: o.method.toUpperCase(), path: o.path, pathParams: [], body: {}, required: [], query: {}, idempotent: o.idempotent, scope: o.scope };

    for (const p of o.pathParams) {
      const name = `path_${p.name}`;
      m.pathParams.push(p.name);
      const hint = p.name === 'card' ? 'The card key, e.g. KAN-42' : p.name === 'decision' ? 'The decision ID, e.g. D-12' : sentence(p.description);
      properties.push(property(name, titleCase(p.name), { type: 'string', default: '' }, { required: true, description: hint, ...show }));
    }

    const extra = [];
    if (o.body) {
      const schema = o.body.schema;
      const req = new Set(schema.required ?? []);
      for (const [k, s] of Object.entries(schema.properties ?? {})) {
        const f = fieldOf(s);
        m.body[k] = { type: baseType(s), array: !!f.array };
        if (req.has(k)) {
          m.required.push(k);
          properties.push(property(`body_${k}`, titleCase(k), f, { required: true, description: sentence(s.description), ...show }));
        } else {
          extra.push(property(k, titleCase(k), f, { description: sentence(s.description) }));
        }
      }
      if (schema.additionalProperties) extra.push({ displayName: 'More Fields (JSON)', name: 'json', type: 'json', default: '{}', description: 'Other card fields this operation accepts, as a JSON object' });
      if (extra.length) properties.push({ displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', placeholder: 'Add Field', default: {}, ...show, options: extra.sort((x, y) => x.displayName.localeCompare(y.displayName)) });
    }

    const raw = o.raw.length > 0;
    const query = o.query.filter((q) => !(raw && RENDER_OMIT.has(q.name)));
    if (o.pagination) {
      m.pagination = o.pagination;
      properties.push({ displayName: 'Return All', name: 'returnAll', type: 'boolean', default: false, description: 'Whether to return all results or only up to a given limit', ...show });
    }
    const options = [];
    for (const q of query) {
      let schema = q.schema ?? {};
      if (raw && q.name === 'format') schema = { ...schema, enum: schema.enum.filter((v) => RENDER_FORMATS.has(v)) };
      m.query[q.name] = { type: baseType(schema) };
      if (o.pagination && q.name === o.pagination.cursorParam) continue; // the node pages itself
      if (o.pagination && q.name === 'limit') {
        const f = fieldOf(schema);
        properties.push(property('limit', 'Limit', { ...f, default: Math.min(50, schema.maximum ?? 50) }, { description: 'Max number of results to return', displayOptions: { show: { ...show.displayOptions.show, returnAll: [false] } } }));
        continue;
      }
      if (TOP_QUERY[q.name]) {
        // The parameter the operation is about (the card query): shown on its own, not under Options.
        m.topQuery = [...(m.topQuery ?? []), q.name];
        properties.push(property(`query_${q.name}`, TOP_QUERY[q.name].label, fieldOf(schema), { description: TOP_QUERY[q.name].description, ...show }));
        continue;
      }
      options.push(property(q.name, titleCase(q.name), fieldOf(schema), { description: sentence(q.description) }));
    }
    if (options.length) properties.push({ displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {}, ...show, options: options.sort((x, y) => x.displayName.localeCompare(y.displayName)) });
    if (raw) {
      m.binary = o.raw;
      properties.push({ displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true, description: 'The name of the output binary field for the image or PDF', ...show });
    }
    meta[`${a.resource}:${a.op}`] = m;
  }
  return { meta, properties };
}

export function render(doc, operations) {
  const { meta, properties } = build(operations(doc));
  const events = doc.components?.schemas?.Event?.properties?.type?.enum ?? [];
  const L = [];
  L.push(`// Generated by products/work/integrations/n8n/scripts/generate.mjs from the divdio Work /v1 OpenAPI document ${doc.info?.version ?? ''}.`);
  L.push('// Do not edit: change the document (work-server/orchestrator/apiv1.mjs) or the generator, then run it.');
  L.push("import type { INodeProperties } from 'n8n-workflow';");
  L.push('');
  L.push('/** The API version these operations were generated from. */');
  L.push(`export const API_VERSION = ${JSON.stringify(doc.info?.version ?? '')};`);
  L.push('');
  L.push('/** Every event type the board sends to a webhook. */');
  L.push(`export const EVENT_TYPES: readonly string[] = ${JSON.stringify(events)};`);
  L.push('');
  L.push('export interface OperationMeta {');
  L.push('  operationId: string;');
  L.push('  method: \'GET\' | \'POST\' | \'PATCH\' | \'PUT\' | \'DELETE\';');
  L.push('  path: string;');
  L.push('  pathParams: string[];');
  L.push('  body: Record<string, { type: string; array: boolean }>;');
  L.push('  required: string[];');
  L.push('  query: Record<string, { type: string }>;');
  L.push('  idempotent: boolean;');
  L.push('  scope: string | null;');
  L.push('  pagination?: { cursorParam: string; nextField: string; moreField: string; itemsField: string };');
  L.push('  binary?: string[];');
  L.push('  /** Query parameters read from their own field (query_<name>) rather than Options. */');
  L.push('  topQuery?: string[];');
  L.push('}');
  L.push('');
  L.push('/** "resource:operation" → how to call it. */');
  L.push(`export const OPERATIONS: Record<string, OperationMeta> = ${JSON.stringify(meta, null, 2)};`);
  L.push('');
  L.push('/** The action node\'s resource, operation and field properties. */');
  L.push(`export const PROPERTIES: INodeProperties[] = ${JSON.stringify(properties, null, 2)};`);
  L.push('');
  return L.join('\n');
}

async function readDocument(from, sdk) {
  if (!from) return sdk.localDocument();
  if (/^https?:\/\//.test(from)) {
    const r = await fetch(from.endsWith('.json') ? from : `${from.replace(/\/$/, '')}/v1/openapi.json`);
    if (!r.ok) throw new Error(`${from}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(fs.readFileSync(from, 'utf8'));
}

async function main(argv) {
  if (!fs.existsSync(SDK)) throw new Error('Run the generator from the divdio monorepo (it reads the document with products/work/sdk/generate.mjs); the published package ships the generated file.');
  const sdk = await import(SDK);
  const check = argv.includes('--check');
  const fromAt = argv.indexOf('--from');
  const doc = await readDocument(fromAt >= 0 ? argv[fromAt + 1] : null, sdk);
  const text = render(doc, sdk.operations);
  const rel = path.relative(process.cwd(), OUT);
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  const n = Object.keys(build(sdk.operations(doc)).meta).length;
  if (old === text) { console.log(`${rel} is up to date (${n} operations, API ${doc.info?.version})`); return 0; }
  if (check) { console.error(`${rel} is out of date; run node products/work/integrations/n8n/scripts/generate.mjs`); return 1; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${rel} (${n} operations, API ${doc.info?.version})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
