/* eslint-disable */
/**
 * SmartLock Gateway – sdílené utility pro Node-RED function nody.
 *
 * Nahraje se přes settings.js (functionGlobalContext) jako `slk`, takže
 * ve function nodech voláme:  const slk = global.get('slk');
 *
 * Obsahuje:
 *   - CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no refIn/Out, xorOut 0)
 *   - parser card_event_t (msg_type 0x01, 24 B)
 *   - builder  auth_response_t (msg_type 0x02, 8 B)
 *   - builder  time_sync_t    (msg_type 0x04, 7 B)
 *   - hex helpers
 */

// --- CRC-16/CCITT-FALSE -----------------------------------------------------
function crc16(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// --- Konstanty --------------------------------------------------------------
const MSG_CARD_EVENT   = 0x01;
const MSG_AUTH_RESP    = 0x02;
const MSG_TIME_SYNC    = 0x04;

const EVENT = { REQUEST: 0, GRANTED: 1, DENIED: 2, TIMEOUT: 3, OFFLINE: 4 };
const EVENT_NAME = ['REQUEST', 'GRANTED', 'DENIED', 'TIMEOUT', 'OFFLINE'];

// --- Hex helpers ------------------------------------------------------------
function hexToBuf(hex) {
  return Buffer.from(hex.replace(/\s+/g, ''), 'hex');
}
function bufToHex(buf) {
  return buf.toString('hex').toUpperCase();
}

// --- Parser: card_event_t (24 B, msg_type 0x01) -----------------------------
//   0:1  msg_type     u8   = 0x01
//   1:2  seq          u16 LE
//   3:4  device_id    u32 LE
//   7:4  timestamp    u32 LE  (Unix epoch UTC, 0 = RTC nenastaveno)
//  11:1  uid_length   u8
//  12:10 uid          u8[10]  (validní jen prvních uid_length bytů)
//  22:1  event        u8
//  23:2  crc16        u16 LE  (přes byty 0..22)
function parseCardEvent(hex) {
  const buf = hexToBuf(hex);
  if (buf.length !== 24) return { ok: false, error: 'BAD_LENGTH', got: buf.length };
  if (buf[0] !== MSG_CARD_EVENT) return { ok: false, error: 'BAD_MSG_TYPE', got: buf[0] };
  const computed = crc16(buf.slice(0, 23));
  const received = buf.readUInt16LE(23);
  if (computed !== received) return { ok: false, error: 'BAD_CRC', computed, received };
  const uidLen = buf[11];
  if (uidLen < 1 || uidLen > 10) return { ok: false, error: 'BAD_UID_LEN', uidLen };
  const uidHex = bufToHex(buf.slice(12, 12 + uidLen));
  return {
    ok: true,
    msg_type: buf[0],
    seq: buf.readUInt16LE(1),
    device_id: buf.readUInt32LE(3),
    timestamp: buf.readUInt32LE(7),
    uid_length: uidLen,
    uid: uidHex,
    event: buf[22],
    eventName: EVENT_NAME[buf[22]] || 'UNKNOWN'
  };
}

// --- Builder: auth_response_t (8 B, msg_type 0x02) --------------------------
//   0:1  msg_type   u8  = 0x02
//   1:2  seq        u16 LE  (echo z requestu)
//   3:1  decision   u8      (0 denied, 1 granted)
//   4:2  open_ms    u16 LE
//   6:2  crc16      u16 LE
function buildAuthResponse({ seq, decision, open_ms = 0 }) {
  const buf = Buffer.alloc(8);
  buf[0] = MSG_AUTH_RESP;
  buf.writeUInt16LE(seq & 0xFFFF, 1);
  buf[3] = decision ? 1 : 0;
  buf.writeUInt16LE(open_ms & 0xFFFF, 4);
  buf.writeUInt16LE(crc16(buf.slice(0, 6)), 6);
  return bufToHex(buf);
}

// --- Builder: time_sync_t (7 B, msg_type 0x04) ------------------------------
//   0:1 msg_type   u8 = 0x04
//   1:4 timestamp  u32 LE
//   5:2 crc16      u16 LE
function buildTimeSync(epochSeconds) {
  const ts = (epochSeconds != null) ? epochSeconds : Math.floor(Date.now() / 1000);
  const buf = Buffer.alloc(7);
  buf[0] = MSG_TIME_SYNC;
  buf.writeUInt32LE(ts >>> 0, 1);
  buf.writeUInt16LE(crc16(buf.slice(0, 5)), 5);
  return bufToHex(buf);
}

// --- AT příkazy: build a parser pro LoRa-E5 ---------------------------------
function atTxLrPkt(hexPayload) {
  return `AT+TEST=TXLRPKT,"${hexPayload}"`;
}
// LoRa-E5 vrací RX takto: +TEST: LEN:24, RSSI:-50, SNR:9
//                          +TEST: RX "010A000123..."
// Některé firmware varianty mohou vracet `+TEST: RX "..."` bez metadat – ošetříme oboje.
const RX_LINE_RE = /\+TEST:\s*RX\s*"([0-9A-Fa-f]+)"/;
const TX_DONE_RE = /\+TEST:\s*TX\s*DONE/;
const TX_BUSY_RE = /\+TEST:\s*LoRaP2P busy/i;
const ERR_RE     = /^\+(ERR|ERROR)/i;

function parseLoraLine(line) {
  if (!line) return { kind: 'IGNORE' };
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'IGNORE' };
  let m;
  if ((m = RX_LINE_RE.exec(trimmed))) return { kind: 'RX', hex: m[1].toUpperCase(), raw: trimmed };
  if (TX_DONE_RE.test(trimmed))       return { kind: 'TX_DONE', raw: trimmed };
  if (TX_BUSY_RE.test(trimmed))       return { kind: 'TX_BUSY', raw: trimmed };
  if (ERR_RE.test(trimmed))           return { kind: 'ERR', raw: trimmed };
  if (trimmed === '+AT: OK' || trimmed === '+OK' || /^\+\w+: OK$/i.test(trimmed)) {
    return { kind: 'OK', raw: trimmed };
  }
  return { kind: 'OTHER', raw: trimmed };
}

// --- Convert MCU epoch u32 -> ISO-8601 (s ošetřením 0 = neznámý čas) --------
function mcuTsToIso(u32) {
  if (!u32) return null;
  return new Date(u32 * 1000).toISOString();
}

module.exports = {
  // konstanty
  MSG_CARD_EVENT, MSG_AUTH_RESP, MSG_TIME_SYNC, EVENT, EVENT_NAME,
  // utility
  crc16, hexToBuf, bufToHex, mcuTsToIso,
  // protokol
  parseCardEvent, buildAuthResponse, buildTimeSync,
  // LoRa-E5 AT vrstva
  atTxLrPkt, parseLoraLine,
  // konfigurační AT sekvence – posílá se při bootu
  bootAtSequence: [
    'AT+MODE=TEST',
    'AT+TEST=RFCFG,868,SF7,125,12,15,14,ON,OFF,OFF',
    'AT+TEST=RXLRPKT'
  ]
};
