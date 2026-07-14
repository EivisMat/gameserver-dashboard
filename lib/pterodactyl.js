'use strict';

/**
 * Thin wrappers over the two Pterodactyl REST APIs.
 *
 *  - Application API (`/api/application`): panel-admin operations (server
 *    creation, allocations, egg/nest inspection). Authenticated with the app key.
 *  - Client API (`/api/client`): per-user operations (power, console, files,
 *    backups, schedules). Authenticated with the client key.
 *
 * Both helpers throw an Error carrying the HTTP status and body on a non-2xx
 * response, and return null for 204 No Content.
 */

const fetch = require('node-fetch');
const { config } = require('./config');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';

function appHeaders() {
  return {
    'Authorization': `Bearer ${config.pterodactyl.appKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

function clientHeaders() {
  return {
    'Authorization': `Bearer ${config.pterodactyl.clientKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

async function request(base, headers, endpoint, options = {}) {
  const res = await fetch(`${config.pterodactyl.url}${base}${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    const api = base.includes('application') ? 'App' : 'Client';
    throw new Error(`Pterodactyl ${api} API ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

const pteroApp = (endpoint, options) => request('/api/application', appHeaders(), endpoint, options);
const pteroClient = (endpoint, options) => request('/api/client', clientHeaders(), endpoint, options);

module.exports = {
  pteroApp,
  pteroClient,
  clientHeaders,
  MODRINTH_API,
  CURSEFORGE_API,
};
