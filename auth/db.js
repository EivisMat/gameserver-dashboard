const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const { DEFAULT_CLIENT_MODS } = require('../lib/clientMods');

const DB_PATH = path.join(__dirname, '..', 'data', 'dashboard.db');
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '*',
      UNIQUE(user_id, permission, scope)
    );

    CREATE TABLE IF NOT EXISTS wireguard_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      ip_address TEXT UNIQUE NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      preshared_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      revoked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS server_owners (
      server_identifier TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_public INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS server_access (
      server_identifier TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (server_identifier, user_id)
    );

    CREATE TABLE IF NOT EXISTS server_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_uuid TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_label TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_server_activity_uuid ON server_activity(server_uuid, id DESC);

    CREATE TABLE IF NOT EXISTS client_mod_denylist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pattern TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed the client-mod denylist once, on first run of a fresh install.
  const denyCount = db.prepare('SELECT COUNT(*) AS n FROM client_mod_denylist').get().n;
  if (denyCount === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO client_mod_denylist (name, pattern) VALUES (?, ?)');
    for (const m of DEFAULT_CLIENT_MODS) ins.run(m.name, m.pattern);
  }

  // Migration: add is_public to existing server_owners installs. Default 1 so
  // legacy servers stay visible to non-admins (preserves current behaviour).
  try { db.exec(`ALTER TABLE server_owners ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1`); } catch (_) {}

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

// --- Users ---

function createUser({ username, password, displayName, isAdmin }) {
  const hash = bcrypt.hashSync(password, 10);
  const stmt = getDb().prepare(
    'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(username, hash, displayName, isAdmin ? 1 : 0);
  return result.lastInsertRowid;
}

function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getAllUsers() {
  return getDb().prepare('SELECT id, username, display_name, is_admin, created_at, last_login FROM users').all();
}

function updateUser(id, { displayName, password, isAdmin }) {
  const user = getUserById(id);
  if (!user) return false;

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }
  if (displayName !== undefined) {
    getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
  }
  if (isAdmin !== undefined) {
    getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }
  return true;
}

function updateLastLogin(id) {
  getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);
}

function deleteUser(id) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

// --- Permissions ---

function getPermissions(userId) {
  return getDb().prepare('SELECT permission, scope FROM user_permissions WHERE user_id = ?').all(userId);
}

function setPermissions(userId, permissions) {
  const del = getDb().prepare('DELETE FROM user_permissions WHERE user_id = ?');
  const ins = getDb().prepare('INSERT INTO user_permissions (user_id, permission, scope) VALUES (?, ?, ?)');

  const tx = getDb().transaction(() => {
    del.run(userId);
    for (const p of permissions) {
      ins.run(userId, p.permission, p.scope || '*');
    }
  });
  tx();
}

// --- WireGuard Peers ---

function getAllPeers() {
  return getDb().prepare(`
    SELECT wp.*, u.username, u.display_name
    FROM wireguard_peers wp
    LEFT JOIN users u ON wp.user_id = u.id
    ORDER BY wp.id
  `).all();
}

function createPeer({ userId, label, ipAddress, publicKey, privateKey, presharedKey }) {
  const stmt = getDb().prepare(
    'INSERT INTO wireguard_peers (user_id, label, ip_address, public_key, private_key, preshared_key) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(userId || null, label, ipAddress, publicKey, privateKey, presharedKey || null);
  return result.lastInsertRowid;
}

function getPeerById(id) {
  return getDb().prepare('SELECT * FROM wireguard_peers WHERE id = ?').get(id);
}

function revokePeer(id) {
  getDb().prepare('UPDATE wireguard_peers SET revoked = 1 WHERE id = ?').run(id);
}

function reactivatePeer(id) {
  getDb().prepare('UPDATE wireguard_peers SET revoked = 0 WHERE id = ?').run(id);
}

function deletePeer(id) {
  getDb().prepare('DELETE FROM wireguard_peers WHERE id = ? AND revoked = 1').run(id);
}

function renamePeer(id, label) {
  getDb().prepare('UPDATE wireguard_peers SET label = ? WHERE id = ?').run(label, id);
}

function linkPeer(id, userId) {
  getDb().prepare('UPDATE wireguard_peers SET user_id = ? WHERE id = ?').run(userId, id);
}

function getNextAvailableIp() {
  const cidr = process.env.WG_SUBNET || '10.8.0.0/24';
  const base = cidr.split('/')[0].split('.').slice(0, 3).join('.') + '.';

  const used = getDb().prepare(
    "SELECT ip_address FROM wireguard_peers WHERE revoked = 0"
  ).all().map(r => r.ip_address);

  for (let i = 3; i <= 254; i++) {
    const ip = `${base}${i}`;
    if (!used.includes(ip)) return ip;
  }
  return null;
}

// --- Server Ownership ---

function setServerOwner(identifier, userId, isPublic = 1) {
  if (!identifier) return;
  getDb().prepare(
    'INSERT OR REPLACE INTO server_owners (server_identifier, user_id, is_public) VALUES (?, ?, ?)'
  ).run(identifier, userId || null, isPublic ? 1 : 0);
}

function getServerOwner(identifier) {
  const row = getDb().prepare('SELECT user_id FROM server_owners WHERE server_identifier = ?').get(identifier);
  return row?.user_id || null;
}

function getOwnedServers(userId) {
  return getDb().prepare('SELECT server_identifier FROM server_owners WHERE user_id = ?')
    .all(userId).map(r => r.server_identifier);
}

function deleteServerOwner(identifier) {
  getDb().prepare('DELETE FROM server_owners WHERE server_identifier = ?').run(identifier);
}

// --- Server Visibility ---

function getServerVisibility(identifier) {
  const row = getDb().prepare('SELECT is_public FROM server_owners WHERE server_identifier = ?').get(identifier);
  if (!row) return 1; // no record = public (legacy default)
  return row.is_public ? 1 : 0;
}

function setServerVisibility(identifier, isPublic) {
  const flag = isPublic ? 1 : 0;
  const existing = getDb().prepare('SELECT user_id FROM server_owners WHERE server_identifier = ?').get(identifier);
  if (existing) {
    getDb().prepare('UPDATE server_owners SET is_public = ? WHERE server_identifier = ?').run(flag, identifier);
  } else {
    getDb().prepare('INSERT INTO server_owners (server_identifier, user_id, is_public) VALUES (?, NULL, ?)').run(identifier, flag);
  }
}

function getPrivateServers() {
  return getDb().prepare('SELECT server_identifier FROM server_owners WHERE is_public = 0')
    .all().map(r => r.server_identifier);
}

// --- Server Access (grants for private servers) ---

function getAccessibleServers(userId) {
  return getDb().prepare('SELECT server_identifier FROM server_access WHERE user_id = ?')
    .all(userId).map(r => r.server_identifier);
}

function getServerAccessUsers(identifier) {
  return getDb().prepare('SELECT user_id FROM server_access WHERE server_identifier = ?')
    .all(identifier).map(r => r.user_id);
}

function addServerAccess(identifier, userId) {
  getDb().prepare('INSERT OR IGNORE INTO server_access (server_identifier, user_id) VALUES (?, ?)').run(identifier, userId);
}

function removeServerAccess(identifier, userId) {
  getDb().prepare('DELETE FROM server_access WHERE server_identifier = ? AND user_id = ?').run(identifier, userId);
}

function clearServerAccess(identifier) {
  getDb().prepare('DELETE FROM server_access WHERE server_identifier = ?').run(identifier);
}

// --- Server Activity ---

function logActivity({ serverUuid, userId, actorLabel, action, details }) {
  if (!serverUuid || !action) return;
  const detailsJson = details && typeof details === 'object' ? JSON.stringify(details) : (details || null);
  const retention = parseInt(process.env.ACTIVITY_RETENTION_PER_SERVER || '100', 10);

  const tx = getDb().transaction(() => {
    getDb().prepare(
      'INSERT INTO server_activity (server_uuid, user_id, actor_label, action, details) VALUES (?, ?, ?, ?, ?)'
    ).run(serverUuid, userId || null, actorLabel || 'Unknown', action, detailsJson);

    if (retention > 0) {
      getDb().prepare(`
        DELETE FROM server_activity
        WHERE server_uuid = ?
          AND id NOT IN (
            SELECT id FROM server_activity
            WHERE server_uuid = ?
            ORDER BY id DESC
            LIMIT ?
          )
      `).run(serverUuid, serverUuid, retention);
    }
  });
  tx();
}

function getActivity(serverUuid, { limit = 100, before = null } = {}) {
  let rows;
  if (before) {
    rows = getDb().prepare(
      'SELECT id, server_uuid, user_id, actor_label, action, details, created_at FROM server_activity WHERE server_uuid = ? AND id < ? ORDER BY id DESC LIMIT ?'
    ).all(serverUuid, before, limit);
  } else {
    rows = getDb().prepare(
      'SELECT id, server_uuid, user_id, actor_label, action, details, created_at FROM server_activity WHERE server_uuid = ? ORDER BY id DESC LIMIT ?'
    ).all(serverUuid, limit);
  }
  return rows.map(r => ({
    id: r.id,
    serverUuid: r.server_uuid,
    userId: r.user_id,
    actorLabel: r.actor_label,
    action: r.action,
    details: r.details ? safeParseJson(r.details) : null,
    createdAt: r.created_at,
  }));
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// --- Client-mod denylist (CurseForge install stripping) ---

function getClientModDenylist() {
  return getDb().prepare('SELECT id, name, pattern, created_at FROM client_mod_denylist ORDER BY name COLLATE NOCASE').all();
}

function addClientMod(name, pattern) {
  const info = getDb().prepare('INSERT OR IGNORE INTO client_mod_denylist (name, pattern) VALUES (?, ?)').run(name, pattern);
  return info.changes > 0;
}

function removeClientMod(id) {
  getDb().prepare('DELETE FROM client_mod_denylist WHERE id = ?').run(id);
}

module.exports = {
  init, getDb,
  createUser, getUserByUsername, getUserById, getAllUsers, updateUser, deleteUser,
  updateLastLogin, verifyPassword,
  getPermissions, setPermissions,
  getAllPeers, createPeer, getPeerById, revokePeer, reactivatePeer, deletePeer, renamePeer, linkPeer, getNextAvailableIp,
  setServerOwner, getServerOwner, getOwnedServers, deleteServerOwner,
  getServerVisibility, setServerVisibility, getPrivateServers,
  getAccessibleServers, getServerAccessUsers,
  addServerAccess, removeServerAccess, clearServerAccess,
  logActivity, getActivity,
  getClientModDenylist, addClientMod, removeClientMod,
};
