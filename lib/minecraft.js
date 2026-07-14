'use strict';

/**
 * Minecraft Server List Ping (SLP) for the modern protocol (1.7+).
 *
 * Implements the handshake / status-request exchange over a raw TCP socket and
 * parses the JSON status response. Used to surface live player counts without
 * depending on the server having a query port or RCON enabled.
 *
 * Protocol reference: https://wiki.vg/Server_List_Ping
 */

const net = require('net');

/** Encode an integer as a Minecraft VarInt (7 bits per byte, MSB = continue). */
function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) { bytes.push(v); break; }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

/**
 * Decode a VarInt at `offset`. Returns { value, bytesRead }, or null if the
 * buffer doesn't yet hold a complete VarInt (the caller is mid-stream).
 */
function readVarInt(buf, offset) {
  let value = 0, position = 0, bytesRead = 0, cur;
  while (true) {
    if (offset + bytesRead >= buf.length) return null;
    cur = buf[offset + bytesRead];
    bytesRead++;
    value |= (cur & 0x7f) << position;
    if ((cur & 0x80) === 0) break;
    position += 7;
    if (position >= 35) throw new Error('VarInt too big');
  }
  return { value, bytesRead };
}

/** Build the handshake + status-request packets for a status (next state = 1) ping. */
function buildHandshakeAndStatus(host, port) {
  const hostBuf = Buffer.from(host, 'utf8');
  const handshakeData = Buffer.concat([
    Buffer.from([0x00]),            // packet id: handshake
    writeVarInt(-1),                // protocol version (-1 = unspecified)
    writeVarInt(hostBuf.length),
    hostBuf,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1),                 // next state: status
  ]);
  const handshake = Buffer.concat([writeVarInt(handshakeData.length), handshakeData]);
  const statusReq = Buffer.from([0x01, 0x00]); // length-prefixed status request
  return Buffer.concat([handshake, statusReq]);
}

/**
 * Ping a Minecraft server and resolve with the parsed status JSON. Rejects on
 * timeout, connection failure, or a malformed response.
 */
function pingMinecraft(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let chunks = Buffer.alloc(0);
    let done = false;
    function finish(err, val) {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(val);
    }
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish(new Error('timeout')));
    sock.once('error', (e) => finish(e));
    sock.once('close', () => finish(new Error('closed')));
    sock.connect(port, host, () => {
      sock.write(buildHandshakeAndStatus(host, port));
    });
    sock.on('data', (data) => {
      chunks = Buffer.concat([chunks, data]);
      try {
        const lenRead = readVarInt(chunks, 0);
        if (!lenRead) return;
        const totalNeeded = lenRead.bytesRead + lenRead.value;
        if (chunks.length < totalNeeded) return; // wait for the rest of the packet
        const idRead = readVarInt(chunks, lenRead.bytesRead);
        if (!idRead) return;
        if (idRead.value !== 0x00) return finish(new Error('unexpected packet id ' + idRead.value));
        const strLenRead = readVarInt(chunks, lenRead.bytesRead + idRead.bytesRead);
        if (!strLenRead) return;
        const jsonStart = lenRead.bytesRead + idRead.bytesRead + strLenRead.bytesRead;
        const jsonEnd = jsonStart + strLenRead.value;
        if (chunks.length < jsonEnd) return;
        const json = chunks.slice(jsonStart, jsonEnd).toString('utf8');
        finish(null, JSON.parse(json));
      } catch (e) { finish(e); }
    });
  });
}

/** Normalise a raw SLP status response into the fields the dashboard displays. */
function normalizeStatus(data) {
  return {
    online: data?.players?.online ?? null,
    max: data?.players?.max ?? null,
    version: data?.version?.name || null,
    motd: typeof data?.description === 'string'
      ? data.description
      : (data?.description?.text || null),
  };
}

const CACHE_TTL_MS = 3000;
const statusCache = new Map(); // "host:port" -> { at, value }

/**
 * Cached SLP lookup. Returns normalised status, or { unreachable: true } if the
 * server didn't answer. Results are cached briefly so repeated UI polls for the
 * same server don't each open a socket.
 */
async function getMcStatus(host, port) {
  const key = `${host}:${port}`;
  const now = Date.now();
  const hit = statusCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  let value;
  try {
    value = normalizeStatus(await pingMinecraft(host, port));
  } catch (_) {
    value = { unreachable: true };
  }
  statusCache.set(key, { at: now, value });
  return value;
}

module.exports = {
  writeVarInt,
  readVarInt,
  buildHandshakeAndStatus,
  pingMinecraft,
  normalizeStatus,
  getMcStatus,
};
