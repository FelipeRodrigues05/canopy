# SPEC — Distributed Wagering Processor

Nov 11, 2026 · @Felipe Rodrigues

## Resumo do desafio

O desafio pede um serviço financeiro distribuído que processe apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de vários provedores, por HTTP e por SQS, e continue correto com mensagens duplicadas, fora de ordem e concorrentes em 3+ instâncias. Não é CRUD: a nota vem de correção financeira, concorrência, idempotência e mensageria. Fonte: [README do junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge) (commit c7143e6, 29/07/2026), único arquivo do repositório.

**Obrigatório (README):** Bun 1.x, TypeScript estrito, NestJS, PostgreSQL, SQS via LocalStack/MiniStack, Docker Compose, migrations reversíveis, MikroORM (preferido) ou TypeORM; ledger imutável; inbox e outbox transacionais; worker de PENDING\_REFERENCE; reconciliação; logs JSON, métricas e health checks; testes de unidade, integração real e concorrência; README.md e ARCHITECTURE.md.

**Opcional (README):** autenticação via IdP externo (Keycloak/Zitadel; não vale pontos, mas se não fizer precisa documentar e deixar ponto de extensão), ledger de partidas dobradas, OpenTelemetry/dashboard, teste de carga em `bun run test:load`.

**Avaliação (100 pts, README):**

| Área | Pontos |
| --- | --- |
| Correção financeira | 20 |
| Concorrência | 20 |
| Idempotência | 15 |
| Mensageria e falhas | 15 |
| Modelagem e arquitetura | 10 |
| Testes | 10 |
| Observabilidade | 5 |
| Documentação | 5 |

**Eliminatórios (README):** `number` para dinheiro; saldo negativo por race; débito ou crédito duplicado; idempotência só em memória; correto só com uma instância; evento publicado antes do commit; sem ledger auditável; testes que mockam totalmente PostgreSQL e SQS.

**Prazo e forma de entrega:** o README não informa; Felipe confirmou 3 dias, com entrega por link de repositório no GitHub.

**Legenda deste doc:** \[README\] = exigido ou dito no README. \[Suposição\] = proposta minha, a decidir por você.

## Escopo e stack

A stack é fechada pelo README: Go não é aceito, então a implementação precisa ser em Bun + TypeScript + NestJS. \[README\]

| Item | Escolha | Origem |
| --- | --- | --- |
| Runtime, package manager e test runner | Bun 1.x | README |
| Linguagem | TypeScript `strict` | README |
| Framework | NestJS | README |
| Banco | PostgreSQL 16 | README (versão é suposição) |
| ORM | MikroORM com `em.transactional()` e `LockMode` | README diz preferencial |
| Mensageria | SQS FIFO via LocalStack | README (LocalStack ou MiniStack) |
| Decimal | `decimal.js` no domínio, `numeric(20,2)` no banco | Suposição |
| IDs | UUIDv7 | Suposição (exemplos do README usam UUIDv7) |
| Logs | `pino` (nestjs-pino) em JSON | Suposição |
| Métricas | `prom-client` em `GET /metrics` | Suposição |
| Testes de integração | Docker Compose ou Testcontainers com Postgres e LocalStack reais | README exige reais; ferramenta é suposição |

**Dentro do escopo \[README\]:** wallets, transações de aposta, ledger, inbox, outbox, worker de referências pendentes, publisher da outbox, consumidor SQS, reconciliação, health checks, observabilidade, testes e documentação.

**Fora do escopo \[README\]:** reversão parcial, conversão de moedas (pode assumir só BRL, mas o modelo continua multi-moeda), tabela própria de usuários com senha.

**Autenticação \[decidido 11/11\]:** entra no escopo com Keycloak no Docker Compose (realm importado por JSON). Provedores autenticam via client credentials (OAuth2), a API valida o JWT pelo JWKS do Keycloak, e o `providerId` do token precisa bater com o `providerId` do payload. Endpoints de health continuam abertos; mensagens da fila são canal interno confiável \[README\]. Como não vale pontos, fica no fim do roteiro.

## Requisitos funcionais e não funcionais

Todos os itens abaixo são \[README\], salvo quando marcado.

### Funcionais

1. **RF01 Criar wallet:** uma por `playerId + currency`; saldo inicial > 0 gera transação `OPENING` e lançamento `CREDIT` na mesma transação SQL; duplicada = conflito.
2. **RF02 BET:** debita; rejeita com saldo insuficiente.
3. **RF03 WIN:** credita; pode referenciar a BET da rodada.
4. **RF04 LOSS:** registra resultado, não mexe em saldo nem ledger, mas publica `WagerTransactionProcessed`.
5. **RF05 REFUND:** credita; só referencia BET `PROCESSED`, uma única vez, mesmo valor.
6. **RF06 ROLLBACK:** inverte BET, WIN ou REFUND `PROCESSED`, uma única vez, mesmo valor.
7. **RF07 Validação de referência:** resolvida por `(providerId, referenceExternalTransactionId)`; mesmo provider, player, wallet, moeda e rodada.
8. **RF08 Referência ausente:** grava `PENDING_REFERENCE`; worker reprocessa com backoff exponencial; esgotado o limite vira `REJECTED` com código próprio e evento.
9. **RF09 Reversão que deixaria saldo negativo:** `REJECTED` com `failureCode` diferente do de saldo insuficiente em BET.
10. **RF10 Idempotência:** header `Idempotency-Key` obrigatório; replay idêntico devolve a resposta original (inclusive o saldo da época) com `idempotentReplay: true`; mesma key com payload diferente = conflito.
11. **RF11 Consultas:** wallet, ledger paginado por cursor opaco, transação por id interno e por `(providerId, externalTransactionId)`.
12. **RF12 Reconciliação:** compara saldo armazenado com o reconstruído do ledger; divergência é logada, vira métrica e aparece na resposta, nunca é corrigida sozinha.
13. **RF13 Consumidor SQS:** mesmo use case do HTTP, inbox por `(consumerName, messageId)`, ack só após commit, DLQ após limite.
14. **RF14 Outbox:** eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`.
15. **RF15 OPENING interno:** não pode ser submetido pela API nem pela fila.

### Não funcionais

- **RNF01 Dinheiro exato:** nada de `number`; string decimal com 2 casas nos contratos; rejeitar NaN, Infinity, notação científica, vazio, >2 casas e negativos na entrada.
- **RNF02 Multi-instância:** correto com 3+ instâncias; unidade de concorrência = `walletId`; sem lock global.
- **RNF03 Garantias no schema:** unicidade, imutabilidade do ledger e saldo não negativo via constraints, índices e triggers no Postgres.
- **RNF04 Atomicidade:** transação, saldo, ledger, inbox e outbox no mesmo commit; nada publicado antes do commit.
- **RNF05 Resiliência:** tolerar queda de Postgres e SQS, crash antes ou depois do commit, `SIGTERM` com conclusão ou devolução de visibilidade.
- **RNF06 Observabilidade:** logs JSON sem payload financeiro completo; métricas mínimas; liveness e readiness abertos.
- **RNF07 Migrations:** versionadas e reversíveis.
- **RNF08 Modelagem:** construtor privado + factories `create`/`from`/`rehydrate`; domínio sem dependência de ORM ou NestJS.

## Arquitetura sugerida

Proponho um monolito modular em camadas (hexagonal), com o mesmo binário rodando em 3 papéis: API HTTP, consumidor SQS e workers (outbox e pending-reference). \[Suposição; o README só pede boundaries e portas claros\]

### Camadas e módulos \[Suposição\]

- `domain/`: `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos de integração, `FailureCode`. Sem imports de NestJS nem MikroORM.
- `application/`: `CreateWalletUseCase`, `SubmitWagerTransactionUseCase` (único ponto de entrada para HTTP e SQS), `ResolvePendingReferencesUseCase`, `PublishOutboxUseCase`, `ReconcileWalletUseCase`. Portas: `WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `UnitOfWork`, `EventPublisher`, `Clock`, `IdGenerator`, `ProviderIdentityPort`.
- `infrastructure/`: entidades e mappers MikroORM, adaptador SQS, publisher SNS/SQS de eventos, métricas, logger.
- `interfaces/`: controllers HTTP, consumidor SQS, schedulers dos workers, health.

### Fluxo de `SubmitWagerTransaction` \[Suposição, cumprindo regras do README\]

1. Validar DTO e construir `Money`; calcular `payloadHash` (SHA-256 do JSON canônico com chaves ordenadas dos campos de negócio).
2. Abrir transação SQL (`READ COMMITTED`).
3. Se a entrada for SQS: `INSERT` na inbox com `ON CONFLICT DO NOTHING`; se já existe processada, devolver o resultado e dar ack.
4. `INSERT` da `wager_transaction` com `ON CONFLICT (idempotency_key) DO NOTHING`. Se conflitou: ler a existente; hash igual = replay (devolve o snapshot de resposta guardado); hash diferente = conflito de idempotência.
5. `SELECT ... FOR UPDATE` na wallet (lock por linha, só dessa wallet).
6. Se exige referência: buscar e travar a referência; ausente = `PENDING_REFERENCE` + evento; presente = validar regras 2 a 5 da seção 7.
7. Aplicar no agregado (`wallet.debit/credit`), gerar `WalletLedgerEntry`, atualizar saldo com `version = version + 1`.
8. Marcar a transação `PROCESSED` ou `REJECTED`, gravar o snapshot de resposta (saldo observado) e enfileirar eventos na outbox.
9. Commit. Só depois disso: resposta HTTP ou ack SQS.

### Estratégia de concorrência \[Suposição\]

Recomendo **lock pessimista por wallet** (`SELECT ... FOR UPDATE`) mais a `CHECK (balance >= 0)` e o `version` como defesa extra. Motivo: em hot wallet o optimistic gera muitos retries; o lock por linha é simples de provar correto e não é global. Retry limitado (ex.: 3) só para deadlock (`40P01`) e serialization failure (`40001`). Alternativa a citar no ARCHITECTURE.md: `UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1`.

### Outbox publisher \[Suposição\]

Cada instância busca lotes com `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at LIMIT 100 FOR UPDATE SKIP LOCKED`, publica, marca `published_at`. Crash entre publicar e marcar gera duplicata, que é segura porque o consumidor deduplica por `eventId`. Entrega: at-least-once.

### Pending-reference worker \[Suposição\]

Mesmo padrão `SKIP LOCKED` em `wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= now()`. Backoff exponencial 1s, 2s, 4s... com teto de 5 min e limite de 10 tentativas \[decidido 11/11\]. Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND`.

### Topologia local \[Suposição\]

Docker Compose com `postgres`, `localstack` (cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` com redrive `maxReceiveCount=5`, e uma fila ou tópico de eventos de saída) e `app` escalável com `--scale app=3`.

## Modelo de dados e schema

O README exige que unicidade, imutabilidade e não negatividade estejam no schema \[README, seção 5.9\]; nomes, tipos e índices abaixo são \[Suposição\].

```sql
CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   uuid NOT NULL,
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id                                 uuid PRIMARY KEY,
  provider_id                        text NOT NULL,
  external_transaction_id            text NOT NULL,
  idempotency_key                    text NOT NULL,
  payload_hash                       char(64) NOT NULL,
  wallet_id                          uuid NOT NULL REFERENCES wallets(id),
  player_id                          uuid NOT NULL,
  round_id                           text NOT NULL,
  game_id                            text NOT NULL,
  kind                               text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                             numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency                           char(3) NOT NULL,
  reference_external_transaction_id  text,
  reference_transaction_id           uuid REFERENCES wager_transactions(id),
  status                             text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                       text,
  response_snapshot                  jsonb,          -- resposta original para replay
  reference_attempts                 integer NOT NULL DEFAULT 0,
  next_retry_at                      timestamptz,
  created_at                         timestamptz NOT NULL,
  processed_at                       timestamptz,
  UNIQUE (provider_id, external_transaction_id),
  UNIQUE (provider_id, idempotency_key),                     -- A1
  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CHECK ((status = 'REJECTED') = (failure_code IS NOT NULL) OR status = 'FAILED')
);
-- A3: cada transação é revertida no máximo uma vez, qualquer que seja o tipo (regra 7.4)
CREATE UNIQUE INDEX ux_reversal_once ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
CREATE INDEX ix_pending_ref ON wager_transactions (next_retry_at) WHERE status = 'PENDING_REFERENCE';

CREATE TABLE wallet_ledger_entries (
  id              uuid PRIMARY KEY,
  wallet_id       uuid NOT NULL REFERENCES wallets(id),
  transaction_id  uuid NOT NULL REFERENCES wager_transactions(id),
  sequence        bigint NOT NULL CHECK (sequence >= 1),  -- A4: = wallets.version no lançamento
  direction       text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount          numeric(20,2) NOT NULL CHECK (amount > 0),
  currency        char(3) NOT NULL,
  balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  created_at      timestamptz NOT NULL,
  UNIQUE (wallet_id, transaction_id),
  UNIQUE (wallet_id, sequence),
  CHECK (balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END)
);
-- imutabilidade: trigger que bloqueia UPDATE e DELETE (+ REVOKE UPDATE, DELETE do usuário da app)

CREATE TABLE inbox_messages (
  consumer_name  text NOT NULL,
  message_id     text NOT NULL,
  payload_hash   char(64) NOT NULL,
  received_at    timestamptz NOT NULL,
  processed_at   timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               uuid PRIMARY KEY,   -- = eventId
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  published_at     timestamptz
);
CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
```

**Pontos a defender na entrevista \[Suposição\]:**

- `UNIQUE (wallet_id, transaction_id)` garante no máximo um lançamento por transação por wallet \[README 6.4\].
- A consistência saldo = último `balance_after` pode ser verificada por trigger deferred ou só pela reconciliação; recomendo a trigger `BEFORE INSERT` no ledger conferindo `balance_before = wallets.balance` dentro do lock.
- `response_snapshot` atende "replay devolve o saldo observado naquele momento" \[README 7.7\] sem recalcular nada.
- Dinheiro em `numeric(20,2)`; o mapper MikroORM lê como string e converte para `Money` (nunca `number`).

## Endpoints, contratos e erros

Os endpoints e payloads são \[README, seção 9\]; o mapeamento de status HTTP e a taxonomia de `failureCode` são decisão do candidato, então tudo nas tabelas de status e códigos é \[Suposição\].

### Endpoints \[README\]

| Método e rota | Função |
| --- | --- |
| `POST /wallets` | Cria wallet com `playerId` e `initialBalance` |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado, cursor opaco e estável |
| `POST /wagering/transactions` | Submete operação; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | Transação por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação por id do provedor |
| `POST /wallets/:walletId/reconciliation` | Reconcilia saldo vs ledger |
| `GET /health/live`, `GET /health/ready` | Liveness e readiness, sem autenticação |
| `GET /metrics` | Métricas Prometheus \[Suposição\] |

Cursor do ledger \[decidido 11/11, A4\]: base64url de `{sequence}` com ordenação `(wallet_id, sequence)`; `limit` entre 1 e 200.

### Status HTTP \[Suposição\]

| Situação | Status | Provedor pode reenviar? |
| --- | --- | --- |
| Processada (nova ou replay) | 200, com `idempotentReplay` | Não precisa |
| Wallet criada | 201 | Não |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | 202 | Sim, mesmo payload (vira replay) |
| Payload inválido ou `Idempotency-Key` ausente | 400 | Não, corrigir |
| Wallet ou transação não encontrada (GET) | 404 | Não |
| Conflito de idempotência (mesma key, payload diferente) ou wallet duplicada | 409 | Não, nova key |
| Rejeição por regra de negócio (`REJECTED`) | 422 com `failureCode` | Não |
| Falha transitória (Postgres fora, timeout de lock) | 503 com `Retry-After` | Sim |
| Erro inesperado | 500 | Sim, com cautela |

Observação: uma transação `REJECTED` é persistida, então o replay dela devolve o mesmo 422 com `idempotentReplay: true`.

### Formato de erro \[Suposição\]

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "category": "BUSINESS", "retryable": false, "message": "...", "transactionId": "...", "correlationId": "..." } }
```

### Taxonomia de `failureCode` \[Suposição; o README exige que exista e seja documentada\]

| Código | Categoria | Quando |
| --- | --- | --- |
| `INVALID_PAYLOAD` | validação | Campos ausentes, Money inválido, `OPENING` submetido |
| `IDEMPOTENCY_CONFLICT` | conflito | Mesma key, hash diferente |
| `WALLET_NOT_FOUND` | negócio | Wallet inexistente |
| `WALLET_PLAYER_MISMATCH` | negócio | Wallet não pertence ao `playerId` |
| `CURRENCY_MISMATCH` | negócio | Moeda da operação diferente da wallet |
| `INSUFFICIENT_FUNDS` | negócio | BET sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | negócio | ROLLBACK que deixaria saldo negativo (distinto do anterior, README 7.9) |
| `REFERENCE_NOT_FOUND` | negócio | Limite do worker esgotado |
| `REFERENCE_MISMATCH` | negócio | Referência de outro player, wallet, moeda, provider ou rodada |
| `INVALID_REFERENCE_KIND` | negócio | REFUND de não-BET, ROLLBACK de LOSS |
| `REFERENCE_NOT_PROCESSED` | negócio | Referência `REJECTED` ou `FAILED` |
| `AMOUNT_MISMATCH` | negócio | Valor diferente da referência |
| `ALREADY_REVERSED` | negócio | Segunda reversão do mesmo tipo |
| `INFRA_PERMANENT_FAILURE` | infra | Status `FAILED`, auditoria |

## Mensageria, testes e observabilidade

### Consumidor SQS

- Filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`; mensagem `WagerTransactionRequested` com envelope `messageId`, `type`, `occurredAt`, `data`. \[README\]
- Dedup via inbox persistente; ack só após commit; erro de negócio = ack; transitório = retry com backoff; permanente = DLQ; limite de tentativas antes da DLQ. \[README\]
- `MessageGroupId = walletId` para ordenar por wallet no broker, só como otimização. \[Suposição; README diz que ordenação do broker não é garantia\]
- Retry transitório: `ChangeMessageVisibility` com 2^n segundos (teto 5 min), `maxReceiveCount = 5` no redrive. Erro permanente (ex.: JSON inválido): enviar direto à DLQ e dar ack. \[Suposição\]
- `SIGTERM`: parar o long polling, esperar mensagens em andamento por até 20 s, devolver visibilidade 0 das restantes, fechar o pool. \[Suposição para cumprir o README\]

### Eventos de integração \[README\]

`IntegrationEvent<T>` abstrata, uma subclasse por evento com `eventType` e `version` no tipo; `data` sempre com `MoneyProps` (string), nunca instância de `Money`. Destino de publicação: uma fila `wallet-events.fifo` no LocalStack \[Suposição; o README não nomeia o destino\].

### Testes obrigatórios \[README\]

- **Unidade:** Money (escala, arredondamento, entradas inválidas), invariantes da Wallet, regras de cada kind, conflito de moeda, idempotency key com payload divergente.
- **Integração com Postgres e LocalStack reais:** migrations e constraints, atomicidade wallet/ledger/inbox/outbox, inbox e redelivery, publishers concorrentes, retry e DLQ, recuperação após reinício.
- **Concorrência real:**
  1. mesma aposta 50x em paralelo = um débito;
  2. saldo 100.00, duas BET de 80.00 simultâneas = uma `PROCESSED`, uma `REJECTED`, saldo 20.00, um débito no ledger;
  3. wallets distintas em paralelo;
  4. 3 ou mais processos simultâneos;
  5. worker morto após commit e antes do ack;
  6. dois publishers na mesma outbox;
  7. ROLLBACK ou REFUND antes da referência;
  8. reinício do serviço com consistência final.
- **Invariante final em todo teste:** `wallet.balance == saldo reconstruído pelo ledger`.

Como simular \[Suposição\]: múltiplas instâncias com `Bun.spawn` de 3 processos apontando para o mesmo banco; crash entre commit e ack com um hook de teste que faz `process.exit` após o commit; asserções de banco com SQL direto, não via ORM.

### Observabilidade \[README, ferramentas são suposição\]

- Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem payload financeiro completo.
- Métricas mínimas (nomes sugeridos): `wager_transactions_total{status,kind}`, `idempotent_duplicates_total{source}`, `processing_retries_total{reason}`, `dlq_messages_total`, `lock_conflicts_total`, `outbox_lag_seconds` (idade do evento pendente mais antigo), `wager_processing_duration_seconds` (histograma), `reconciliation_mismatches_total`.
- `/health/ready` checa `SELECT 1` e `GetQueueAttributes` no SQS; `/health/live` só responde 200.

## Decisões em aberto

Decididas por Felipe em 11/11/2026:

| Tema | Decisão |
| --- | --- |
| Prazo e entrega | 3 dias, entrega como link de repositório no GitHub |
| Stack | Bun + NestJS |
| ORM | MikroORM |
| Concorrência | Lock pessimista por wallet (`SELECT ... FOR UPDATE`) + `CHECK (balance >= 0)` |
| Autenticação | Implementar com Keycloak (OIDC) |
| Teste de carga | Fazer, em `bun run test:load` |

Também decidido em 11/11: nome do projeto **Canopy**; eventos da outbox vão para uma fila SQS FIFO (`wallet-events.fifo`), e o worker de referência pendente desiste após 10 tentativas.

Ajustes ao SPEC aceitos em 11/11 (detalhes na seção 0 do PLAN):

| # | Decisão |
| --- | --- |
| A1 | Idempotência única por `(provider_id, idempotency_key)`, não global |
| A2 | `WALLET_NOT_FOUND` responde 422 sem persistir a transação (FK de `wallet_id` mantida) |
| A3 | `ux_reversal_once` só em `reference_transaction_id`: uma reversão por transação, qualquer tipo |
| A4 | Ledger com `sequence` (= `wallets.version`), `UNIQUE (wallet_id, sequence)`, usada como cursor |
| A5 | Replay de transação que respondeu 202 devolve o snapshot original (202); estado atual via `GET` |
| A6 | Money na entrada aceita 0 a 2 casas decimais; saída sempre com 2 |

## Roteiro em etapas e critérios de aceite \[Suposição na ordem; critérios vêm do README\]

1. **Fundação:** Docker Compose (Postgres + LocalStack com filas), projeto Nest em Bun, TS strict, MikroORM, migrations, logger JSON, health.
   - Aceite: `docker compose up` sobe tudo; `/health/ready` = 200; `migration:up` e `migration:down` funcionam.
2. **Domínio:** `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `FailureCode`, com testes de unidade.
   - Aceite: nenhum `number` em dinheiro; inputs inválidos rejeitados; transições terminais lançam erro; ledger valida aritmética.
3. **Schema e wallets:** tabelas com constraints, trigger de imutabilidade, `POST /wallets` com OPENING, `GET /wallets`.
   - Aceite: wallet duplicada = 409; UPDATE/DELETE no ledger falha no banco; saldo negativo falha no banco.
4. **Submit de transações via HTTP:** use case completo, idempotência, regras de BET/WIN/LOSS/REFUND/ROLLBACK, outbox na mesma transação.
   - Aceite: cenário 100.00 / 2x 80.00 passa; 50 envios paralelos = 1 débito; payload divergente = 409; replay devolve saldo original.
5. **Outbox publisher:** worker `SKIP LOCKED` com backoff.
   - Aceite: dois publishers não perdem eventos; crash após commit e antes de publicar é recuperado por outra instância.
6. **Consumidor SQS:** inbox, ack pós-commit, classificação de erros, DLQ, `SIGTERM`.
   - Aceite: redelivery não duplica; erro permanente cai na DLQ; kill após commit e antes do ack não duplica.
7. **Referências pendentes:** status `PENDING_REFERENCE`, worker com backoff e limite.
   - Aceite: ROLLBACK antes da BET é aplicado quando a BET chega; sem BET vira `REJECTED` com `REFERENCE_NOT_FOUND` e evento.
8. **Consultas e reconciliação:** ledger com cursor, GETs de transação, endpoint de reconciliação.
   - Aceite: divergência induzida em teste é logada, contada em métrica e sinalizada, sem correção.
9. **Multi-instância e métricas:** suíte com 3 processos, reinício do serviço, `/metrics` completo.
   - Aceite: todos os 8 cenários de concorrência passam e todo teste termina com saldo = ledger.
10. **Documentação:** README.md (setup e comandos) e ARCHITECTURE.md (ORM, mapeamento do Money, estratégia transacional e de lock, transições de estado, hash canônico, taxonomia de erros, status HTTP, auth, trade-offs e limitações).
    - Aceite: alguém sobe e roda os testes só lendo o README.
11. **Opcional:** teste de carga com p50/p95/p99, throughput, erros, conflitos e outbox lag; ledger de partidas dobradas; OpenTelemetry.

**Ajuste do roteiro para 3 dias \[decidido 11/11\]:** o item 11 deixa de ser opcional no teste de carga, e entra uma etapa de autenticação antes da documentação.

- **Autenticação com Keycloak:** Keycloak no Compose, realm com um client por provedor, guard JWT no Nest, checagem de `providerId`.
  - Aceite: request sem token = 401; token de `provider-a` enviando `providerId: provider-b` = 403; health sem token = 200.
- **Teste de carga (`bun run test:load`):** k6 ou script Bun contra 3 instâncias, com hot wallet e wallets distribuídas.
  - Aceite: relatório com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de lock e outbox lag, e saldo = ledger ao final.

Divisão sugerida: dia 1 = etapas 1 a 4; dia 2 = etapas 5 a 9; dia 3 = Keycloak, teste de carga e documentação.
