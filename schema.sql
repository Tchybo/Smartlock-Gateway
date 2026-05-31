-- =============================================================
-- SmartLock Gateway – local SQLite schema
-- =============================================================
-- Slouží jako:
--   1) Read-through cache entit z BE (users, rooms, cards, permissions)
--   2) Mapování device_id (u32 z MCU UID) -> roomId (lokální konfigurace)
--   3) Persistentní fronta logů (access_log) s flagem sentToBackend
-- =============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -------------------------------------------------------------
-- Cache z BE (read-only z pohledu gateway)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY,
  uuid      TEXT UNIQUE,
  name      TEXT,
  email     TEXT,
  role      TEXT,                       -- SUPER_ADMIN | ADMIN | USER
  status    TEXT,                       -- NOT_VERIFIED | ACTIVE | DISABLED
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id        INTEGER PRIMARY KEY,
  uuid      TEXT UNIQUE,
  name      TEXT,
  location  TEXT,
  status    TEXT,                       -- ACTIVE | BLOCKED | DISABLED
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY,
  uuid       TEXT UNIQUE,
  code       TEXT UNIQUE NOT NULL,      -- UID v UPPERCASE hex (např. "DEADBEEF")
  userId     INTEGER,
  type       TEXT,                      -- RFID
  status     TEXT,                      -- ACTIVE | DISABLED
  assignedAt TEXT,
  updatedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_code ON cards(code);
CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(userId);

CREATE TABLE IF NOT EXISTS permissions (
  id        INTEGER PRIMARY KEY,
  userId    INTEGER NOT NULL,
  roomId    INTEGER NOT NULL,
  status    TEXT,                       -- ACTIVE | SUSPENDED | EXPIRED
  validFrom TEXT,
  validTo   TEXT,
  updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_perm_user_room ON permissions(userId, roomId);

-- -------------------------------------------------------------
-- Lokální konfigurace: mapování fyzických zámků na roomId.
-- device_id se odvozuje z MCU UID a posílá v card_event_t.
-- Tato tabulka musí být ručně/skriptem nahrána při deploy nového
-- zámku (BE o ní zatím podle dokumentace neví – viz README).
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  device_id INTEGER PRIMARY KEY,        -- u32 z MCU UID
  roomId    INTEGER NOT NULL,
  name      TEXT,
  defaultOpenMs INTEGER DEFAULT 3000,
  updatedAt TEXT,
  FOREIGN KEY (roomId) REFERENCES rooms(id)
);

-- -------------------------------------------------------------
-- Persistentní fronta access logů (request + result spárované)
-- sentToBackend = 0 -> ještě se nepodařilo doručit BE
-- =============================================================
CREATE TABLE IF NOT EXISTS access_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id      INTEGER NOT NULL,
  roomId         INTEGER,
  seq            INTEGER NOT NULL,      -- z card_event_t.seq (koreluje REQUEST a outcome)
  uid            TEXT,                  -- UPPERCASE hex
  cardId         INTEGER,               -- FK -> cards.id (NULL pro neznámou kartu)
  userId         INTEGER,               -- FK -> users.id (NULL pro neznámou kartu)
  requestedAt    TEXT NOT NULL,         -- ISO-8601, převedeno z u32 epoch
  completedAt    TEXT,                  -- doplní se po obdržení outcome eventu
  decision       INTEGER,               -- 1 granted, 0 denied (jak gateway vyhodnotila)
  result         TEXT,                  -- OK | DENIED | TIMEOUT | GENERIC_ERROR
  openMs         INTEGER,
  denyReason     TEXT,                  -- diagnostika: NO_CARD | CARD_DISABLED | NO_USER | USER_DISABLED | NO_PERMISSION | OUT_OF_WINDOW | NO_ROOM_MAPPING
  sentToBackend  INTEGER NOT NULL DEFAULT 0,
  sendAttempts   INTEGER NOT NULL DEFAULT 0,
  lastSendError  TEXT,
  createdAt      TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_log_dev_seq ON access_log(device_id, seq);
CREATE INDEX IF NOT EXISTS idx_log_pending ON access_log(sentToBackend, id);

-- -------------------------------------------------------------
-- Stav synchronizace (kdy proběhla poslední úspěšná sync z BE)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
  entity     TEXT PRIMARY KEY,          -- 'users' | 'rooms' | 'cards' | 'permissions'
  lastSyncAt TEXT,
  lastError  TEXT
);
INSERT OR IGNORE INTO sync_state(entity) VALUES ('users'),('rooms'),('cards'),('permissions');
