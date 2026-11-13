# Canopy

Processador distribuído de apostas: wallets, `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` vindos de vários provedores, por **HTTP** e **SQS**, corretos com mensagens **duplicadas**, **fora de ordem** e **concorrentes** em várias instâncias.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 12 · MikroORM 7 · PostgreSQL 16 · SQS (LocalStack 4.9) · Keycloak 26 · Docker Compose.

As decisões, garantias e trade-offs estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**. O relatório do teste de carga está em **[test/load/REPORT.md](test/load/REPORT.md)**.

---

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com o plugin Compose (v2)
- Portas livres: `3000-3002` (app), `5432` (Postgres), `4566` (LocalStack), `8080` (Keycloak). A stack de testes usa `55432`, `54566` e `58080`, então as duas podem rodar juntas.

```bash
bun install
```

## Subir tudo

```bash
docker compose up -d --build --scale app=3 --wait
```

Isso sobe:

| Serviço | O quê |
|---|---|
| `postgres` | PostgreSQL 16, com dois papéis: `canopy_migrator` (DDL) e `canopy_app` (só DML; sem `UPDATE`/`DELETE` no ledger) |
| `localstack` | SQS com `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wallet-events.fifo` |
| `keycloak` | IdP com o realm `wagering` importado de `infra/keycloak/realm-wagering.json` |
| `migrate` | Roda as migrations uma vez e sai |
| `app` ×3 | O serviço, cada réplica com os papéis `api`, `consumer` e `workers`, nas portas 3000, 3001 e 3002 |

```bash
curl localhost:3000/health/ready     # {"status":"ok", ... database: up, sqs: up}
docker compose down                  # para tudo (o volume do Postgres fica)
docker compose down -v               # para tudo e apaga os dados
```

> **Por que LocalStack 4.9?** A partir de 2026 a imagem `latest` exige `LOCALSTACK_AUTH_TOKEN` e não sobe sem conta. A 4.9 é a última versão community que roda sem token. O README do desafio também aceita MiniStack.

## Autenticação

Toda rota exige um bearer token do Keycloak, **menos** `/health/*` e `/metrics`. Cada provedor é um client OAuth2 com *client credentials*:

| Client | Secret | Pode |
|---|---|---|
| `provider-a` | `provider-a-secret` | submeter e ler transações **de `provider-a`**; criar/ler wallets |
| `provider-b` | `provider-b-secret` | o mesmo, como `provider-b` |
| `canopy-backoffice` | `canopy-backoffice-secret` | criar/ler wallets, reconciliar, ler qualquer transação; **não** submete apostas |

```bash
TOKEN=$(curl -s -X POST localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)
```

Os secrets ficam no JSON do realm só porque é um ambiente local. Em produção eles iriam para um secret manager.

## Exemplos

```bash
H=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

# Criar wallet (saldo inicial > 0 gera a transação OPENING + lançamento CREDIT no mesmo commit)
curl -s localhost:3000/wallets "${H[@]}" -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# → 201 {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1,...}

# Submeter uma aposta (Idempotency-Key é obrigatório)
curl -s localhost:3000/wagering/transactions "${H[@]}" -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<walletId>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
# → 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"walletVersion":2,"idempotentReplay":false}
# Reenviar o mesmo pedido → 200 com "idempotentReplay": true e o mesmo saldo de antes.

# Consultas
curl -s localhost:3000/wallets/<walletId> "${H[@]}"
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=50" "${H[@]}"         # paginação: ?cursor=<nextCursor>
curl -s localhost:3000/wagering/transactions/<transactionId> "${H[@]}"
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123 "${H[@]}"

# Reconciliação (saldo guardado × saldo reconstruído do ledger)
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation "${H[@]}"

# Pela fila (canal interno, sem token)
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-11-13T10:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp",
    "kind":"WIN","money":{"amount":"50.00","currency":"BRL"},"referenceExternalTransactionId":"transaction-123"}}'

# Eventos publicados pela outbox
aws --endpoint-url http://localhost:4566 sqs receive-message --max-number-of-messages 10 \
  --queue-url http://localhost:4566/000000000000/wallet-events.fifo
```

Status HTTP de `POST /wagering/transactions`: **200** processada · **202** aguardando a referência · **422** rejeitada por regra de negócio (`failureCode`) · **400** payload inválido ou sem `Idempotency-Key` · **409** mesma key com outro payload · **401/403** auth · **503** falha transitória (reenviar). Tabela completa e taxonomia de códigos no [ARCHITECTURE.md](ARCHITECTURE.md#erros-e-status-http).

## Testes

Nenhuma suíte mocka Postgres ou SQS: integração e concorrência rodam contra containers reais (`docker-compose.test.yaml`).

| Comando | O quê | Tempo |
|---|---|---|
| `bun run check` | tipos (`tsc`), lint (`oxlint`), regras de arquitetura e **testes de unidade** | ~5 s |
| `bun run test:integration` | sobe Postgres, LocalStack e Keycloak de teste e roda `test/integration` | ~1–2 min |
| `bun run test:concurrency` | mesmo processo + **3 processos reais** (`bun src/main.ts`) disputando as mesmas wallets | ~15 s |
| `bun run test:load` | teste de carga com 3 réplicas atrás de nginx; gera `test/load/REPORT.md` | ~3 min |
| `bun run test:infra:down` | derruba a infra de teste | |

As suítes de integração e concorrência compartilham o banco de teste: rode uma de cada vez.

Todo teste de integração e de concorrência termina conferindo, em SQL direto, a invariante do README para **todas** as wallets: `wallet.balance == saldo reconstruído pelo ledger` (e ledger sem buracos, numerado pela `version`).

## Migrations

```bash
bun run migration:up                     # aplica as pendentes (usa MIGRATOR_DATABASE_URL)
bun run migration:down                   # reverte a última
bun scripts/migrate.ts down all          # reverte todas
bun run migration:status
bun run migration:create <nome_snake>    # cria o arquivo; registre-o em src/database/migrations/index.ts
```

Com o Compose, as migrations rodam sozinhas no serviço `migrate`.

## Rodar sem Docker para o app

```bash
docker compose up -d postgres localstack keycloak --wait
docker compose run --rm migrate
cp .env.example .env
bun run dev          # bun --watch src/main.ts, porta 3000
```

## Variáveis de ambiente

Validadas no boot com zod. Se faltar alguma obrigatória, o processo não sobe. Referência completa em [`src/config/env.schema.ts`](src/config/env.schema.ts) e exemplo em [`.env.example`](.env.example).

| Variável | Padrão | Para quê |
|---|---|---|
| `APP_ROLES` | `api,consumer,workers` | papéis deste processo: HTTP, consumidor SQS, publisher da outbox + worker de pendências |
| `DATABASE_URL` / `MIGRATOR_DATABASE_URL` | obrigatórias | app (DML) / migrations (DDL) |
| `DATABASE_POOL_MAX` | `10` | conexões por processo |
| `AWS_ENDPOINT_URL`, `AWS_REGION`, credenciais | LocalStack | SQS |
| `SQS_WAGER_QUEUE`, `SQS_WAGER_DLQ`, `SQS_EVENTS_QUEUE` | nomes padrão | filas |
| `SQS_WAIT_TIME_SECONDS` / `SQS_VISIBILITY_TIMEOUT_SECONDS` | `20` / `30` | long polling / visibilidade |
| `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` | `20000` | quanto o `SIGTERM` espera mensagens em andamento |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo do publisher quando a outbox está vazia |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | tentativas antes de `REJECTED / REFERENCE_NOT_FOUND` |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_DELAY_MS` | `1000` / `300000` | backoff exponencial do worker de pendências |
| `AUTH_ENABLED` | `true` | com `true`, `AUTH_ISSUER` é obrigatório |
| `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE` | — / `{issuer}/protocol/openid-connect/certs` / `canopy-api` | validação do JWT |
| `LOG_LEVEL` | `info` | logs JSON (pino) |

## Observabilidade

- **Logs** em JSON (pino) com `correlationId` (header `X-Correlation-Id` ou gerado), `messageId`, `transactionId`, `walletId` e `providerId`. Valores e saldos saem como `[REDACTED]`.
- **Métricas** Prometheus em `GET /metrics` (por réplica): transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência e reconciliações. A lista está no [ARCHITECTURE.md](ARCHITECTURE.md#observabilidade).
- **Health:** `GET /health/live` (processo vivo) e `GET /health/ready` (`SELECT 1` no Postgres e `GetQueueAttributes` no SQS).

## Estrutura

```
src/
  main.ts, app.module.ts, http-app.ts     bootstrap e pipeline HTTP
  config/                                 schema do ambiente (zod)
  shared/                                 Money, Currency, erros, portas (UnitOfWork, Clock, IdGenerator, AppMetrics), adaptadores
  modules/
    wallet/          Wallet, WalletLedgerEntry, criação, consulta, ledger
    wagering/        WagerTransaction, WagerPolicy, submit (HTTP e SQS), worker de pendências
    messaging/       Inbox, Outbox, publisher
    reconciliation/  reconciliação
    auth/            porta de identidade, adaptador OIDC (Keycloak), guard
    health/, observability/
    <módulo>/{domain,application,infrastructure,presentation}
  database/migrations/
test/
  integration/  concurrency/  load/  support/
infra/          postgres/init.sh, localstack/init-sqs.sh, keycloak/realm-wagering.json, nginx/nginx.conf
scripts/        migrate.ts, wait-for-deps.ts, check-architecture.ts, load/run.ts
```
