import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/** A divdio Work API token (dwk_…) and the board's address. The token is kept by n8n's credential store. */
export class DivdioWorkApi implements ICredentialType {
  name = 'divdioWorkApi';

  // eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-miscased -- the brand is written in lowercase: divdio
  displayName = 'divdio Work API';

  icon = 'file:../nodes/DivdioWork/divdioWork.svg' as const;

  documentationUrl = 'https://divdio.com/help/work/n8n';

  properties: INodeProperties[] = [
    {
      displayName: 'Board URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      placeholder: 'https://work.example.com',
      required: true,
      description: 'The address of your divdio Work board, hosted or self-hosted, without /v1',
    },
    {
      displayName: 'API Token',
      name: 'apiToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'A token from Settings → API & webhooks (starts with dwk_). Give it the scopes your workflows need: read, cards:write, decisions:answer, docs:write, and webhooks:manage for the trigger.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiToken}}' },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
      url: '/v1/me',
    },
  };
}
