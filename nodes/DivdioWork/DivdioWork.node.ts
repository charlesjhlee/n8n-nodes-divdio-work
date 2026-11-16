// divdio Work action node: one operation per mapped /v1 operationId. The resources, operations and fields come from
// Work's OpenAPI document (generated/operations.ts); this file only turns a filled-in node into the request.
import type {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestMethods,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { OPERATIONS, PROPERTIES } from './generated/operations';
import type { OperationMeta } from './generated/operations';
import { CREDENTIAL, workRequest } from './transport';

const PAGE = 500; // the most /v1/events answers at once

function toValue(raw: unknown, spec: { type: string; array: boolean }): unknown {
  if (spec.array) {
    if (Array.isArray(raw)) return raw;
    return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

/** The request body from the node's required fields, its Additional Fields and their JSON. */
export function bodyOf(meta: OperationMeta, required: IDataObject, additional: IDataObject): IDataObject | undefined {
  if (!Object.keys(meta.body).length && !('json' in additional)) return undefined;
  const body: IDataObject = {};
  const { json, ...rest } = additional;
  if (json !== undefined && json !== '' && json !== '{}') {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('More Fields (JSON) must be a JSON object');
    Object.assign(body, parsed);
  }
  for (const [k, v] of Object.entries({ ...rest, ...required })) {
    const spec = meta.body[k] ?? { type: 'string', array: false };
    body[k] = toValue(v, spec) as IDataObject[keyof IDataObject];
  }
  return body;
}

export class DivdioWork implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'divdio Work',
    name: 'divdioWork',
    icon: 'file:divdioWork.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Create, move and message cards, answer decisions, read events and render boards in divdio Work',
    defaults: { name: 'divdio Work' },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: PROPERTIES,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const executionId = this.getExecutionId();
    const nodeId = this.getNode().id;

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        const operation = this.getNodeParameter('operation', i) as string;
        const meta = OPERATIONS[`${resource}:${operation}`];
        if (!meta) throw new NodeOperationError(this.getNode(), `Unknown operation ${resource}: ${operation}`, { itemIndex: i });

        let path = meta.path;
        for (const p of meta.pathParams) {
          const v = String(this.getNodeParameter(`path_${p}`, i) ?? '').trim();
          if (!v) throw new NodeOperationError(this.getNode(), `${p} is required`, { itemIndex: i });
          path = path.replace(`{${p}}`, encodeURIComponent(v));
        }

        const required: IDataObject = {};
        for (const k of meta.required) required[k] = this.getNodeParameter(`body_${k}`, i) as IDataObject[string];
        const hasBody = Object.keys(meta.body).length > 0;
        const additional = hasBody ? (this.getNodeParameter('additionalFields', i, {}) as IDataObject) : {};
        let body: IDataObject | undefined;
        try {
          body = hasBody ? bodyOf(meta, required, additional) : undefined;
        } catch (e) {
          throw new NodeOperationError(this.getNode(), (e as Error).message, { itemIndex: i });
        }

        const qs: IDataObject = Object.keys(meta.query).length ? { ...(this.getNodeParameter('options', i, {}) as IDataObject) } : {};
        for (const q of meta.topQuery ?? []) {
          const v = this.getNodeParameter(`query_${q}`, i, '') as string;
          if (v !== '') qs[q] = v;
        }
        const headers: IDataObject = {};
        // The same key on n8n's retries of this item, so Work answers the write once.
        if (meta.idempotent) headers['Idempotency-Key'] = `n8n_${executionId}_${nodeId}_${i}`;
        const method = meta.method as IHttpRequestMethods;

        if (meta.binary) {
          const field = this.getNodeParameter('binaryPropertyName', i) as string;
          const res = (await workRequest(this, method, path, { qs, headers, binary: true })) as { body: ArrayBuffer | Buffer; headers: IDataObject };
          const type = String(res.headers?.['content-type'] ?? meta.binary[0]).split(';')[0];
          const ext = type === 'application/pdf' ? 'pdf' : 'png';
          const name = `${meta.operationId.replace(/^render/, '').toLowerCase()}${meta.pathParams.length ? `-${path.split('/').pop()}` : ''}.${ext}`;
          const data = await this.helpers.prepareBinaryData(Buffer.from(res.body as ArrayBuffer), name, type);
          out.push({ json: { operation: meta.operationId, mimeType: type, fileName: name }, binary: { [field]: data }, pairedItem: { item: i } });
          continue;
        }

        if (meta.pagination) {
          const pg = meta.pagination;
          const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
          const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i, 50) as number);
          const found: IDataObject[] = [];
          let cursor: string | undefined;
          for (;;) {
            const page = (await workRequest(this, method, path, { qs: { ...qs, limit: Math.min(PAGE, limit - found.length), ...(cursor ? { [pg.cursorParam]: cursor } : {}) }, headers })) as IDataObject;
            found.push(...((page[pg.itemsField] as IDataObject[]) ?? []));
            if (!page[pg.moreField] || found.length >= limit || !page[pg.nextField]) break;
            cursor = String(page[pg.nextField]);
          }
          for (const e of found.slice(0, limit)) out.push({ json: e, pairedItem: { item: i } });
          continue;
        }

        const res = await workRequest(this, method, path, { body, qs, headers });
        const rows = Array.isArray(res) ? res : [res ?? {}];
        for (const r of rows) out.push({ json: r as IDataObject, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
      }
    }
    return [out];
  }
}
