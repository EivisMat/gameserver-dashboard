'use strict';

/**
 * Helpers for writing to the per-server activity log from request handlers.
 * `logAct` resolves the acting user from the request and records the event;
 * power actions additionally notify the state watcher so it doesn't mistake a
 * deliberate restart for a crash.
 */

const authDb = require('../auth/db');
const { markUserPower } = require('./stateWatcher');

/** Resolve the acting user (id + display label) from a request. */
function actorOf(req) {
  const u = req.user || {};
  return { userId: u.id || null, actorLabel: u.display_name || u.username || 'Unknown' };
}

function logAct(serverUuid, req, action, details) {
  if (!serverUuid) return;
  const { userId, actorLabel } = actorOf(req);
  authDb.logActivity({ serverUuid, userId, actorLabel, action, details });
  if (action.startsWith('power.')) markUserPower(serverUuid);
}

module.exports = { actorOf, logAct };
