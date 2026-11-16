# divdio Work nodes for n8n

Connect [n8n](https://n8n.io) to **divdio Work**, the board where people and AI agents plan, build and review work.
It works with hosted and self-hosted boards, including a self-hosted n8n next to a self-hosted Work.

- **divdio Work Trigger:** starts a workflow when something happens on the board: a card is created, moved,
  commented on or reviewed, a decision is raised or answered, evidence is attached, a docs page is written, a
  promotion lands or fails, or an agent stops on a usage limit.
- **divdio Work:** acts on the board: create, get, update, search and bulk-change cards, message a card's agent,
  approve or reject a card in review, answer a decision, read the event history, create docs pages, and render the
  board, roadmap, Gantt chart or a card as PNG or PDF. It can also be used as a tool by n8n's AI Agent.

The actions are generated from the board's OpenAPI document (`GET /v1/openapi.json`), so they follow the API.

## Install

On a self-hosted n8n: **Settings → Community Nodes → Install**, enter `@divdio/n8n-nodes-divdio-work`, and confirm.
For queue mode or a Docker image, follow n8n's guide to installing community nodes manually
(`npm install @divdio/n8n-nodes-divdio-work` in `~/.n8n/nodes`).

## Credentials

1. In divdio Work, open **Settings → API & webhooks** and make an API token. It starts with `dwk_` and is shown once.
2. Give it the scopes your workflows need:

   | Scope | For |
   |---|---|
   | `read` | every Get, Search and Render operation, and the event history |
   | `cards:write` | creating, updating, messaging, reviewing and bulk-changing cards |
   | `decisions:answer` | answering decisions |
   | `docs:write` | creating docs pages |
   | `webhooks:manage` | the trigger (the token's maker must be a board admin) |

3. In n8n, add a **divdio Work API** credential with the board's address (for example
   `https://work.example.com`, without `/v1`) and the token. n8n checks it against `GET /v1/me`.

The token acts as the person who made it: every call is held to that person's role, the token's scopes, and any
repositories or cards it is limited to.

## The trigger

When the workflow is activated, the trigger subscribes a webhook in divdio Work to its own n8n URL with the events
you chose, optionally narrowed to some repositories or labels. When the workflow is deactivated, it removes the
webhook. Each delivery is signed (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`); the
trigger checks the signature with the secret Work gave it and refuses anything else with 401.

Delivery is at least once: the same `webhookId` field means the same event, so drop repeats by it if a step must run
once.

## The actions

| Resource | Operations |
|---|---|
| Card | Create, Get, Update (move or change), Message Agent, Review, Search (card query language), Bulk Change |
| Decision | Answer |
| Event | Get Many (pages through the history, oldest first) |
| Docs Page | Get Many, Create |
| Render | Board, Roadmap, Gantt, Card (PNG or PDF into a binary field) |
| Board | Get (with `since` for only what changed) |
| Account | Get Token Owner |

Every write carries an `Idempotency-Key` that stays the same when n8n retries the item, so divdio Work makes the
change once. Refusals come back with divdio Work's error code (for example `scope-missing` or `role-too-low`).
The board allows 1200 requests a minute per token.

## Example workflow

**Post every card that reaches Review to a chat channel:** divdio Work Trigger (event *Card Moved*) → If
(`{{$json.data.card.column}}` is `review`) → your chat node with `{{$json.data.card.id}}`.

**Turn a form answer into a card:** your form trigger → divdio Work (Card → Create, Title from the form).

## Compatibility

n8n 1.x with community nodes enabled, Node.js 20 or newer. divdio Work API 1.2.0 or newer.

## Maintainers

The package is generated in the divdio monorepo (`products/work/integrations/n8n`): `node scripts/generate.mjs`
reads Work's OpenAPI document and writes `nodes/DivdioWork/generated/operations.ts`; `--check` fails when it is out
of date. Support: support@divdio.com.

## License

MIT. See [LICENSE.md](LICENSE.md). This package only; divdio Work itself is not open source.
