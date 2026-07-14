'use strict';

/**
 * Read/write text files in a server's volume through the Pterodactyl Client API.
 * These use the file contents/write endpoints directly (rather than the JSON
 * pteroClient wrapper) because they exchange raw text, not JSON.
 */

const fetch = require('node-fetch');
const { config } = require('./config');

function clientUrl(uuid, action, filePath) {
  return `${config.pterodactyl.url}/api/client/servers/${uuid}/files/${action}` +
    `?file=${encodeURIComponent(filePath)}`;
}

async function writeServerFile(uuid, filePath, content) {
  const res = await fetch(clientUrl(uuid, 'write', filePath), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.pterodactyl.clientKey}`, 'Content-Type': 'text/plain' },
    body: content,
  });
  if (!res.ok) {
    throw new Error(`Pterodactyl Client API ${res.status}: ${await res.text()}`);
  }
}

/** Returns the file's text, or null if it doesn't exist (404). */
async function readServerFile(uuid, filePath) {
  const res = await fetch(clientUrl(uuid, 'contents', filePath), {
    headers: { 'Authorization': `Bearer ${config.pterodactyl.clientKey}`, 'Accept': 'text/plain' },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Pterodactyl Client API ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

module.exports = { writeServerFile, readServerFile };
