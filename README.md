# Canopy

Distributed wagering processor: wallets, bets, wins, refunds and rollbacks from several providers, over HTTP and SQS, correct under duplicated, out-of-order and concurrent delivery across many instances.

Stack: Bun 1.x, TypeScript (strict), NestJS 12, MikroORM 7, PostgreSQL 16, SQS (LocalStack).

> Work in progress. Full setup, API and architecture docs arrive with the documentation stage.

## Quick start

```bash
bun install
docker compose up -d --build --scale app=3 --wait   # postgres, localstack, migrations, 3 app instances
curl localhost:3000/health/ready
```

## Tests

```bash
bun run check              # typecheck + lint + unit tests
bun run test:integration   # starts docker-compose.test.yaml (real Postgres + LocalStack)
```

## Migrations

```bash
bun run migration:up
bun run migration:down     # last one; `bun scripts/migrate.ts down all` reverts everything
bun run migration:create <snake_case_name>
```
