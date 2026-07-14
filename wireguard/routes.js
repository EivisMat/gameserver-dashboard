const express = require('express');
const { execSync } = require('child_process');
const { requireAuth, requireAdmin } = require('../auth/middleware');
const db = require('../auth/db');

const router = express.Router();
const WG_HELPER = process.env.WG_HELPER_PATH || '/opt/dashboard/wg-helper.sh';
const NODE_PUBLIC_IP = process.env.NODE_PUBLIC_IP;
const WG_LISTEN_PORT = process.env.WG_LISTEN_PORT || '51820';
const WG_SUBNET = process.env.WG_SUBNET || '10.8.0.0/24';
const VPS_ENDPOINT = `${NODE_PUBLIC_IP}:${WG_LISTEN_PORT}`;

function runHelper(args) {
  return execSync(`sudo ${WG_HELPER} ${args}`, { encoding: 'utf-8', timeout: 10000 }).trim();
}

// GET /api/wireguard/peers: list all peers with live stats
router.get('/peers', requireAuth, requireAdmin, (req, res) => {
  try {
    const peers = db.getAllPeers();

    // Get live stats from wg show
    let liveStats = {};
    try {
      const dump = runHelper('list-peers');
      // wg show dump format: pubkey preshared endpoint allowed-ips latest-handshake transfer-rx transfer-tx
      const lines = dump.split('\n').slice(1); // skip interface line
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 7) {
          liveStats[parts[0]] = {
            endpoint: parts[2] === '(none)' ? null : parts[2],
            latestHandshake: parseInt(parts[4]) || 0,
            transferRx: parseInt(parts[5]) || 0,
            transferTx: parseInt(parts[6]) || 0,
          };
        }
      }
    } catch (e) { /* live stats unavailable */ }

    const result = peers.map(p => ({
      id: p.id,
      label: p.label,
      ipAddress: p.ip_address,
      userId: p.user_id,
      username: p.username,
      displayName: p.display_name,
      createdAt: p.created_at,
      revoked: !!p.revoked,
      live: liveStats[p.public_key] || null,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wireguard/peers: create new peer
router.post('/peers', requireAuth, requireAdmin, (req, res) => {
  try {
    const { label, userId } = req.body;
    if (!label) return res.status(400).json({ error: 'Label is required' });

    const ip = db.getNextAvailableIp();
    if (!ip) return res.status(400).json({ error: `No available IPs in ${WG_SUBNET}` });

    const keyOutput = runHelper('generate-keys');
    const [privateKey, publicKey, presharedKey] = keyOutput.split('\n');

    runHelper(`add-peer "${publicKey}" "${presharedKey}" "${ip}"`);

    const serverPubKey = runHelper('get-server-pubkey');

    // Save to database
    const id = db.createPeer({
      userId: userId || null,
      label,
      ipAddress: ip,
      publicKey,
      privateKey,
      presharedKey,
    });

    // Generate client config
    const config = [
      '[Interface]',
      `PrivateKey = ${privateKey}`,
      `Address = ${ip}/32`,
      'DNS = 1.1.1.1',
      '',
      '[Peer]',
      `PublicKey = ${serverPubKey}`,
      `PresharedKey = ${presharedKey}`,
      `Endpoint = ${VPS_ENDPOINT}`,
      `AllowedIPs = ${WG_SUBNET}`,
      'PersistentKeepalive = 25',
    ].join('\n');

    res.json({ id, ip, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wireguard/peers/:id/config: download config
router.get('/peers/:id/config', requireAuth, requireAdmin, (req, res) => {
  try {
    const peer = db.getPeerById(parseInt(req.params.id));
    if (!peer) return res.status(404).json({ error: 'Peer not found' });
    if (peer.revoked) return res.status(400).json({ error: 'Peer has been revoked' });

    const serverPubKey = runHelper('get-server-pubkey');

    const config = [
      '[Interface]',
      `PrivateKey = ${peer.private_key}`,
      `Address = ${peer.ip_address}/32`,
      'DNS = 1.1.1.1',
      '',
      '[Peer]',
      `PublicKey = ${serverPubKey}`,
      `PresharedKey = ${peer.preshared_key}`,
      `Endpoint = ${VPS_ENDPOINT}`,
      `AllowedIPs = ${WG_SUBNET}`,
      'PersistentKeepalive = 25',
    ].join('\n');

    res.json({ config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/wireguard/peers/:id: update label and/or linked user
router.patch('/peers/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const peer = db.getPeerById(parseInt(req.params.id));
    if (!peer) return res.status(404).json({ error: 'Peer not found' });
    const { label, userId } = req.body;
    if (label !== undefined) {
      if (!label.trim()) return res.status(400).json({ error: 'Label cannot be empty' });
      db.renamePeer(peer.id, label.trim());
    }
    if (userId !== undefined) {
      db.linkPeer(peer.id, userId || null);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/wireguard/peers/:id: revoke peer (must not already be revoked)
router.delete('/peers/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const peer = db.getPeerById(parseInt(req.params.id));
    if (!peer) return res.status(404).json({ error: 'Peer not found' });
    if (peer.revoked) return res.status(400).json({ error: 'Peer is already revoked' });
    runHelper(`remove-peer "${peer.public_key}"`);
    db.revokePeer(peer.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wireguard/peers/:id/reactivate: re-add a revoked peer to WireGuard
router.post('/peers/:id/reactivate', requireAuth, requireAdmin, (req, res) => {
  try {
    const peer = db.getPeerById(parseInt(req.params.id));
    if (!peer) return res.status(404).json({ error: 'Peer not found' });
    if (!peer.revoked) return res.status(400).json({ error: 'Peer is not revoked' });
    runHelper(`add-peer "${peer.public_key}" "${peer.preshared_key}" "${peer.ip_address}"`);
    db.reactivatePeer(peer.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/wireguard/peers/:id/permanent: permanently delete a revoked peer from DB
router.delete('/peers/:id/permanent', requireAuth, requireAdmin, (req, res) => {
  try {
    const peer = db.getPeerById(parseInt(req.params.id));
    if (!peer) return res.status(404).json({ error: 'Peer not found' });
    if (!peer.revoked) return res.status(400).json({ error: 'Revoke the peer before deleting' });
    db.deletePeer(peer.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
