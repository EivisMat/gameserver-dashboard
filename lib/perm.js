'use strict';

/**
 * Convenience wrappers around requirePermission for server-scoped routes.
 *   perm('servers.power')          -> checks the permission against req.params.id
 *   perm('servers.settings','appId') -> checks against a differently-named param
 *   permAny('servers.create')      -> checks a permission with no server scope
 */

const { requirePermission } = require('../auth/middleware');

const perm = (permission, scopeParam = 'id') =>
  requirePermission(permission, (req) => req.params[scopeParam]);

const permAny = (permission) => requirePermission(permission);

module.exports = { perm, permAny };
