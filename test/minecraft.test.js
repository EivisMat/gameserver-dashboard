'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  writeVarInt,
  readVarInt,
  buildHandshakeAndStatus,
  normalizeStatus,
} = require('../lib/minecraft');

test('VarInt round-trips representative values', () => {
  for (const n of [0, 1, 127, 128, 255, 300, 25565, 2097151, 2147483647]) {
    const buf = writeVarInt(n);
    const { value, bytesRead } = readVarInt(buf, 0);
    assert.equal(value, n, `round-trip failed for ${n}`);
    assert.equal(bytesRead, buf.length);
  }
});

test('VarInt uses the documented byte widths', () => {
  assert.equal(writeVarInt(0).length, 1);
  assert.equal(writeVarInt(127).length, 1);
  assert.equal(writeVarInt(128).length, 2);   // first value needing a continuation byte
  assert.equal(writeVarInt(25565).length, 3);
});

test('readVarInt returns null when the buffer is incomplete', () => {
  // 0x80 has the continuation bit set but no following byte.
  assert.equal(readVarInt(Buffer.from([0x80]), 0), null);
});

test('handshake packet is length-prefixed and carries the port', () => {
  const packet = buildHandshakeAndStatus('localhost', 25565);
  const { value: len, bytesRead } = readVarInt(packet, 0);
  // The declared length must match the bytes that follow the handshake's own
  // length prefix, up to the trailing status-request packet (2 bytes).
  assert.equal(packet.length, bytesRead + len + 2);
  // Tail of the packet: [...port hi][port lo][next-state VarInt = 0x01][status request = 0x01 0x00].
  // So the big-endian port sits 5 and 4 bytes from the end.
  const portHi = packet[packet.length - 5];
  const portLo = packet[packet.length - 4];
  assert.equal((portHi << 8) | portLo, 25565);
});

test('normalizeStatus extracts the fields the UI needs', () => {
  const raw = {
    players: { online: 5, max: 20 },
    version: { name: '1.20.1' },
    description: 'A Minecraft Server',
  };
  assert.deepEqual(normalizeStatus(raw), {
    online: 5, max: 20, version: '1.20.1', motd: 'A Minecraft Server',
  });
});

test('normalizeStatus tolerates missing fields and object MOTD', () => {
  assert.deepEqual(normalizeStatus({}), { online: null, max: null, version: null, motd: null });
  assert.equal(normalizeStatus({ description: { text: 'hi' } }).motd, 'hi');
});
