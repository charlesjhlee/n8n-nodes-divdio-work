// divdio Work trigger: when the workflow is activated it subscribes a Work webhook (POST /v1/webhooks) to the node's
// own URL, checks each delivery's Standard Webhooks signature, and removes the webhook when the workflow stops.
import type {
  IDataObject,
  IHookFunctions,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { EVENT_TYPES } from './generated/operations';
import { verifySignature } from './signature';
import { CREDENTIAL, workRequest } from './transport';

const label = (t: string) => t.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** "*", every family ("card.*") and every event type, from Work's OpenAPI Event schema. */
export const EVENT_OPTIONS: INodePropertyOptions[] = [
  { name: 'Any Event', value: '*' },
  ...[...new Set(EVENT_TYPES.map((t) => t.split('.')[0]))].map((f) => ({ name: `Any ${label(f)} Event`, value: `${f}.*` })),
  ...EVENT_TYPES.map((t) => ({ name: label(t), value: t })),
];

const list = (s: unknown) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

interface HookState {
  webhookId?: string;
  webhookSecret?: string;
}

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool -- a trigger can't be an AI tool, and the type allows only true
export class DivdioWorkTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'divdio Work Trigger',
    name: 'divdioWorkTrigger',
    icon: 'file:divdioWork.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: 'Starts the workflow when something happens on a divdio Work board',
    defaults: { name: 'divdio Work Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName: 'The API token needs the webhooks:manage scope and must belong to a board admin.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        options: EVENT_OPTIONS,
        default: ['card.*'],
        required: true,
        description: 'The events that start the workflow',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Labels',
            name: 'labels',
            type: 'string',
            default: '',
            description: 'Only cards with at least one of these labels. Comma-separated, at most 20.',
          },
          {
            displayName: 'Repositories',
            name: 'repos',
            type: 'string',
            default: '',
            description: "Only these projects' cards. Comma-separated. Empty means the whole board.",
          },
          {
            displayName: 'Check Signature',
            name: 'verifySignature',
            type: 'boolean',
            default: true,
            description: 'Whether to refuse deliveries whose webhook-signature does not match the secret Work gave this trigger',
          },
        ],
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node') as HookState;
        if (!state.webhookId) return false;
        try {
          const res = (await workRequest(this, 'GET', `/v1/webhooks/${encodeURIComponent(state.webhookId)}`)) as IDataObject;
          const hook = (res.webhook ?? res) as IDataObject;
          if (hook.url === this.getNodeWebhookUrl('default') && state.webhookSecret) return true;
        } catch {
          // Gone (deleted in Work settings) or unreachable: make a new one.
        }
        delete state.webhookId;
        delete state.webhookSecret;
        return false;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const options = this.getNodeParameter('options', {}) as IDataObject;
        const body: IDataObject = {
          url: this.getNodeWebhookUrl('default') as string,
          events: this.getNodeParameter('events') as string[],
          repos: list(options.repos),
          labels: list(options.labels),
          description: `n8n: ${this.getWorkflow().name ?? this.getWorkflow().id}`.slice(0, 200),
        };
        const res = (await workRequest(this, 'POST', '/v1/webhooks', {
          body,
          headers: { 'Idempotency-Key': `n8n_hook_${this.getWorkflow().id}_${this.getNode().id}_${Date.now()}` },
        })) as IDataObject;
        const hook = (res.webhook ?? {}) as IDataObject;
        if (!hook.id || !res.secret) return false;
        const state = this.getWorkflowStaticData('node') as HookState;
        state.webhookId = String(hook.id);
        state.webhookSecret = String(res.secret);
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node') as HookState;
        if (state.webhookId) {
          try {
            await workRequest(this, 'DELETE', `/v1/webhooks/${encodeURIComponent(state.webhookId)}`, {
              headers: { 'Idempotency-Key': `n8n_unhook_${state.webhookId}` },
            });
          } catch {
            return false;
          }
        }
        delete state.webhookId;
        delete state.webhookSecret;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject() as ReturnType<IWebhookFunctions['getRequestObject']> & { rawBody?: Buffer };
    const options = this.getNodeParameter('options', {}) as IDataObject;
    const state = this.getWorkflowStaticData('node') as HookState;
    if (options.verifySignature !== false) {
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(this.getBodyData()));
      const verdict = state.webhookSecret ? verifySignature(state.webhookSecret, req.headers, raw) : 'bad-signature';
      if (verdict !== 'ok') {
        const res = this.getResponseObject();
        res.status(401).json({ error: { status: 401, code: verdict, message: 'The delivery is not signed with this trigger\'s secret.' } });
        return { noWebhookResponse: true };
      }
    }
    const event = this.getBodyData() as IDataObject;
    const headers = this.getHeaderData() as IDataObject;
    return {
      workflowData: [this.helpers.returnJsonArray([{ ...event, webhookId: headers['webhook-id'] ?? null }])],
    };
  }
}
