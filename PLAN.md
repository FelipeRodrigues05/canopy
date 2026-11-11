# PLAN — Distributed Wagering Processor

Nov 11, 2026 · baseado em `SPEC — Distributed Wagering Processor.md`

Plano de execução em 3 dias. O SPEC diz **o quê**; este documento diz **como**, seguindo as convenções de NestJS, TypeScript, MikroORM e Bun. Ambiente local verificado: Bun 1.4.4 e Docker.

---

## 0. Ajustes no SPEC antes de codar

**Status: as seis recomendações foram aceitas em 11/11 e aplicadas ao SPEC.** Projeto: **Canopy**.

| # | Problema no SPEC | Recomendação |
| --- | --- | --- |
| A1 | `idempotency_key UNIQUE` é global: dois provedores que gerem a mesma key colidem e um recebe 409 indevido. | `UNIQUE (provider_id, idempotency_key)`. |
| A2 | `wallet_id NOT NULL REFERENCES wallets` impede persistir uma transação `REJECTED` com `WALLET_NOT_FOUND`. | Não persistir esse caso: validar a wallet antes do INSERT e responder 422 sem gravar. O replay continua estável, porque a wallet não pode passar a existir com o mesmo id. Alternativa: tornar `wallet_id` nullable. |
| A3 | `ux_reversal_once (reference_transaction_id, kind)` deixa a mesma BET receber um REFUND **e** um ROLLBACK, ou seja, crédito duplicado. | Índice único só em `reference_transaction_id` (`WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`): cada transação é revertida no máximo uma vez, qualquer que seja o tipo. ROLLBACK de um REFUND continua possível, porque referencia o REFUND e não a BET. |
| A4 | O cursor do ledger em `(created_at, id)` usa o relógio da aplicação. Com 3 instâncias os relógios divergem, e a ordem fica diferente da ordem real de aplicação. | Adicionar `sequence bigint` = `wallets.version` no momento do lançamento, com `UNIQUE (wallet_id, sequence)`. Como os lançamentos de uma wallet são serializados pelo lock, a sequência é monotônica e sem buracos (bom para a auditoria), e o cursor passa a ser `(wallet_id, sequence)`. |
| A5 | Replay de uma transação que estava `PENDING_REFERENCE` (202) e depois foi processada: devolve o snapshot original ou o estado atual? | Devolver o snapshot original (202), como manda a regra 7.7; o provedor consulta o estado atual pelo `GET`. Documentar no ARCHITECTURE.md. |
| A6 | O SPEC aceita "string decimal com 2 casas" mas não diz se `"10"` ou `"10.5"` são válidos. | Aceitar de 0 a 2 casas na entrada e sempre devolver com exatamente 2. A regex do DTO é a primeira barreira e `Money.from()` é a fonte da verdade. |

---

## 1. Convenções (padrões da linguagem e do framework)

### TypeScript
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`.
- `experimentalDecorators` + `emitDecoratorMetadata`, que o NestJS exige. O Bun respeita os dois.
- Proibido `any`. Erros tipados por classe e `catch (e: unknown)` com narrowing.
- Dinheiro: lint customizado (regra `no-restricted-syntax`) proibindo `Number(`, `parseFloat` e `+x` nos arquivos de `domain/` e nos mappers de dinheiro.

### NestJS
- **Um módulo por feature** (`WalletModule`, `WageringModule`, `MessagingModule`, `ReconciliationModule`, `HealthModule`, `AuthModule`, `ObservabilityModule`) e um `SharedModule`/`DatabaseModule` global mínimo.
- **Arquivos em kebab-case com sufixo de tipo**: `wallet.controller.ts`, `create-wallet.use-case.ts`, `wallet.repository.ts`, `wallet.orm-entity.ts`, `create-wallet.dto.ts`, `money.spec.ts`.
- **Portas como `abstract class`**, que funcionam como token de DI sem `@Inject(SYMBOL)`: `export abstract class WalletRepository { abstract findByIdForUpdate(...) }` e `{ provide: WalletRepository, useClass: MikroOrmWalletRepository }`.
- **DTOs** com `class-validator` + `class-transformer` e `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`).
- **Config** com `@nestjs/config` + validação do `.env` por schema (zod ou class-validator) e falha no boot se faltar variável.
- **Erros**: exceções de domínio puras, convertidas em HTTP por um `ExceptionFilter` global de acordo com a tabela de status do SPEC. Rejeição de negócio (`REJECTED`) não é exceção: é um resultado do use case que o controller converte em 422.
- **Ciclo de vida**: `app.enableShutdownHooks()`, `OnApplicationBootstrap` para iniciar os pollers e `BeforeApplicationShutdown`/`OnApplicationShutdown` para drenar e fechar.
- **Rotas públicas** marcadas com o decorator `@Public()` e o guard JWT registrado como `APP_GUARD`.

### Camadas (hexagonal dentro de cada módulo)
```
<module>/
  domain/          # entidades, value objects, erros, eventos — sem Nest nem MikroORM
  application/     # use cases + portas (abstract classes)
  infrastructure/  # ORM entities, mappers, repositórios, adaptadores SQS
  presentation/    # controllers, DTOs, consumers, schedulers
  <module>.module.ts
```
Regra de dependência: `presentation → application → domain` e `infrastructure → application/domain`. Verificar com `eslint-plugin-boundaries` (ou `dependency-cruiser`) no CI.

### MikroORM
- `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/nestjs`, `@mikro-orm/migrations` (última major estável).
- **Entidades de persistência separadas do domínio** (`*.orm-entity.ts`) definidas com `defineEntity`/`EntitySchema` e tipos explícitos, sem depender de reflection. Assim o domínio fica sem ORM (RNF08) e evitamos problemas de metadata no Bun.
- Mappers explícitos `toDomain()`/`toPersistence()`. `numeric(20,2)` mapeado como `DecimalType` em modo `string`, e só o mapper cria `Money`.
- Transações por `em.transactional()`, encapsulado no adaptador `UnitOfWork`.
- Fora do ciclo HTTP (consumer, workers) usar `@CreateRequestContext()` ou `em.fork()` em cada iteração, nunca o EM global.
- SQL específico de Postgres via `qb`/`em.execute`: `INSERT ... ON CONFLICT DO NOTHING`, `FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`) e `FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`).
- Migrations escritas à mão em `up()`/`down()` com SQL (triggers, índices parciais e `REVOKE` não saem do schema generator). Rodar por script (`scripts/migrate.ts` com `orm.migrator.up/down`) em vez do CLI, que é mais frágil sob Bun.

### Bun
- `bun install`, `bun run`, `bun test` (runner único). Testes `*.spec.ts` ao lado do código (unidade) e em `test/` (integração, concorrência, carga).
- Dev com `bun --watch src/main.ts`; type-check com `tsc --noEmit` (o Bun não faz type-check).
- Imagem Docker `oven/bun:1` multi-stage, rodando como usuário não-root.

### Qualidade
- ESLint (`typescript-eslint` strict-type-checked) + Prettier, os padrões do Nest.
- `bun run check` = `tsc --noEmit && eslint . && bun test src`.
- Conventional Commits, um commit por etapa entregável. O histórico conta na avaliação.

---

## 2. Estrutura do repositório

```
canopy/
├── docker-compose.yaml            # postgres, localstack, keycloak, app (scale 3), nginx opcional
├── docker-compose.test.yaml       # postgres + localstack isolados para testes
├── Dockerfile
├── infra/
│   ├── localstack/init-sqs.sh    # cria filas FIFO, DLQ e redrive
│   └── keycloak/realm-wagering.json
├── scripts/
│   ├── migrate.ts                # up | down | create
│   └── wait-for-deps.ts
├── src/
│   ├── main.ts                   # bootstrap; APP_ROLES=api,consumer,workers
│   ├── app.module.ts
│   ├── config/                   # env.schema.ts, *.config.ts (registerAs)
│   ├── shared/
│   │   ├── domain/               # money.ts, currency.ts, entity-id.ts, domain-error.ts, integration-event.ts
│   │   ├── application/          # unit-of-work.ts, clock.ts, id-generator.ts (portas)
│   │   └── infrastructure/       # mikro-orm.config.ts, unit-of-work.mikro-orm.ts, uuidv7.id-generator.ts, canonical-hash.ts
│   ├── modules/
│   │   ├── wallet/               # Wallet, WalletLedgerEntry, CreateWallet, GetWallet, ListLedger
│   │   ├── wagering/             # WagerTransaction, SubmitWagerTransaction, ResolvePendingReferences, GetTransaction
│   │   ├── messaging/            # Inbox, Outbox, SqsConsumer, OutboxPublisher, eventos
│   │   ├── reconciliation/
│   │   ├── auth/                 # JwtStrategy/Guard, @Public, ProviderIdentity
│   │   ├── health/
│   │   └── observability/        # logger, métricas, correlation id (nestjs-cls)
│   └── database/migrations/
├── test/
│   ├── support/                  # app factory, db helpers (SQL direto), sqs helpers, spawn de instâncias
│   ├── integration/
│   ├── concurrency/
│   └── load/
├── README.md
└── ARCHITECTURE.md
```

**Papéis do mesmo binário:** `APP_ROLES` controla quais providers sobem (`api` registra controllers e listen; `consumer` registra o poller SQS; `workers` registra o outbox publisher e o pending-reference worker). Usar `ConditionalModule.registerWhen` do `@nestjs/config` ou módulos dinâmicos. No Compose: `app` (todos os papéis) com `--scale app=3`.

---

## 3. Dependências

| Pacote | Uso |
| --- | --- |
| `@nestjs/core`, `common`, `platform-express`, `config`, `terminus`, `passport`, `jwt` | Framework |
| `@mikro-orm/core`, `postgresql`, `nestjs`, `migrations` | ORM |
| `decimal.js` | Aritmética do `Money` |
| `class-validator`, `class-transformer` | DTOs |
| `@aws-sdk/client-sqs` | Consumer e publisher |
| `nestjs-pino`, `pino`, `pino-http` | Logs JSON |
| `nestjs-cls` | `correlationId` por AsyncLocalStorage (HTTP, SQS, workers) |
| `@willsoto/nestjs-prometheus`, `prom-client` | `/metrics` |
| `passport-jwt`, `jwks-rsa` | Validar JWT do Keycloak |
| `uuid` (v7) | IDs |
| dev: `typescript`, `@types/*`, `eslint`, `typescript-eslint`, `prettier`, `@nestjs/testing`, `supertest` | Qualidade e testes |
| `k6` (via imagem `grafana/k6`) | Teste de carga |

Testcontainers sob Bun ainda tem arestas. Recomendo `docker-compose.test.yaml` + `wait-for-deps.ts` (mais previsível) e deixar Testcontainers como alternativa.

---

## 4. Etapas

Cada etapa termina com `bun run check` verde e um commit. O **DoD** (definição de pronto) repete o critério de aceite do SPEC e acrescenta o que falta para ele ser verificável.

### DIA 1: fundação, domínio, schema, wallets, submit HTTP

#### Etapa 1: Fundação (≈2h)
1. `bun init`, `package.json` com scripts: `start`, `dev`, `build` (tsc), `check`, `test`, `test:unit`, `test:integration`, `test:concurrency`, `test:load`, `migration:up`, `migration:down`, `migration:create`.
2. `tsconfig.json` strict (seção 1), `.eslintrc`, `.prettierrc`, `.editorconfig`, `.env.example`.
3. `docker-compose.yaml`: `postgres:16` (healthcheck `pg_isready`), `localstack/localstack` com `init-sqs.sh` criando `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive `maxReceiveCount=5`) e `wallet-events.fifo`.
4. `ConfigModule` com schema validado; `MikroOrmModule.forRootAsync`; `LoggerModule` (pino JSON, `genReqId` lendo `X-Correlation-Id`, `redact` para `amount`, `balance` e `authorization`).
5. `HealthModule`: `/health/live` (200 fixo) e `/health/ready` (`MikroOrmHealthIndicator` + `SqsHealthIndicator` custom com `GetQueueAttributes`).
6. Migration inicial vazia + `scripts/migrate.ts`.

**DoD:** `docker compose up` sobe tudo; `/health/ready` = 200; `migration:up` e `migration:down` rodam sem erro.

#### Etapa 2: Domínio (≈3h, TDD)
- `Money` (`shared/domain/money.ts`): construtor privado; `Money.from(amount: string, currency)`, `Money.zero(currency)`, `add`, `subtract`, `isNegative`, `equals`, `compare`, `toProps(): MoneyProps`. Usa `Decimal` configurado com `ROUND_HALF_EVEN` e escala 2. Rejeita NaN, Infinity, notação científica, vazio, negativo, >2 casas e moeda divergente em operações.
- `Wallet`: `create`, `rehydrate`; `debit(money)` lança `InsufficientFundsError`; `credit(money)`; `reverseCredit(money)` lança `ReversalWouldOverdrawError`; mantém `version`; devolve o `WalletLedgerEntry` gerado.
- `WalletLedgerEntry`: `create` valida `balanceAfter = balanceBefore ± amount` e `amount > 0`; carrega `sequence`.
- `WagerTransaction`: máquina de estados `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED` e `PENDING_REFERENCE → PROCESSED | REJECTED`; transições a partir de estados terminais lançam erro. Métodos `markProcessed`, `reject(code)`, `awaitReference(nextRetryAt)`, `registerReferenceAttempt()`.
- `WagerPolicy` (serviço de domínio puro): dada a transação, a referência (opcional) e a wallet, decide `apply(debit|credit|none)` ou `reject(code)`. Concentra as regras de cada kind e de RF07.
- `FailureCode` (enum de string), `IntegrationEvent<T>` abstrata + os 4 eventos, `InboxMessage`, `OutboxMessage`.
- `canonicalHash(payload)`: JSON com chaves ordenadas recursivamente e só os campos de negócio → SHA-256 hex.

**DoD:** `bun test src` cobre todas as regras da lista de "Unidade" do SPEC; o lint de `domain/` não acusa imports de `@nestjs` ou `@mikro-orm`.

#### Etapa 3: Schema e wallets (≈2h)
- Migration `Migration20261111_init`: tabelas do SPEC com os ajustes A1–A4. Incluir:
  - trigger `ledger_immutable` (`BEFORE UPDATE OR DELETE ... RAISE EXCEPTION`) + `REVOKE UPDATE, DELETE ON wallet_ledger_entries FROM app_user`;
  - trigger `ledger_balance_matches_wallet` (`BEFORE INSERT`: `balance_before = wallets.balance` dentro do lock);
  - `down()` dropando tudo em ordem reversa.
- Usuário `app_user` sem DDL para a app e `migrator` com DDL (duas connection strings).
- `CreateWalletUseCase` (OPENING + CREDIT + outbox `WalletBalanceChanged` na mesma transação); `GetWalletUseCase`.
- `WalletController`: `POST /wallets` (201/409), `GET /wallets/:walletId`.

**DoD (integração real):** wallet duplicada = 409; `UPDATE`/`DELETE` no ledger falha no banco; `UPDATE wallets SET balance = -1` falha; `migration:down` seguido de `up` é idempotente.

#### Etapa 4: Submit via HTTP (≈4h, a etapa mais crítica)
`SubmitWagerTransactionUseCase.execute(command, source: 'HTTP' | { sqs: messageId })`, seguindo o fluxo do SPEC com estes detalhes:
1. Hash canônico; `OPENING` → `INVALID_PAYLOAD`.
2. `uow.run(async (tx) => { ... })` com retry só para `40P01`/`40001` (3x, jitter).
3. Inbox (se SQS) com `ON CONFLICT DO NOTHING RETURNING`.
4. `INSERT wager_transaction ... ON CONFLICT DO NOTHING RETURNING id`. Se não retornar linha: `SELECT` pela `(provider_id, idempotency_key)`. Hash igual → replay do `response_snapshot` (se ainda `PENDING`, o INSERT concorrente já esperou o commit do outro, então o snapshot existe). Hash diferente → `IdempotencyConflictError` (409). Mesma `(provider_id, external_transaction_id)` com key diferente → 409 também.
5. `SELECT wallet FOR UPDATE` → `WagerPolicy` → `wallet.debit/credit` → `UPDATE wallets SET balance, version = version + 1 WHERE id AND version = :old` (afetar 0 linhas = bug, lança erro).
6. INSERT ledger, UPDATE transação (status, snapshot), INSERT outbox (`WagerTransactionProcessed|Rejected` + `WalletBalanceChanged` se o saldo mudou).
7. Commit e só então a resposta.
- `WageringController.submit` com `@Headers('idempotency-key')` validado por um pipe e `@Res({ passthrough: true })` para 200/202/422 com `idempotentReplay`.
- `GlobalExceptionFilter` com o formato de erro do SPEC.

**DoD (integração + concorrência real):** 100.00 / 2x 80.00 → um `PROCESSED`, um `REJECTED`, saldo 20.00 e uma linha `DEBIT`; 50 envios paralelos da mesma BET → 1 débito; payload divergente → 409; replay devolve o saldo da época. Todo teste termina com `assertLedgerInvariant()`.

---

### DIA 2: mensageria, pendências, consultas, multi-instância

#### Etapa 5: Outbox publisher (≈2h)
- `OutboxPublisherWorker` (role `workers`): loop com `setTimeout` adaptativo (vazio → espera 500 ms; lote cheio → roda de novo já).
- Em cada ciclo, uma transação curta: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100`, `SendMessageBatch` (10 por chamada, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`), `UPDATE published_at` para os enviados e `attempts++` com `next_attempt_at` em backoff para as falhas.
- Métrica `outbox_lag_seconds` como gauge calculada no scrape.

**DoD:** dois publishers concorrentes não perdem nem duplicam eventos no banco (cada `id` é publicado ≥1x e `published_at` é marcado 1x); crash simulado entre o commit da transação de negócio e a publicação é recuperado por outra instância.

#### Etapa 6: Consumidor SQS (≈3h)
- `SqsConsumer` (role `consumer`): long polling (`WaitTimeSeconds=20`, `MaxNumberOfMessages=10`), processamento concorrente limitado por grupo e `AbortController` para parar.
- Envelope validado (`WagerTransactionRequested`) com class-validator; JSON inválido ou envelope inválido → erro permanente: envia para a DLQ e dá `DeleteMessage`.
- Classificação: sucesso ou rejeição de negócio → delete (ack); transitório (conexão, `40P01` esgotado, timeout) → `ChangeMessageVisibility(2^n s, teto 300)` sem ack; o redrive leva à DLQ após 5 recebimentos.
- `beforeApplicationShutdown`: para o polling, aguarda até 20 s as mensagens em voo e devolve visibilidade 0 das restantes.
- Hook de teste `CRASH_AFTER_COMMIT=1` (só com `NODE_ENV=test`), que faz `process.exit(137)` após o commit e antes do delete.

**DoD:** redelivery não duplica (inbox); erro permanente cai na DLQ; kill após commit e antes do ack → ao reprocessar, inbox detecta e dá ack sem novo débito.

#### Etapa 7: Referências pendentes (≈2h)
- No submit: referência ausente → `PENDING_REFERENCE`, `next_retry_at = now + 1s`, evento `WagerTransactionPendingReference`, resposta 202.
- `PendingReferenceWorker`: `SKIP LOCKED` em lote; para cada item, abre a transação, trava a wallet, busca a referência e reaplica a `WagerPolicy`. Sem referência: `attempts++` e `next_retry_at = now + min(2^attempts s, 300 s)`; ao chegar a 10 tentativas → `REJECTED/REFERENCE_NOT_FOUND` + evento.
- Otimização opcional: ao processar uma BET/WIN/REFUND, adiantar para `now()` o `next_retry_at` dos pendentes que a referenciam.

**DoD:** ROLLBACK antes da BET é aplicado quando a BET chega; sem BET vira `REJECTED` com `REFERENCE_NOT_FOUND` e evento (no teste, encurtar o backoff via config).

#### Etapa 8: Consultas e reconciliação (≈1,5h)
- `GET /wallets/:id/ledger?cursor&limit`: cursor base64url de `{ sequence }`, `limit` 1–200 e resposta `{ items, nextCursor }`.
- `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- `POST /wallets/:id/reconciliation`: `SUM(CASE direction ...)` em SQL comparado com `wallets.balance` e com o `balance_after` do último `sequence`. Divergência → log `warn`, `reconciliation_mismatches_total++` e `{ consistent: false, stored, computed, difference }`, sem nunca corrigir.

**DoD:** divergência induzida no teste (desabilitar o trigger dentro do teste com o usuário migrator e alterar o saldo) é logada, contada e sinalizada.

#### Etapa 9: Multi-instância e métricas (≈2,5h)
- `test/support/spawn-instances.ts`: `Bun.spawn` de 3 processos com portas distintas, aguardando `/health/ready`.
- Suíte `test/concurrency` com os 8 cenários do SPEC, distribuindo requests em round-robin entre as 3 instâncias.
- Cenário 8 (reinício): matar as 3 instâncias no meio de uma carga, subir de novo, esperar a outbox e os pendentes zerarem e verificar a invariante.
- Completar as métricas da lista do SPEC, com histograma de duração por `kind` e `source`.

**DoD:** os 8 cenários passam 10 execuções seguidas sem flakiness; todo teste termina com saldo = ledger.

---

### DIA 3: auth, carga e documentação

#### Etapa 10: Keycloak (≈2,5h)
- Compose: `quay.io/keycloak/keycloak` em modo dev com `--import-realm`; realm `wagering` com clients `provider-a` e `provider-b` (client credentials) e mapper de claim `provider_id`.
- `AuthModule`: `JwtStrategy` (`passport-jwt` + `jwks-rsa`, valida `iss` e `aud`), `JwtAuthGuard` como `APP_GUARD`, `@Public()` em health e metrics.
- `ProviderIdentityPort` (abstract class) implementada por `KeycloakProviderIdentity`; guard ou interceptor compara a claim com `body.providerId` → 403. Esse é o ponto de extensão para outro IdP.
- O consumer SQS não passa pelo guard (canal interno confiável).
- `AUTH_ENABLED=false` para as suítes que não testam auth, com teste dedicado para auth.

**DoD:** sem token = 401; token de `provider-a` com `providerId: provider-b` = 403; health sem token = 200.

#### Etapa 11: Teste de carga (≈2h)
- `bun run test:load` sobe o Compose com `--scale app=3` + nginx round-robin e roda `grafana/k6` com dois cenários: hot wallet (poucas wallets, muito contention) e distribuído (milhares de wallets).
- Ao final, um script Bun coleta o outbox lag e os conflitos em `/metrics`, roda a reconciliação de todas as wallets e grava `test/load/REPORT.md` (ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos, lag e invariante).

#### Etapa 12: Documentação (≈2,5h)
- **README.md:** pré-requisitos, `docker compose up`, variáveis, como obter token no Keycloak (curl pronto), como rodar cada suíte, exemplos de requests.
- **ARCHITECTURE.md:** diagrama (Mermaid) de componentes e da sequência do submit; ORM e mapeamento de Money; estratégia transacional e de lock (com a alternativa `UPDATE ... WHERE balance >= $1`); máquina de estados; hash canônico; taxonomia de erros e status HTTP; outbox/inbox e garantias at-least-once; auth; decisões A1–A6; trade-offs e limitações (ex.: o lock por wallet limita o throughput de hot wallet).

**Folga do dia 3:** cerca de 1h para bugs encontrados pela carga.

---

## 5. Estratégia de testes

| Suíte | Comando | Infra | Isolamento |
| --- | --- | --- | --- |
| Unidade | `bun test src` | nenhuma | puro |
| Integração | `bun run test:integration` | `docker-compose.test.yaml` (Postgres + LocalStack reais) | `TRUNCATE ... CASCADE` (usuário migrator) + purge das filas em `beforeEach` |
| Concorrência | `bun run test:concurrency` | mesma + 3 processos `Bun.spawn` | banco próprio `wagering_concurrency` |
| Carga | `bun run test:load` | Compose completo | ambiente dedicado |

- App de teste criada com `Test.createTestingModule(AppModule)`, sem sobrescrever repositórios (eliminatório: não mockar Postgres e SQS).
- Asserções de banco com SQL direto (`test/support/db.ts`), nunca via ORM.
- `assertLedgerInvariant()` em `afterEach` de todas as suítes de integração e concorrência.
- Os únicos fakes permitidos são `Clock` e o backoff, para acelerar o pending worker.

---

## 6. Riscos e mitigação

| Risco | Mitigação |
| --- | --- |
| Incompatibilidade pontual Nest/MikroORM sob Bun (metadata, CLI) | Validar na etapa 1 com uma entidade de teste; entidades sem reflection (`defineEntity`); migrations via script. Último recurso: rodar a app com Node só no container, mantendo o Bun para tooling/testes (documentar). |
| Dia 1 longo (etapa 4 é a mais densa) | Se atrasar, a etapa 8 (consultas) vai para o fim do dia 2, porque é a mais simples. |
| Testes de concorrência flaky | Sem `sleep`: polling por condição com timeout; seeds determinísticos; rodar 10x antes de commitar. |
| LocalStack FIFO e `ChangeMessageVisibility` com comportamento diferente da AWS | Testar o redrive cedo (etapa 6) e documentar divergências. |
| Keycloak lento para subir | Healthcheck no Compose e `depends_on: condition: service_healthy`; auth desligável nas suítes. |

---

## 7. Checklist contra os eliminatórios

- [ ] Nenhum `number` para dinheiro (lint + revisão de mappers)
- [ ] `CHECK (balance >= 0)` + lock por wallet + teste 2x 80.00
- [ ] Débito duplicado impossível: `UNIQUE` de idempotência, inbox, `UNIQUE (wallet_id, transaction_id)` no ledger e índice de reversão única
- [ ] Idempotência persistida no Postgres
- [ ] Suíte com 3 processos
- [ ] Outbox: publicação só pelo worker, após o commit
- [ ] Ledger imutável por trigger + `REVOKE`
- [ ] Testes com Postgres e LocalStack reais
