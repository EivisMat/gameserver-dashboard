'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasPermission } = require('../auth/middleware');

/** Build a non-admin user with sensible empty defaults. */
function user(overrides = {}) {
  return {
    is_admin: false,
    permissions: [],
    ownedServers: [],
    privateServerIds: [],
    accessibleServers: [],
    ...overrides,
  };
}

const SERVER = 'abcd1234';

test('admins bypass every check', () => {
  const admin = user({ is_admin: true, permissions: [] });
  assert.equal(hasPermission(admin, 'servers.delete', SERVER), true);
  assert.equal(hasPermission(admin, 'anything', null), true);
});

test('a global (*) grant applies to any server', () => {
  const u = user({ permissions: [{ permission: 'servers.power', scope: '*' }] });
  assert.equal(hasPermission(u, 'servers.power', SERVER), true);
  assert.equal(hasPermission(u, 'servers.power', 'other'), true);
});

test('a server-scoped grant applies only to that server', () => {
  const u = user({ permissions: [{ permission: 'servers.files', scope: SERVER }] });
  assert.equal(hasPermission(u, 'servers.files', SERVER), true);
  assert.equal(hasPermission(u, 'servers.files', 'other'), false);
});

test('missing permission is denied', () => {
  const u = user({ permissions: [{ permission: 'servers.view', scope: '*' }] });
  assert.equal(hasPermission(u, 'servers.delete', SERVER), false);
});

test('implicit owner gets full servers.* on a server they created', () => {
  const u = user({ ownedServers: [SERVER] }); // no explicit permissions
  assert.equal(hasPermission(u, 'servers.delete', SERVER), true);
  assert.equal(hasPermission(u, 'servers.files', SERVER), true);
  assert.equal(hasPermission(u, 'servers.power', 'other'), false);
});

test('a private server is hidden even from a holder of a global grant', () => {
  const u = user({
    permissions: [{ permission: 'servers.view', scope: '*' }],
    privateServerIds: [SERVER],
    accessibleServers: [],
  });
  assert.equal(hasPermission(u, 'servers.view', SERVER), false);
  assert.equal(hasPermission(u, 'servers.view', 'public-one'), true);
});

test('granting access to a private server re-enables existing grants', () => {
  const u = user({
    permissions: [{ permission: 'servers.console.write', scope: '*' }],
    privateServerIds: [SERVER],
    accessibleServers: [SERVER],
  });
  assert.equal(hasPermission(u, 'servers.console.write', SERVER), true);
});

test('the private gate only applies to servers.* permissions', () => {
  const u = user({
    permissions: [{ permission: 'something.else', scope: '*' }],
    privateServerIds: [SERVER],
  });
  assert.equal(hasPermission(u, 'something.else', SERVER), true);
});
