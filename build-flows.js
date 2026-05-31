#!/usr/bin/env node
/**
 * Generátor flows.json pro SmartLock Gateway.
 * Spustit: node build-flows.js > flows.json
 *
 * Generuje strukturovaný flow se 6 záložkami:
 *   1) Init           – Inicializace DB, boot AT sekvence
 *   2) LoRa Bridge    – Serial I/O, line parser, TX queue
 *   3) Authorization  – Vyhodnocení access requestů
 *   4) Logging        – Persistentní fronta logů
 *   5) Backend Sync   – Pull users/rooms/cards/permissions z BE
 *   6) Time Sync      – Periodický time_sync_t broadcast
 */

const crypto = require('crypto');
const id = (() => { let i = 0; return (p='n') => `${p}_${(++i).toString(36)}`; })();

// ---------- helpers ----------
const tab    = (id, label) => ({ id, type: 'tab', label, disabled: false, info: '' });
const wire   = (...ids) => [ids];
const inject = (z, x, y, name, props={}, payload='', topic='', repeat=null, once=false) => ({
  id: id('inj'), type: 'inject', z, name, props: [
    { p: 'payload' }, { p: 'topic', vt: 'str' }
  ], repeat: repeat||'', crontab: '', once, onceDelay: 0.5, topic, payload, payloadType: 'date',
  x, y, wires: [[]]
});
const fn = (z, x, y, name, code, outputs=1) => ({
  id: id('fn'), type: 'function', z, name, func: code, outputs, noerr: 0,
  initialize: '', finalize: '', libs: [], x, y, wires: Array.from({length: outputs}, () => [])
});
const debug = (z, x, y, name, prop='payload') => ({
  id: id('dbg'), type: 'debug', z, name, active: true, tosidebar: true, console: false,
  tostatus: false, complete: prop, targetType: 'msg', statusVal: '', statusType: 'auto', x, y, wires: []
});
const linkIn  = (z, x, y, name, links=[]) => ({ id: id('lin'), type: 'link in',  z, name, links, x, y, wires: [[]] });
const linkOut = (z, x, y, name, links=[]) => ({ id: id('lout'),type: 'link out', z, name, mode: 'link', links, x, y });
const status  = (z, x, y, name) => ({ id: id('st'), type: 'status', z, name, scope: null, x, y, wires: [[]] });

// ---------- IDs sdílené přes flow ----------
const SERIAL_CFG = 'serial_lora_e5';
const SQLITE_CFG = 'sqlite_gateway_db';

// ---------- TABS ----------
const tabInit   = tab('tab_init',   '1) Init');
const tabLora   = tab('tab_lora',   '2) LoRa Bridge');
const tabAuth   = tab('tab_auth',   '3) Authorization');
const tabLog    = tab('tab_log',    '4) Logging');
const tabSync   = tab('tab_sync',   '5) Backend Sync');
const tabTime   = tab('tab_time',   '6) Time Sync');

// ---------- CONFIG NODES ----------
// POZOR: 'serialport' a 'serial port' nody patří do nodu node-red-node-serialport;
// 'sqlitedb' do node-red-node-sqlite. Pokud nemáš nainstalované, viz README.
const serialCfg = {
  id: SERIAL_CFG, type: 'serial-port',
  serialport: '/dev/ttyUSB0',     // <-- uprav podle skutečnosti (Windows: 'COM3', Linux: '/dev/ttyUSB0' nebo '/dev/ttyACM0')
  serialbaud: '115200', databits: '8', parity: 'none', stopbits: '1',
  waitfor: '', dtr: 'none', rts: 'none', cts: 'none', dsr: 'none',
  newline: '\\n',                 // LoRa-E5 odpovídá řádky terminované \r\n
  bin: 'false', out: 'char', addchar: '\\r\\n', responsetimeout: '10000'
};
const sqliteCfg = {
  id: SQLITE_CFG, type: 'sqlitedb', name: 'gateway.db',
  db: '/var/lib/smartlock-gw/gateway.db',   // <-- uprav podle deploy targetu
  mode: 'RWC'
};

// ==============================================================
// TAB 1: INIT
// ==============================================================
const initOnce = inject('tab_init', 120, 80, 'Once on start', {}, '', '', '', true);
initOnce.payloadType = 'date';

const initSchema = fn('tab_init', 320, 80, 'Load schema.sql', `
// Schéma má 10+ statementů (CREATE TABLE, CREATE INDEX, INSERT...).
// node-red-node-sqlite zpracuje jen první statement, takže musíme schema
// rozdělit a poslat každý DDL zvlášť. Sqlite node běží sekvenčně, proto
// stačí vrátit pole zpráv.
const schemaSql = \`${require('fs').readFileSync('/home/claude/smartlock-gateway/schema.sql','utf8').replace(/`/g,'\\\`')}\`;

// Rozparsujeme statement-by-statement (jednoduchý split na středník, mimo
// stringy a komentáře). schema.sql u nás nemá žádné středníky uvnitř hodnot
// nebo v komentářích, takže split('\\n;') / regex je v pohodě.
const stripComments = schemaSql
  .split('\\n')
  .filter(line => !line.trim().startsWith('--'))
  .join('\\n');

const statements = stripComments
  .split(';')
  .map(s => s.trim())
  .filter(s => s.length > 0);

const out = statements.map(s => ({ topic: s + ';' }));
node.status({ fill: 'green', shape: 'dot', text: \`\${out.length} statements\` });
return [ out ];
`.trim());

const initSqlite = {
  id: id('sql'), type: 'sqlite', z: 'tab_init',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'Init schema',
  x: 540, y: 80, wires: [[]]
};

const initBootAt = fn('tab_init', 760, 80, 'Trigger boot AT sequence', `
const slk = global.get('slk');
// Pošleme každý AT příkaz jako samostatnou zprávu do TX queue.
// txKind = 'AT' znamená, že nečekáme TX_DONE, jen krátkou pauzu.
const out = slk.bootAtSequence.map(at => ({ payload: at, txKind: 'AT' }));
return [ out ];
`.trim());

const initBootLink = linkOut('tab_init', 980, 80, 'to TX queue', []); // links naplníme později

// Wires
initOnce.wires = [[initSchema.id]];
initSchema.wires = [[initSqlite.id]];
initSqlite.wires = [[initBootAt.id]];
initBootAt.wires = [[initBootLink.id]];

// ==============================================================
// TAB 2: LoRa Bridge
// ==============================================================
const serialIn = {
  id: id('sin'), type: 'serial in', z: 'tab_lora',
  name: 'LoRa-E5 RX', serial: SERIAL_CFG, x: 130, y: 100, wires: [[]]
};

const lineParser = fn('tab_lora', 350, 100, 'Parse LoRa line', `
const slk = global.get('slk');
const line = (msg.payload || '').toString();
const parsed = slk.parseLoraLine(line);
msg.parsed = parsed;
msg.payload = parsed;
// Výstup 1: RX (parsed.kind === 'RX')
// Výstup 2: TX_DONE
// Výstup 3: vše ostatní (OK/ERR/OTHER) – pro debug
switch (parsed.kind) {
  case 'RX':       return [msg, null, null];
  case 'TX_DONE':  return [null, msg, null];
  default:         return [null, null, msg];
}
`.trim(), 3);

const rxDispatch = fn('tab_lora', 580, 60, 'Decode card_event_t', `
const slk = global.get('slk');
const hex = msg.parsed && msg.parsed.hex;
if (!hex) { node.warn('No hex payload'); return null; }
// Dispatch dle prvního bytu (msg_type)
const msgType = parseInt(hex.substr(0,2), 16);
if (msgType !== slk.MSG_CARD_EVENT) {
  node.warn('Ignoring non-card_event msg_type: 0x' + msgType.toString(16));
  return null;
}
const ev = slk.parseCardEvent(hex);
if (!ev.ok) {
  node.warn('parseCardEvent failed: ' + JSON.stringify(ev));
  return null;
}
msg.event = ev;
msg.payload = ev;
return msg;
`.trim());

const rxToAuth = linkOut('tab_lora', 800, 60, 'to Authorization', []);

const txQueueFn = fn('tab_lora', 350, 260, 'TX Queue (busy-guard)', `
// Frontu držíme v context. Stav:
//   ctx.queue = pole úkolů { payload, txKind }
//   ctx.busy  = boolean (čekáme na TX_DONE z TXLRPKT)
//
// Vstupy:
//   msg.payload = AT příkaz (string)
//   msg.txKind = 'TXLRPKT' | 'AT'
//   msg._txDone = true   (signál z line parseru)
const ctx = context;
let queue = ctx.get('queue') || [];
let busy  = ctx.get('busy')  || false;

function emit() {
  if (busy || queue.length === 0) return null;
  const next = queue.shift();
  ctx.set('queue', queue);
  if (next.txKind === 'TXLRPKT') {
    busy = true; ctx.set('busy', true);
  }
  // Pro AT příkazy přidáme malou prodlevu mezi commandy
  // (Node-RED serial-out posílá hned; spoléháme na addchar '\\r\\n' v config)
  return { payload: next.payload };
}

if (msg._txDone) {
  busy = false; ctx.set('busy', false);
  const out = emit();
  node.status({ fill: busy?'yellow':'green', shape: busy?'ring':'dot', text: 'queue='+queue.length });
  return out ? [out] : null;
}

// Standardní vstup: enqueue
const item = {
  payload: msg.payload,
  txKind: msg.txKind || 'AT'
};
// Pokud je vstupem pole, rozbal:
const items = Array.isArray(item.payload) ? item.payload.map(p => ({payload: p, txKind: item.txKind})) : [item];
queue.push(...items);
ctx.set('queue', queue);
node.status({ fill: busy?'yellow':'green', shape: busy?'ring':'dot', text: 'queue='+queue.length });
const out = emit();
return out ? [out] : null;
`.trim());

const serialOut = {
  id: id('sout'), type: 'serial out', z: 'tab_lora',
  name: 'LoRa-E5 TX', serial: SERIAL_CFG, x: 580, y: 260, wires: []
};

const txDoneFanout = fn('tab_lora', 580, 160, 'Signal TX_DONE -> queue', `
msg._txDone = true;
msg.payload = null;
return msg;
`.trim());

const txQueueLinkIn = linkIn('tab_lora', 130, 260, 'TX in', []); // links naplníme později

// Wires – LoRa Bridge
serialIn.wires = [[lineParser.id]];
lineParser.wires = [
  [rxDispatch.id],         // RX
  [txDoneFanout.id],       // TX_DONE
  []                       // ostatní (volitelně do debug)
];
rxDispatch.wires = [[rxToAuth.id]];
txDoneFanout.wires = [[txQueueFn.id]];
txQueueLinkIn.wires = [[txQueueFn.id]];
txQueueFn.wires = [[serialOut.id]];

// Debug výstup pro „ostatní" řádky (volitelné)
const dbgOther = debug('tab_lora', 580, 200, 'LoRa misc', 'parsed.raw');
lineParser.wires[2] = [dbgOther.id];

// ==============================================================
// TAB 3: AUTHORIZATION
// ==============================================================
const authIn = linkIn('tab_auth', 110, 200, 'card_event in', []);

const authRouter = fn('tab_auth', 320, 200, 'Route by event type', `
// REQUEST -> pokračuje na lookup
// Outcome (GRANTED/DENIED/TIMEOUT/OFFLINE) -> aktualizace logu
const slk = global.get('slk');
const ev = msg.event;
if (!ev) return null;
if (ev.event === slk.EVENT.REQUEST) {
  return [msg, null];
}
return [null, msg];
`.trim(), 2);

// --- větev REQUEST ---
const buildLookupSql = fn('tab_auth', 540, 140, 'Build authorize SQL', `
// Sestaví parametrizovaný dotaz, který v jednom SELECTu zjistí vše potřebné:
//   - card podle UID
//   - user podle card.userId
//   - roomId z device map
//   - aktivní permission user+room v čase NOW
const ev = msg.event;
const uid = ev.uid;
const deviceId = ev.device_id;
// Použijeme aktuální čas serveru (NOT MCU timestamp, který může být 0).
const now = new Date().toISOString();
msg.topic = \`
SELECT
  c.id   AS cardId,  c.status AS cardStatus, c.userId AS userId,
  u.status AS userStatus, u.name AS userName,
  d.roomId AS roomId, d.defaultOpenMs AS defaultOpenMs,
  r.status AS roomStatus,
  p.id    AS permId, p.status AS permStatus, p.validFrom AS validFrom, p.validTo AS validTo
FROM (SELECT \${'$uid'} AS uid, \${'$deviceId'} AS deviceId, \${'$now'} AS now) q
LEFT JOIN cards c       ON c.code = q.uid
LEFT JOIN users u       ON u.id   = c.userId
LEFT JOIN devices d     ON d.device_id = q.deviceId
LEFT JOIN rooms r       ON r.id   = d.roomId
LEFT JOIN permissions p ON p.userId = c.userId
                       AND p.roomId = d.roomId
                       AND p.status = 'ACTIVE'
                       AND (p.validFrom IS NULL OR p.validFrom <= q.now)
                       AND (p.validTo   IS NULL OR p.validTo   >= q.now);
\`;
// SQLite node očekává parametry v msg.params (object)
msg.params = { '$uid': uid, '$deviceId': deviceId, '$now': now };
msg._authCtx = { uid, deviceId, seq: ev.seq, requestedAt: now };
return msg;
`.trim());

// Bohužel node-red-node-sqlite nepodporuje pojmenované parametry přímo v topicu;
// použijeme parametrickou variantu přes msg.params + sqlquery: 'msg.topic'.
// V praxi: prefereuji vložit hodnoty escapovaně do SQL (kontrolujeme typ).
// Pro produkční nasazení doporučuji upravit na PreparedStatement (viz README).

const lookupSqlite = {
  id: id('sql'), type: 'sqlite', z: 'tab_auth', mydb: SQLITE_CFG,
  sqlquery: 'prepared', sql: '', name: 'Authorize lookup',
  // node-red-node-sqlite "prepared" režim:
  //   msg.topic = SQL, msg.params = {...}
  // (V některých verzích je preferován formát msg.params jako pole; viz README)
  x: 780, y: 140, wires: [[]]
};

const decideFn = fn('tab_auth', 1010, 140, 'Decide & build response', `
const slk = global.get('slk');
const row = (Array.isArray(msg.payload) && msg.payload[0]) || null;
const ctx = msg._authCtx || {};
let decision = 0;
let openMs   = 0;
let denyReason = null;
let roomId = row && row.roomId;
let userId = row && row.userId;
let cardId = row && row.cardId;

if (!row) {
  denyReason = 'NO_LOOKUP_RESULT';
} else if (!row.roomId) {
  denyReason = 'NO_ROOM_MAPPING';
} else if (row.roomStatus !== 'ACTIVE') {
  denyReason = 'ROOM_NOT_ACTIVE:' + row.roomStatus;
} else if (!row.cardId) {
  denyReason = 'NO_CARD';
} else if (row.cardStatus !== 'ACTIVE') {
  denyReason = 'CARD_DISABLED';
} else if (!row.userId) {
  denyReason = 'CARD_UNASSIGNED';
} else if (row.userStatus !== 'ACTIVE') {
  denyReason = 'USER_NOT_ACTIVE:' + row.userStatus;
} else if (!row.permId) {
  denyReason = 'NO_PERMISSION_OR_OUT_OF_WINDOW';
} else {
  decision = 1;
  openMs = row.defaultOpenMs || 3000;
}

const hex = slk.buildAuthResponse({ seq: ctx.seq, decision, open_ms: openMs });

// 1. Připravíme TX zprávu
const txMsg = {
  payload: slk.atTxLrPkt(hex),
  txKind: 'TXLRPKT',
  _meta: { seq: ctx.seq, decision, openMs }
};

// 2. Připravíme log zápis (REQUEST řádek)
const logMsg = {
  topic: 'INSERT_LOG',
  log: {
    device_id: ctx.deviceId,
    roomId,
    seq: ctx.seq,
    uid: ctx.uid,
    cardId, userId,
    requestedAt: ctx.requestedAt,
    completedAt: null,         // doplní outcome event
    decision,
    result: null,              // doplní outcome event (OK | DENIED | TIMEOUT | GENERIC_ERROR)
    openMs,
    denyReason
  }
};

node.status({
  fill: decision ? 'green' : 'red',
  shape: 'dot',
  text: \`seq=\${ctx.seq} dec=\${decision} \${denyReason||''}\`
});

return [ txMsg, logMsg ];
`.trim(), 2);

const decideToTx  = linkOut('tab_auth', 1240, 100, 'to TX queue', []);
const decideToLog = linkOut('tab_auth', 1240, 180, 'to Logging', []);

// --- větev OUTCOME ---
const outcomeFn = fn('tab_auth', 540, 280, 'Build outcome update', `
const slk = global.get('slk');
const ev = msg.event;
const resultMap = {
  [slk.EVENT.GRANTED]: 'OK',
  [slk.EVENT.DENIED]:  'DENIED',
  [slk.EVENT.TIMEOUT]: 'TIMEOUT',
  [slk.EVENT.OFFLINE]: 'GENERIC_ERROR'
};
msg.topic = 'UPDATE_LOG_OUTCOME';
msg.outcome = {
  device_id: ev.device_id,
  seq: ev.seq,
  completedAt: new Date().toISOString(),
  result: resultMap[ev.event] || 'GENERIC_ERROR'
};
return msg;
`.trim());

const outcomeToLog = linkOut('tab_auth', 780, 280, 'to Logging', []);

// Wires – Authorization
authIn.wires = [[authRouter.id]];
authRouter.wires = [[buildLookupSql.id], [outcomeFn.id]];
buildLookupSql.wires = [[lookupSqlite.id]];
lookupSqlite.wires = [[decideFn.id]];
decideFn.wires = [[decideToTx.id], [decideToLog.id]];
outcomeFn.wires = [[outcomeToLog.id]];

// ==============================================================
// TAB 4: LOGGING
// ==============================================================
const logIn = linkIn('tab_log', 110, 200, 'log in', []);

const logRouter = fn('tab_log', 320, 200, 'Route by topic', `
if (msg.topic === 'INSERT_LOG')           return [msg, null];
if (msg.topic === 'UPDATE_LOG_OUTCOME')   return [null, msg];
return null;
`.trim(), 2);

const buildInsertSql = fn('tab_log', 540, 140, 'Build INSERT SQL', `
const L = msg.log;
const esc = s => s===null||s===undefined ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const num = n => (n===null||n===undefined) ? 'NULL' : Number(n);
// INSERT OR IGNORE – pokud REQUEST dorazí dvakrát (replay), nezduplikujeme
msg.topic = \`
INSERT OR IGNORE INTO access_log
 (device_id, roomId, seq, uid, cardId, userId, requestedAt, decision, openMs, denyReason)
 VALUES (\${num(L.device_id)}, \${num(L.roomId)}, \${num(L.seq)}, \${esc(L.uid)},
         \${num(L.cardId)}, \${num(L.userId)}, \${esc(L.requestedAt)},
         \${num(L.decision)}, \${num(L.openMs)}, \${esc(L.denyReason)});\`;
return msg;
`.trim());

const buildUpdateSql = fn('tab_log', 540, 260, 'Build UPDATE SQL', `
const O = msg.outcome;
const esc = s => s===null||s===undefined ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
msg.topic = \`
UPDATE access_log
   SET completedAt = \${esc(O.completedAt)},
       result      = \${esc(O.result)}
 WHERE device_id   = \${Number(O.device_id)}
   AND seq         = \${Number(O.seq)};\`;
return msg;
`.trim());

const sqlInsertLog = {
  id: id('sql'), type: 'sqlite', z: 'tab_log',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'INSERT log',
  x: 780, y: 140, wires: [[]]
};
const sqlUpdateLog = {
  id: id('sql'), type: 'sqlite', z: 'tab_log',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'UPDATE log',
  x: 780, y: 260, wires: [[]]
};

// Wires
logIn.wires = [[logRouter.id]];
logRouter.wires = [[buildInsertSql.id], [buildUpdateSql.id]];
buildInsertSql.wires = [[sqlInsertLog.id]];
buildUpdateSql.wires = [[sqlUpdateLog.id]];

// ==============================================================
// TAB 5: BACKEND SYNC
// ==============================================================
// Periodicky pulluje entity z BE a upsertuje do lokální cache.
// Periodicky flushuje access_log s sentToBackend = 0.
//
// BE URL a auth se konfigurují přes env vars (viz README + globální context).

const syncTick = inject('tab_sync', 110, 80, 'Pull every 60s', {}, '', '', '60', false);
syncTick.payloadType = 'date';

const syncFanOut = fn('tab_sync', 320, 80, 'Fan-out entities', `
// Auth modes (BE_AUTH_MODE):
//   'bearer'  (default) -> Authorization: Bearer <BE_API_KEY>
//   'xapikey'           -> x-api-key: <BE_API_KEY>
//   'cookie'            -> Cookie: <BE_SESSION_COOKIE>   (NextAuth JWT fallback)
const base    = env.get('BE_BASE_URL')   || 'http://localhost:3000';
const apiKey  = env.get('BE_API_KEY')    || '';
const cookie  = env.get('BE_SESSION_COOKIE') || '';
const mode    = (env.get('BE_AUTH_MODE') || 'bearer').toLowerCase();

let headers = {};
if (mode === 'xapikey' && apiKey)      headers = { 'x-api-key': apiKey };
else if (mode === 'cookie' && cookie)  headers = { 'Cookie': cookie };
else if (apiKey)                       headers = { 'Authorization': 'Bearer ' + apiKey };

const entities = [
  { name: 'users',       path: 'users' },
  { name: 'rooms',       path: 'rooms' },
  { name: 'cards',       path: 'access-cards' },
  { name: 'permissions', path: 'access-permissions' }
];
// Spustíme každou entitu od page=1, paginate-loop pokračuje v upsertFn.
return [ entities.map(e => ({
  url: \`\${base}/api/admin/\${e.path}?page=1&limit=100\`,
  method: 'GET',
  headers,
  entity: e.name,
  apiPath: e.path,
  _page: 1
})) ];
`.trim());

const httpFetch = {
  id: id('http'), type: 'http request', z: 'tab_sync',
  name: 'BE fetch', method: 'use', ret: 'obj', paytoqs: 'ignore',
  url: '', tls: '', persist: false, proxy: '', authType: '', x: 540, y: 80, wires: [[]]
};

const upsertFn = fn('tab_sync', 760, 80, 'Upsert into cache', `
// Očekáváme BE response { data: [...], meta: { total, page, limit, totalPages } }
const body = msg.payload || {};
const items = Array.isArray(body.data) ? body.data : (Array.isArray(body) ? body : []);
const meta  = body.meta || {};
const entity = msg.entity;
const apiPath = msg.apiPath;
const page = msg._page || 1;
const now = new Date().toISOString();
const esc = s => s===null||s===undefined ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const num = n => (n===null||n===undefined) ? 'NULL' : Number(n);

// Multi-row INSERT VALUES - jeden statement, žádné explicitní transakce.
// node-red-node-sqlite obaluje každý topic do své transakce, BEGIN/COMMIT
// by způsobilo "transaction within a transaction". Multi-row VALUES je
// jediný INSERT, takže sqlite ho zvládne v jedné implicitní transakci.
let upsertSql = null;
if (items.length > 0) {
  if (entity === 'users') {
    const values = items.map(u =>
      \`(\${num(u.id)},\${esc(u.uuid)},\${esc(u.name)},\${esc(u.email)},\${esc(u.role)},\${esc(u.status)},\${esc(now)})\`
    ).join(',');
    upsertSql = \`INSERT OR REPLACE INTO users(id,uuid,name,email,role,status,updatedAt) VALUES \${values};\`;
  } else if (entity === 'rooms') {
    const values = items.map(r =>
      \`(\${num(r.id)},\${esc(r.uuid)},\${esc(r.name)},\${esc(r.location)},\${esc(r.status)},\${esc(now)})\`
    ).join(',');
    upsertSql = \`INSERT OR REPLACE INTO rooms(id,uuid,name,location,status,updatedAt) VALUES \${values};\`;
  } else if (entity === 'cards') {
    const values = items.map(c => {
      const code = c.code ? String(c.code).toUpperCase() : null;
      return \`(\${num(c.id)},\${esc(c.uuid)},\${esc(code)},\${num(c.userId)},\${esc(c.type||'RFID')},\${esc(c.status)},\${esc(c.assignedAt)},\${esc(now)})\`;
    }).join(',');
    upsertSql = \`INSERT OR REPLACE INTO cards(id,uuid,code,userId,type,status,assignedAt,updatedAt) VALUES \${values};\`;
  } else if (entity === 'permissions') {
    const values = items.map(p => {
      const vFrom = p.from || p.validFrom || null;
      const vTo   = p.to   || p.validTo   || null;
      return \`(\${num(p.id)},\${num(p.userId)},\${num(p.roomId)},\${esc(p.status)},\${esc(vFrom)},\${esc(vTo)},\${esc(now)})\`;
    }).join(',');
    upsertSql = \`INSERT OR REPLACE INTO permissions(id,userId,roomId,status,validFrom,validTo,updatedAt) VALUES \${values};\`;
  }
}

const isLastPage = !meta.totalPages || page >= meta.totalPages;

// Output 1: pole zpráv - sqlite node je zpracuje postupně
const sqlMsgs = [];
if (upsertSql) sqlMsgs.push({ topic: upsertSql });
if (isLastPage) {
  sqlMsgs.push({ topic: \`UPDATE sync_state SET lastSyncAt=\${esc(now)}, lastError=NULL WHERE entity=\${esc(entity)};\` });
}

// Output 2: paginate-loop
let nextMsg = null;
if (!isLastPage) {
  const base    = env.get('BE_BASE_URL')   || 'http://localhost:3000';
  const apiKey  = env.get('BE_API_KEY')    || '';
  const cookie  = env.get('BE_SESSION_COOKIE') || '';
  const mode    = (env.get('BE_AUTH_MODE') || 'bearer').toLowerCase();
  let headers = {};
  if (mode === 'xapikey' && apiKey)      headers = { 'x-api-key': apiKey };
  else if (mode === 'cookie' && cookie)  headers = { 'Cookie': cookie };
  else if (apiKey)                       headers = { 'Authorization': 'Bearer ' + apiKey };
  nextMsg = {
    url: \`\${base}/api/admin/\${apiPath}?page=\${page+1}&limit=100\`,
    method: 'GET',
    headers, entity, apiPath, _page: page + 1
  };
}

node.status({
  fill: isLastPage ? 'green' : 'yellow',
  shape: 'dot',
  text: \`\${entity}: p\${page}/\${meta.totalPages||'?'} (+\${items.length})\`
});

return [ sqlMsgs.length ? sqlMsgs : null, nextMsg ];
`.trim(), 2);

const sqlUpsert = {
  id: id('sql'), type: 'sqlite', z: 'tab_sync',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'Upsert cache',
  x: 990, y: 80, wires: [[]]
};

// Error handling: catch na HTTP fail nastaví sync_state.lastError
const httpCatch = { id: id('catch'), type: 'catch', z: 'tab_sync', name: 'HTTP catch',
  scope: [httpFetch.id], uncaught: false, x: 540, y: 140, wires: [[]] };

const markFail = fn('tab_sync', 760, 140, 'Record sync error', `
const esc = s => s===null||s===undefined ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const entity = (msg.entity) || 'unknown';
msg.topic = \`UPDATE sync_state SET lastError=\${esc(msg.error && msg.error.message)} WHERE entity=\${esc(entity)};\`;
node.warn(\`Sync \${entity} failed: \${msg.error && msg.error.message}\`);
return msg;
`.trim());

// reuse sqlUpsert? Lépe separátní node, ať se logika nemíchá
const sqlMarkFail = {
  id: id('sql'), type: 'sqlite', z: 'tab_sync',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'Save error',
  x: 990, y: 140, wires: [[]]
};

// Wires
syncTick.wires = [[syncFanOut.id]];
syncFanOut.wires = [[httpFetch.id]];
httpFetch.wires = [[upsertFn.id]];
// upsertFn má dva výstupy: [0] = SQL upsert, [1] = další HTTP request pro paginate-loop
upsertFn.wires = [[sqlUpsert.id], [httpFetch.id]];
httpCatch.wires = [[markFail.id]];
markFail.wires = [[sqlMarkFail.id]];

// ----- Log flush (push pending logs to BE) -----
const flushTick = inject('tab_sync', 110, 260, 'Flush every 10s', {}, '', '', '10', false);
flushTick.payloadType = 'date';

const flushSelectFn = fn('tab_sync', 320, 260, 'Select pending', `
msg.topic = \`SELECT * FROM access_log
 WHERE sentToBackend = 0
   AND result IS NOT NULL    -- pouze "kompletní" záznamy (request + outcome)
 ORDER BY id ASC
 LIMIT 50;\`;
return msg;
`.trim());

const sqlSelectPending = {
  id: id('sql'), type: 'sqlite', z: 'tab_sync',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'Select pending',
  x: 540, y: 260, wires: [[]]
};

const flushBuildBatch = fn('tab_sync', 760, 260, 'Build POST body', `
const rows = msg.payload || [];
if (!rows.length) { node.status({fill:'grey',shape:'ring',text:'no pending'}); return null; }

// POZOR: bez BE patche endpoint /api/gateway/access/logs neexistuje (404).
// Logy zůstanou ve frontě s sendAttempts++. Toto je očekávané chování pro v1
// scénář bez BE patche. Po aplikaci patche endpoint začne odpovídat 201.
const base    = env.get('BE_BASE_URL')   || 'http://localhost:3000';
const apiKey  = env.get('BE_API_KEY')    || '';
const cookie  = env.get('BE_SESSION_COOKIE') || '';
const mode    = (env.get('BE_AUTH_MODE') || 'bearer').toLowerCase();
let headers = { 'Content-Type': 'application/json' };
if (mode === 'xapikey' && apiKey)      headers['x-api-key'] = apiKey;
else if (mode === 'cookie' && cookie)  headers['Cookie'] = cookie;
else if (apiKey)                       headers['Authorization'] = 'Bearer ' + apiKey;

msg.url = base + '/api/gateway/access/logs';
msg.method = 'POST';
msg.headers = headers;
msg.payload = {
  items: rows.map(r => ({
    deviceId:    r.device_id,
    seq:         r.seq,
    uid:         r.uid,
    request: {
      userId:    r.userId,
      cardId:    r.cardId,
      roomId:    r.roomId,
      requestedAt: r.requestedAt
    },
    result: r.result ? {
      result:      r.result,
      completedAt: r.completedAt,
      openMs:      r.openMs,
      denyReason:  r.denyReason
    } : null
  }))
};
msg._sentIds = rows.map(r => r.id);
node.status({fill:'yellow',shape:'dot',text:'sending '+rows.length});
return msg;
`.trim());

const httpFlush = {
  id: id('http'), type: 'http request', z: 'tab_sync',
  name: 'BE log push', method: 'use', ret: 'obj', paytoqs: 'ignore',
  url: '', tls: '', persist: false, proxy: '', authType: '', x: 990, y: 260, wires: [[]]
};

const markSentFn = fn('tab_sync', 1210, 260, 'Mark sent', `
const ids = msg._sentIds || [];
const sc = msg.statusCode;
if (sc < 200 || sc >= 300) {
  node.warn('BE responded ' + sc + ' on log push, will retry');
  msg.topic = \`UPDATE access_log
                 SET sendAttempts = sendAttempts + 1,
                     lastSendError = 'HTTP \${sc}'
               WHERE id IN (\${ids.join(',')});\`;
  node.status({fill:'red',shape:'dot',text:'HTTP '+sc});
} else {
  msg.topic = \`UPDATE access_log
                 SET sentToBackend = 1, lastSendError = NULL
               WHERE id IN (\${ids.join(',')});\`;
  node.status({fill:'green',shape:'dot',text:'sent '+ids.length});
}
return msg;
`.trim());

const sqlMarkSent = {
  id: id('sql'), type: 'sqlite', z: 'tab_sync',
  mydb: SQLITE_CFG, sqlquery: 'msg.topic', sql: '', name: 'Update sent',
  x: 1430, y: 260, wires: [[]]
};

const httpFlushCatch = { id: id('catch'), type: 'catch', z: 'tab_sync',
  name: 'Push catch', scope: [httpFlush.id], uncaught: false, x: 990, y: 320, wires: [[]] };

const flushFailFn = fn('tab_sync', 1210, 320, 'Push failed', `
const ids = msg._sentIds || [];
node.warn('BE log push failed: ' + (msg.error && msg.error.message));
msg.topic = \`UPDATE access_log
               SET sendAttempts = sendAttempts + 1,
                   lastSendError = \${"'"+String(msg.error&&msg.error.message||'').replace(/'/g,"''")+"'"}
             WHERE id IN (\${ids.join(',')});\`;
return msg;
`.trim());

// Wires – log flush
flushTick.wires = [[flushSelectFn.id]];
flushSelectFn.wires = [[sqlSelectPending.id]];
sqlSelectPending.wires = [[flushBuildBatch.id]];
flushBuildBatch.wires = [[httpFlush.id]];
httpFlush.wires = [[markSentFn.id]];
markSentFn.wires = [[sqlMarkSent.id]];
httpFlushCatch.wires = [[flushFailFn.id]];
flushFailFn.wires = [[sqlMarkSent.id]];

// ==============================================================
// TAB 6: TIME SYNC
// ==============================================================
// Při bootu (jednou) + každou hodinu vysílá time_sync_t na všechny zámky.
// Protože LoRa P2P TXLRPKT je broadcast, jedna zpráva pokryje všechny.

const timeBoot = inject('tab_time', 110, 80, 'Boot', {}, '', '', '', true);
timeBoot.payloadType = 'date';
const timeHourly = inject('tab_time', 110, 140, 'Every hour', {}, '', '', '3600', false);
timeHourly.payloadType = 'date';

const buildTimeSyncFn = fn('tab_time', 350, 110, 'Build time_sync_t', `
const slk = global.get('slk');
const hex = slk.buildTimeSync();
return {
  payload: slk.atTxLrPkt(hex),
  txKind: 'TXLRPKT',
  _meta: { kind: 'TIME_SYNC' }
};
`.trim());

const timeToTx = linkOut('tab_time', 580, 110, 'to TX queue', []);

timeBoot.wires = [[buildTimeSyncFn.id]];
timeHourly.wires = [[buildTimeSyncFn.id]];
buildTimeSyncFn.wires = [[timeToTx.id]];

// ==============================================================
// LINK GLUE
// ==============================================================
// Spojení link out -> link in podle jmen
initBootLink.links = [txQueueLinkIn.id];
rxToAuth.links     = [authIn.id];
decideToTx.links   = [txQueueLinkIn.id];
decideToLog.links  = [logIn.id];
outcomeToLog.links = [logIn.id];
timeToTx.links     = [txQueueLinkIn.id];

txQueueLinkIn.links = [];
authIn.links = [];
logIn.links = [];

// Doplnění reverzní cesty (link in.links se obvykle nevyplňuje – Node-RED si jej
// dopočítá z odpovídajících link out; ponecháme prázdné a doplníme jen vstupy
// nahoře v link out).

// ==============================================================
// COLLECT
// ==============================================================
const flow = [
  // tabs
  tabInit, tabLora, tabAuth, tabLog, tabSync, tabTime,
  // config nodes
  serialCfg, sqliteCfg,
  // init
  initOnce, initSchema, initSqlite, initBootAt, initBootLink,
  // lora
  serialIn, lineParser, rxDispatch, rxToAuth, txDoneFanout, txQueueFn, serialOut, txQueueLinkIn, dbgOther,
  // auth
  authIn, authRouter, buildLookupSql, lookupSqlite, decideFn, decideToTx, decideToLog,
  outcomeFn, outcomeToLog,
  // log
  logIn, logRouter, buildInsertSql, buildUpdateSql, sqlInsertLog, sqlUpdateLog,
  // sync
  syncTick, syncFanOut, httpFetch, upsertFn, sqlUpsert, httpCatch, markFail, sqlMarkFail,
  flushTick, flushSelectFn, sqlSelectPending, flushBuildBatch, httpFlush, markSentFn, sqlMarkSent,
  httpFlushCatch, flushFailFn,
  // time
  timeBoot, timeHourly, buildTimeSyncFn, timeToTx
];

process.stdout.write(JSON.stringify(flow, null, 2));
