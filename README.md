# BE patch — Gateway log push endpoint

Hotový patch pro `iot_smartlock` repo, který doplní vše potřebné pro push access logů z gateway middleware. Obsahuje:

- Bearer token auth pro `/api/gateway/*` (`requireGatewayApi`)
- POST `/api/gateway/access/logs` s idempotencí dle `(deviceId, seq)`
- Prisma migration: 3 nová pole na `AccessRequest` (`deviceId`, `seq`, `uid`) a 2 na `AccessResult` (`openMs`, `denyReason`)
- Zod validation schema
- Rozšíření `env.ts` o `GATEWAY_TOKEN`

## Aplikace patche

### 1. Zkopírovat soubory do repa

```bash
cd iot_smartlock
# pět nových souborů (přepíše existující env.ts a dvě prisma schemata)
cp -r ../iot_smartlock-patch/* .
```

Změněné/nové soubory:

| Soubor | Typ |
|---|---|
| `src/lib/auth/gateway-auth.ts` | **nový** |
| `src/lib/validations/gateway-log.ts` | **nový** |
| `src/app/api/gateway/access/logs/route.ts` | **nový** |
| `src/lib/env.ts` | **změna** (přidán `GATEWAY_TOKEN`) |
| `prisma/schema/access-request.prisma` | **změna** (gateway fields + `uq_device_seq` unique) |
| `prisma/schema/access-result.prisma` | **změna** (`openMs`, `denyReason`) |
| `prisma/migrations/20260512120000_gateway_log_push/migration.sql` | **nový** |

### 2. Vygenerovat token a doplnit do .env

```bash
# Wygenerovat 64-hex token (32 bytes)
echo "GATEWAY_TOKEN=$(openssl rand -hex 32)" >> .env.local
```

### 3. Spustit migraci a regenerovat Prisma client

```bash
npm run db:migrate          # Prisma migrate dev/deploy
# nebo explicitně:
npx prisma migrate deploy
npx prisma generate
```

### 4. Restart Next.js

```bash
npm run dev
```

### 5. Smoke test

```bash
# Mělo by vrátit 401 (žádný token)
curl -i http://localhost:3000/api/gateway/access/logs -X POST -H "Content-Type: application/json" -d '{"items":[]}'

# Mělo by vrátit 422 (prázdný items, schema vyžaduje min 1)
curl -i http://localhost:3000/api/gateway/access/logs -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"items":[]}'

# Validní request (potřebuješ existující IDs v DB)
curl -i http://localhost:3000/api/gateway/access/logs -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "deviceId": 12345,
      "seq": 1,
      "uid": "DEADBEEF",
      "request": {
        "userId": 1, "cardId": 1, "roomId": 1,
        "requestedAt": "2026-05-12T10:00:00.000Z"
      },
      "result": {
        "result": "OK",
        "completedAt": "2026-05-12T10:00:03.000Z",
        "openMs": 3000,
        "denyReason": null
      }
    }]
  }'
# → 201 { "accepted": 1, "skipped": 0 }

# Retry stejného requestu by mělo vrátit accepted=0, skipped=1 (idempotence)
```

## Designová rozhodnutí

### Idempotence

Unikátní klíč `(deviceId, seq)` je nově `@@unique` v Prismě. Server před každým insertem dělá `findUnique`, takže duplicity se tiše přeskočí (vrací `skipped++`). Pokud klient pošle dříve jen REQUEST část (`result: null`) a později k tomu outcome, server v duplicitní cestě udělá `upsert` na `AccessResult`.

### FK validace

Pole `userId`, `cardId`, `roomId` v Prisma modelu jsou `NOT NULL`. Pokud gateway nepošle některé z nich (neznámá karta, nemapovaný device), server **odmítne záznam** s diagnostickým errorem v response, místo aby zápis prošel se zfalšovanými FK.

To je záměrné — diagnostika pro neznámé karty zůstává v gateway-side `access_log` tabulce (SQLite). Pokud chceš tyto případy reportovat i do BE, je třeba změnit Prisma schema na `userId Int?` atd. (větší změna, mimo scope patche).

### Constant-time token check

`gateway-auth.ts` používá `crypto.timingSafeEqual` místo `===`, aby token nešel extrahovat side-channelem (měřením doby odpovědi). Pokud `GATEWAY_TOKEN` není v env nastaven, endpoint vrací 503, místo aby pustil unauth provoz.

### HTTP status convention

| Status | Význam | Gateway retry chování |
|---|---|---|
| `201` | Vše OK (i s tichým skip duplicit) | Označit `sentToBackend=1` |
| `400` | Invalid JSON | Poison — **nezkoušet znovu** |
| `401` | Bad/missing Bearer | Retry po fixu tokenu |
| `422` | Schema validation | Poison |
| `500` | Unexpected (DB down apod.) | Retry s back-offem |
| `503` | `GATEWAY_TOKEN` nenakonfigurován | Retry — admin musí doplnit env |

Gateway flow (`flushFailFn` + `markSentFn` v `flows.json`) momentálně rozlišuje jen 2xx vs. else. **Pro produkci doporučuji v gateway přidat `isPoison` flag** do `access_log` a nastavit ho při 4xx (jinak hrozí infinite loop na vadných záznamech).

## Volitelné navazující změny

Nejsou součástí tohoto patche, ale dávají smysl jako další PR:

1. **OpenAPI doc registration** — přidat `registry.registerPath(...)` v `src/lib/openapi/spec.ts` pro `/api/gateway/access/logs`, aby se to objevilo v Swagger UI na `/docs`.
2. **Rate limiting** — middleware s token bucket per `GATEWAY_TOKEN` (max 100 requestů/min).
3. **Multi-tenant** — `GatewayClient` entita v Prismě, per-gateway tokeny, audit log connections.
4. **Device entita** — `prisma/schema/device.prisma` + `GET /api/admin/devices` (mapování `deviceId → roomId` přesunout z gateway SQLite do BE).
