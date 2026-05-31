# SmartLock Gateway v Dockeru — Win 11 ARM

Návod pro spuštění Node-RED gateway v Docker Desktop na Windows 11 s ARM procesorem (Snapdragon X / Surface Pro 11 apod.).

## Proč je to na Windows složitější

Docker Desktop na Windows nespouští kontejnery přímo — běží uvnitř WSL2 VM. USB zařízení (LoRa-E5) hostitelský Windows do té VM **defaultně nepustí**. Řeší se nástrojem `usbipd-win`, který USB device přes IP protokol „prostrčí" do WSL2, odkud ho už kontejner vidí jako `/dev/ttyACM0`.

Tok: `LoRa-E5 (USB)` → `Windows host` → `usbipd-win` → `WSL2` → `Docker kontejner`

`nodered/node-red` image má nativní `arm64` build, takže samotný Node-RED běží bez emulace — rychle.

## Předpoklady

| Komponenta | Jak získat |
|---|---|
| Docker Desktop for Windows (ARM64) | docker.com — má ARM build |
| WSL2 | `wsl --install` v PowerShell jako admin (Docker Desktop ho většinou doinstaluje sám) |
| usbipd-win | `winget install usbipd` |
| LoRa-E5 modul na USB-UART | připojený k PC |

## Krok 1 — Příprava souborů

Vytvoř si pracovní složku, např. `C:\smartlock-gateway\`, a do ní zkopíruj:

```
C:\smartlock-gateway\
├── docker-compose.yml          (z dodaných souborů)
├── .env                        (vytvoříš v kroku 4)
└── data\                       (vytvoříš teď, prázdná složka)
    ├── settings.js             (z dodaných souborů — viz krok 2)
    ├── slk-protocol.js         (z dodaných souborů)
    ├── flows.json              (z dodaných souborů)
    └── schema.sql              (z dodaných souborů)
```

```powershell
cd C:\smartlock-gateway
mkdir data
# zkopíruj sem dodané soubory: settings.js, slk-protocol.js, flows.json, schema.sql
```

> **Pozor:** `data/` je v kontejneru namapovaná jako `/data` — to je výchozí Node-RED userDir. `flows.json` Node-RED při prvním startu **nenačte automaticky** — naimportuješ ho přes editor (krok 6). Soubory `slk-protocol.js`, `schema.sql` tam jen leží, aby na ně flow a settings dosáhly.

## Krok 2 — settings.js pro kontejner

V kontejneru je userDir `/data`, takže `settings.js` musí být v `data/settings.js`. Použij **dodaný `settings-fragment.js` jako vzor**, ale potřebuješ kompletní `settings.js`. Nejjednodušší cesta:

```powershell
# Stáhni default settings.js z image:
docker run --rm nodered/node-red:4.0-debian cat /data/settings.js > data\settings.js
```

Pak v `data\settings.js` najdi `functionGlobalContext: {` a uprav na:

```js
    functionGlobalContext: {
        slk: require('/data/slk-protocol.js')
    },
    functionExternalModules: true,
```

(Cesta je `/data/...`, ne `./` — uvnitř kontejneru.)

## Krok 3 — Přidat SQLite a serial nody do image

Oficiální image nemá `node-red-node-sqlite` ani `node-red-node-serialport`. Dvě možnosti:

**A) Přes editor (jednodušší):** spusť kontejner (krok 5), pak v Node-RED UI → Menu → Manage palette → Install → najdi a nainstaluj `node-red-node-sqlite` a `node-red-node-serialport`. Nainstalují se do `/data/node_modules`, takže přežijí restart.

**B) Vlastní Dockerfile (pro produkci):**

```dockerfile
FROM nodered/node-red:4.0-debian
RUN npm install node-red-node-sqlite node-red-node-serialport
```

```yaml
# v docker-compose.yml zaměň `image:` za:
build: .
```

Pro start doporučuji **A)**.

## Krok 4 — USB pass-through přes usbipd-win

V PowerShellu **jako administrátor**:

```powershell
# 1) Vypiš USB zařízení, najdi LoRa-E5 (typicky "USB Serial" nebo "CP210x"/"CH340")
usbipd list

# Výstup např.:
#   BUSID  VID:PID    DEVICE                          STATE
#   2-3    10c4:ea60  Silicon Labs CP210x USB to UART  Not shared

# 2) Sdílej zařízení (stačí jednou)
usbipd bind --busid 2-3

# 3) Připoj do WSL2 s auto-reconnectem (po každém odpojení/restartu se znovu připojí)
usbipd attach --wsl --busid 2-3 --auto-attach
```

Ověř ve WSL2, že se zařízení objevilo:

```powershell
wsl -d docker-desktop ls -la /dev/ttyACM0 /dev/ttyUSB0
```

Jeden z těch dvou by měl existovat. **Zapamatuj si který** a uprav `docker-compose.yml` sekci `devices:` (default je `/dev/ttyACM0`).

> **Pozn.:** `--auto-attach` musí běžet pořád (drží okno PowerShellu). Pro trvalý provoz nastav scheduled task nebo to spouštěj ručně po restartu. Bez toho se po reconnectu USB device do WSL nevrátí.

## Krok 5 — .env a spuštění

```powershell
# Vytvoř .env vedle docker-compose.yml
@"
BE_GATEWAY_TOKEN=zatim_prazdne_nez_aplikujes_BE_patch
"@ | Out-File -Encoding utf8 .env

docker compose up -d
docker compose logs -f
```

V logu hledej `Server now running at http://127.0.0.1:1880/`.

## Krok 6 — Konfigurace flow

1. Otevři `http://localhost:1880`
2. Pokud jsi neudělal krok 3B: Menu → Manage palette → Install → `node-red-node-sqlite`, `node-red-node-serialport`
3. Menu → Import → vyber `flows.json` → Deploy
4. Otevři `serial-port` config node → změň `serialport` na to, co ti vyšlo v kroku 4 (`/dev/ttyACM0` nebo `/dev/ttyUSB0`)
5. Otevři `sqlitedb` config node → ověř cestu `/data/gateway.db` (uvnitř kontejneru — leží v namountované `data/` složce)
6. Deploy

> ⚠️ V `schema.sql` a `build-flows.js` je defaultní cesta `/var/lib/smartlock-gw/gateway.db`. **V Dockeru ji změň na `/data/gateway.db`** v `sqlitedb` config nodu, jinak se DB vytvoří mimo namountovaný volume a po restartu zmizí.

## Krok 7 — Ověření

```powershell
# Je SQLite DB na svém místě?
docker compose exec node-red ls -la /data/gateway.db

# Vidí kontejner serial port?
docker compose exec node-red ls -la /dev/ttyACM0

# Co je v cache (po 60s sync s BE)?
docker compose exec node-red node -e "
const db = require('/data/node_modules/node-red-node-sqlite/node_modules/sqlite3');
" 2>/dev/null || echo "Pro SQL dotazy použij debug nody v editoru nebo si doinstaluj sqlite3 CLI"
```

Nejjednodušší kontrola je přes **debug nody přímo v Node-RED editoru** — flow je má rozmístěné na klíčových místech.

## Časté problémy

| Problém | Příčina | Řešení |
|---|---|---|
| `Error: No such file or directory, cannot open /dev/ttyACM0` | USB není prostrčené do WSL2 | Zopakuj krok 4, ověř `usbipd list` ukazuje `Attached` |
| Port zmizí po uspání PC | usbipd reconnect | `--auto-attach` musí běžet; po probuzení případně `usbipd attach` znovu |
| `BE_BASE_URL` nedostupné | `localhost` v kontejneru ≠ Windows host | Použij `http://host.docker.internal:3000` (už je v compose) |
| SQLite DB se po restartu vyprázdní | DB cesta mimo volume | V `sqlitedb` config nodu nastav `/data/gateway.db` |
| `node-red-node-sqlite` install selže | chybí build tools v image | Použij `nodered/node-red:4.0-debian` (ne `-minimal`), má build-essential |
| Kontejner nestartuje, `devices` chyba | `/dev/ttyACM0` ve WSL2 neexistuje | Buď USB neni připojené (krok 4), nebo je to `/dev/ttyUSB0` — uprav compose |

## Co dál

Pro produkční nasazení viz `README.md` sekce 8 (HMAC nad LoRa rámci, HTTPS na BE, monitoring). Pro Docker konkrétně navíc:

- **Healthcheck** v compose (`healthcheck:` blok volající `/`)
- **Log rotation** — `logging:` driver s `max-size`
- **Restart usbipd auto-attach** jako Windows scheduled task při bootu
