# Poly-Gate — Gateway для Polymarket

Единый шлюз (reverse-proxy + фасад) над публичными и приватными API Polymarket.

## Цели

1. **Единая точка входа** для трёх API Polymarket (Gamma, Data, CLOB) + приватная торговля.
2. **Централизованный контроль лимитов** запросов к Polymarket (см. Rate Limits) — чтобы не упираться в throttling Cloudflare со стороны всех наших процессов сразу.
3. **Своя авторизация L2 (POLY_1271, `signatureType: 3`)**: приватные ключи/креды кошельков хранятся в конфиге на нашей стороне, наружу отдаём один свой токен доступа. Поддержка нескольких кошельков (нескольких пользователей).

## Стек

- **Node.js 24 (TypeScript)**
- **Fastify** — HTTP-сервер
- **@fastify/swagger** + **@fastify/swagger-ui** — OpenAPI-документация
- **TypeBox** (`@sinclair/typebox` через `@fastify/type-provider-typebox`) — схемы валидации + автогенерация Swagger из них
- **zod** — валидация конфигурационного файла
- **@polymarket/clob-client-v2** + **viem** — подпись ордеров, L1/L2-аутентификация CLOB, balance/allowance (переиспользуем официальный SDK вместо копирования подписи вручную)
- **undici** (встроенный `fetch`) — проксирование публичных Gamma/Data запросов
- **Bottleneck** — токен-бакеты для контроля исходящих лимитов (in-memory, один инстанс)
- **pino** (встроен в Fastify) — логирование
- **vitest** — тесты

> SDK Polymarket (`@polymarket/clob-client-v2`) используем **только для приватных CLOB-эндпоинтов** (L2/подпись, ордера, `balance-allowance`). Все публичные запросы — Gamma, Data и **CLOB market data (`/books`)** — идут напрямую через `httpProxy` (undici/fetch), без SDK.

> **Работа без кредов:** сервис обязан стартовать и обслуживать публичные эндпоинты даже если в конфиге нет ни одного пользователя с `privateKey/creds`. Отсутствие кредов НЕ является фатальной ошибкой — приватные роуты в этом случае просто вернут понятную ошибку авторизации.

---

## Архитектура

```
Клиент ──(Bearer: наш токен)──▶ Poly-Gate ──(rate limiter)──▶ Gamma API
                                    │                       ├─▶ Data API
                                    │                       └─▶ CLOB API (L2 подпись на лету)
                                    └─ config: users[] (privateKey, creds, funder, ...)
```

Слои:
- **config** — загрузка + валидация YAML/JSON конфига (zod). Список пользователей-кошельков **опционален**: сервис стартует и без кредов (только публичные эндпоинты).
- **plugins** — `auth` (проверка нашего токена + выбор кошелька), `swagger`, `rateLimit`, `errorHandler`.
- **lib/rateLimiter** — реестр бакетов Bottleneck по группам лимитов Polymarket.
- **lib/polymarket** — `gammaClient`, `dataClient`, `clobClient` (обёртка SDK, кэш инстансов на пользователя).
- **routes** — эндпоинты, сгруппированные по доменам, каждый со схемой TypeBox.

### Структура каталогов
```
poly-gate/
  src/
    index.ts                 # bootstrap + listen + graceful shutdown
    server.ts                # сборка Fastify-инстанса, регистрация плагинов/роутов
    config/
      schema.ts              # zod-схема конфига
      index.ts               # загрузка и парсинг config-файла
    plugins/
      auth.ts                # Bearer-токен + выбор пользователя (X-Poly-User)
      swagger.ts
      rateLimit.ts           # регистрация исходящего лимитера
      errorHandler.ts        # маппинг ошибок upstream -> наши ответы
    lib/
      rateLimiter.ts         # Bottleneck-группы
      httpProxy.ts           # проксирование публичных запросов (Gamma/Data + CLOB /books) напрямую
      polymarket/
        gammaClient.ts
        dataClient.ts
        clobClient.ts        # обёртка @polymarket/clob-client-v2 (per-user)
        clientFactory.ts     # кэш клиентов по userId
    routes/
      health.ts
      events.ts              # Gamma
      profiles.ts            # Gamma
      marketData.ts          # CLOB /books (напрямую через httpProxy)
      trade.ts               # CLOB приватная торговля (L2)
      balance.ts             # CLOB balance/allowance (USDC + токены)
      dataCore.ts            # Data API: positions/activity/trades/leaderboard/holders/snapshot
    schemas/                 # общие TypeBox-схемы
    types/
  config.example.yaml
  .env.example               # путь к конфигу + порт (секреты — в config-файле)
  package.json
  tsconfig.json
  README.md
```

---

## Аутентификация

### Наш уровень (доступ к шлюзу)
- **Bearer требуется только там, где Polymarket требует авторизацию** (приватные CLOB-эндпоинты) — токен нужен, чтобы выбрать кошелёк-конфиг для L2-подписи.
- **Публичные роуты (Gamma, Data, CLOB market data) — без Bearer**, просто проксируются.
- **Модель:** у каждого пользователя-кошелька свой токен. Токен одновременно (а) аутентифицирует вызов и (б) однозначно выбирает кошелёк — заголовок `X-Poly-User` не нужен.
- Токены хранятся в конфиге; при старте строим индекс `token → user` (сравнение в постоянное время).

### Уровень Polymarket (L2, POLY_1271)
- Креды берём **из конфига** (заранее прописаны), API-ключи не создаём на лету, но добавим CLI-скрипт `scripts/derive-creds.ts` для первичного получения `apiKey/secret/passphrase` по `privateKey` (через `createOrDeriveApiKey`).
- На каждый приватный CLOB-запрос SDK формирует 5 заголовков `POLY_*` (HMAC-SHA256 на `secret`), ордера подписываются с `signatureType: 3`.
- **Про адреса (важно):**
  - `privateKey` → из него SDK/viem выводит адрес **signer** (EOA-подписант). Отдельно в конфиге его не храним.
  - `funder` — это **proxy wallet** пользователя Polymarket (адрес, на котором лежат средства), НЕ выводится из `privateKey`. Передаётся в `ClobClient({ funder, signatureType: 3 })`.
- **Из конфига берём ТОЛЬКО данные для авторизации** (`privateKey`, `funder`, `signatureType`, `creds`) — они используются для инициализации CLOB-клиента и подписи L2/ордеров.
- **Параметры эндпоинтов не трогаем и не автозаполняем.** Все path/query/body параметры — ровно как у Polymarket и приходят от клиента (в т.ч. `maker_address`, `user`, `address`, `token_id` и т.д.). Никакой автоподстановки адресов из конфига в параметры запросов нет.

### Пример конфига (`config.example.yaml`)
`users` — опциональный массив (может быть пустым/отсутствовать). Без пользователей работают только публичные эндпоинты.
```yaml
server:
  host: 0.0.0.0
  port: 8080
upstreams:
  gamma: https://gamma-api.polymarket.com
  data:  https://data-api.polymarket.com
  clob:  https://clob.polymarket.com
  chainId: 137
# users опционален: можно оставить пустым/убрать — тогда доступны только публичные эндпоинты
users:
  - id: main
    token: "REPLACE_WITH_STRONG_TOKEN"   # токен для доступа к нашему шлюзу
    privateKey: "0x..."                   # приватный ключ (из него выводится signer/EOA)
    funder: "0x..."                       # proxy wallet пользователя Polymarket (НЕ выводится из privateKey)
    signatureType: 3                      # POLY_1271
    creds:
      apiKey: "..."
      secret: "..."
      passphrase: "..."
rateLimits:
  enabled: true
  # опциональные оверрайды; по умолчанию берём значения из доков Polymarket
```

---

## Контроль лимитов (исходящий)

Централизованный in-memory лимитер на базе Bottleneck (шлюз запускается в одном инстансе): по одному бакету на **группу эндпоинтов** Polymarket (лимиты — скользящее окно 10 c / 10 мин). Каждый наш роут привязан к своему бакету. Все кошельки делят общие бакеты (лимиты у Polymarket на IP/аккаунт, не на кошелёк).

Значения по умолчанию (из доков; берём с запасом ~90%):

| Группа бакета            | Лимит Polymarket        | Наши роуты                                   |
| ------------------------ | ----------------------- | -------------------------------------------- |
| gamma:events             | 900 req/10s (listing)   | `GET /gamma/events/keyset`, `GET /gamma/events/slug/{slug}` |
| gamma:general            | 4000 req/10s            | `GET /gamma/public-profile`                  |
| clob:books               | 500 req/10s             | `POST /clob/books`                           |
| clob:order:post          | 5000/10s, 120k/10min    | `POST /clob/order`                           |
| clob:order:delete        | 5000/10s, 120k/10min    | `DELETE /clob/order`                         |
| clob:ledger              | 900 req/10s             | `GET /clob/data/order/{orderID}`             |
| clob:data:trades         | 500 req/10s             | `GET /clob/data/trades`                      |
| clob:balance             | 200 req/10s             | `GET /clob/balance-allowance`                |
| data:trades              | 200 req/10s             | `GET /data/trades`                           |
| data:positions           | 150 req/10s             | `GET /data/closed-positions`                 |
| data:general             | 1000 req/10s            | `GET /data/activity`, `GET /data/v1/leaderboard`, `GET /data/holders`, `GET /data/v1/accounting/snapshot` |

- Реализуем burst + sustained (Bottleneck `reservoir` + refresh) для торговых бакетов.
- При достижении лимита — очередь (как у Cloudflare), с таймаутом и ответом `429`/`503 Retry-After` при переполнении.
- Лимитируем только **исходящие** запросы к Polymarket; входящих лимитов на наш шлюз нет.

---

## Повторные попытки (retries)

Все исходящие запросы к Polymarket оборачиваем в retry с экспоненциальным backoff + jitter. **Исключение: `POST /clob/order`** — размещение ордера НЕ ретраим (повтор может создать дубликат ордера; клиент сам решает, что делать при ошибке).

- **Ретраим только идемпотентное:** все `GET`, `POST /clob/books` (read-only), `DELETE /clob/order` (отмена идемпотентна).
- **Условия ретрая:** сетевые ошибки (ECONNRESET/таймаут/DNS), `5xx`, а также `429/503` — c учётом `Retry-After`.
- **НЕ ретраим:** `4xx` (кроме `429`) — это ошибки запроса/валидации, повтор не поможет.
- **Параметры (по умолчанию, настраиваемо в конфиге):** `retries: 3`, базовая задержка `250ms`, множитель `2`, максимум `~4s`, полный jitter, общий таймаут на попытку.
- Ретрай применяется **внутри** бакета лимитера (каждая попытка проходит через rate limiter), поэтому повторы не пробивают лимиты.
- Реализация — единый helper `withRetry()` в `lib/httpProxy.ts`; для CLOB-методов SDK оборачиваем вызовы тем же helper'ом (кроме постинга ордера).

### Конфиг retries (добавка к `config.example.yaml`)
```yaml
retries:
  enabled: true
  attempts: 3          # число повторов сверх первой попытки
  baseDelayMs: 250
  maxDelayMs: 4000
  factor: 2
```

---

## Карта эндпоинтов (наш роут → upstream)

Правило именования: наш путь = `/<api>` + **оригинальный путь Polymarket** (`api` ∈ `gamma|clob|data`). Пути, path- и query-параметры, тела запросов не переименовываем — 1:1 как в доках Polymarket.

### Gamma (публичные, без Bearer) — префикс `/gamma`
- `GET /gamma/events/keyset` → `GET gamma /events/keyset` (keyset-пагинация, проброс `next_cursor`)
- `GET /gamma/events/slug/{slug}` → `GET gamma /events/slug/{slug}`
- `GET /gamma/public-profile` → `GET gamma /public-profile?address=`

### CLOB market data (публичные, без Bearer) — префикс `/clob`
- `POST /clob/books` → `POST clob /books` (массив `token_id`) — **напрямую через `httpProxy` (undici/fetch), НЕ через SDK**

### CLOB торговля (приватные, L2 + подпись, **требуют Bearer**) — префикс `/clob`
- `POST /clob/order` → `POST clob /order` — тело высокоуровневое (`tokenID, price, size, side, orderType` + **`tickSize` и `negRisk` обязательны от клиента**), сборка+подпись на стороне шлюза. **Без retry** (риск дубликата ордера)
- `DELETE /clob/order` → `DELETE clob /order` (тело `{ orderID }`)
- `GET /clob/data/order/{orderID}` → `GET clob /data/order/{orderID}`
- `GET /clob/data/trades` → `GET clob /data/trades` (`maker_address` и прочие параметры — от клиента, как у Polymarket)
- `GET /clob/balance-allowance` → CLOB balance/allowance: **USDC/collateral** (`asset_type=COLLATERAL`) или **конкретный токен** (`asset_type=CONDITIONAL` + `token_id`). Все параметры — от клиента; из конфига только авторизация (`signatureType`/`funder`/`creds`). Массового «все токены» нет.

### Data API (публичные, без Bearer) — префикс `/data`
Все параметры (`user`, `market`, `address` и т.д.) — ровно как у Polymarket, от клиента.
- `GET /data/closed-positions` → `GET data /closed-positions`
- `GET /data/activity` → `GET data /activity`
- `GET /data/trades` → `GET data /trades`
- `GET /data/v1/accounting/snapshot` → `GET data /v1/accounting/snapshot` (ZIP passthrough, `application/zip`)
- `GET /data/v1/leaderboard` → `GET data /v1/leaderboard`
- `GET /data/holders` → `GET data /holders`

### Служебные
- `GET /health` — жив ли шлюз (+ опционально ping `/ok` upstream'ов)
- `GET /docs` — Swagger UI

---

## Этапы реализации

### Этап 0. Каркас проекта
- `package.json`, `tsconfig.json`, ESLint/Prettier (или Biome), скрипты `dev/build/start/test`.
- Fastify-инстанс, `GET /health`, graceful shutdown, pino-логирование.
- Swagger + Swagger UI на `/docs`.

### Этап 1. Конфиг и аутентификация
- zod-схема конфига (`users` опционален, допускается пустой список), загрузчик (`POLY_GATE_CONFIG` → YAML), маскирование секретов в логах.
- Плагин `auth`: применяется только к приватным CLOB-роутам; Bearer-токен → индекс `token → user`, декоратор `request.polyUser`. Если пользователей нет — приватные роуты отвечают понятной ошибкой авторизации, сервис не падает.
- Единый `errorHandler` (маппинг upstream-ошибок → унифицированный JSON `{ error, code?, retryAfter? }`).

### Этап 2. Лимитер, retries и клиенты upstream
- `lib/rateLimiter.ts` — бакеты Bottleneck по таблице выше.
- `withRetry()` — общий helper повторных попыток (backoff+jitter, учёт `Retry-After`, исключение `POST /clob/order`).
- `httpProxy.ts` — helper проксирования публичных GET с прокидыванием query/статусов (использует лимитер + `withRetry`).
- `clientFactory.ts` + `clobClient.ts` — per-user инстансы `@polymarket/clob-client-v2` (кэш), `creds` из конфига.
- CLI `scripts/derive-creds.ts` — получение/деривация L2-кредов по `privateKey`.

### Этап 3. Публичные роуты (Gamma + Data)
- `events`, `profiles`, `dataCore` (closed-positions, activity, trades, leaderboard, holders, accounting snapshot).
- TypeBox-схемы запрос/ответ → попадают в Swagger. Каждый роут привязан к своему бакету.

### Этап 4. CLOB market data + приватная торговля
- `POST /clob/books` — напрямую через `httpProxy` (не SDK).
- `trade`: create/post order (tickSize/negRisk из тела, подпись на шлюзе, без retry), cancel, get order, get trades (`maker_address` от клиента) — через SDK с L2/подписью.
- `balance`: `balance-allowance` (COLLATERAL или CONDITIONAL по `token_id`, параметры от клиента).

### Этап 5. Качество и запуск
- Юнит-тесты (config, auth, rate limiter) + интеграционные (моки upstream через `undici` MockAgent).
- README (локальный запуск, конфиг, примеры), `.env.example`, `config.example.yaml`.
- Скрипты `dev` (watch) и `start` для локального запуска.

---

## Открытые вопросы / принятые по умолчанию решения

1. **Модель токенов** — ✅ решено: токен на каждого пользователя (он же выбирает кошелёк), без `X-Poly-User`.
2. **Формат конфига** — YAML-файл (путь через `POLY_GATE_CONFIG`). Можно переключить на `.env`/JSON при желании.
3. **Хранение лимитера** — in-memory (шлюз работает в одном инстансе, горизонтальное масштабирование не предполагается).
4. **Balance** — ✅ решено: только CLOB `balance-allowance` (COLLATERAL или CONDITIONAL по `token_id`). Массового списка всех токенов (`/data/positions`) не добавляем.
5. **Проброс vs нормализация ответов** — по умолчанию отдаём ответы Polymarket «как есть» (тонкий прокси), схемы Swagger описывают ключевые поля. Глубокую нормализацию не делаем.
6. **Heartbeat** — ✅ решено: в первой версии не реализуем. TS-клиент heartbeat сам не шлёт (только Rust SDK умеет фон), а сценарий требует цикла каждые ~5с + хранения chaining `heartbeat_id`. Если позже понадобится auto-cancel-защита открытых ордеров — добавим фоновый цикл на стороне шлюза (вкл/выкл по-кошельково).
7. **`POST /clob/order` тело** — ✅ решено: высокоуровневое (`tokenID, price, size, side, orderType`), `tickSize` и `negRisk` **обязательны от клиента**, подпись на шлюзе.
8. **Параметры эндпоинтов** — ✅ решено: все path/query/body параметры ровно как у Polymarket и приходят от клиента; из конфига берётся только информация для авторизации (никакой автоподстановки адресов).
9. **Bearer только где нужно** — ✅ решено: наш токен требуется лишь на приватных CLOB-эндпоинтах (для выбора кошелька-конфига под L2-подпись); публичные Gamma/Data/CLOB market data — без Bearer.
10. **CLOB `/books` напрямую** — ✅ решено: публичный `POST /clob/books` идёт через `httpProxy` (undici/fetch), не через SDK. SDK — только приватные CLOB-эндпоинты.
11. **Работа без кредов** — ✅ решено: `users` опционален; сервис стартует и обслуживает публичные эндпоинты без `privateKey/creds`. Приватные роуты без настроенного кошелька возвращают ошибку авторизации, но не роняют сервис.
```
