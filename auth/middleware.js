const jwt = require('jsonwebtoken');
const db = require('./db');

function getJwtSecret() {
  return process.env.JWT_SECRET;
}

function hasPermission(user, permission, serverUuid) {
  if (user.is_admin) return true;

  // Implicit owner: full servers.* access on a server you created through the dash
  if (permission.startsWith('servers.') && serverUuid && user.ownedServers?.includes(serverUuid)) {
    return true;
  }

  // Private-server gate: if this server is private and the user isn't on the
  // access list, no servers.* permission applies regardless of scope.
  if (permission.startsWith('servers.') && serverUuid &&
      user.privateServerIds?.includes(serverUuid) &&
      !user.accessibleServers?.includes(serverUuid)) {
    return false;
  }

  return user.permissions.some(p =>
    p.permission === permission && (p.scope === '*' || p.scope === serverUuid)
  );
}

// Verify a token and return the user enriched with permissions + server access
// lists, or null if the token is invalid or the user no longer exists.
function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const user = db.getUserById(payload.userId);
    if (!user) return null;
    user.permissions = db.getPermissions(user.id);
    user.ownedServers = db.getOwnedServers(user.id);
    user.privateServerIds = db.getPrivateServers();
    user.accessibleServers = db.getAccessibleServers(user.id);
    return user;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin required' });
  next();
}

function requirePermission(permission, getScope) {
  return (req, res, next) => {
    const scope = getScope ? getScope(req) : null;
    if (!hasPermission(req.user, permission, scope)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Parse cookies from raw header (for WebSocket upgrade, where Express middleware doesn't run)
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

function authenticateWs(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return userFromToken(cookies.token);
}

module.exports = {
  requireAuth, requireAdmin, requirePermission,
  hasPermission, authenticateWs, getJwtSecret,
};
