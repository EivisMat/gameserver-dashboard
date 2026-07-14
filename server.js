require('dotenv').config();
const express = require('express');
const http = require('http');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const { WebSocket } = require('ws');
const cookieParser = require('cookie-parser');

const AdmZip = require('adm-zip');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const { config, assertValid } = require('./lib/config');
const { pteroApp, pteroClient, clientHeaders, MODRINTH_API, CURSEFORGE_API } = require('./lib/pterodactyl');
const { getMcStatus } = require('./lib/minecraft');
const { asyncHandler, errorHandler } = require('./lib/asyncHandler');
const { perm, permAny } = require('./lib/perm');
const { logAct } = require('./lib/activity');
const { startStateWatcher } = require('./lib/stateWatcher');
const { writeServerFile, readServerFile } = require('./lib/serverFiles');
const { WORLD_ONLY_PTEROIGNORE, KNOWN_BACKUP_MODS } = require('./lib/backupMods');
const { compileDenylist, matchClientOnlyMod, prefixFromFilename } = require('./lib/clientMods');
const { upload } = require('./lib/upload');
const authDb = require('./auth/db');
const authRoutes = require('./auth/routes');
const { requireAuth, requireAdmin, hasPermission, authenticateWs } = require('./auth/middleware');
const wireguardRoutes = require('./wireguard/routes');

assertValid();
authDb.init();

const app = express();
const server = http.createServer(app);

const PORT = config.port;
const PTERO_URL = config.pterodactyl.url;
const CLIENT_KEY = config.pterodactyl.clientKey;
const CF_API_KEY = config.curseforgeApiKey;
const NODE_PUBLIC_IP = config.node.publicIp;
const PTERO_DEFAULT_USER_ID = config.pterodactyl.defaultUserId;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);          // login is unauthenticated
app.use('/api/wireguard', wireguardRoutes); // admin-gated inside the router
app.use('/api', requireAuth);               // everything below requires a session

// --- Server list (Application API) ---

app.get('/api/servers', asyncHandler(async (req, res) => {
  const data = await pteroApp('/servers?include=egg,nest,allocations');
  if (!req.user.is_admin) {
    data.data = (data.data || []).filter(s =>
      hasPermission(req.user, 'servers.view', s.attributes.uuid) ||
      hasPermission(req.user, 'servers.view', s.attributes.identifier)
    );
  }
  res.json(data);
}));

// --- Server details + resources (Client API) ---

app.get('/api/servers/:id/details', perm('servers.view'), asyncHandler(async (req, res) => {
  res.json(await pteroClient(`/servers/${req.params.id}`));
}));

app.get('/api/servers/:id/resources', perm('servers.view'), asyncHandler(async (req, res) => {
  res.json(await pteroClient(`/servers/${req.params.id}/resources`));
}));

// --- Minecraft player count (server-scoped) ---

app.get('/api/servers/:id/mc-status', perm('servers.view'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}`);
  const alloc = data?.attributes?.relationships?.allocations?.data?.find(a => a.attributes.is_default)
    || data?.attributes?.relationships?.allocations?.data?.[0];
  const port = alloc?.attributes?.port;
  const host = alloc?.attributes?.ip_alias || alloc?.attributes?.ip;
  if (!port || !host) return res.json({ unreachable: true });
  const status = await getMcStatus(host, port);
  res.json(status);
}));

// --- Activity log (server-scoped) ---

app.get('/api/servers/:id/activity', perm('servers.view'), asyncHandler((req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const before = req.query.before ? parseInt(req.query.before) : null;
  const rows = authDb.getActivity(req.params.id, { limit, before });
  res.json({ data: rows });
}));

// --- Power actions (Client API) ---

app.post('/api/servers/:id/power', perm('servers.power'), asyncHandler(async (req, res) => {
  const signal = req.body.signal;
  await pteroClient(`/servers/${req.params.id}/power`, {
    method: 'POST',
    body: JSON.stringify({ signal }),
  });
  logAct(req.params.id, req, `power.${signal}`);
  res.json({ success: true });
}));

// --- Send command to console (Client API) ---

app.post('/api/servers/:id/command', perm('servers.console.write'), asyncHandler(async (req, res) => {
  await pteroClient(`/servers/${req.params.id}/command`, {
    method: 'POST',
    body: JSON.stringify({ command: req.body.command }),
  });
  res.json({ success: true });
}));

// --- Eggs (Application API) ---

app.get('/api/eggs', permAny('servers.create'), asyncHandler(async (req, res) => {
  const nests = await pteroApp('/nests');
  const allEggs = [];
  for (const nest of nests.data) {
    const eggs = await pteroApp(`/nests/${nest.attributes.id}/eggs?include=variables`);
    for (const egg of eggs.data) {
      allEggs.push({
        id: egg.attributes.id,
        name: egg.attributes.name,
        nestId: nest.attributes.id,
        nestName: nest.attributes.name,
        dockerImage: egg.attributes.docker_image,
        dockerImages: egg.attributes.docker_images || {},
        startup: egg.attributes.startup,
        variables: egg.attributes.relationships?.variables?.data?.map(v => v.attributes) || [],
      });
    }
  }
  // Only keep Minecraft eggs (exclude CurseForge Generic)
  const filtered = allEggs.filter(e => {
    const n = e.name.toLowerCase();
    const isMinecraft = e.nestName.toLowerCase() === 'minecraft' ||
      ['vanilla minecraft', 'paper', 'forge minecraft', 'fabric', 'sponge', 'bungeecord'].some(k => n.includes(k));
    const isCFGeneric = n.includes('curseforge generic');
    return isMinecraft && !isCFGeneric;
  });
  res.json(filtered);
}));

// --- Allocations (Application API) ---

app.get('/api/allocations', permAny('servers.create'), asyncHandler(async (req, res) => {
  const data = await pteroApp('/nodes/1/allocations?per_page=100');
  res.json(data);
}));

app.post('/api/allocations', permAny('servers.create'), asyncHandler(async (req, res) => {
  await pteroApp('/nodes/1/allocations', {
    method: 'POST',
    body: JSON.stringify({
      ip: NODE_PUBLIC_IP,
      ports: [String(req.body.port)],
    }),
  });
  const allocs = await pteroApp('/nodes/1/allocations?per_page=200');
  const found = allocs.data.find(a => a.attributes.port === req.body.port && !a.attributes.assigned);
  res.json(found || { created: true });
}));

// --- Create server (Application API) ---

app.post('/api/servers', permAny('servers.create'), asyncHandler(async (req, res) => {
  const { name, eggId, memory, disk, cpu, port, environment, dockerImage, startup } = req.body;
  // Only admins get the visibility choice; non-admin servers are always public.
  const isPublic = req.user?.is_admin
    ? (req.body.isPublic === true || req.body.isPublic === 1)
    : true;

  await pteroApp('/nodes/1/allocations', {
    method: 'POST',
    body: JSON.stringify({
      ip: NODE_PUBLIC_IP,
      ports: [String(port)],
    }),
  });

  let allocationId = null;
  let page = 1;
  while (!allocationId) {
    const allocs = await pteroApp(`/nodes/1/allocations?per_page=100&page=${page}`);
    const found = allocs.data.find(a => a.attributes.port === parseInt(port) && !a.attributes.assigned);
    if (found) {
      allocationId = found.attributes.id;
      break;
    }
    if (page >= (allocs.meta?.pagination?.total_pages || 1)) break;
    page++;
  }

  if (!allocationId) {
    return res.status(400).json({ error: 'Could not create/find allocation for port ' + port });
  }

  const serverData = {
    name,
    user: PTERO_DEFAULT_USER_ID,
    egg: eggId,
    docker_image: dockerImage,
    startup: startup,
    environment: environment || {},
    limits: {
      memory: parseInt(memory),
      swap: 0,
      disk: parseInt(disk),
      io: 500,
      cpu: parseInt(cpu) || 0,
    },
    feature_limits: {
      databases: 2,
      backups: 3,
      allocations: 1,
    },
    allocation: {
      default: allocationId,
    },
  };

  const data = await pteroApp('/servers', {
    method: 'POST',
    body: JSON.stringify(serverData),
  });

  const serverIdent = data.attributes?.identifier;
  logAct(serverIdent, req, 'server.create', { name, eggId, port: parseInt(port), memory: parseInt(memory), disk: parseInt(disk), isPublic });
  if (serverIdent && req.user?.id) {
    authDb.setServerOwner(serverIdent, req.user.id, isPublic);
  }

  // Enable whitelist + write world-only .pteroignore for Minecraft servers
  const serverUuid = data.attributes?.uuid;
  if (serverUuid) {
    // Give Wings a moment to set up the server
    setTimeout(async () => {
      try {
        await writeServerFile(serverUuid, '/server.properties', 'white-list=true\nenforce-whitelist=true\n');
      } catch (e) { /* non-fatal */ }
      try {
        await writeServerFile(serverUuid, '/.pteroignore', WORLD_ONLY_PTEROIGNORE);
      } catch (e) { /* non-fatal */ }
    }, 8000);
  }

  res.json(data);
}));

// --- Delete server (Application API) ---

app.delete('/api/servers/:id', perm('servers.delete'), asyncHandler(async (req, res) => {
  let name = null, ident = null;
  try {
    const s = await pteroApp(`/servers/${req.params.id}`);
    name = s.attributes?.name || null;
    ident = s.attributes?.identifier || null;
  } catch (_) {}
  await pteroApp(`/servers/${req.params.id}`, { method: 'DELETE' });
  if (ident) {
    logAct(ident, req, 'server.delete', { name });
    authDb.deleteServerOwner(ident);
    authDb.clearServerAccess(ident);
  }
  res.json({ success: true });
}));

// --- Server visibility + access (admin only) ---

app.get('/api/servers/:id/access', requireAdmin, asyncHandler((req, res) => {
  const id = req.params.id;
  const isPublic = authDb.getServerVisibility(id) === 1;
  const ownerId = authDb.getServerOwner(id);
  const grantUserIds = authDb.getServerAccessUsers(id);
  const allUsers = authDb.getAllUsers();
  const byId = new Map(allUsers.map(u => [u.id, u]));
  const fmt = (u) => u ? { id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin } : null;
  res.json({
    isPublic,
    owner: fmt(byId.get(ownerId)),
    accessGrants: grantUserIds.map(uid => fmt(byId.get(uid))).filter(Boolean),
  });
}));

app.patch('/api/servers/:id/visibility', requireAdmin, asyncHandler((req, res) => {
  const isPublic = !!req.body.isPublic;
  authDb.setServerVisibility(req.params.id, isPublic);
  logAct(req.params.id, req, 'config.visibility', { isPublic });
  res.json({ success: true, isPublic });
}));

app.post('/api/servers/:id/access', requireAdmin, asyncHandler((req, res) => {
  const userId = parseInt(req.body.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const user = authDb.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  authDb.addServerAccess(req.params.id, userId);
  logAct(req.params.id, req, 'access.grant', { userId, username: user.username });
  res.json({ success: true });
}));

app.delete('/api/servers/:id/access/:userId', requireAdmin, asyncHandler((req, res) => {
  const userId = parseInt(req.params.userId);
  const user = authDb.getUserById(userId);
  authDb.removeServerAccess(req.params.id, userId);
  logAct(req.params.id, req, 'access.revoke', { userId, username: user?.username || null });
  res.json({ success: true });
}));

// --- File management (Client API) ---

app.get('/api/servers/:id/files/list', perm('servers.files'), asyncHandler(async (req, res) => {
  const dir = req.query.directory || '/';
  const data = await pteroClient(`/servers/${req.params.id}/files/list?directory=${encodeURIComponent(dir)}`);
  res.json(data);
}));

app.post('/api/servers/:id/files/compress', perm('servers.files'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/files/compress`, {
    method: 'POST',
    body: JSON.stringify({
      root: req.body.root || '/',
      files: req.body.files,
    }),
  });
  res.json(data);
}));

app.get('/api/servers/:id/files/download', perm('servers.files'), asyncHandler(async (req, res) => {
  const file = req.query.file;
  const data = await pteroClient(`/servers/${req.params.id}/files/download?file=${encodeURIComponent(file)}`);
  const url = data.attributes?.url;
  if (!url) return res.status(500).json({ error: 'No download URL from Wings' });
  const filename = file.split('/').pop();
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const upstream = await fetch(url);
  if (!upstream.ok) return res.status(upstream.status).json({ error: 'Wings returned ' + upstream.status });
  res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  const cl = upstream.headers.get('Content-Length');
  if (cl) res.setHeader('Content-Length', cl);
  upstream.body.pipe(res);
}));

app.get('/api/servers/:id/files/upload', perm('servers.files'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/files/upload`);
  res.json(data);
}));

app.post('/api/servers/:id/files/upload', perm('servers.files'), upload.array('files', 20), asyncHandler(async (req, res) => {
  const files = req.files || [];
  try {
    const directory = req.query.directory || '/';
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const urlData = await pteroClient(`/servers/${req.params.id}/files/upload`);
    const uploadUrl = urlData.attributes.url;

    const form = new FormData();
    for (const f of files) {
      form.append('files', fs.createReadStream(f.path), {
        filename: f.originalname,
        contentType: f.mimetype,
      });
    }

    const uploadRes = await fetch(`${uploadUrl}&directory=${encodeURIComponent(directory)}`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Upload failed ${uploadRes.status}: ${text}`);
    }

    res.json({ success: true, count: files.length });
  } finally {
    for (const f of files) { try { fs.unlinkSync(f.path); } catch (_) {} }
  }
}));

// Folder upload: the browser sends all files of a directory tree with their
// relative paths as the multipart filename (webkitRelativePath). We zip them
// server-side preserving structure, upload the single archive to Wings, then
// decompress, keeping it to ~3 Pterodactyl calls regardless of folder size.
app.post('/api/servers/:id/files/upload-folder', perm('servers.files'), upload.array('files', 5000), asyncHandler(async (req, res) => {
  let tmpZip = null;
  const files = req.files || [];
  try {
    const directory = req.query.directory || '/';
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    tmpZip = path.join(os.tmpdir(), `folder-upload-${Date.now()}.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tmpZip);
      const archive = archiver('zip', { zlib: { level: 1 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const f of files) {
        // originalname carries the relative path (e.g. "myfolder/config/a.cfg")
        archive.file(f.path, { name: f.originalname });
      }
      archive.finalize();
    });

    const archiveName = `__folder-upload-${Date.now()}.zip`;
    const urlData = await pteroClient(`/servers/${req.params.id}/files/upload`);
    const uploadUrl = urlData.attributes.url;

    const form = new FormData();
    form.append('files', fs.createReadStream(tmpZip), { filename: archiveName, contentType: 'application/zip' });
    const uploadRes = await fetch(`${uploadUrl}&directory=${encodeURIComponent(directory)}`, {
      method: 'POST', body: form, headers: form.getHeaders(),
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Upload failed ${uploadRes.status}: ${text}`);
    }

    await pteroClient(`/servers/${req.params.id}/files/decompress`, {
      method: 'POST',
      body: JSON.stringify({ root: directory, file: archiveName }),
    });

    // Remove the staging archive from the server volume
    try {
      await pteroClient(`/servers/${req.params.id}/files/delete`, {
        method: 'POST',
        body: JSON.stringify({ root: directory, files: [archiveName] }),
      });
    } catch (_) { /* non-fatal */ }

    res.json({ success: true, count: files.length });
  } finally {
    if (tmpZip) try { fs.unlinkSync(tmpZip); } catch (_) {}
    for (const f of files) { try { fs.unlinkSync(f.path); } catch (_) {} }
  }
}));

app.post('/api/servers/:id/files/decompress', perm('servers.files'), asyncHandler(async (req, res) => {
  await pteroClient(`/servers/${req.params.id}/files/decompress`, {
    method: 'POST',
    body: JSON.stringify({
      root: req.body.root || '/',
      file: req.body.file,
    }),
  });
  res.json({ success: true });
}));

app.post('/api/servers/:id/files/delete', perm('servers.files'), asyncHandler(async (req, res) => {
  const root = req.body.root || '/';
  const files = req.body.files;
  await pteroClient(`/servers/${req.params.id}/files/delete`, {
    method: 'POST',
    body: JSON.stringify({ root, files }),
  });
  logAct(req.params.id, req, 'file.delete', { root, files });
  res.json({ success: true });
}));

// --- File contents (read/write) ---

app.get('/api/servers/:id/files/contents', perm('servers.files'), asyncHandler(async (req, res) => {
  const file = req.query.file;
  const url = `${PTERO_URL}/api/client/servers/${req.params.id}/files/contents?file=${encodeURIComponent(file)}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${CLIENT_KEY}`, 'Accept': 'text/plain' } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Pterodactyl Client API ${r.status}: ${text}`);
  }
  const text = await r.text();
  res.type('text/plain').send(text);
}));

app.post('/api/servers/:id/files/write', perm('servers.files'), asyncHandler(async (req, res) => {
  const file = req.query.file;
  const url = `${PTERO_URL}/api/client/servers/${req.params.id}/files/write?file=${encodeURIComponent(file)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CLIENT_KEY}`, 'Content-Type': 'text/plain' },
    body: req.body.content,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Pterodactyl Client API ${r.status}: ${text}`);
  }
  res.json({ success: true });
}));

app.post('/api/servers/:id/files/rename', perm('servers.files'), asyncHandler(async (req, res) => {
  const root = req.body.root || '/';
  const files = req.body.files;
  await pteroClient(`/servers/${req.params.id}/files/rename`, {
    method: 'PUT',
    body: JSON.stringify({ root, files }),
  });
  logAct(req.params.id, req, 'file.rename', { root, files });
  res.json({ success: true });
}));

app.post('/api/servers/:id/files/create-folder', perm('servers.files'), asyncHandler(async (req, res) => {
  await pteroClient(`/servers/${req.params.id}/files/create-folder`, {
    method: 'POST',
    body: JSON.stringify({
      root: req.body.root || '/',
      name: req.body.name,
    }),
  });
  res.json({ success: true });
}));

// --- Change server port (Application API) ---

app.post('/api/servers/:appId/port', perm('servers.settings', 'appId'), asyncHandler(async (req, res) => {
  const portNum = parseInt(req.body.port);
  const appId = req.params.appId;
  if (!portNum || portNum < 1024 || portNum > 65535) {
    return res.status(400).json({ error: 'Invalid port (1024-65535)' });
  }

  async function findAllocByPort() {
    let page = 1;
    while (true) {
      const allocs = await pteroApp(`/nodes/1/allocations?per_page=100&page=${page}&include=server`);
      const match = allocs.data.find(a => a.attributes.port === portNum);
      if (match) return match.attributes;
      if (page >= (allocs.meta?.pagination?.total_pages || 1)) return null;
      page++;
    }
  }

  const server = await pteroApp(`/servers/${appId}?include=allocations`);
  const attr = server.attributes;
  const currentAlloc = attr.relationships?.allocations?.data?.[0]?.attributes;
  if (currentAlloc && currentAlloc.port === portNum) {
    return res.json({ success: true, port: portNum, unchanged: true });
  }

  let alloc = await findAllocByPort();
  if (alloc && alloc.assigned) {
    const ownerData = alloc.relationships?.server?.attributes;
    const ownerName = ownerData?.name ? `"${ownerData.name}"` : `server #${ownerData?.id ?? '?'}`;
    return res.status(409).json({ error: `Port ${portNum} is already in use by ${ownerName}. Pick a different port.` });
  }

  if (!alloc) {
    await pteroApp('/nodes/1/allocations', {
      method: 'POST',
      body: JSON.stringify({ ip: NODE_PUBLIC_IP, ports: [String(portNum)] }),
    });
    alloc = await findAllocByPort();
  }

  if (!alloc) {
    return res.status(400).json({ error: `Could not allocate port ${portNum}. The node may not permit this port range.` });
  }

  const oldAllocId = currentAlloc?.id;

  await pteroApp(`/servers/${appId}/build`, {
    method: 'PATCH',
    body: JSON.stringify({
      allocation: oldAllocId || alloc.id,
      add_allocations: [alloc.id],
      memory: attr.limits.memory,
      swap: attr.limits.swap,
      disk: attr.limits.disk,
      io: attr.limits.io,
      cpu: attr.limits.cpu,
      threads: attr.limits.threads,
      feature_limits: attr.feature_limits,
    }),
  });

  await pteroApp(`/servers/${appId}/build`, {
    method: 'PATCH',
    body: JSON.stringify({
      allocation: alloc.id,
      remove_allocations: oldAllocId ? [oldAllocId] : [],
      memory: attr.limits.memory,
      swap: attr.limits.swap,
      disk: attr.limits.disk,
      io: attr.limits.io,
      cpu: attr.limits.cpu,
      threads: attr.limits.threads,
      feature_limits: attr.feature_limits,
    }),
  });

  if (attr.identifier) logAct(attr.identifier, req, 'config.port', { from: currentAlloc?.port || null, to: portNum });
  res.json({ success: true, port: portNum });
}));

// --- Change server limits (memory/disk/cpu) ---

app.patch('/api/servers/:appId/limits', perm('servers.settings', 'appId'), asyncHandler(async (req, res) => {
  const appId = req.params.appId;
  const server = await pteroApp(`/servers/${appId}?include=allocations`);
  const attr = server.attributes;
  const cur = attr.limits;

  const memory = req.body.memory != null ? parseInt(req.body.memory) : cur.memory;
  const disk = req.body.disk != null ? parseInt(req.body.disk) : cur.disk;
  const cpu = req.body.cpu != null ? parseInt(req.body.cpu) : cur.cpu;
  const curFeatures = attr.feature_limits || {};
  const backups = req.body.backups != null ? parseInt(req.body.backups) : curFeatures.backups;

  if (Number.isNaN(memory) || memory < 0) return res.status(400).json({ error: 'Invalid memory' });
  if (Number.isNaN(disk) || disk < 0) return res.status(400).json({ error: 'Invalid disk' });
  if (Number.isNaN(cpu) || cpu < 0) return res.status(400).json({ error: 'Invalid cpu' });
  if (Number.isNaN(backups) || backups < 0) return res.status(400).json({ error: 'Invalid backups' });

  const allocId = attr.relationships?.allocations?.data?.[0]?.attributes?.id || attr.allocation;

  await pteroApp(`/servers/${appId}/build`, {
    method: 'PATCH',
    body: JSON.stringify({
      allocation: allocId,
      memory,
      swap: cur.swap,
      disk,
      io: cur.io,
      cpu,
      threads: cur.threads,
      feature_limits: { ...curFeatures, backups },
    }),
  });

  if (attr.identifier) {
    const details = {};
    if (memory !== cur.memory) details.memory = { from: cur.memory, to: memory };
    if (disk !== cur.disk) details.disk = { from: cur.disk, to: disk };
    if (cpu !== cur.cpu) details.cpu = { from: cur.cpu, to: cpu };
    if (backups !== curFeatures.backups) details.backups = { from: curFeatures.backups, to: backups };
    if (Object.keys(details).length) logAct(attr.identifier, req, 'config.limits', details);
  }

  res.json({ success: true, limits: { memory, disk, cpu, backups } });
}));

// --- Change server docker image (Application API) ---

app.get('/api/servers/:appId/docker-image', perm('servers.settings', 'appId'), asyncHandler(async (req, res) => {
  const server = await pteroApp(`/servers/${req.params.appId}?include=egg`);
  const attr = server.attributes;
  const eggId = attr.egg;
  const egg = await pteroApp(`/nests/${attr.nest}/eggs/${eggId}`);
  res.json({
    currentImage: attr.container?.image || attr.image,
    availableImages: egg.attributes.docker_images || {},
  });
}));

app.patch('/api/servers/:appId/docker-image', perm('servers.settings', 'appId'), asyncHandler(async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image is required' });

  const server = await pteroApp(`/servers/${req.params.appId}?include=variables`);
  const attr = server.attributes;
  const variables = attr.relationships?.variables?.data || [];
  const environment = {};
  for (const v of variables) {
    environment[v.attributes.env_variable] = v.attributes.server_value ?? v.attributes.default_value ?? '';
  }

  await pteroApp(`/servers/${req.params.appId}/startup`, {
    method: 'PATCH',
    body: JSON.stringify({
      startup: attr.container?.startup_command || attr.invocation,
      environment,
      egg: attr.egg,
      image,
      skip_scripts: true,
    }),
  });
  if (attr.identifier) logAct(attr.identifier, req, 'config.image', { image, from: attr.container?.image || null });
  res.json({ success: true, image });
}));

// --- Backup hygiene (.pteroignore + auto-backup mod detection) ---

async function listFilesInDir(id, dir) {
  try {
    const data = await pteroClient(`/servers/${id}/files/list?directory=${encodeURIComponent(dir)}`);
    return data.data || [];
  } catch (_) { return []; }
}

app.get('/api/servers/:id/backup-hygiene', perm('servers.backups'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const clientData = await pteroClient(`/servers/${id}`).catch(() => null);
  const backupLimit = clientData?.attributes?.feature_limits?.backups ?? null;
  const existing = await readServerFile(id, '/.pteroignore');
  const present = existing !== null;
  const worldOnly = present && existing.trim() === WORLD_ONLY_PTEROIGNORE.trim();

  const modFiles = await listFilesInDir(id, '/mods');
  const modNames = modFiles
    .filter(f => f.attributes.is_file)
    .map(f => f.attributes.name);

  const detectedMods = [];
  if (modNames.length) {
    const configEntries = await listFilesInDir(id, '/config');
    const configRootNames = new Set(
      configEntries.map(f => f.attributes.name + (f.attributes.is_file ? '' : '/'))
    );

    for (const mod of KNOWN_BACKUP_MODS) {
      if (!modNames.some(n => mod.match.test(n))) continue;

      let resolved = null;
      for (const cand of mod.candidates) {
        const head = cand.path.replace(/^config\//, '').split('/')[0];
        const isNested = cand.path.split('/').length > 2;
        if (isNested) {
          if (configRootNames.has(head + '/')) {
            const exists = await readServerFile(id, '/' + cand.path);
            if (exists !== null) { resolved = cand; break; }
          }
        } else {
          if (configRootNames.has(head)) { resolved = cand; break; }
        }
      }

      detectedMods.push({
        name: mod.name,
        configPath: resolved ? resolved.path : null,
        hint: resolved ? resolved.hint : null,
        candidatePaths: mod.candidates.map(c => c.path),
      });
    }
  }

  res.json({
    pteroignore: { present, worldOnly, content: existing },
    recommendedContent: WORLD_ONLY_PTEROIGNORE,
    detectedMods,
    backupLimit,
  });
}));

app.post('/api/servers/:id/apply-pteroignore', perm('servers.backups'), asyncHandler(async (req, res) => {
  await writeServerFile(req.params.id, '/.pteroignore', WORLD_ONLY_PTEROIGNORE);
  logAct(req.params.id, req, 'config.pteroignore', { mode: 'world-only' });
  res.json({ success: true });
}));

// --- Backups (Client API) ---

app.get('/api/servers/:id/backups', perm('servers.backups'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/backups`);
  res.json(data);
}));

app.post('/api/servers/:id/backups', perm('servers.backups'), asyncHandler(async (req, res) => {
  const name = req.body.name || '';
  const data = await pteroClient(`/servers/${req.params.id}/backups`, {
    method: 'POST',
    body: JSON.stringify({ name, is_locked: false }),
  });
  logAct(req.params.id, req, 'backup.create', { name, backupUuid: data?.attributes?.uuid || null });
  res.json(data);
}));

app.get('/api/servers/:id/backups/:bid/download', perm('servers.backups'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/backups/${req.params.bid}/download`);
  res.json(data);
}));

app.post('/api/servers/:id/backups/:bid/restore', perm('servers.backups'), asyncHandler(async (req, res) => {
  await pteroClient(`/servers/${req.params.id}/backups/${req.params.bid}/restore`, {
    method: 'POST',
    body: JSON.stringify({ truncate: true }),
  });
  logAct(req.params.id, req, 'backup.restore', { backupUuid: req.params.bid });
  res.json({ success: true });
}));

app.delete('/api/servers/:id/backups/:bid', perm('servers.backups'), asyncHandler(async (req, res) => {
  await pteroClient(`/servers/${req.params.id}/backups/${req.params.bid}`, { method: 'DELETE' });
  logAct(req.params.id, req, 'backup.delete', { backupUuid: req.params.bid });
  res.json({ success: true });
}));

// --- Modpack info (read metadata from server) ---

app.get('/api/servers/:id/modpack-info', perm('servers.view'), async (req, res) => {
  try {
    const url = `${PTERO_URL}/api/client/servers/${req.params.id}/files/contents?file=/.dash-modpack.json`;
    const r = await fetch(url, { headers: clientHeaders() });
    if (!r.ok) { res.json(null); return; }
    const text = await r.text();
    res.json(JSON.parse(text));
  } catch (e) {
    res.json(null);
  }
});

// --- Node stats (for overview) ---

app.get('/api/node/stats', asyncHandler(async (req, res) => {
  const node = await pteroApp('/nodes/1');
  const attr = node.attributes;

  let disk_vps_total = 0, disk_vps_used = 0;
  try {
    const dfOut = execSync("df -B1 --output=size,used /").toString().trim().split('\n')[1].trim().split(/\s+/);
    disk_vps_total = parseInt(dfOut[0]);
    disk_vps_used = parseInt(dfOut[1]);
  } catch (_) {}

  res.json({
    memory_total: attr.memory,
    disk_vps_total,
    disk_vps_used,
  });
}));

// --- Schedules (Client API) ---

app.get('/api/servers/:id/schedules', perm('servers.schedules'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/schedules`);
  // Fetch tasks for each schedule
  const schedules = data.data || [];
  const detailed = await Promise.all(schedules.map(async (s) => {
    try {
      const full = await pteroClient(`/servers/${req.params.id}/schedules/${s.attributes.id}`);
      return full;
    } catch (e) { return s; }
  }));
  res.json({ data: detailed });
}));

app.post('/api/servers/:id/schedules', perm('servers.schedules'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/schedules`, {
    method: 'POST',
    body: JSON.stringify(req.body),
  });
  logAct(req.params.id, req, 'schedule.create', { id: data?.attributes?.id || null, name: req.body?.name || null, cron: req.body?.cron_expression || null });
  res.json(data);
}));

app.post('/api/servers/:id/schedules/:sid', perm('servers.schedules'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/schedules/${req.params.sid}`, {
    method: 'POST',
    body: JSON.stringify(req.body),
  });
  logAct(req.params.id, req, 'schedule.update', { id: parseInt(req.params.sid), name: req.body?.name || null });
  res.json(data);
}));

app.delete('/api/servers/:id/schedules/:sid', perm('servers.schedules'), asyncHandler(async (req, res) => {
  let scheduleName = null;
  try {
    const sch = await pteroClient(`/servers/${req.params.id}/schedules/${req.params.sid}`);
    scheduleName = sch?.attributes?.name || null;
  } catch (_) {}
  await pteroClient(`/servers/${req.params.id}/schedules/${req.params.sid}`, { method: 'DELETE' });
  logAct(req.params.id, req, 'schedule.delete', { id: parseInt(req.params.sid), name: scheduleName });
  res.json({ success: true });
}));

app.post('/api/servers/:id/schedules/:sid/tasks', perm('servers.schedules'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/schedules/${req.params.sid}/tasks`, {
    method: 'POST',
    body: JSON.stringify(req.body),
  });
  logAct(req.params.id, req, 'schedule.task.create', { scheduleId: parseInt(req.params.sid), action: req.body?.action || null, payload: req.body?.payload || null });
  res.json(data);
}));

app.delete('/api/servers/:id/schedules/:sid/tasks/:tid', perm('servers.schedules'), asyncHandler(async (req, res) => {
  await pteroClient(`/servers/${req.params.id}/schedules/${req.params.sid}/tasks/${req.params.tid}`, { method: 'DELETE' });
  logAct(req.params.id, req, 'schedule.task.delete', { scheduleId: parseInt(req.params.sid), taskId: parseInt(req.params.tid) });
  res.json({ success: true });
}));

// --- Modpack APIs (Modrinth + CurseForge) ---

app.get('/api/modpacks/platforms', (req, res) => {
  res.json({ modrinth: true, curseforge: !!CF_API_KEY });
});

// Modrinth
app.get('/api/modpacks/modrinth/search', asyncHandler(async (req, res) => {
  const query = req.query.query || '';
  const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent('[["project_type:modpack"]]')}&limit=10`;
  const r = await fetch(url, { headers: { 'User-Agent': 'gameserver-dash/1.0' } });
  if (!r.ok) throw new Error(`Modrinth ${r.status}`);
  res.json(await r.json());
}));

app.get('/api/modpacks/modrinth/project/:id', asyncHandler(async (req, res) => {
  const r = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(req.params.id)}`, { headers: { 'User-Agent': 'gameserver-dash/1.0' } });
  if (!r.ok) throw new Error(`Modrinth ${r.status}`);
  res.json(await r.json());
}));

app.get('/api/modpacks/modrinth/project/:id/versions', asyncHandler(async (req, res) => {
  const r = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(req.params.id)}/version`, { headers: { 'User-Agent': 'gameserver-dash/1.0' } });
  if (!r.ok) throw new Error(`Modrinth ${r.status}`);
  res.json(await r.json());
}));

// CurseForge (requires API key)
app.get('/api/modpacks/curseforge/search', asyncHandler(async (req, res) => {
  if (!CF_API_KEY) return res.status(400).json({ error: 'CurseForge API key not configured' });
  const query = req.query.query || '';
  // classId 4471 = Modpacks, gameId 432 = Minecraft
  const url = `${CURSEFORGE_API}/mods/search?gameId=432&classId=4471&searchFilter=${encodeURIComponent(query)}&pageSize=10&sortField=2&sortOrder=desc`;
  const r = await fetch(url, { headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`CurseForge ${r.status}`);
  res.json(await r.json());
}));

app.get('/api/modpacks/curseforge/mod/:id', asyncHandler(async (req, res) => {
  if (!CF_API_KEY) return res.status(400).json({ error: 'CurseForge API key not configured' });
  const r = await fetch(`${CURSEFORGE_API}/mods/${req.params.id}`, { headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`CurseForge ${r.status}`);
  res.json(await r.json());
}));

app.get('/api/modpacks/curseforge/mod/:id/files', asyncHandler(async (req, res) => {
  if (!CF_API_KEY) return res.status(400).json({ error: 'CurseForge API key not configured' });
  const r = await fetch(`${CURSEFORGE_API}/mods/${req.params.id}/files?pageSize=50`, { headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`CurseForge ${r.status}`);
  res.json(await r.json());
}));

// List a modpack's standalone server-pack files (isServerPack). CurseForge
// doesn't always link a server pack to its client file via serverPackFileId, so
// some packs only expose them as independent files, which
// can be older than the newest client release. Scans several pages and returns
// them newest-first so the UI can offer one for a server install.
app.get('/api/modpacks/curseforge/mod/:id/serverpacks', asyncHandler(async (req, res) => {
  if (!CF_API_KEY) return res.status(400).json({ error: 'CurseForge API key not configured' });
  const PAGE = 50, MAX_PAGES = 6;
  const packs = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await fetch(`${CURSEFORGE_API}/mods/${req.params.id}/files?pageSize=${PAGE}&index=${i * PAGE}`,
      { headers: { 'x-api-key': CF_API_KEY, 'Accept': 'application/json' } });
    if (!r.ok) break;
    const data = (await r.json()).data || [];
    for (const f of data) {
      if (f.isServerPack) {
        packs.push({
          id: f.id,
          name: f.displayName || f.fileName,
          gameVersions: (f.gameVersions || []).filter(v => /^\d/.test(v)),
          fileDate: f.fileDate,
        });
      }
    }
    if (data.length < PAGE) break; // last page
  }
  packs.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  res.json({ data: packs });
}));

// Resolve a CurseForge file's download URL: the official endpoint first, then
// the forgecdn fallback constructed from the file name (some files 404 the
// official URL but are still reachable on the CDN).
async function resolveCfDownloadUrl(projectId, fileId) {
  try {
    const r = await fetch(`${CURSEFORGE_API}/mods/${projectId}/files/${fileId}/download-url`, { headers: { 'x-api-key': CF_API_KEY } });
    if (r.ok) {
      const d = await r.json();
      if (d.data) return d.data;
    }
  } catch (_) { /* fall through to CDN */ }
  try {
    const r = await fetch(`${CURSEFORGE_API}/mods/${projectId}/files/${fileId}`, { headers: { 'x-api-key': CF_API_KEY } });
    if (r.ok) {
      const fn = (await r.json()).data?.fileName;
      if (fn) {
        return `https://edge.forgecdn.net/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fn)}`;
      }
    }
  } catch (_) { /* give up */ }
  return null;
}

// If every entry of a zip lives under one top-level folder, return that folder
// (with trailing slash) so it can be stripped; otherwise ''. Server packs are
// sometimes wrapped in a single directory that shouldn't reach the server root.
function commonTopLevelDir(entries) {
  if (!entries.length) return '';
  const first = entries[0].entryName.split('/')[0] + '/';
  return entries.every(e => e.entryName.startsWith(first)) ? first : '';
}

// --- Client-mod denylist management (admin only) ---

app.get('/api/admin/client-mods', requireAdmin, (req, res) => {
  res.json({ data: authDb.getClientModDenylist() });
});

app.post('/api/admin/client-mods', requireAdmin, (req, res) => {
  const pattern = (req.body.pattern || '').trim().toLowerCase();
  const name = (req.body.name || '').trim() || pattern;
  if (!pattern) return res.status(400).json({ error: 'A filename prefix is required' });
  if (!/^[a-z0-9]/.test(pattern)) return res.status(400).json({ error: 'Prefix should start with the mod\'s jar name' });
  const added = authDb.addClientMod(name, pattern);
  res.json({ success: true, added });
});

app.delete('/api/admin/client-mods/:id', requireAdmin, (req, res) => {
  authDb.removeClientMod(parseInt(req.params.id));
  res.json({ success: true });
});

// Scan a server's newest crash report (or latest.log) for the tell-tale signs
// of client-only mods on a dedicated server, and surface the offending mod jars
// so an admin can add them to the denylist. Admin-only; these internals are
// never shown to the user installing a modpack.
app.get('/api/servers/:id/crash-scan', requireAdmin, asyncHandler(async (req, res) => {
  const id = req.params.id;

  let source = null, reportName = null;
  try {
    const list = await pteroClient(`/servers/${id}/files/list?directory=${encodeURIComponent('/crash-reports')}`);
    const reports = (list.data || [])
      .filter(f => f.attributes.is_file && /^crash-.*\.txt$/.test(f.attributes.name))
      .sort((a, b) => new Date(b.attributes.modified_at) - new Date(a.attributes.modified_at));
    if (reports.length) {
      reportName = reports[0].attributes.name;
      source = await readServerFile(id, '/crash-reports/' + reportName);
    }
  } catch (_) { /* no crash-reports dir */ }

  if (!source) {
    try { source = await readServerFile(id, '/logs/latest.log'); reportName = 'logs/latest.log'; } catch (_) {}
  }
  if (!source) return res.json({ report: null, lines: [], suspects: [] });

  const relevant = /invalid dist DEDICATED_SERVER|\bFATAL\b|Mod File:|Failure message:|has class loading errors/;
  const lines = source.split(/\r?\n/).filter(l => relevant.test(l)).slice(0, 200);

  // Suspects come from two places: the jar named in a "Mod File:" line (the mod
  // being loaded when it failed) and the mod id of a failing mixin config (the
  // mod that provides the bad client mixin, often the real culprit).
  const suspects = [];
  const seen = new Set();
  const modFileRe = /\/mods\/([^\s/]+\.jar)/;
  const mixinRe = /\[([a-z0-9_]+)\.mixins\.json/i;
  const addSuspect = (prefix, file) => {
    if (prefix && !seen.has(prefix.toLowerCase())) { seen.add(prefix.toLowerCase()); suspects.push({ file, prefix }); }
  };
  for (const line of source.split(/\r?\n/)) {
    if (line.includes('Mod File:')) {
      const mm = modFileRe.exec(line);
      if (mm) addSuspect(prefixFromFilename(mm[1]), mm[1]);
    }
    if (/FAILED|class loading errors/.test(line) && line.includes('.mixins.json')) {
      const mm = mixinRe.exec(line);
      if (mm) addSuspect(mm[1], `${mm[1]} (mixin)`);
    }
  }
  res.json({ report: reportName, lines, suspects });
}));

// Install modpack on a server (streaming progress)
app.post('/api/servers/:id/install-modpack', perm('servers.modpacks'), async (req, res) => {
  req.setTimeout(600000);
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx buffering

  const { platform, fileUrl, cfServerPack } = req.body;
  const serverId = req.params.id;
  const clientModMatchers = compileDenylist(authDb.getClientModDenylist());
  let tmpDir;

  function send(stage, message, progress, extra) {
    res.write(JSON.stringify({ stage, message, progress, ...extra }) + '\n');
  }

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modpack-'));
    let deps = {};
    let filesCount = 0;
    const skippedMods = []; // populated only by the CurseForge path

    if (platform === 'modrinth') {
      send('download', 'Downloading modpack...', 2);
      const mrpackRes = await fetch(fileUrl, { headers: { 'User-Agent': 'gameserver-dash/1.0' } });
      if (!mrpackRes.ok) throw new Error('Failed to download .mrpack');
      const mrpackBuf = Buffer.from(await mrpackRes.arrayBuffer());

      send('parse', 'Parsing modpack index...', 8);
      const mrpack = new AdmZip(mrpackBuf);
      const indexEntry = mrpack.getEntry('modrinth.index.json');
      if (!indexEntry) throw new Error('Invalid .mrpack: missing modrinth.index.json');
      const index = JSON.parse(indexEntry.getData().toString('utf8'));

      const serverFiles = (index.files || []).filter(f => !f.env || f.env.server !== 'unsupported');
      filesCount = serverFiles.length;

      for (const f of serverFiles) {
        fs.mkdirSync(path.join(tmpDir, path.dirname(f.path)), { recursive: true });
      }

      send('mods', `Downloading mods (0/${filesCount})...`, 10);
      let downloaded = 0;
      for (let i = 0; i < serverFiles.length; i += 10) {
        await Promise.all(serverFiles.slice(i, i + 10).map(async (f) => {
          const dlRes = await fetch(f.downloads[0], { headers: { 'User-Agent': 'gameserver-dash/1.0' } });
          if (!dlRes.ok) throw new Error(`Failed to download ${f.path}`);
          fs.writeFileSync(path.join(tmpDir, f.path), Buffer.from(await dlRes.arrayBuffer()));
          downloaded++;
        }));
        const pct = 10 + Math.round((downloaded / filesCount) * 60);
        send('mods', `Downloading mods (${downloaded}/${filesCount})...`, pct);
      }

      send('overrides', 'Extracting configs...', 72);
      for (const entry of mrpack.getEntries()) {
        let relPath = null;
        if (entry.entryName.startsWith('server-overrides/')) {
          relPath = entry.entryName.slice('server-overrides/'.length);
        } else if (entry.entryName.startsWith('overrides/')) {
          relPath = entry.entryName.slice('overrides/'.length);
        }
        if (relPath && !entry.isDirectory) {
          const dest = path.join(tmpDir, relPath);
          if (!fs.existsSync(dest) || entry.entryName.startsWith('server-overrides/')) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, entry.getData());
          }
        }
      }

      deps = index.dependencies || {};

    } else if (platform === 'curseforge') {
      if (!CF_API_KEY) throw new Error('CurseForge API key not configured');

      // Prefer an author-curated server pack when one was chosen: it's the
      // server-safe file set, avoiding the client-only mods that crash a
      // dedicated server. Otherwise download the selected (client) file.
      let zip;
      if (cfServerPack?.serverPackId) {
        send('download', 'Downloading server pack...', 2);
        const url = await resolveCfDownloadUrl(cfServerPack.projectId, cfServerPack.serverPackId);
        if (!url) throw new Error('Could not resolve the CurseForge server pack download URL');
        const spRes = await fetch(url);
        if (!spRes.ok) throw new Error(`Failed to download server pack (HTTP ${spRes.status})`);
        zip = new AdmZip(Buffer.from(await spRes.arrayBuffer()));
      } else {
        send('download', 'Downloading modpack...', 2);
        const zipRes = await fetch(fileUrl);
        if (!zipRes.ok) throw new Error('Failed to download CurseForge modpack');
        zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
      }

      // A ready-to-run bundle (no manifest.json, i.e. a server pack) is
      // extracted wholesale. A manifest pack falls through to per-mod download.
      let bundleExtracted = false;
      if (!zip.getEntry('manifest.json')) {
        send('extract', 'Extracting server pack...', 40);
        const entries = zip.getEntries().filter(e => !e.isDirectory);
        const prefix = commonTopLevelDir(entries);
        filesCount = entries.length;
        for (const entry of entries) {
          const rel = prefix ? entry.entryName.slice(prefix.length) : entry.entryName;
          if (!rel) continue;
          const dest = path.join(tmpDir, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, entry.getData());
        }
        bundleExtracted = true;
      }

      // Manifest processing, for client packs and manifest-style server packs.
      if (!bundleExtracted) {
        send('parse', 'Parsing manifest...', 8);
        const manifestEntry = zip.getEntry('manifest.json');
        if (!manifestEntry) throw new Error('Invalid CurseForge modpack: missing manifest.json');
        const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));

        const modsDir = path.join(tmpDir, 'mods');
        fs.mkdirSync(modsDir, { recursive: true });

        const modFiles = manifest.files || [];
        filesCount = modFiles.length;
        let downloaded = 0;

        send('mods', `Downloading mods (0/${filesCount})...`, 10);
        for (let i = 0; i < modFiles.length; i += 5) {
          await Promise.all(modFiles.slice(i, i + 5).map(async (mod) => {
            try {
              const downloadUrl = await resolveCfDownloadUrl(mod.projectID, mod.fileID);

              if (!downloadUrl) {
                let modName = `Project #${mod.projectID}`;
                try {
                  const info = await fetch(`${CURSEFORGE_API}/mods/${mod.projectID}`, { headers: { 'x-api-key': CF_API_KEY } });
                  if (info.ok) { const d = await info.json(); modName = d.data?.name || modName; }
                } catch (e) {}
                skippedMods.push({ name: modName, projectId: mod.projectID, fileId: mod.fileID, reason: 'Download URL unavailable' });
                downloaded++;
                return;
              }

              const filename = decodeURIComponent(downloadUrl.split('/').pop().split('?')[0]);

              // Strip known client-only mods that would crash a dedicated server.
              const clientMod = matchClientOnlyMod(filename, clientModMatchers);
              if (clientMod) {
                skippedMods.push({ name: filename, projectId: mod.projectID, fileId: mod.fileID, reason: `client-only (${clientMod.name})` });
                downloaded++;
                return;
              }

              const dlRes = await fetch(downloadUrl);
              if (!dlRes.ok) {
                skippedMods.push({ name: filename, projectId: mod.projectID, fileId: mod.fileID, reason: `HTTP ${dlRes.status}` });
                downloaded++;
                return;
              }
              fs.writeFileSync(path.join(modsDir, filename), Buffer.from(await dlRes.arrayBuffer()));
              downloaded++;
            } catch (e) {
              skippedMods.push({ name: `Project #${mod.projectID}`, projectId: mod.projectID, fileId: mod.fileID, reason: e.message });
              downloaded++;
            }
          }));
          const pct = 10 + Math.round((downloaded / filesCount) * 60);
          send('mods', `Downloading mods (${downloaded}/${filesCount})${skippedMods.length ? ` [${skippedMods.length} skipped]` : ''}...`, pct);
        }

        send('overrides', 'Extracting configs...', 72);
        const overridesPrefix = manifest.overrides || 'overrides';
        for (const entry of zip.getEntries()) {
          if (entry.entryName.startsWith(overridesPrefix + '/') && !entry.isDirectory) {
            const relPath = entry.entryName.slice(overridesPrefix.length + 1);
            const dest = path.join(tmpDir, relPath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, entry.getData());
          }
        }

        if (manifest.minecraft) {
          deps.minecraft = manifest.minecraft.version;
          const loader = manifest.minecraft.modLoaders?.find(l => l.primary);
          if (loader) {
            const parts = loader.id.split('-');
            deps[parts[0]] = parts.slice(1).join('-');
          }
        }
      } // end manifest processing (server-pack bundles skip it)
    } else {
      throw new Error('Unknown platform: ' + platform);
    }

    // Collect all files and split into chunks
    send('archive', 'Packing files...', 75);
    const MAX_CHUNK = 90 * 1024 * 1024; // 90 MB per zip to stay under 100 MB limit

    function collectFiles(dir, base) {
      let results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = base ? base + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          results = results.concat(collectFiles(full, rel));
        } else {
          results.push({ abs: full, rel, size: fs.statSync(full).size });
        }
      }
      return results;
    }

    const allFiles = collectFiles(tmpDir, '');
    // Split into chunks by cumulative size
    const chunks = [];
    let currentChunk = [];
    let currentSize = 0;
    for (const f of allFiles) {
      if (currentChunk.length > 0 && currentSize + f.size > MAX_CHUNK) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }
      currentChunk.push(f);
      currentSize += f.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const totalChunks = chunks.length;
    const zipPaths = [];

    for (let c = 0; c < totalChunks; c++) {
      const chunkLabel = totalChunks > 1 ? ` (part ${c + 1}/${totalChunks})` : '';
      send('archive', `Packing files${chunkLabel}...`, 75 + Math.round((c / totalChunks) * 3));

      const zipPath = path.join(os.tmpdir(), `modpack-part-${Date.now()}-${c}.zip`);
      zipPaths.push(zipPath);

      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 1 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        for (const f of chunks[c]) {
          archive.file(f.abs, { name: f.rel });
        }
        archive.finalize();
      });

      // Upload this chunk
      const chunkName = `modpack-part${c}.zip`;
      send('upload', `Uploading${chunkLabel}...`, 78 + Math.round((c / totalChunks) * 10));

      const uploadUrlData = await pteroClient(`/servers/${serverId}/files/upload`);
      const uploadUrl = uploadUrlData.attributes.url;

      const form = new FormData();
      form.append('files', fs.createReadStream(zipPath), {
        filename: chunkName,
        contentType: 'application/zip',
      });

      const uploadRes = await fetch(`${uploadUrl}&directory=/`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
      });

      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        throw new Error(`Upload failed ${uploadRes.status}: ${text}`);
      }

      // Extract this chunk
      send('extract', `Extracting${chunkLabel}...`, 88 + Math.round((c / totalChunks) * 7));
      await pteroClient(`/servers/${serverId}/files/decompress`, {
        method: 'POST',
        body: JSON.stringify({ root: '/', file: chunkName }),
      });

      // Delete the chunk zip from the server
      try {
        await pteroClient(`/servers/${serverId}/files/delete`, {
          method: 'POST',
          body: JSON.stringify({ root: '/', files: [chunkName] }),
        });
      } catch (e) {}

      try { fs.unlinkSync(zipPath); } catch (e) {}
    }

    // Accept EULA automatically so the server can boot unattended
    send('cleanup', 'Accepting EULA...', 96);
    try {
      await pteroClient(`/servers/${serverId}/files/write?file=/eula.txt`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'eula=true\n',
        rawBody: true,
      });
    } catch (e) { /* non-fatal */ }

    send('cleanup', 'Cleaning up...', 97);
    for (const zp of zipPaths) {
      try { fs.unlinkSync(zp); } catch (e) {}
    }

    // Save modpack metadata for update tracking
    const modpackMeta = req.body.modpackMeta || null;
    if (modpackMeta) {
      try {
        await pteroClient(`/servers/${serverId}/files/write?file=/.dash-modpack.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(modpackMeta, null, 2),
          rawBody: true,
        });
      } catch (e) { /* non-fatal */ }
    }

    logAct(serverId, req, 'modpack.install', { platform, filesInstalled: filesCount, skipped: skippedMods.length, dependencies: deps });
    send('done', 'Modpack installed!', 100, { result: { success: true, dependencies: deps, filesInstalled: filesCount, skippedMods } });
    res.end();
  } catch (e) {
    send('error', e.message, -1);
    res.end();
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// --- Update server startup (Application API) ---

app.patch('/api/servers/:appId/startup', perm('servers.settings', 'appId'), asyncHandler(async (req, res) => {
  const data = await pteroApp(`/servers/${req.params.appId}/startup`, {
    method: 'PATCH',
    body: JSON.stringify(req.body),
  });
  const ident = data?.attributes?.identifier;
  if (ident) logAct(ident, req, 'config.startup', { startup: req.body?.startup || null, image: req.body?.image || null });
  res.json(data);
}));

// --- WebSocket info for console (Client API) ---

app.get('/api/servers/:id/websocket', perm('servers.console.read'), asyncHandler(async (req, res) => {
  const data = await pteroClient(`/servers/${req.params.id}/websocket`);
  res.json(data);
}));

// Track active browser WebSocket connections per server UUID for command broadcasting
const serverClients = new Map();

// --- WebSocket proxy for console ---
// Browser connects to /ws/servers/<uuid>; we relay to the Wings WS URL
// returned by Pterodactyl's GET /api/client/servers/<uuid>/websocket call.

function denyUpgrade(socket, reason, uuid) {
  console.warn(`[ws/upgrade] reject ${reason} uuid=${uuid || '?'}`);
  try {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  } catch (_) {}
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const match = req.url.match(/^\/ws\/servers\/([a-f0-9-]+)$/);
  if (!match) {
    denyUpgrade(socket, 'bad-path', null);
    return;
  }

  const uuid = match[1];

  const user = authenticateWs(req);
  if (!user) {
    denyUpgrade(socket, 'unauthenticated', uuid);
    return;
  }

  if (!hasPermission(user, 'servers.console.read', uuid)) {
    denyUpgrade(socket, `no-permission user=${user.username}`, uuid);
    return;
  }

  const canWrite = hasPermission(user, 'servers.console.write', uuid);

  try {
    const data = await pteroClient(`/servers/${uuid}/websocket`);
    const wsData = data.data;

    const wingsWs = new WebSocket(wsData.socket, {
      rejectUnauthorized: false,
      headers: {
        'Origin': PTERO_URL,
      },
    });

    wingsWs.on('open', () => {
      const clientWs = new WebSocket.Server({ noServer: true });
      clientWs.handleUpgrade(req, socket, head, (ws) => {
        if (!serverClients.has(uuid)) serverClients.set(uuid, new Set());
        const clientEntry = { ws, displayName: user.display_name || user.username };
        serverClients.get(uuid).add(clientEntry);

        // Send the token to the client so it can authenticate
        ws.send(JSON.stringify({ event: 'token', args: [wsData.token] }));

        // Relay messages between client and Wings (block commands if read-only)
        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.event === 'send command') {
              if (!canWrite) return; // block
              // Broadcast user command to all watchers of this server
              const cmd = parsed.args?.[0];
              if (cmd) {
                const broadcast = JSON.stringify({ event: 'user command', args: [clientEntry.displayName, cmd] });
                serverClients.get(uuid)?.forEach(c => {
                  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(broadcast);
                });
              }
            }
          } catch {}
          if (wingsWs.readyState === WebSocket.OPEN) {
            wingsWs.send(msg.toString());
          }
        });

        wingsWs.on('message', (msg) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg.toString());
          }
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.event === 'token expiring') {
              pteroClient(`/servers/${uuid}/websocket`).then(d => {
                wingsWs.send(JSON.stringify({ event: 'auth', args: [d.data.token] }));
              }).catch(() => {});
            }
          } catch {}
        });

        ws.on('close', () => { serverClients.get(uuid)?.delete(clientEntry); wingsWs.close(); });
        wingsWs.on('close', () => ws.close());
        ws.on('error', () => { serverClients.get(uuid)?.delete(clientEntry); wingsWs.close(); });
        wingsWs.on('error', () => ws.close());
      });
    });

    wingsWs.on('error', (err) => {
      denyUpgrade(socket, `wings-ws-error ${err?.message || err}`, uuid);
    });
  } catch (e) {
    denyUpgrade(socket, `ptero-fetch-failed ${e?.message || e}`, uuid);
  }
});

// --- Fallback to SPA ---

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(errorHandler);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard running on http://127.0.0.1:${PORT}`);
  startStateWatcher();
});
