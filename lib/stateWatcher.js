'use strict';

/**
 * Background watcher that infers crash and auto-restart events from Pterodactyl
 * power-state transitions.
 *
 * Wings doesn't push an event when a server dies on its own, so we poll each
 * server's state and compare against the last seen value. A running -> offline
 * transition with no recent user-initiated power command is treated as a crash;
 * an offline -> starting transition the same way is treated as an auto-restart.
 * Both are written to the activity log attributed to "Wings".
 *
 * `markUserPower` is called by the activity logger whenever a user issues a
 * power command, so the watcher can distinguish deliberate restarts from crashes
 * within a grace window.
 */

const { pteroApp, pteroClient } = require('./pterodactyl');
const { config } = require('./config');
const authDb = require('../auth/db');

const USER_POWER_GRACE_MS = 5 * 60 * 1000;

const lastServerState = new Map();  // identifier -> last state seen
const lastUserPowerAt = new Map();  // identifier -> timestamp of last user power.* action

function markUserPower(identifier) {
  if (identifier) lastUserPowerAt.set(identifier, Date.now());
}

function recentUserPower(identifier) {
  return Date.now() - (lastUserPowerAt.get(identifier) || 0) < USER_POWER_GRACE_MS;
}

function detectTransition(identifier, prev, curr) {
  if (prev === curr || recentUserPower(identifier)) return;

  if ((prev === 'running' || prev === 'starting') && (curr === 'offline' || curr === 'stopping')) {
    authDb.logActivity({
      serverUuid: identifier, userId: null, actorLabel: 'Wings',
      action: 'server.crash', details: { from: prev, to: curr },
    });
  }
  if (prev === 'offline' && curr === 'starting') {
    authDb.logActivity({
      serverUuid: identifier, userId: null, actorLabel: 'Wings',
      action: 'server.auto_restart', details: { from: prev, to: curr },
    });
  }
}

async function pollServerStates() {
  try {
    const list = await pteroApp('/servers?per_page=200');
    for (const s of list.data || []) {
      const identifier = s.attributes.identifier;
      if (!identifier) continue;
      try {
        const r = await pteroClient(`/servers/${identifier}/resources`);
        const state = r?.attributes?.current_state;
        if (!state) continue;
        const prev = lastServerState.get(identifier);
        if (prev) detectTransition(identifier, prev, state);
        lastServerState.set(identifier, state);
      } catch (_) { /* server gone or transient; skip */ }
    }
  } catch (_) { /* Pterodactyl unreachable; try again next interval */ }
}

function startStateWatcher() {
  pollServerStates();
  setInterval(pollServerStates, config.statePollIntervalMs);
}

module.exports = { startStateWatcher, markUserPower };
