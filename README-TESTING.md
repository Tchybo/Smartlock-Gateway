# Smoke test bez fyzického zámku

Návod pro zprovoznění gateway end-to-end na Win 11 ARM **bez čekání na zámek a bez BE patche**. Postupuj v tomto pořadí, ať nezápasíš se třemi věcmi najednou.

## Co se otestuje

| Vrstva | Test | Stav po dokončení |
|---|---|---|
| BE konektivita | `test-be-connection.ps1` | ✅ Bearer/X-API-Key/query: víme, co BE žere |
| LoRa serial vrstva | `lock-simulator.js` přes virtual COM | ✅ Gateway "vidí" simulovaný zámek |
| Authorization engine | Simulátor scan + ověření v debug nodech | ✅ Funguje cache + JOIN + builder |
| Log push do BE | (selže do aplikace patche) | ⏭ Logy zůstanou ve frontě SQLite |

---

## Krok 1 — BE smoke test (5 minut)

V PowerShellu na host stroji (NE v Dockeru):

```powershell
$env:BE_BASE_URL = "https://tvoje-produkce.cloud"   # bez trailing /
$env:BE_API_KEY  = "7c41..."                         # tvůj klíč
.\test-be-connection.ps1
```

Skript vyzkouší 3 auth metody (`Authorization: Bearer ...`, `X-API-Key: ...`, `?apiKey=...`). Jedna z nich musí projít. Tu pak nastav v `.env`:

```ini
BE_AUTH_MODE=bearer   # nebo xapikey / cookie
BE_API_KEY=7c41...
```

Pokud žádná metoda nefunguje, zeptej se BE týmu na přesný header — flow už podporuje switch přes `BE_AUTH_MODE`.

---

## Krok 2 — Virtual COM port pár (Win 11)

Cíl: vytvořit pár `COM3 ↔ COM4`, kde **gateway poslouchá na jednom konci a simulátor na druhém**. Vše, co simulátor pošle na COM4, gateway přijme na COM3 a obráceně.

### Instalace com0com

```powershell
# Win 11 ARM nutno: stáhnout signed ARM build z https://com0com.sourceforge.net/
# (původní instalátor je x86, ale funguje pod ARM emulací, jen vyžaduje
# disabled driver signature enforcement při instalaci - boot do Advanced
# startup -> Troubleshoot -> Advanced -> Startup Settings -> Disable driver
# signature enforcement)
# 
# Alternativa pro vývoj: vmware/parallels Linux VM, tam jen 'socat'.

# Po instalaci v Setup utility:
#   Virtual Port Pair Driver Setup
#   -> "use Ports class": ANO (jinak se neukáže v Device Manager)
#   -> CNCA0 = COM3
#   -> CNCB0 = COM4
```

Ověření:

```powershell
# V Device Manager → Ports (COM & LPT) musí být COM3 i COM4
# Z PowerShellu:
[System.IO.Ports.SerialPort]::GetPortNames()
# -> { COM3, COM4, ... }
```

### Alternativa: WSL2 + socat (pro vývoj)

Pokud používáš Docker Desktop už ve WSL2, můžeš si v Ubuntu WSL2 udělat:

```bash
sudo apt install socat
socat -d -d pty,raw,echo=0,link=/tmp/lora-sim pty,raw,echo=0,link=/tmp/lora-gw &
ls -la /tmp/lora-sim /tmp/lora-gw   # → /dev/pts/X
```

Gateway nasměruj na `/tmp/lora-gw`, simulátor na `/tmp/lora-sim`. Tohle je čistě v Linuxu, bez com0com.

---

## Krok 3 — Spustit gateway na COM3

Buď v Docker Desktop, nebo nativně (instalátor z `nodered.org`).

### Nativní Node-RED na Windows

```powershell
# Node.js 20 LTS musí být na Windows ARM (ARM64 instalátor z nodejs.org)
npm install -g --unsafe-perm node-red

# Sdílený modul
mkdir $env:USERPROFILE\.node-red -Force
Copy-Item slk-protocol.js $env:USERPROFILE\.node-red\

# Editor settings.js: přidat blok z settings-fragment.js
# Pak:
cd $env:USERPROFILE\.node-red
npm install node-red-node-serialport node-red-node-sqlite

# Env vars před spuštěním
$env:BE_BASE_URL = "https://tvoje-produkce.cloud"
$env:BE_API_KEY  = "7c41..."
$env:BE_AUTH_MODE = "bearer"

node-red
```

V editoru:
1. Import `flows.json`
2. Otevřít `serial-port` config node → port `COM3`
3. Otevřít `sqlitedb` config node → cesta `C:\smartlock\gateway.db` (nebo kdekoli si přeješ)
4. Deploy

Měl bys vidět:
- V debug panelu boot AT sekvenci (3 příkazy)
- Po 60s SQL upsert s daty z BE (`SELECT COUNT(*) FROM users` v gateway.db → ≥ 1)

---

## Krok 4 — Spustit lock simulator na COM4

V druhém terminálu:

```powershell
# Závislosti (jednou):
mkdir C:\smartlock-sim ; cd C:\smartlock-sim
npm init -y
npm install serialport
Copy-Item ...\lock-simulator.js .

# Spuštění (interaktivní)
node lock-simulator.js --port COM4 --device-id 0xCAFE0001
```

Měl bys vidět:

```
[sim] LoRa-E5 simulator
[sim]   port:      COM4
[sim]   device_id: 0xCAFE0001
[sim] port open, awaiting AT commands from gateway...
[sim] RX: AT+MODE=TEST
[sim] TX: +MODE: TEST
[sim] RX: AT+TEST=RFCFG,...
[sim] TX: +TEST: RFCFG ...
[sim] RX: AT+TEST=RXLRPKT
[sim] TX: +TEST: RXLRPKT
[sim] LoRa-E5 boot sequence complete, ready for traffic.

[sim] Tip: napiš "help" pro seznam příkazů, "scan DEADBEEF" pro testovací sken

sim>
```

> Pokud nevidíš RX AT příkazy, gateway buď neběží, nebo je COM port špatně namapovaný.

---

## Krok 5 — Konfigurace testovacích dat v BE

Než přiložíš první "kartu", musí v BE existovat:

1. **User** se statusem ACTIVE
2. **Room** se statusem ACTIVE  
3. **AccessCard** se statusem ACTIVE, `code = "DEADBEEF"` (nebo libovolný UID), přiřazená k tomu Useru
4. **AccessPermission** ACTIVE, propojující User × Room

Vytvoř to v admin UI BE (`/dashboard`).

Pak v gateway SQLite (nutné protože BE nemá Device entitu):

```powershell
# Použij sqlite3 CLI nebo DB Browser for SQLite
sqlite3 C:\smartlock\gateway.db
> INSERT INTO devices(device_id, roomId, name, defaultOpenMs) 
  VALUES (0xCAFE0001, <roomId z BE>, 'Test door', 3000);
> .quit
```

`<roomId z BE>` najdeš v admin UI nebo přes `SELECT id, name FROM rooms;` v gateway.db (po sync).

Restartuj Node-RED, ať se cache načte čerstvě.

---

## Krok 6 — Test happy day

V simulátoru:

```
sim> scan DEADBEEF
[sim] === SCAN: uid=DEADBEEF device=0xcafe0001 seq=1 ===
[sim] TX: +TEST: LEN:24, RSSI:-47, SNR:7
[sim] TX: +TEST: RX "010100..."
[sim] RX: AT+TEST=TXLRPKT,"0201000B0B..."
[sim] >>> auth_response_t seq=1 decision=1 open_ms=3000 crc=OK
[sim] TX: +TEST: TX DONE
[sim] TX: +TEST: RX "010100..."   ← outcome event GRANTED
```

V gateway debug panelu uvidíš:
- `card_event_t REQUEST` se rozparsuje
- SQL JOIN vrátí match (user + permission active + room active)
- Decide & build response: `dec=1 openMs=3000`
- TX AT+TEST=TXLRPKT s hex auth_response_t

V gateway SQLite:

```sql
SELECT id, seq, uid, decision, result, denyReason, sentToBackend
  FROM access_log ORDER BY id DESC LIMIT 5;

-- Očekávané:
-- id | seq | uid       | decision | result | denyReason | sentToBackend
-- 1  | 1   | DEADBEEF  | 1        | OK     | NULL       | 0
```

`sentToBackend=0` zůstane, dokud nedoplníš BE patch. To je správně.

---

## Krok 7 — Test deny

```
sim> scan AABBCCDD
```

`AABBCCDD` v cache neexistuje:

```
[sim] >>> auth_response_t seq=2 decision=0 open_ms=0 crc=OK
[sim] TX: +TEST: RX "..."   ← outcome event DENIED
```

V `access_log`:

```
| seq | uid       | decision | result | denyReason
| 2   | AABBCCDD  | 0        | DENIED | NO_CARD
```

---

## Krok 8 — Test offline BE

V PowerShellu zastav přístup k BE (firewall) nebo vypni internet. Pak scan v simulátoru. Autorizace by měla pořád běžet (z cache), jen sync error v `sync_state`:

```sql
SELECT * FROM sync_state;
-- entity     | lastSyncAt           | lastError
-- users      | 2026-05-25T...       | <stale, neaktualizováno>
-- ...
```

A v debug panelu Node-RED uvidíš HTTP 5xx/timeout na sync requestech.

Zapni síť → další 60s tick obnoví cache.

---

## Časté problémy

| Problém | Diagnóza |
|---|---|
| Simulátor: `Error: cannot open COM4` | com0com nenainstalován, nebo `Use Ports class` neaktivováno → COM4 není ve výpisu `GetPortNames()` |
| Gateway: žádný RX po scanu | Boot AT sekvence neproběhla → restartuj sim i gateway ve správném pořadí (sim první, pak gateway) |
| Gateway: `BAD_CRC` | Bity někde flippnuly → nemělo by nastat v softwarovém pipe; pokud nastane, signalizuje to bug v `slk-protocol.js` na jedné z stran |
| BE sync: 401 | API klíč nefunguje s vybraným `BE_AUTH_MODE` → zopakuj Krok 1 |
| `denyReason: NO_ROOM_MAPPING` v logu | Nemáš v `devices` tabulce mapping pro daný `device_id` → vrať se ke Kroku 5 |
| Scan funguje, ale `denyReason: NO_PERMISSION_OR_OUT_OF_WINDOW` | Permission v BE má `from`/`to` mimo aktuální čas, nebo `status != ACTIVE` |
