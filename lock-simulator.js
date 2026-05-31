#!/usr/bin/env node
/* eslint-disable */
/**
 * SmartLock IoT Node Simulator
 * ============================
 *
 * Simuluje LoRa-E5 modul + STM32 firmware zámku. Připojuje se k virtual
 * serial portu, kde gateway očekává reálný LoRa-E5. Z pohledu gateway je
 * tohle k nerozeznání od skutečného modulu.
 *
 * Použití:
 *   node lock-simulator.js --port COM4 --device-id 0xDEADBEEF
 *
 * Setup na Win 11:
 *   1) Nainstalovat com0com (https://com0com.sourceforge.net/) — vytváří
 *      pár virtual COM portů (např. COM3 <-> COM4). Co napíšeš na COM3,
 *      vyteče na COM4 a obráceně.
 *   2) Gateway nakonfiguruj na COM3 (jeden konec páru).
 *   3) Simulátor spusť na COM4 (druhý konec páru).
 *
 * Setup na Linux:
 *   socat -d -d pty,raw,echo=0,link=/tmp/lora-gw pty,raw,echo=0,link=/tmp/lora-sim
 *   Gateway -> /tmp/lora-gw, simulátor -> /tmp/lora-sim
 *
 * Interaktivní příkazy (stdin):
 *   scan <UID> [device_id]   - pošle card_event_t REQUEST (UID UPPERCASE hex)
 *                              device_id volitelný, default z --device-id
 *   help                     - nápověda
 *   quit                     - ukončit
 *
 * Automatický mód (--auto):
 *   Po startu simuluje 3 různé karty každých 10s.
 *
 * Závislosti:  npm i serialport
 */

const { SerialPort } = require('serialport');
const readline = require('readline');

// --- CRC-16/CCITT-FALSE (identické se slk-protocol.js) ----------------------
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
const bufToHex = (b) => b.toString('hex').toUpperCase();

// --- CLI args ---------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
};
const PORT = getArg('--port', process.platform === 'win32' ? 'COM4' : '/tmp/lora-sim');
const DEVICE_ID = parseInt(getArg('--device-id', '0xDEADBEEF'));
const AUTO = args.includes('--auto');

console.log(`[sim] LoRa-E5 simulator`);
console.log(`[sim]   port:      ${PORT}`);
console.log(`[sim]   device_id: 0x${DEVICE_ID.toString(16).toUpperCase().padStart(8, '0')}`);
console.log(`[sim]   auto mode: ${AUTO}`);

// --- Serial port -----------------------------------------------------------
const port = new SerialPort({
    path: PORT, baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1,
    autoOpen: false,
});
port.open((err) => {
    if (err) {
        console.error(`[sim] FATAL: cannot open ${PORT}: ${err.message}`);
        console.error('[sim] Hint: vytvořil jsi virtual COM port pair? com0com (Win) / socat (Linux)');
        process.exit(1);
    }
    console.log(`[sim] port open, awaiting AT commands from gateway...`);
});

// --- Line accumulator (čteme po řádcích, gateway posílá AT+...\r\n) --------
let rxBuf = '';
port.on('data', (chunk) => {
    rxBuf += chunk.toString('utf8');
    let nl;
    while ((nl = rxBuf.indexOf('\n')) >= 0) {
        const line = rxBuf.slice(0, nl).replace(/\r$/, '');
        rxBuf = rxBuf.slice(nl + 1);
        if (line) handleATCommand(line);
    }
});

// --- AT command handler ----------------------------------------------------
let configured = false;
const pendingSeqResponses = new Map(); // seq -> auth_response_t parsed

function send(line) {
    port.write(line + '\r\n');
    console.log(`[sim] TX: ${line}`);
}

function handleATCommand(line) {
    console.log(`[sim] RX: ${line}`);

    if (line.startsWith('AT+MODE')) {
        send('+MODE: TEST');
        return;
    }
    if (line.startsWith('AT+TEST=RFCFG')) {
        send('+TEST: RFCFG F:868000000, SF7, BW125K, TXPR:12, RXPR:15, POW:14dBm, CRC:ON, IQ:OFF, NET:OFF');
        return;
    }
    if (line.startsWith('AT+TEST=RXLRPKT')) {
        send('+TEST: RXLRPKT');
        configured = true;
        console.log('[sim] LoRa-E5 boot sequence complete, ready for traffic.');
        return;
    }
    if (line.startsWith('AT+TEST=TXLRPKT')) {
        // Gateway nám posílá auth_response_t nebo time_sync_t.
        // Tvar: AT+TEST=TXLRPKT,"02XXXX..." (uppercase hex v uvozovkách)
        const m = /AT\+TEST=TXLRPKT,"([0-9A-Fa-f]+)"/.exec(line);
        if (!m) { send('+TEST: ERR'); return; }
        const hex = m[1];
        const buf = Buffer.from(hex, 'hex');
        const msgType = buf[0];

        // Po krátké pauze odpovíme TX DONE (jako reálný LoRa-E5)
        setTimeout(() => send('+TEST: TX DONE'), 50);

        if (msgType === 0x02) {
            // auth_response_t (8 B)
            const seq      = buf.readUInt16LE(1);
            const decision = buf[3];
            const openMs   = buf.readUInt16LE(4);
            const crcGot   = buf.readUInt16LE(6);
            const crcCalc  = crc16(buf.slice(0, 6));
            const crcOk    = crcGot === crcCalc;
            console.log(`[sim] >>> auth_response_t seq=${seq} decision=${decision} open_ms=${openMs} crc=${crcOk?'OK':'FAIL'}`);
            pendingSeqResponses.set(seq, { decision, openMs, ts: Date.now() });

            // Simuluj otevření zámku + pošli outcome event (s krátkou prodlevou
            // jako kdyby servo opravdu jelo a karta byla "halted")
            setTimeout(() => emitOutcomeEvent(seq, decision), Math.max(200, openMs / 5));
        } else if (msgType === 0x04) {
            // time_sync_t (7 B)
            const ts = buf.readUInt32LE(1);
            console.log(`[sim] >>> time_sync_t  ts=${ts} (${new Date(ts*1000).toISOString()})`);
        } else {
            console.log(`[sim] >>> unknown msg_type 0x${msgType.toString(16)}: ${hex}`);
        }
        return;
    }

    // Generický fallback – cokoli jiného (AT+ID, AT+VER, …)
    send('+OK');
}

// --- Builders pro card_event_t (24 B, msg_type 0x01) -----------------------
function buildCardEvent({ seq, uid, event, deviceId = DEVICE_ID, timestamp = 0 }) {
    const buf = Buffer.alloc(24);
    buf[0] = 0x01;
    buf.writeUInt16LE(seq & 0xFFFF, 1);
    buf.writeUInt32LE(deviceId >>> 0, 3);
    buf.writeUInt32LE(timestamp >>> 0, 7);
    const uidBytes = Buffer.from(uid, 'hex');
    buf[11] = uidBytes.length;
    uidBytes.copy(buf, 12, 0, Math.min(uidBytes.length, 10));
    buf[22] = event;
    buf.writeUInt16LE(crc16(buf.slice(0, 23)), 23);
    return bufToHex(buf);
}

function emitCardEvent(opts) {
    const hex = buildCardEvent(opts);
    // LoRa-E5 firmware má dvě varianty výstupu RX, podporujeme oba (gateway
    // parser akceptuje obě):
    // 1)  +TEST: LEN:24, RSSI:-50, SNR:9
    //     +TEST: RX "010A00..."
    // 2)  +TEST: RX "010A00..."
    send(`+TEST: LEN:24, RSSI:-${30 + Math.floor(Math.random()*40)}, SNR:${5 + Math.floor(Math.random()*5)}`);
    send(`+TEST: RX "${hex}"`);
}

function emitOutcomeEvent(seq, decision) {
    if (!lastScans.has(seq)) return;
    const scan = lastScans.get(seq);
    let event;
    if (decision === 1) event = 1;       // GRANTED
    else if (decision === 0) event = 2;  // DENIED
    else event = 3;                       // TIMEOUT (defensive)
    emitCardEvent({ seq, uid: scan.uid, event, deviceId: scan.deviceId });
    lastScans.delete(seq);
}

// --- Card scan API ---------------------------------------------------------
let seqCounter = 1;
const lastScans = new Map();
function scanCard(uid, deviceId = DEVICE_ID) {
    if (!configured) {
        console.log('[sim] WARNING: LoRa not configured yet (gateway boot sequence pending)');
        return;
    }
    const seq = seqCounter++;
    const ts  = Math.floor(Date.now() / 1000);
    lastScans.set(seq, { uid, deviceId });
    console.log(`[sim] === SCAN: uid=${uid} device=0x${deviceId.toString(16)} seq=${seq} ===`);
    emitCardEvent({ seq, uid: uid.toUpperCase(), event: 0, deviceId, timestamp: ts });

    // Pokud gateway neodpoví do 3s, simulátor pošle TIMEOUT outcome event
    setTimeout(() => {
        if (lastScans.has(seq)) {
            console.log(`[sim] !!! TIMEOUT for seq=${seq} (no auth_response_t in 3s)`);
            emitCardEvent({ seq, uid, event: 3, deviceId });
            lastScans.delete(seq);
        }
    }, 3500);
}

// --- Interactive CLI (jen pokud je TTY) -----------------------------------
const isTTY = process.stdin.isTTY;
let rl = null;
function prompt() {
    if (!rl) return;
    rl.question('sim> ', handleInput);
}

function handleInput(line) {
    const args = line.trim().split(/\s+/);
    const cmd = args[0];
    if (!cmd) return prompt();
    if (cmd === 'quit' || cmd === 'exit') {
        port.close(); if (rl) rl.close(); return;
    }
    if (cmd === 'help' || cmd === '?') {
        console.log(`
  scan <UID> [device_id_hex]   pošle card_event_t REQUEST
                               UID = uppercase hex bez prefixu, max 10 bytes (20 chars)
                               device_id volitelně (default --device-id), např. 0xCAFE0001
  status                       vypiše stav simulátoru
  help                         tahle nápověda
  quit                         ukončit
        `.trim());
        return prompt();
    }
    if (cmd === 'status') {
        console.log(`  configured: ${configured}`);
        console.log(`  pending scans: ${lastScans.size}`);
        console.log(`  total scans sent: ${seqCounter - 1}`);
        return prompt();
    }
    if (cmd === 'scan') {
        const uid = args[1];
        if (!uid || !/^[0-9A-Fa-f]{2,20}$/.test(uid)) {
            console.log('  ERR: uid musí být hex 2-20 chars, např. DEADBEEF');
            return prompt();
        }
        const did = args[2] ? parseInt(args[2]) : DEVICE_ID;
        scanCard(uid, did);
        return prompt();
    }
    console.log(`  ERR: neznámý příkaz '${cmd}', zkus 'help'`);
    prompt();
}

if (isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

// Auto mode -----------------------------------------------------------------
if (AUTO) {
    const fakeCards = ['DEADBEEF', 'CAFEBABE', '12345678'];
    let i = 0;
    setInterval(() => {
        if (configured) scanCard(fakeCards[i++ % fakeCards.length]);
    }, 10000);
}

// Welcome + první prompt po naběhnutí konfigurace
setTimeout(() => {
    if (isTTY) {
        console.log('\n[sim] Tip: napiš "help" pro seznam příkazů, "scan DEADBEEF" pro testovací sken\n');
        prompt();
    } else {
        console.log('[sim] non-TTY mode - CLI disabled, čekám AT příkazy / SIGINT pro ukončení');
    }
}, 500);

// Cleanup ---------------------------------------------------------------
process.on('SIGINT', () => { port.close(); process.exit(0); });
