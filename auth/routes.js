const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { requireAuth, requireAdmin, getJwtSecret } = require('./middleware');

const router = express.Router();

// POST /api/auth/login: no auth required
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.getUserByUsername(username);
  if (!user || !db.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  db.updateLastLogin(user.id);

  const token = jwt.sign(
    { userId: user.id, username: user.username, isAdmin: !!user.is_admin },
    getJwtSecret(),
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  const permissions = db.getPermissions(user.id);
  const ownedServers = db.getOwnedServers(user.id);
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    isAdmin: !!user.is_admin,
    permissions,
    ownedServers,
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// GET /api/auth/me: requires auth
router.get('/me', requireAuth, (req, res) => {
  const user = req.user;
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    isAdmin: !!user.is_admin,
    permissions: user.permissions,
    ownedServers: user.ownedServers || [],
  });
});

// PATCH /api/auth/me: update own account (display name, password)
router.patch('/me', requireAuth, (req, res) => {
  const { displayName, currentPassword, newPassword } = req.body;

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required to change password' });
    const user = db.getUserById(req.user.id);
    if (!db.verifyPassword(user, currentPassword)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    db.updateUser(req.user.id, { password: newPassword });
  }

  if (displayName !== undefined) {
    db.updateUser(req.user.id, { displayName });
  }

  res.json({ success: true });
});

// GET /api/auth/users: admin only
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.getAllUsers();
  const result = users.map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    createdAt: u.created_at,
    lastLogin: u.last_login,
    permissions: db.getPermissions(u.id),
  }));
  res.json(result);
});

// POST /api/auth/users: admin only
router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, displayName, isAdmin, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const id = db.createUser({ username, password, displayName: displayName || username, isAdmin: !!isAdmin });
    if (permissions && Array.isArray(permissions)) {
      db.setPermissions(id, permissions);
    }
    res.json({ id, username });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/auth/users/:id: admin only
router.patch('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { displayName, password, isAdmin, permissions } = req.body;

  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.updateUser(id, { displayName, password, isAdmin });
  if (permissions && Array.isArray(permissions)) {
    db.setPermissions(id, permissions);
  }

  res.json({ success: true });
});

// DELETE /api/auth/users/:id: admin only
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Prevent deleting yourself
  if (req.user.id === id) return res.status(400).json({ error: 'Cannot delete your own account' });

  db.deleteUser(id);
  res.json({ success: true });
});

module.exports = router;
