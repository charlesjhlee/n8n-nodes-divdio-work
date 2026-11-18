// The hand-written part of the node: calling divdio Work's /v1 API with the credential, and checking the
// signature of a webhook delivery (signature.ts). Built-in Node modules only: a verified community node has no run-time dependencies.
import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const CREDENTIAL = 'divdioWorkApi';

type Ctx = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions;

export async function baseUrl(ctx: Ctx): Promise<string> {
  const creds = await ctx.getCredentials(CREDENTIAL);
  return String(creds.baseUrl ?? '').replace(/\/+$/, '');
}

export interface CallOptions {
  body?: IDataObject;
  qs?: IDataObject;
  headers?: IDataObject;
  /** Ask for the bytes and the headers (renders: PNG or PDF). */
  binary?: boolean;
}

/** One /v1 call with the credential's token. A refusal ({ error: { status, code, message } }) becomes a NodeApiError. */
export async function workRequest(ctx: Ctx, method: IHttpRequestMethods, path: string, opts: CallOptions = {}): Promise<unknown> {
  const request: IHttpRequestOptions = {
    method,
    url: `${await baseUrl(ctx)}${path}`,
    headers: { accept: opts.binary ? '*/*' : 'application/json', 'user-agent': 'n8n-nodes-divdio-work', ...(opts.headers ?? {}) },
    qs: opts.qs,
    json: !opts.binary,
  };
  if (opts.body !== undefined) request.body = opts.body;
  if (opts.binary) {
    request.encoding = 'arraybuffer';
    request.returnFullResponse = true;
  }
  try {
    return await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, request);
  } catch (error) {
    const err = error as JsonObject & { response?: { body?: { error?: { message?: string; code?: string } } } };
    const work = err.response?.body?.error;
    throw new NodeApiError(ctx.getNode(), err, work ? { message: work.message, description: work.code ? `divdio Work refused it: ${work.code}` : undefined } : {});
  }
}
