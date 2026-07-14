let currentUser = null;
let servers = [];
let eggs = [];
let currentServer = null;
let consoleWs = null;
let resourceInterval = null;
let playerInterval = null;
let selectedModpack = null;
let modpackVersions = [];
let cfServerPacks = []; // standalone CurseForge server-pack files for the selected pack
let cfAvailable = false;
const PERMISSIONS = [
  { key: 'servers.view', label: 'View servers' },
  { key: 'servers.power', label: 'Power (start/stop)' },
  { key: 'servers.console.read', label: 'Console (read)' },
  { key: 'servers.console.write', label: 'Console (write)' },
  { key: 'servers.files', label: 'File browser' },
  { key: 'servers.backups', label: 'Backups' },
  { key: 'servers.schedules', label: 'Schedules' },
  { key: 'servers.delete', label: 'Delete servers' },
  { key: 'servers.create', label: 'Create servers' },
  { key: 'servers.modpacks', label: 'Install modpacks' },
  { key: 'servers.update', label: 'Update modpacks' },
  { key: 'servers.settings', label: 'Settings (port, startup)' },
];

function can(permission, serverUuid) {
  if (!currentUser) return false;
  if (currentUser.isAdmin) return true;
  if (currentUser.permissions.some(p =>
    p.permission === permission && (p.scope === '*' || p.scope === serverUuid)
  )) return true;
  if (permission.startsWith('servers.') && serverUuid && currentUser.ownedServers?.includes(serverUuid)) {
    return true;
  }
  return false;
}

async function initAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    currentUser = await res.json();
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('main-navbar').style.display = '';
    document.getElementById('navbar-username').textContent = currentUser.displayName || currentUser.username;
    document.getElementById('nav-create').style.display = can('servers.create') ? '' : 'none';
    document.getElementById('nav-admin').style.display = currentUser.isAdmin ? '' : 'none';
    const promptEl = document.getElementById('console-prompt-name');
    if (promptEl) promptEl.textContent = (currentUser.displayName || currentUser.username) + ' >';

    applyRoute(parseUrl());
  } catch {
    document.getElementById('login-overlay').style.display = 'flex';
    document.getElementById('main-navbar').style.display = 'none';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  btn.disabled = true;
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    currentUser = data;
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('main-navbar').style.display = '';
    document.getElementById('navbar-username').textContent = currentUser.displayName || currentUser.username;
    document.getElementById('nav-create').style.display = can('servers.create') ? '' : 'none';
    document.getElementById('nav-admin').style.display = currentUser.isAdmin ? '' : 'none';
    const promptEl = document.getElementById('console-prompt-name');
    if (promptEl) promptEl.textContent = (currentUser.displayName || currentUser.username) + ' >';
    applyRoute(parseUrl());
  } catch (err) {
    errorEl.textContent = err.message;
  }

  btn.disabled = false;
}

function showAccountSettings() {
  document.getElementById('settings-display').value = currentUser?.displayName || '';
  document.getElementById('pw-current').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('settings-modal').style.display = 'flex';
}

async function saveAccountSettings(e) {
  e.preventDefault();
  const displayName = document.getElementById('settings-display').value.trim();
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;

  if (newPassword && !currentPassword) {
    toast('Enter current password to change password', 'error');
    return;
  }

  const body = {};
  if (displayName) body.displayName = displayName;
  if (newPassword) { body.currentPassword = currentPassword; body.newPassword = newPassword; }

  if (!Object.keys(body).length) { toast('Nothing to save', 'info'); return; }

  try {
    await api('/api/auth/me', { method: 'PATCH', body });
    if (displayName) {
      currentUser.displayName = displayName;
      document.getElementById('navbar-username').textContent = displayName;
    }
    toast('Settings saved', 'success');
    document.getElementById('settings-modal').style.display = 'none';
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('main-navbar').style.display = 'none';
}
function navigate(page, params = {}) {
  let url = '/';
  if (page === 'server') url = `/server/${params.id}`;
  else if (page === 'create') url = '/create';
  else if (page === 'admin') url = '/admin';
  if (params.tab) url += '#' + params.tab;
  history.pushState({ page, ...params }, '', url);
  applyRoute({ page, ...params });
}

function applyRoute(state) {
  if (consoleWs) { consoleWs._manualClose = true; consoleWs.close(); consoleWs = null; }
  if (typeof clearConsoleReconnect === 'function') clearConsoleReconnect();
  if (resourceInterval) { clearInterval(resourceInterval); resourceInterval = null; }
  currentServer = null;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.navbar-link').forEach(l => l.classList.remove('active'));

  const page = state.page || 'home';
  const el = document.getElementById(`page-${page}`);
  if (!el) { navigate('home'); return; }
  el.classList.add('active');

  const navLink = document.querySelector(`.navbar-link[data-page="${page}"]`);
  if (navLink) navLink.classList.add('active');

  if (page === 'home') loadServers();
  if (page === 'server') showServerDetail(state.id);
  if (page === 'create') loadCreateForm();
  if (page === 'admin') loadAdmin();
}

function parseUrl() {
  const path = window.location.pathname;
  const hash = window.location.hash.slice(1);
  const m = path.match(/^\/server\/([a-f0-9-]+)$/);
  if (m) return { page: 'server', id: m[1], tab: hash || null };
  if (path === '/create') return { page: 'create' };
  if (path === '/admin') return { page: 'admin', tab: hash || null };
  return { page: 'home' };
}

window.addEventListener('popstate', (e) => {
  applyRoute(e.state || parseUrl());
});
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    currentUser = null;
    document.getElementById('login-overlay').style.display = 'flex';
    document.getElementById('main-navbar').style.display = 'none';
    throw new Error('Session expired');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return Math.round(mb) + ' MB';
}

function mbToString(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb + ' MB';
}

function classifyError(err) {
  const msg = err?.message || String(err);
  const match = msg.match(/Pterodactyl (?:App|Client) API (\d+):/);
  if (match) {
    const code = parseInt(match[1]);
    if (code === 429) return { kind: 'warn', title: 'Rate limited by panel', detail: 'Pterodactyl is throttling requests. Wait a few seconds and retry.' };
    if (code === 403) return { kind: 'error', title: 'Not permitted', detail: 'The dashboard\'s API key doesn\'t have access to this resource on the panel.' };
    if (code === 404) return { kind: 'error', title: 'Not found', detail: 'The resource doesn\'t exist on the panel anymore.' };
    if (code >= 500) return { kind: 'error', title: `Panel error (${code})`, detail: 'Pterodactyl responded with a server error. Try again shortly.' };
    return { kind: 'error', title: `Panel error (${code})`, detail: msg };
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return { kind: 'error', title: 'Connection problem', detail: 'Couldn\'t reach the dashboard. Check your VPN connection and retry.' };
  }
  if (/timeout/i.test(msg)) {
    return { kind: 'warn', title: 'Request timed out', detail: 'The panel didn\'t respond in time. Retry.' };
  }
  return { kind: 'error', title: 'Error', detail: msg };
}

function renderError(container, err, retryFn) {
  if (!container) return;
  const c = classifyError(err);
  const wrap = document.createElement('div');
  wrap.className = `inline-error${c.kind === 'warn' ? ' warn' : ''}`;
  wrap.innerHTML = `
    <div class="inline-error-icon">!</div>
    <div class="inline-error-body">
      <div class="inline-error-title">${esc(c.title)}</div>
      <div class="inline-error-detail">${esc(c.detail)}</div>
    </div>
    <div class="inline-error-actions"></div>
  `;
  if (typeof retryFn === 'function') {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => retryFn());
    wrap.querySelector('.inline-error-actions').appendChild(btn);
  }
  container.innerHTML = '';
  container.appendChild(wrap);
}

function fmtDateTime(input) {
  if (input == null || input === '') return '';
  const t = typeof input === 'string' && !input.includes('T') && !input.endsWith('Z')
    ? input.replace(' ', 'T') + 'Z'
    : input;
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return String(input);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
async function loadServers() {
  const list = document.getElementById('server-list');
  list.innerHTML = '<div class="loading">Loading servers...</div>';

  const createBtn = document.getElementById('home-create-btn');
  if (createBtn) createBtn.style.display = can('servers.create') ? '' : 'none';

  try {
    const data = await api('/api/servers');
    servers = data.data || [];

    if (servers.length === 0) {
      list.innerHTML = '<div class="loading">No servers yet. Create one to get started.</div>';
      return;
    }

    const perServer = await Promise.all(servers.map(async (s) => {
      const uuid = s.attributes.uuid;
      const out = { uuid, status: 'offline', cpuPct: 0, memBytes: 0, diskBytes: 0, backupBytes: 0, backupCount: 0 };
      try {
        const res = await api(`/api/servers/${uuid}/resources`);
        out.status = res.attributes.current_state || 'offline';
        out.cpuPct = res.attributes.resources.cpu_absolute || 0;
        out.memBytes = res.attributes.resources.memory_bytes || 0;
        out.diskBytes = res.attributes.resources.disk_bytes || 0;
      } catch (e) {}
      if (can('servers.backups', uuid)) {
        try {
          const bk = await api(`/api/servers/${uuid}/backups`);
          const list = bk.data || [];
          out.backupCount = list.length;
          out.backupBytes = list.reduce((sum, b) => sum + (b.attributes.bytes || 0), 0);
        } catch (e) {}
      }
      return out;
    }));

    const rows = servers.map((s, i) => {
      const attr = s.attributes;
      const uuid = attr.uuid;
      const r = perServer[i];
      const eggName = attr.relationships?.egg?.attributes?.name || 'Unknown';
      const installState = getInstallState();
      const isInstalling = installState && installState.serverUuid === uuid && installState.status === 'installing';
      const diskText = r.backupBytes > 0
        ? `${formatBytes(r.diskBytes)} <span style="color:var(--gray-400)">+ ${formatBytes(r.backupBytes)} in ${r.backupCount} backup${r.backupCount === 1 ? '' : 's'}</span>`
        : formatBytes(r.diskBytes);

      return `
        <div class="server-row" onclick="navigate('server', { id: '${esc(uuid)}' })">
          <div class="server-row-main">
            <div class="server-row-name">${esc(attr.name)}${isInstalling ? ' <span style="color:var(--cyan-400);font-size:0.75rem">(installing modpack...)</span>' : ''}</div>
            <div class="server-row-meta">
              <span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>
                ${esc(eggName)}
              </span>
              <span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/></svg>
                ${formatBytes(r.memBytes)} / ${mbToString(attr.limits.memory)}
              </span>
              <span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                ${diskText}
              </span>
            </div>
          </div>
          <div class="status-bar ${r.status}"></div>
        </div>
      `;
    });

    list.innerHTML = rows.join('');

    const statsEl = document.getElementById('overview-stats');
    let totalAllocMem = 0, totalAllocDisk = 0;
    let totalUsedMem = 0, totalUsedDisk = 0, totalCpu = 0, runningCount = 0, totalBackupMb = 0;
    servers.forEach(s => {
      totalAllocMem += s.attributes.limits.memory || 0;
      totalAllocDisk += s.attributes.limits.disk || 0;
    });
    perServer.forEach(r => {
      if (r.status === 'running' || r.status === 'starting') {
        runningCount++;
        totalUsedMem += r.memBytes / 1024 / 1024;
        totalCpu += r.cpuPct;
      }
      totalUsedDisk += r.diskBytes / 1024 / 1024;
      totalBackupMb += r.backupBytes / 1024 / 1024;
    });

    document.getElementById('overview-count').textContent = servers.length;

    try {
      const nodeStats = await api('/api/node/stats');
      const totalNodeMem = nodeStats.memory_total || 0;
      document.getElementById('overview-memory').textContent = mbToString(totalUsedMem) + ' / ' + mbToString(totalNodeMem);
      document.getElementById('overview-memory-detail').textContent = 'Allocated: ' + mbToString(totalAllocMem) + ' · Running: ' + runningCount;
      document.getElementById('overview-cpu').textContent = totalCpu.toFixed(1) + '%';
      document.getElementById('overview-cpu-cores').textContent = runningCount + ' server(s) running';

      const vpsDiskTotal = nodeStats.disk_vps_total || 0;
      const vpsDiskUsed = nodeStats.disk_vps_used || 0;
      document.getElementById('overview-disk').textContent = formatBytes(vpsDiskUsed) + ' / ' + formatBytes(vpsDiskTotal);
      const backupSuffix = totalBackupMb > 0 ? ' · Backups: ' + mbToString(totalBackupMb) : '';
      document.getElementById('overview-disk-detail').textContent = 'Allocated: ' + mbToString(totalAllocDisk) + ' · Servers: ' + mbToString(totalUsedDisk) + backupSuffix;
    } catch (e) {
      document.getElementById('overview-memory').textContent = mbToString(totalAllocMem);
      document.getElementById('overview-cpu').textContent = totalCpu.toFixed(1) + '%';
      document.getElementById('overview-disk').textContent = mbToString(totalAllocDisk);
    }

    statsEl.style.display = '';
  } catch (e) {
    renderError(list, e, loadServers);
  }
}
async function showServerDetail(id) {
  if (!id) { navigate('home'); return; }

  if (servers.length === 0) {
    try {
      const data = await api('/api/servers');
      servers = data.data || [];
    } catch (e) {
      toast('Failed to load servers: ' + e.message, 'error');
      navigate('home');
      return;
    }
  }

  const s = servers.find(s => s.attributes.uuid === id || s.attributes.identifier === id);
  if (!s) {
    toast('Server not found', 'error');
    navigate('home');
    return;
  }

  const attr = s.attributes;
  const eggName = attr.relationships?.egg?.attributes?.name || 'Unknown';
  const nestName = attr.relationships?.nest?.attributes?.name || '';

  currentServer = {
    appId: attr.id,
    clientId: attr.uuid,
    name: attr.name,
    eggName,
    nestName,
    limits: attr.limits,
    allocation: attr.relationships?.allocations?.data?.[0]?.attributes || null,
  };

  document.getElementById('server-name').textContent = currentServer.name;
  document.getElementById('server-game').textContent = eggName;

  const port = currentServer.allocation?.port || '?';
  const host = currentServer.allocation?.ip_alias || currentServer.allocation?.ip || '?';
  document.getElementById('stat-address').textContent = `${host}:${port}`;

  const editLink = document.querySelector('#stat-address-block .stat-edit-link');
  if (editLink) editLink.style.display = can('servers.settings', currentServer.clientId) ? '' : 'none';

  const isMinecraft = ['Vanilla Minecraft', 'Paper', 'Sponge', 'Bungeecord', 'Forge Minecraft', 'CurseForge Generic']
    .some(n => eggName.includes(n)) || nestName === 'Minecraft';

  const worldsSection = document.getElementById('worlds-section');
  worldsSection.style.display = isMinecraft ? '' : 'none';
  if (isMinecraft) loadWorlds();

  const uuid = currentServer.clientId;
  const tabFiles = document.querySelector('.detail-tab[data-tab="files"]');
  const tabSchedules = document.querySelector('.detail-tab[data-tab="schedules"]');
  const tabBackups = document.querySelector('.detail-tab[data-tab="backups"]');
  if (tabFiles) tabFiles.style.display = can('servers.files', uuid) ? '' : 'none';
  if (tabSchedules) tabSchedules.style.display = can('servers.schedules', uuid) ? '' : 'none';
  if (tabBackups) tabBackups.style.display = can('servers.backups', uuid) ? '' : 'none';

  const consoleInput = document.querySelector('.console-input-row');
  if (consoleInput) consoleInput.style.display = can('servers.console.write', uuid) ? '' : 'none';

  const powerRow = document.querySelector('.power-row');
  if (powerRow) powerRow.style.display = can('servers.power', uuid) ? '' : 'none';

  const deleteDiv = document.getElementById('delete-div');
  if (deleteDiv) {
    deleteDiv.style.display = can('servers.delete', uuid) ? '' : 'none';
    deleteDiv.onclick = () => deleteServer(currentServer.appId, currentServer.name);
  }

  const accessZone = document.getElementById('access-zone');
  if (accessZone) {
    accessZone.style.display = currentUser?.isAdmin ? '' : 'none';
    if (currentUser?.isAdmin) loadAccessPanel();
  }

  const initialTab = window.location.hash.slice(1) || 'console';
  switchDetailTab(initialTab);
  if (can('servers.schedules', uuid)) loadSchedules();
  if (can('servers.backups', uuid)) loadBackups();
  if (can('servers.update', uuid)) loadModpackInfo();
  else document.getElementById('modpack-update').style.display = 'none';
  if (can('servers.files', uuid)) loadFiles('/');
  closeFileEditor();
  initConsole();

  resetStatsHistory();
  updateResources();
  if (resourceInterval) clearInterval(resourceInterval);
  resourceInterval = setInterval(updateResources, 5000);
  loadDockerImage();

  if (playerInterval) clearInterval(playerInterval);
  const playersBlock = document.getElementById('stat-players-block');
  if (isMinecraft) {
    playersBlock.style.display = '';
    document.getElementById('stat-players').textContent = '...';
    updatePlayerCount();
    playerInterval = setInterval(updatePlayerCount, 5000);
  } else {
    playersBlock.style.display = 'none';
  }

  if (can('servers.backups', uuid)) loadBackupStats();
}

async function loadBackupStats() {
  if (!currentServer) return;
  try {
    const data = await api(`/api/servers/${currentServer.clientId}/backups`);
    const backups = data.data || [];
    currentServer.backupCount = backups.length;
    currentServer.backupBytes = backups.reduce((sum, b) => sum + (b.attributes.bytes || 0), 0);
  } catch {
    currentServer.backupCount = 0;
    currentServer.backupBytes = 0;
  }
}

function getAlarmClass(value, max) {
  if (!max || max <= 0) return '';
  const pct = value / max;
  if (pct > 0.9) return 'danger';
  if (pct > 0.8) return 'warn';
  return '';
}
function switchDetailTab(tab) {
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));
  const el = document.getElementById(`tab-${tab}`);
  if (el) el.classList.add('active');
  if (currentServer) {
    const url = `/server/${currentServer.clientId}#${tab}`;
    history.replaceState({ page: 'server', id: currentServer.clientId, tab }, '', url);
  }
  if (tab === 'activity') loadActivity();
}
function showModal({ title, message, showInput, inputValue, selectOptions, selectValue, confirmLabel, dangerMode } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title || '';
    document.getElementById('modal-message').textContent = message || '';

    const inputWrap = document.getElementById('modal-input-wrap');
    const inputEl = document.getElementById('modal-input');
    inputWrap.style.display = showInput ? '' : 'none';
    if (showInput) inputEl.value = inputValue || '';

    const selectWrap = document.getElementById('modal-select-wrap');
    const selectEl = document.getElementById('modal-select');
    if (selectOptions) {
      selectEl.innerHTML = '';
      for (const opt of selectOptions) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === selectValue) o.selected = true;
        selectEl.appendChild(o);
      }
      selectWrap.style.display = '';
    } else {
      selectWrap.style.display = 'none';
    }

    const okBtn = document.getElementById('modal-ok');
    okBtn.textContent = confirmLabel || 'OK';
    okBtn.className = dangerMode ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';

    overlay.style.display = '';
    if (showInput) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
    else if (selectOptions) setTimeout(() => selectEl.focus(), 50);

    function cleanup(result) {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      document.getElementById('modal-cancel').removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() {
      if (showInput) cleanup(inputEl.value);
      else if (selectOptions) cleanup(selectEl.value);
      else cleanup(true);
    }
    function onCancel() { cleanup(null); }
    function onKey(e) { if (e.key === 'Escape') onCancel(); }

    okBtn.addEventListener('click', onOk);
    document.getElementById('modal-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey);
  });
}

// --- Stats history (CPU/Memory line graphs) ---

const STATS_HISTORY_MAX = 60;
let cpuHistory = [];
let memHistory = [];

function resetStatsHistory() {
  cpuHistory = [];
  memHistory = [];
  renderStatsGraphs();
}

function pushStatsSample(stats) {
  const now = Date.now();
  const cpu = typeof stats.cpu_absolute === 'number' ? stats.cpu_absolute : 0;
  const memBytes = typeof stats.memory_bytes === 'number' ? stats.memory_bytes : 0;

  cpuHistory.push({ t: now, value: cpu });
  if (cpuHistory.length > STATS_HISTORY_MAX) cpuHistory.shift();

  memHistory.push({ t: now, value: memBytes });
  if (memHistory.length > STATS_HISTORY_MAX) memHistory.shift();

  applyStatsToCards(stats);
  renderStatsGraphs();
}

function applyStatsToCards(stats) {
  const cpuPct = stats.cpu_absolute || 0;
  const memBytes = stats.memory_bytes || 0;
  const memLimit = currentServer?.limits?.memory || 0;
  const cpuLimit = currentServer?.limits?.cpu || 0;
  const memMb = Math.round(memBytes / 1024 / 1024);

  const gCpu = document.getElementById('graph-cpu');
  const gMem = document.getElementById('graph-memory');
  if (gCpu) gCpu.innerHTML = `${cpuPct.toFixed(2)}%${cpuLimit ? `<span class="graph-limit"> / ${cpuLimit}%</span>` : ''}`;
  if (gMem) gMem.innerHTML = `${formatBytes(memBytes)}<span class="graph-limit"> / ${mbToString(memLimit)}</span>`;

  const bCpu = document.getElementById('bar-cpu');
  const bMem = document.getElementById('bar-memory');
  if (bCpu) bCpu.style.width = Math.min(cpuLimit ? (cpuPct / cpuLimit) * 100 : cpuPct, 100) + '%';
  if (bMem) bMem.style.width = memLimit ? Math.min((memMb / memLimit) * 100, 100) + '%' : '0%';
}

function renderStatsGraphs() {
  renderLineGraph('svg-cpu', cpuHistory, '#22d3ee', () => {
    const limit = currentServer?.limits?.cpu || 0;
    const peak = cpuHistory.reduce((m, s) => Math.max(m, s.value), 0);
    return Math.max(limit || 0, peak, 5);
  });
  renderLineGraph('svg-memory', memHistory, '#4ade80', () => {
    const limitMb = currentServer?.limits?.memory || 0;
    const limitBytes = limitMb * 1024 * 1024;
    const peak = memHistory.reduce((m, s) => Math.max(m, s.value), 0);
    return Math.max(limitBytes || 0, peak, 1024 * 1024);
  });

  const peakCpuEl = document.getElementById('peak-cpu');
  if (peakCpuEl) {
    if (cpuHistory.length === 0) peakCpuEl.textContent = '';
    else {
      const peak = cpuHistory.reduce((m, s) => Math.max(m, s.value), 0);
      peakCpuEl.textContent = `peak ${peak.toFixed(1)}%`;
    }
  }
  const peakMemEl = document.getElementById('peak-memory');
  if (peakMemEl) {
    if (memHistory.length === 0) peakMemEl.textContent = '';
    else {
      const peak = memHistory.reduce((m, s) => Math.max(m, s.value), 0);
      peakMemEl.textContent = `peak ${formatBytes(peak)}`;
    }
  }
}

function renderLineGraph(svgId, samples, color, getMax) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const w = svg.clientWidth || 200;
  const h = svg.clientHeight || 44;
  if (samples.length < 2) {
    svg.innerHTML = '';
    return;
  }
  const max = getMax(samples) || 1;
  const step = w / (STATS_HISTORY_MAX - 1);
  const offset = w - (samples.length - 1) * step;
  const pad = 1;
  const usable = h - pad * 2;
  let line = '';
  for (let i = 0; i < samples.length; i++) {
    const x = offset + i * step;
    const y = pad + usable - Math.min(samples[i].value / max, 1) * usable;
    line += (i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  const lastX = offset + (samples.length - 1) * step;
  const fill = `${line} L ${lastX.toFixed(1)} ${h} L ${offset.toFixed(1)} ${h} Z`;
  const gradId = `grad-${svgId}`;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${fill}" fill="url(#${gradId})"/>
    <path d="${line}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
  `;
}

async function updateResources() {
  if (!currentServer) return;
  try {
    const res = await api(`/api/servers/${currentServer.clientId}/resources`);
    const r = res.attributes;
    const status = r.current_state || 'offline';

    const badge = document.getElementById('server-status');
    badge.textContent = status;
    badge.className = `status-badge ${status}`;

    document.getElementById('btn-start').disabled = status !== 'offline';
    document.getElementById('btn-stop').disabled = status === 'offline';
    document.getElementById('btn-stop').textContent = status === 'stopping' ? 'Kill' : 'Stop';
    if (status === 'stopping') {
      document.getElementById('btn-stop').onclick = () => powerAction('kill');
    } else {
      document.getElementById('btn-stop').onclick = () => powerAction('stop');
    }

    const cpuPct = r.resources.cpu_absolute || 0;
    const memBytes = r.resources.memory_bytes || 0;
    const diskBytes = r.resources.disk_bytes || 0;
    const memLimit = currentServer.limits?.memory || 0;
    const diskLimit = currentServer.limits?.disk || 0;
    const cpuLimit = currentServer.limits?.cpu || 0;

    const memMb = Math.round(memBytes / 1024 / 1024);
    const diskMb = Math.round(diskBytes / 1024 / 1024);

    const offline = status === 'offline';
    const offlineHtml = '<span style="color:var(--gray-400)">Offline</span>';

    document.getElementById('stat-cpu').innerHTML = offline ? offlineHtml :
      `${cpuPct.toFixed(2)}%${cpuLimit ? `<span class="stat-limit">/ ${cpuLimit}%</span>` : '<span class="stat-limit">/ &infin;</span>'}`;
    document.getElementById('stat-memory').innerHTML = offline ? offlineHtml :
      `${formatBytes(memBytes)}<span class="stat-limit">/ ${mbToString(memLimit)}</span>`;
    document.getElementById('stat-disk').innerHTML =
      `${formatBytes(diskBytes)}<span class="stat-limit">/ ${mbToString(diskLimit)}</span>`;

    document.getElementById('stat-cpu-block').className = `stat-block ${getAlarmClass(cpuPct, cpuLimit)}`;
    document.getElementById('stat-mem-block').className = `stat-block ${getAlarmClass(memMb, memLimit)}`;
    document.getElementById('stat-disk-block').className = `stat-block ${getAlarmClass(diskMb, diskLimit)}`;

    const uptimeMs = r.resources.uptime || 0;
    const uptimeEl = document.getElementById('stat-uptime');
    if (status === 'offline' || !uptimeMs) {
      uptimeEl.textContent = status === 'offline' ? 'Offline' : status.charAt(0).toUpperCase() + status.slice(1);
      document.getElementById('stat-uptime-block').className = `stat-block ${status !== 'running' && status !== 'offline' ? 'warn' : status === 'offline' ? 'danger' : ''}`;
    } else {
      const totalSec = Math.floor(uptimeMs / 1000);
      const d = Math.floor(totalSec / 86400);
      const h = Math.floor((totalSec % 86400) / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      uptimeEl.textContent = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
      document.getElementById('stat-uptime-block').className = 'stat-block';
    }

    document.getElementById('graph-cpu').innerHTML = `${cpuPct.toFixed(2)}%${cpuLimit ? `<span class="graph-limit"> / ${cpuLimit}%</span>` : ''}`;
    document.getElementById('graph-memory').innerHTML = `${formatBytes(memBytes)}<span class="graph-limit"> / ${mbToString(memLimit)}</span>`;

    const backupBytes = currentServer.backupBytes || 0;
    const backupCount = currentServer.backupCount || 0;
    const combinedBytes = diskBytes + backupBytes;
    document.getElementById('graph-disk').innerHTML = `${formatBytes(combinedBytes)}<span class="graph-limit"> / ${mbToString(diskLimit)}</span>`;

    document.getElementById('bar-cpu').style.width = Math.min(cpuLimit ? (cpuPct / cpuLimit) * 100 : cpuPct, 100) + '%';
    document.getElementById('bar-memory').style.width = memLimit ? Math.min((memMb / memLimit) * 100, 100) + '%' : '0%';

    // Disk bar: stacked server + backups, clipped to 100% total
    if (diskLimit > 0) {
      const limitBytes = diskLimit * 1024 * 1024;
      const serverPct = Math.min((diskBytes / limitBytes) * 100, 100);
      const remainingPct = Math.max(0, 100 - serverPct);
      const backupPct = Math.min((backupBytes / limitBytes) * 100, remainingPct);
      document.getElementById('bar-disk').style.width = serverPct + '%';
      document.getElementById('bar-disk-backups').style.width = backupPct + '%';
    } else {
      document.getElementById('bar-disk').style.width = '0%';
      document.getElementById('bar-disk-backups').style.width = '0%';
    }

    const footer = document.getElementById('disk-footer');
    if (footer) {
      if (backupCount > 0) {
        footer.innerHTML = `<span class="swatch live"></span>Live ${formatBytes(diskBytes)} &nbsp;&nbsp; <span class="swatch backups"></span>${backupCount} backup${backupCount === 1 ? '' : 's'} ${formatBytes(backupBytes)}`;
      } else {
        footer.innerHTML = '';
      }
    }
  } catch (e) {
    document.getElementById('server-status').textContent = 'offline';
    document.getElementById('server-status').className = 'status-badge offline';
  }
}

async function updatePlayerCount() {
  if (!currentServer) return;
  const el = document.getElementById('stat-players');
  if (!el) return;
  try {
    const data = await api(`/api/servers/${currentServer.clientId}/mc-status`);
    if (data.unreachable || data.notMinecraft) {
      el.innerHTML = '<span style="color:var(--gray-400)">Offline</span>';
      return;
    }
    const online = data.online ?? '?';
    const max = data.max ?? '?';
    el.innerHTML = `${online}<span class="stat-limit">/ ${max}</span>`;
  } catch (e) {
    el.innerHTML = '<span style="color:var(--gray-400)">Offline</span>';
  }
}

async function powerAction(signal) {
  if (!currentServer) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/power`, { method: 'POST', body: { signal } });
    toast(`${signal.charAt(0).toUpperCase() + signal.slice(1)} signal sent`, 'success');
    setTimeout(updateResources, 1500);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteServer(appId, name) {
  const ok = await showModal({ title: 'Delete Server', message: `Are you sure you want to delete "${name}"? This cannot be undone.`, confirmLabel: 'Delete', dangerMode: true });
  if (!ok) return;
  try {
    await api(`/api/servers/${appId}`, { method: 'DELETE' });
    toast('Server deleted', 'success');
    navigate('home');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// --- Access panel (admin-only, on server detail) ---

async function loadAccessPanel() {
  if (!currentServer || !currentUser?.isAdmin) return;
  const body = document.getElementById('access-panel-body');
  if (!body) return;
  body.innerHTML = '<div class="loading">Loading access...</div>';
  try {
    const data = await api(`/api/servers/${currentServer.clientId}/access`);
    const isPublic = !!data.isPublic;
    const ownerLine = data.owner
      ? `<div class="access-meta">Created by <strong>${esc(data.owner.displayName || data.owner.username)}</strong></div>`
      : '';
    const visClass = isPublic ? 'access-pill public' : 'access-pill private';
    const visLabel = isPublic ? 'Public' : 'Private';
    const visDesc = isPublic
      ? 'Visible to non-admins that have the right view permission.'
      : 'Admin-only by default. Grant access below to specific non-admins.';
    const toggleLabel = isPublic ? 'Make private' : 'Make public';

    let grantsHtml = '';
    if (!isPublic) {
      const rows = (data.accessGrants || []).map(u => `
        <div class="access-user-row">
          <div class="access-user-name">${esc(u.displayName || u.username)} <span class="access-user-handle">@${esc(u.username)}</span></div>
          <button class="btn btn-ghost btn-sm" onclick="revokeUserAccess(${u.id})">Revoke</button>
        </div>
      `).join('');
      grantsHtml = `
        <div class="access-grants">
          <div class="access-grants-header">
            <strong>Granted users</strong>
            <button class="btn btn-secondary btn-sm" onclick="openAddAccessUserModal()">+ Add user</button>
          </div>
          ${rows || '<div class="access-empty">No non-admin users have access yet.</div>'}
        </div>
      `;
    }

    body.innerHTML = `
      <div class="access-row">
        <div class="access-row-body">
          <div><span class="${visClass}">${visLabel}</span></div>
          <div class="access-desc">${visDesc}</div>
          ${ownerLine}
        </div>
        <button class="btn btn-secondary btn-sm" onclick="toggleServerVisibility(${!isPublic})">${toggleLabel}</button>
      </div>
      ${grantsHtml}
    `;
  } catch (e) {
    renderError(body, e, loadAccessPanel);
  }
}

async function toggleServerVisibility(newPublic) {
  if (!currentServer) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/visibility`, {
      method: 'PATCH', body: { isPublic: !!newPublic },
    });
    toast(`Server set to ${newPublic ? 'public' : 'private'}`, 'success');
    loadAccessPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function revokeUserAccess(userId) {
  if (!currentServer) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/access/${userId}`, { method: 'DELETE' });
    toast('Access revoked', 'success');
    loadAccessPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openAddAccessUserModal() {
  if (!currentServer) return;
  let users = [];
  try { users = await api('/api/auth/users'); } catch (e) { toast(e.message, 'error'); return; }
  let accessData;
  try { accessData = await api(`/api/servers/${currentServer.clientId}/access`); } catch (e) { toast(e.message, 'error'); return; }
  const grantedIds = new Set((accessData.accessGrants || []).map(u => u.id));
  const candidates = users.filter(u => !u.isAdmin && !grantedIds.has(u.id));
  if (candidates.length === 0) {
    toast('All non-admin users already have access', 'info');
    return;
  }
  const result = await showModal({
    title: 'Grant access',
    message: 'Pick a user to grant access to this server. They\'ll see it in their server list, and their existing role permissions apply.',
    selectOptions: candidates.map(u => ({ value: String(u.id), label: `${u.displayName || u.username} (@${u.username})` })),
    selectValue: String(candidates[0].id),
    confirmLabel: 'Grant',
  });
  if (result === null) return;
  const userId = parseInt(result);
  if (!userId) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/access`, {
      method: 'POST', body: { userId },
    });
    toast('Access granted', 'success');
    loadAccessPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}
// Exponential backoff schedule for console WS reconnect (seconds).
const CONSOLE_RECONNECT_DELAYS = [1, 2, 5, 10, 15, 30];
const CONSOLE_RECONNECT_MAX_ATTEMPTS = 20;
let consoleReconnect = { attempts: 0, timer: null, serverId: null };

function clearConsoleReconnect() {
  if (consoleReconnect.timer) {
    clearTimeout(consoleReconnect.timer);
    consoleReconnect.timer = null;
  }
  consoleReconnect = { attempts: 0, timer: null, serverId: null };
}

async function initConsole() {
  if (!currentServer) return;
  const output = document.getElementById('console-output');
  output.innerHTML = '';
  appendConsoleLine(output, 'Connecting to console...', 'log-info');

  clearConsoleReconnect();
  consoleReconnect.serverId = currentServer.clientId;
  if (consoleWs) {
    consoleWs._manualClose = true;
    consoleWs.close();
    consoleWs = null;
  }
  connectConsoleWs();
}

function connectConsoleWs() {
  if (!currentServer) return;
  const output = document.getElementById('console-output');
  const expectedServerId = consoleReconnect.serverId;
  if (currentServer.clientId !== expectedServerId) return;  // navigated away

  const pendingEchoes = new Set();

  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/servers/${currentServer.clientId}`);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.event === 'token') {
        ws.send(JSON.stringify({ event: 'auth', args: [msg.args[0]] }));
      }

      if (msg.event === 'auth success') {
        appendConsoleLine(output, consoleReconnect.attempts > 0 ? 'Reconnected.' : 'Connected to console.', 'log-info');
        consoleReconnect.attempts = 0;
        ws.send(JSON.stringify({ event: 'send logs', args: [null] }));
      }

      if (msg.event === 'user command') {
        const [username, cmd] = msg.args || [];
        appendConsoleLine(output, `[${username}] ${cmd}`, 'log-user');
        pendingEchoes.add(cmd.trim());
        output.scrollTop = output.scrollHeight;
      }

      if (msg.event === 'console output') {
        const line = stripAnsi(msg.args?.[0] || '');
        if (pendingEchoes.has(line.trim())) {
          pendingEchoes.delete(line.trim());
        } else {
          appendConsoleLine(output, line);
          output.scrollTop = output.scrollHeight;
        }
      }

      if (msg.event === 'status') {
        const status = msg.args?.[0] || 'unknown';
        document.getElementById('server-status').textContent = status;
        document.getElementById('server-status').className = `status-badge ${status}`;
        updateResources();
      }

      if (msg.event === 'stats') {
        try {
          const stats = JSON.parse(msg.args?.[0] || '{}');
          pushStatsSample(stats);
        } catch (_) {}
      }
    };

    ws.onerror = () => { /* surfaced via onclose */ };
    ws.onclose = () => {
      if (ws._manualClose) return;
      if (currentServer?.clientId !== expectedServerId) return;
      if (consoleReconnect.attempts >= CONSOLE_RECONNECT_MAX_ATTEMPTS) {
        appendConsoleLine(output, '[Disconnected - refresh the page to retry]', 'log-error');
        return;
      }
      const delay = CONSOLE_RECONNECT_DELAYS[Math.min(consoleReconnect.attempts, CONSOLE_RECONNECT_DELAYS.length - 1)];
      consoleReconnect.attempts++;
      appendConsoleLine(output, `[Disconnected - reconnecting in ${delay}s (attempt ${consoleReconnect.attempts})]`, 'log-warn');
      consoleReconnect.timer = setTimeout(connectConsoleWs, delay * 1000);
    };

    consoleWs = ws;
  } catch (e) {
    appendConsoleLine(output, `Error: ${e.message}`, 'log-error');
  }
}

async function sendCommand() {
  const input = document.getElementById('console-command');
  const cmd = input.value.trim();
  if (!cmd || !currentServer) return;

  try {
    if (consoleWs && consoleWs.readyState === WebSocket.OPEN) {
      consoleWs.send(JSON.stringify({ event: 'send command', args: [cmd] }));
      // echo arrives via 'user command' broadcast from backend
    } else {
      await api(`/api/servers/${currentServer.clientId}/command`, { method: 'POST', body: { command: cmd } });
      // HTTP fallback: no WS broadcast, echo locally
      const output = document.getElementById('console-output');
      const label = currentUser?.displayName || currentUser?.username || 'You';
      appendConsoleLine(output, `[${label}] ${cmd}`, 'log-user');
      output.scrollTop = output.scrollHeight;
    }
    input.value = '';
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function loadWorlds() {
  if (!currentServer) return;
  const list = document.getElementById('worlds-list');
  list.innerHTML = '<div class="loading">Scanning for worlds...</div>';

  try {
    const data = await api(`/api/servers/${currentServer.clientId}/files/list?directory=/`);
    const files = data.data || [];
    const dirs = files.filter(f => f.attributes.is_file === false);
    const worldDirs = [];

    for (const dir of dirs) {
      try {
        const contents = await api(`/api/servers/${currentServer.clientId}/files/list?directory=/${encodeURIComponent(dir.attributes.name)}`);
        const hasLevelDat = (contents.data || []).some(f => f.attributes.name === 'level.dat');
        if (hasLevelDat) worldDirs.push(dir);
      } catch (e) {}
    }

    if (worldDirs.length === 0) {
      list.innerHTML = '<div class="loading">No worlds found. Start the server to generate one, or upload a world.</div>';
      return;
    }

    list.innerHTML = worldDirs.map(dir => `
      <div class="world-card">
        <div>
          <div class="world-name">${esc(dir.attributes.name)}</div>
          <div class="world-size">World directory</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="downloadWorld('${esc(dir.attributes.name)}')">Download</button>
      </div>
    `).join('');
  } catch (e) {
    renderError(list, e, loadWorlds);
  }
}

async function downloadWorld(worldName) {
  if (!currentServer) return;
  toast('Compressing world...', 'info');
  try {
    const compressRes = await api(`/api/servers/${currentServer.clientId}/files/compress`, {
      method: 'POST', body: { root: '/', files: [worldName] },
    });
    const archiveName = compressRes.attributes?.name;
    if (!archiveName) throw new Error('Compression failed');

    const dlRes = await fetch(`/api/servers/${currentServer.clientId}/files/download?file=${encodeURIComponent('/' + archiveName)}`);
    if (!dlRes.ok) { const d = await dlRes.json(); throw new Error(d.error || 'Download failed'); }
    const blob = await dlRes.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = archiveName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
    toast('Download started!', 'success');

    setTimeout(async () => {
      try { await api(`/api/servers/${currentServer.clientId}/files/delete`, { method: 'POST', body: { root: '/', files: [archiveName] } }); } catch (e) {}
    }, 10000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function uploadWorld(input) {
  if (!currentServer || !input.files.length) return;
  const file = input.files[0];

  if (!file.name.endsWith('.zip') && !file.name.endsWith('.tar.gz')) {
    toast('Please upload a .zip or .tar.gz file', 'error');
    input.value = '';
    return;
  }

  toast(`Uploading ${file.name}...`, 'info');
  try {
    const formData = new FormData();
    formData.append('files', file);
    const res = await fetch(`/api/servers/${currentServer.clientId}/files/upload?directory=/`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    toast('Extracting...', 'info');
    await api(`/api/servers/${currentServer.clientId}/files/decompress`, { method: 'POST', body: { root: '/', file: file.name } });
    toast('World uploaded!', 'success');

    try { await api(`/api/servers/${currentServer.clientId}/files/delete`, { method: 'POST', body: { root: '/', files: [file.name] } }); } catch (e) {}
    loadWorlds();
  } catch (e) {
    toast(e.message, 'error');
  }
  input.value = '';
}
async function loadCreateForm() {
  const select = document.getElementById('create-egg');
  const visGroup = document.getElementById('create-visibility-group');
  if (visGroup) visGroup.style.display = currentUser?.isAdmin ? '' : 'none';
  if (eggs.length === 0) {
    try { eggs = await api('/api/eggs'); } catch (e) { toast('Failed to load games: ' + e.message, 'error'); return; }
  }
  select.innerHTML = '<option value="">Select a game...</option>';
  eggs.forEach(egg => {
    const opt = document.createElement('option');
    opt.value = egg.id;
    opt.textContent = `${egg.name} (${egg.nestName})`;
    select.appendChild(opt);
  });
  document.getElementById('egg-variables').classList.remove('visible');
  document.getElementById('egg-variables').innerHTML = '';

  clearModpack();

  try {
    const p = await api('/api/modpacks/platforms');
    cfAvailable = p.curseforge;
    const cfBadge = document.getElementById('cf-badge');
    if (cfBadge) {
      cfBadge.className = cfAvailable ? 'platform-badge available' : 'platform-badge unavailable';
      cfBadge.innerHTML = cfAvailable
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> CurseForge'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> CurseForge';
    }
  } catch (e) {}
}
async function lookupModpack() {
  const query = document.getElementById('modpack-query').value.trim();
  if (!query) return;

  const btn = document.getElementById('modpack-lookup-btn');
  btn.disabled = true;
  btn.textContent = 'Searching...';

  try {
    const modrinthMatch = query.match(/modrinth\.com\/modpack\/([a-zA-Z0-9_-]+)/);
    const cfMatch = query.match(/curseforge\.com\/minecraft\/modpacks\/([a-zA-Z0-9_-]+)/);
    const isNumericId = /^\d+$/.test(query);

    if (modrinthMatch) {
      const project = await api(`/api/modpacks/modrinth/project/${encodeURIComponent(modrinthMatch[1])}`);
      await selectModpack(project, 'modrinth');
      return;
    }

    if ((cfMatch || isNumericId) && cfAvailable) {
      if (isNumericId) {
        const data = await api(`/api/modpacks/curseforge/mod/${query}`);
        await selectCurseForgeModpack(data.data);
        return;
      }
      const slug = cfMatch[1];
      const results = await api(`/api/modpacks/curseforge/search?query=${encodeURIComponent(slug.replace(/-/g, ' '))}`);
      const match = (results.data || []).find(m => m.slug === slug);
      if (match) { await selectCurseForgeModpack(match); return; }
    }

    try {
      const project = await api(`/api/modpacks/modrinth/project/${encodeURIComponent(query)}`);
      if (project.project_type === 'modpack') {
        await selectModpack(project, 'modrinth');
        return;
      }
    } catch (e) {}

    const modrinthResults = await api(`/api/modpacks/modrinth/search?query=${encodeURIComponent(query)}`);
    let cfResults = [];
    if (cfAvailable) {
      try {
        const cfData = await api(`/api/modpacks/curseforge/search?query=${encodeURIComponent(query)}`);
        cfResults = cfData.data || [];
      } catch (e) {}
    }
    showModpackResults(modrinthResults.hits || [], cfResults);
  } catch (e) {
    toast('Modpack lookup failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lookup';
  }
}

function showModpackResults(modrinthHits, cfHits) {
  const container = document.getElementById('modpack-results');
  const all = [
    ...modrinthHits.map(h => ({ platform: 'modrinth', slug: h.slug, title: h.title, desc: h.description, icon: h.icon_url, downloads: h.downloads })),
    ...cfHits.map(h => ({ platform: 'curseforge', id: String(h.id), slug: h.slug, title: h.name, desc: h.summary, icon: h.logo?.thumbnailUrl, downloads: h.downloadCount })),
  ];

  all.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

  if (all.length === 0) {
    container.style.display = 'block';
    container.innerHTML = '<div class="loading">No modpacks found.</div>';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = all.map(h => `
    <div class="modpack-result" onclick="pickModpackResult('${esc(h.platform)}', '${esc(h.platform === 'curseforge' ? h.id : (h.slug || h.id))}')">
      ${h.icon ? `<img src="${esc(h.icon)}" alt="">` : '<div class="modpack-icon-placeholder"></div>'}
      <div style="flex:1;min-width:0">
        <div class="modpack-result-name">${esc(h.title)}</div>
        <div class="modpack-result-desc">${esc(h.desc || '')}</div>
        <div class="modpack-result-meta">${h.platform === 'modrinth' ? 'Modrinth' : 'CurseForge'} &middot; ${formatDownloads(h.downloads)} downloads</div>
      </div>
    </div>
  `).join('');
}

function formatDownloads(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function pickModpackResult(platform, idOrSlug) {
  try {
    if (platform === 'modrinth') {
      const project = await api(`/api/modpacks/modrinth/project/${encodeURIComponent(idOrSlug)}`);
      await selectModpack(project, 'modrinth');
    } else {
      const data = await api(`/api/modpacks/curseforge/mod/${idOrSlug}`);
      await selectCurseForgeModpack(data.data);
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function showModpackInfoPanel({ title, description, iconUrl }) {
  document.getElementById('modpack-results').style.display = 'none';
  document.getElementById('modpack-info').style.display = '';
  document.getElementById('modpack-name').textContent = title;
  document.getElementById('modpack-desc').textContent = description || '';

  const icon = document.getElementById('modpack-icon');
  if (iconUrl) { icon.src = iconUrl; icon.style.display = ''; }
  else icon.style.display = 'none';

  document.getElementById('create-name').value = title;
}

// Render the version dropdown from the current modpackVersions (both Modrinth
// and CurseForge map their responses into the same {id, name, loaders,
// game_versions} shape before calling this).
function populateModpackVersionSelect() {
  const select = document.getElementById('modpack-version');
  select.innerHTML = modpackVersions.map(v => {
    const loaders = v.loaders.join(', ') || '?';
    const mc = v.game_versions.join(', ') || '?';
    return `<option value="${v.id}">${esc(v.name || v.version_number)} - ${loaders} - MC ${mc}</option>`;
  }).join('');
  if (modpackVersions.length > 0) onModpackVersionChange();
}

async function selectModpack(project, platform) {
  selectedModpack = { ...project, platform };
  cfServerPacks = []; // Modrinth (.mrpack) handles server side natively
  showModpackInfoPanel({ title: project.title, description: project.description, iconUrl: project.icon_url });

  try {
    modpackVersions = await api(`/api/modpacks/modrinth/project/${project.slug || project.id}/versions`);
    populateModpackVersionSelect();
  } catch (e) {
    toast('Failed to load versions: ' + e.message, 'error');
  }
}

async function selectCurseForgeModpack(mod) {
  selectedModpack = {
    platform: 'curseforge',
    id: mod.id,
    title: mod.name,
    description: mod.summary,
    icon_url: mod.logo?.thumbnailUrl,
  };
  showModpackInfoPanel({ title: mod.name, description: mod.summary, iconUrl: mod.logo?.thumbnailUrl });

  try {
    const filesData = await api(`/api/modpacks/curseforge/mod/${mod.id}/files`);
    const files = filesData.data || [];
    modpackVersions = files.map(f => ({
      id: String(f.id),
      name: f.displayName,
      loaders: f.gameVersions?.filter(v => !v.match(/^\d/)) || [],
      game_versions: f.sortableGameVersions?.map(g => g.gameVersionName).filter(v => v.match(/^\d/)) || f.gameVersions?.filter(v => v.match(/^\d/)) || [],
      files: [{ url: f.downloadUrl, filename: f.fileName }],
      _cfServerPackId: f.serverPackFileId,
      _cfFileId: f.id,
    }));
    populateModpackVersionSelect();
    loadServerPacks(mod.id);
  } catch (e) {
    toast('Failed to load versions: ' + e.message, 'error');
  }
}

// Discover any server packs for a CurseForge modpack so the installer can
// prefer one automatically. CurseForge hides many server packs from the files
// listing, so the per-version linkage (serverPackFileId) is the more reliable
// signal; the standalone-file scan is a fallback.
async function loadServerPacks(projectId) {
  cfServerPacks = [];
  try {
    const res = await api(`/api/modpacks/curseforge/mod/${projectId}/serverpacks`);
    cfServerPacks = res.data || [];
  } catch (_) { cfServerPacks = []; }
}

// The (projectId, serverPackId) to install, or null to use the client file.
// Prefers the selected version's linked server pack (version-accurate), then
// falls back to the newest standalone server pack. Client-only mods in a plain
// client install are stripped by the denylist regardless.
function selectedCfServerPack() {
  const version = modpackVersions.find(v => v.id === document.getElementById('modpack-version')?.value);
  if (version?._cfServerPackId) return { projectId: selectedModpack.id, serverPackId: version._cfServerPackId };
  if (cfServerPacks.length) return { projectId: selectedModpack.id, serverPackId: cfServerPacks[0].id };
  return null;
}

function onModpackVersionChange() {
  const versionId = document.getElementById('modpack-version').value;
  const version = modpackVersions.find(v => v.id === versionId);
  if (!version) return;

  const loader = (version.loaders[0] || '').toLowerCase();
  const eggSelect = document.getElementById('create-egg');

  let matched = false;
  for (const egg of eggs) {
    const name = egg.name.toLowerCase();
    if (
      (loader === 'forge' && name.includes('forge') && !name.includes('curseforge') && !name.includes('neoforge')) ||
      (loader === 'neoforge' && name.includes('neoforge')) ||
      (loader === 'fabric' && name.includes('fabric')) ||
      (loader === 'quilt' && name.includes('quilt'))
    ) {
      eggSelect.value = egg.id;
      onEggChange();
      matched = true;
      break;
    }
  }

  if (!matched) {
    for (const egg of eggs) {
      const name = egg.name.toLowerCase();
      if (name.includes('curseforge') || (name.includes('forge') && !name.includes('neoforge'))) {
        eggSelect.value = egg.id;
        onEggChange();
        break;
      }
    }
  }

  if (version.game_versions.length > 0) {
    setTimeout(() => {
      const mc = version.game_versions[0];
      document.querySelectorAll('#egg-variables input[data-env-var]').forEach(input => {
        const v = input.dataset.envVar.toUpperCase();
        if (v === 'MINECRAFT_VERSION' || v === 'MC_VERSION' || v === 'VANILLA_VERSION') {
          input.value = mc;
        }
      });
    }, 100);
  }

  const mem = document.getElementById('create-memory');
  if (parseInt(mem.value) < 4096) mem.value = 4096;
  const disk = document.getElementById('create-disk');
  if (parseInt(disk.value) < 15000) disk.value = 15000;
}

function clearModpack() {
  selectedModpack = null;
  modpackVersions = [];
  cfServerPacks = [];
  document.getElementById('modpack-info').style.display = 'none';
  document.getElementById('modpack-results').style.display = 'none';
  const q = document.getElementById('modpack-query');
  if (q) q.value = '';
}

function onEggChange() {
  const eggId = parseInt(document.getElementById('create-egg').value);
  const egg = eggs.find(e => e.id === eggId);
  const varsContainer = document.getElementById('egg-variables');
  const imageGroup = document.getElementById('create-image-group');
  const imageSelect = document.getElementById('create-image');

  if (egg && egg.dockerImages && Object.keys(egg.dockerImages).length > 0) {
    imageSelect.innerHTML = '';
    for (const [label, url] of Object.entries(egg.dockerImages)) {
      const opt = document.createElement('option');
      opt.value = url;
      opt.textContent = label;
      if (url === egg.dockerImage) opt.selected = true;
      imageSelect.appendChild(opt);
    }
    imageGroup.style.display = '';
  } else {
    imageGroup.style.display = 'none';
    imageSelect.innerHTML = '';
  }

  if (!egg || !egg.variables.length) {
    varsContainer.classList.remove('visible');
    varsContainer.innerHTML = '';
    return;
  }

  varsContainer.classList.add('visible');
  varsContainer.innerHTML = `<h3>Configuration</h3>` + egg.variables.map(v => `
    <div class="form-group">
      <label>${esc(v.name)}</label>
      <input type="text" data-env-var="${esc(v.env_variable)}" value="${esc(v.default_value || '')}" placeholder="${esc(v.description || '')}">
      ${v.description ? `<small>${esc(v.description)}</small>` : ''}
    </div>
  `).join('');

  const portInput = document.getElementById('create-port');
  const name = egg.name.toLowerCase();
  if (name.includes('minecraft') || name.includes('forge') || name.includes('paper') || name.includes('curseforge') || name.includes('sponge') || name.includes('bungeecord')) portInput.value = 25565;
  else if (name.includes('source') || name.includes('csgo') || name.includes('counter') || name.includes('tf2') || name.includes('garry') || name.includes('insurgency')) portInput.value = 27015;
  else if (name.includes('rust')) portInput.value = 28015;
  else if (name.includes('ark')) portInput.value = 7777;
  else if (name.includes('teamspeak')) portInput.value = 9987;
  else if (name.includes('mumble')) portInput.value = 64738;
}

async function createServer(e) {
  e.preventDefault();
  const btn = document.getElementById('create-submit');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  const eggId = parseInt(document.getElementById('create-egg').value);
  const egg = eggs.find(eg => eg.id === eggId);

  if (!egg) { toast('Please select a game', 'error'); btn.disabled = false; btn.textContent = 'Create Server'; return; }

  const environment = {};
  document.querySelectorAll('#egg-variables input[data-env-var]').forEach(input => {
    environment[input.dataset.envVar] = input.value;
  });

  for (const v of egg.variables) {
    if (!(v.env_variable in environment) || environment[v.env_variable] === '') {
      if (v.default_value !== null && v.default_value !== '') environment[v.env_variable] = v.default_value;
    }
  }

  const port = parseInt(document.getElementById('create-port').value);
  for (const v of egg.variables) {
    const envLower = v.env_variable.toLowerCase();
    if (envLower === 'server_port' || envLower === 'port') environment[v.env_variable] = String(port);
  }

  try {
    const data = await api('/api/servers', {
      method: 'POST',
      body: {
        name: document.getElementById('create-name').value,
        eggId, memory: document.getElementById('create-memory').value,
        disk: document.getElementById('create-disk').value,
        cpu: document.getElementById('create-cpu').value,
        port, environment,
        dockerImage: document.getElementById('create-image').value || egg.dockerImage,
        startup: egg.startup,
        isPublic: !!document.getElementById('create-public')?.checked,
      },
    });
    toast('Server created!', 'success');

    if (data?.attributes?.identifier && currentUser) {
      currentUser.ownedServers = (currentUser.ownedServers || []).concat([data.attributes.identifier]);
    }

    if (selectedModpack && modpackVersions.length > 0) {
      const versionId = document.getElementById('modpack-version').value;
      const version = modpackVersions.find(v => v.id === versionId);

      if (version) {
        const platform = selectedModpack.platform;
        let fileUrl = null;

        let cfServerPack = null;
        if (platform === 'modrinth') {
          const mrpack = version.files?.find(f => f.filename.endsWith('.mrpack')) || version.files?.[0];
          fileUrl = mrpack?.url;
        } else if (platform === 'curseforge') {
          fileUrl = version.files?.[0]?.url;
          cfServerPack = selectedCfServerPack();
        }

        if (fileUrl) {
          const serverUuid = data.attributes?.uuid;
          const serverName = data.attributes?.name || 'Server';
          if (serverUuid) {
            btn.textContent = 'Installing modpack...';

            const modpackMeta = {
              platform,
              projectId: platform === 'modrinth' ? (selectedModpack.slug || selectedModpack.id) : selectedModpack.id,
              projectTitle: selectedModpack.title,
              versionId: version.id,
              versionName: version.name || version.version_number || version.id,
              installedAt: new Date().toISOString(),
            };

            saveInstallState({
              serverUuid,
              serverName,
              platform,
              startedAt: Date.now(),
              status: 'installing',
              progress: 0,
              message: 'Waiting for server...',
            });
            updateInstallOverlay('Waiting for server...', 0);

            await new Promise(r => setTimeout(r, 5000));

            for (let attempt = 0; attempt < 6; attempt++) {
              try {
                await streamModpackInstall(serverUuid, serverName, platform, fileUrl, modpackMeta, cfServerPack);
                break;
              } catch (installErr) {
                if (attempt < 5) {
                  updateInstallOverlay(`Retrying... (${attempt + 2}/6)`, 0);
                  await new Promise(r => setTimeout(r, 5000));
                } else {
                  saveInstallState({ ...getInstallState(), status: 'error', message: installErr.message });
                  updateInstallOverlay('Installation failed: ' + installErr.message, -1);
                  toast('Modpack install failed: ' + installErr.message, 'error');
                }
              }
            }
          }
        }
      }
    }

    navigate('home');
  } catch (e) {
    toast(e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Create Server';
}
function getInstallState() {
  try { return JSON.parse(localStorage.getItem('modpackInstall')); }
  catch (e) { return null; }
}

function saveInstallState(state) {
  localStorage.setItem('modpackInstall', JSON.stringify(state));
}

function clearInstallState() {
  localStorage.removeItem('modpackInstall');
}

function updateInstallOverlay(message, progress) {
  const el = document.getElementById('install-overlay');
  el.style.display = '';
  el.className = 'install-overlay' + (progress === -1 ? ' error' : progress >= 100 ? ' done' : '');

  document.getElementById('install-detail').textContent = message;
  document.getElementById('install-dismiss').style.display = (progress >= 100 || progress === -1) ? '' : 'none';

  if (progress >= 0) {
    document.getElementById('install-bar').style.width = progress + '%';
    document.getElementById('install-pct').textContent = Math.round(progress) + '%';
  }
  if (progress >= 100) {
    document.getElementById('install-title').textContent = 'Installation complete!';
  } else if (progress === -1) {
    document.getElementById('install-title').textContent = 'Installation failed';
    document.getElementById('install-pct').textContent = '';
  } else {
    document.getElementById('install-title').textContent = 'Installing modpack...';
  }

  const state = getInstallState() || {};
  state.message = message;
  state.progress = progress;
  if (progress >= 100) state.status = 'done';
  else if (progress === -1) state.status = 'error';
  saveInstallState(state);
}

function dismissInstallOverlay() {
  document.getElementById('install-overlay').style.display = 'none';
  document.getElementById('install-skipped').style.display = 'none';
  document.getElementById('install-skipped').innerHTML = '';
  clearInstallState();
}

function checkPendingInstall() {
  const state = getInstallState();
  if (!state) return;

  const age = Date.now() - (state.startedAt || 0);
  const maxAge = 15 * 60 * 1000; // 15 minutes

  if (state.status === 'installing' && age < maxAge) {
    updateInstallOverlay(
      `"${state.serverName || 'Server'}" - ${state.message || 'Installation may still be in progress...'}`,
      state.progress || 0
    );
    document.getElementById('install-dismiss').style.display = '';
  } else if (state.status === 'done') {
    updateInstallOverlay(`"${state.serverName || 'Server'}" - Modpack installed!`, 100);
    if (state.skippedMods?.length) showSkippedMods(state.skippedMods);
  } else if (state.status === 'error') {
    updateInstallOverlay(`"${state.serverName || 'Server'}" - Failed: ${state.message}`, -1);
  } else {
    clearInstallState();
  }
}

function showSkippedMods(mods) {
  if (!mods || !mods.length) return;
  const el = document.getElementById('install-skipped');
  el.style.display = '';
  el.innerHTML = `
    <div class="install-skipped-header">${mods.length} mod(s) could not be downloaded:</div>
    <div class="install-skipped-list">
      ${mods.map(m => `
        <div class="install-skipped-item">
          <span class="install-skipped-name">${esc(m.name || 'Unknown mod')}</span>
          <span class="install-skipped-reason">${esc(m.reason)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

async function streamModpackInstall(serverUuid, serverName, platform, fileUrl, modpackMeta, cfServerPack) {
  const response = await fetch(`/api/servers/${serverUuid}/install-modpack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, fileUrl, modpackMeta, cfServerPack }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastData = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        lastData = data;
        if (data.stage === 'error') {
          updateInstallOverlay(data.message, -1);
          saveInstallState({ ...getInstallState(), status: 'error', message: data.message });
          throw new Error(data.message);
        }
        updateInstallOverlay(data.message, data.progress);
        if (data.stage === 'done' && data.result) {
          const r = data.result;
          const state = getInstallState() || {};
          state.status = 'done';
          state.skippedMods = r.skippedMods || [];
          saveInstallState(state);

          toast(`Modpack installed! (${r.filesInstalled} files)`, 'success');
          if (r.skippedMods?.length) {
            showSkippedMods(r.skippedMods);
          }
        }
      } catch (e) {
        if (e.message && !e.message.startsWith('Unexpected')) throw e;
      }
    }
  }

  if (lastData?.stage === 'error') {
    throw new Error(lastData.message);
  }
}
function toggleScheduleForm() {
  const form = document.getElementById('schedule-form');
  form.style.display = form.style.display === 'none' ? '' : 'none';
}

function onSchedPresetChange() {
  const preset = document.getElementById('sched-preset').value;
  document.getElementById('sched-cron-group').style.display = preset === 'custom' ? '' : 'none';
}

function onSchedActionChange() {
  const action = document.getElementById('sched-action').value;
  document.getElementById('sched-cmd-group').style.display = action === 'command' ? '' : 'none';
}

async function loadSchedules() {
  if (!currentServer) return;
  const list = document.getElementById('schedules-list');
  list.innerHTML = '<div class="loading">Loading schedules...</div>';

  try {
    const data = await api(`/api/servers/${currentServer.clientId}/schedules`);
    const schedules = data.data || [];

    if (schedules.length === 0) {
      list.innerHTML = '<div class="loading" style="padding:1.5rem">No schedules yet.</div>';
      return;
    }

    list.innerHTML = schedules.map(s => {
      const a = s.attributes;
      const cron = `${a.cron.minute} ${a.cron.hour} ${a.cron.day_of_month} ${a.cron.month} ${a.cron.day_of_week}`;
      const tasks = a.relationships?.tasks?.data || [];
      const nextRun = a.next_run_at ? fmtDateTime(a.next_run_at) : 'N/A';

      return `
        <div class="schedule-card">
          <div class="schedule-card-header">
            <div class="schedule-card-name">${esc(a.name)}</div>
            <div class="schedule-card-actions">
              <span class="schedule-badge ${a.is_active ? 'active' : 'inactive'}">${a.is_active ? 'Active' : 'Inactive'}</span>
              <button class="btn btn-ghost btn-sm" onclick="toggleScheduleActive('${currentServer.clientId}', ${a.id}, ${!a.is_active})" title="${a.is_active ? 'Disable' : 'Enable'}">
                ${a.is_active ? 'Disable' : 'Enable'}
              </button>
              <button class="btn btn-danger btn-sm" onclick="deleteSchedule('${currentServer.clientId}', ${a.id})" title="Delete">&times;</button>
            </div>
          </div>
          <div class="schedule-card-meta">
            <span title="${cron}">${cronToHuman(cron)}</span>
            <span>Next: ${nextRun}</span>
            ${a.only_when_online ? '<span>Only when online</span>' : ''}
          </div>
          ${tasks.length > 0 ? `
            <div class="schedule-tasks">
              ${tasks.map((t, i) => {
                const ta = t.attributes;
                let desc = '';
                if (ta.action === 'power') desc = `Power: <strong>${esc(ta.payload)}</strong>`;
                else if (ta.action === 'command') desc = `Command: <code>${esc(ta.payload)}</code>`;
                else if (ta.action === 'backup') desc = 'Create backup';
                else desc = `${esc(ta.action)}: ${esc(ta.payload)}`;
                const offset = ta.time_offset > 0 ? ` <span style="color:var(--gray-500)">(+${ta.time_offset}s)</span>` : '';
                return `<div class="schedule-task"><span class="schedule-task-action">${i + 1}. ${desc}${offset}</span></div>`;
              }).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } catch (e) {
    renderError(list, e, loadSchedules);
  }
}

function cronToHuman(cron) {
  const presets = {
    '*/30 * * * *': 'Every 30 minutes',
    '0 * * * *': 'Every hour',
    '0 */2 * * *': 'Every 2 hours',
    '0 */3 * * *': 'Every 3 hours',
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '0 0 * * *': 'Daily at midnight',
    '0 0 * * 0': 'Weekly (Sunday)',
  };
  return presets[cron] || `Cron: ${cron}`;
}

async function createSchedule() {
  if (!currentServer) return;

  const name = document.getElementById('sched-name').value.trim();
  const preset = document.getElementById('sched-preset').value;
  const cronStr = preset === 'custom' ? document.getElementById('sched-cron').value.trim() : preset;
  const actionVal = document.getElementById('sched-action').value;
  const command = document.getElementById('sched-command').value.trim();
  const onlyOnline = document.getElementById('sched-only-online').checked;

  const parts = cronStr.split(/\s+/);
  if (parts.length !== 5) { toast('Invalid cron expression', 'error'); return; }

  const schedName = name || `${actionVal.includes(':') ? actionVal.split(':')[1] : actionVal} - ${cronToHuman(cronStr)}`;

  try {
    const sched = await api(`/api/servers/${currentServer.clientId}/schedules`, {
      method: 'POST',
      body: {
        name: schedName,
        is_active: true,
        minute: parts[0],
        hour: parts[1],
        day_of_month: parts[2],
        month: parts[3],
        day_of_week: parts[4],
        only_when_online: onlyOnline,
      },
    });

    const schedId = sched.attributes.id;

    let action, payload;
    if (actionVal.startsWith('power:')) {
      action = 'power';
      payload = actionVal.split(':')[1];
    } else if (actionVal === 'command') {
      if (!command) { toast('Please enter a command', 'error'); return; }
      action = 'command';
      payload = command;
    } else {
      action = actionVal;
      payload = '';
    }

    await api(`/api/servers/${currentServer.clientId}/schedules/${schedId}/tasks`, {
      method: 'POST',
      body: { action, payload, time_offset: 0 },
    });

    toast('Schedule created!', 'success');
    document.getElementById('schedule-form').style.display = 'none';
    document.getElementById('sched-name').value = '';
    document.getElementById('sched-command').value = '';
    loadSchedules();
  } catch (e) {
    toast('Failed to create schedule: ' + e.message, 'error');
  }
}

async function toggleScheduleActive(serverId, schedId, active) {
  try {
    await api(`/api/servers/${serverId}/schedules/${schedId}`, {
      method: 'POST',
      body: { is_active: active },
    });
    toast(active ? 'Schedule enabled' : 'Schedule disabled', 'success');
    loadSchedules();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteSchedule(serverId, schedId) {
  const ok = await showModal({ title: 'Delete Schedule', message: 'Delete this schedule?', confirmLabel: 'Delete', dangerMode: true });
  if (!ok) return;
  try {
    await api(`/api/servers/${serverId}/schedules/${schedId}`, { method: 'DELETE' });
    toast('Schedule deleted', 'success');
    loadSchedules();
  } catch (e) {
    toast(e.message, 'error');
  }
}
let currentFilesDir = '/';
let editingFilePath = null;
let allFiles = [];
let selectedFiles = new Set();

async function loadFiles(dir, keepSearch = false) {
  if (!currentServer) return;
  const newDir = dir || '/';
  const dirChanged = newDir !== currentFilesDir;
  currentFilesDir = newDir;
  if (dirChanged) selectedFiles.clear();
  const list = document.getElementById('files-list');
  list.innerHTML = '<div class="loading">Loading files...</div>';
  const searchEl = document.getElementById('files-search');
  if (searchEl && dirChanged && !keepSearch) searchEl.value = '';
  updateBreadcrumb();

  try {
    const data = await api(`/api/servers/${currentServer.clientId}/files/list?directory=${encodeURIComponent(currentFilesDir)}`);
    allFiles = data.data || [];
    allFiles.sort((a, b) => {
      if (a.attributes.is_file !== b.attributes.is_file) return a.attributes.is_file ? 1 : -1;
      return a.attributes.name.localeCompare(b.attributes.name);
    });
    renderFiles();
  } catch (e) {
    renderError(list, e, () => loadFiles(dir, keepSearch));
  }
}

function renderFiles() {
  const list = document.getElementById('files-list');
  const query = (document.getElementById('files-search')?.value || '').toLowerCase();
  const files = query ? allFiles.filter(f => f.attributes.name.toLowerCase().includes(query)) : allFiles;

  if (files.length === 0) {
    list.innerHTML = `<div class="loading" style="padding:1.5rem">${query ? 'No files match your search.' : 'Empty directory.'}</div>`;
    return;
  }

  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
  const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

  list.innerHTML = files.map(f => {
    const a = f.attributes;
    const isDir = !a.is_file;
    const size = isDir ? '' : formatBytes(a.size);
    const safeName = esc(a.name);
    const encodedName = encodeURIComponent(a.name);
    const checked = selectedFiles.has(a.name) ? 'checked' : '';

    return `
      <div class="file-row" onclick="${isDir ? `loadFiles('${esc(currentFilesDir === '/' ? '/' : currentFilesDir + '/')}${encodedName}')` : `openFile('${esc(currentFilesDir)}', '${safeName}')`}">
        <input type="checkbox" class="file-row-check" ${checked} onclick="event.stopPropagation(); toggleFileSelect('${safeName}', this.checked)" title="Select">
        <div class="file-row-icon ${isDir ? 'folder' : ''}">${isDir ? folderIcon : fileIcon}</div>
        <div class="file-row-name">${safeName}</div>
        <div class="file-row-size">${size}</div>
        <div class="file-row-actions" onclick="event.stopPropagation()">
          ${a.is_file ? `<button onclick="downloadFile('${esc(currentFilesDir)}/${encodedName}')" title="Download">dl</button>` : ''}
          <button onclick="renameFile('${safeName}')" title="Rename">ren</button>
          <button class="danger" onclick="deleteFile('${safeName}', ${isDir})" title="Delete">del</button>
        </div>
      </div>
    `;
  }).join('');

  renderFileSelectionBar();
}

function toggleFileSelect(name, checked) {
  if (checked) selectedFiles.add(name);
  else selectedFiles.delete(name);
  renderFileSelectionBar();
}

function clearFileSelection() {
  selectedFiles.clear();
  renderFiles();
}

function renderFileSelectionBar() {
  const bar = document.getElementById('files-selection-bar');
  if (!bar) return;
  const n = selectedFiles.size;
  if (n === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = `
    <span class="files-selection-count">${n} selected</span>
    <div class="files-selection-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteSelectedFiles()">Delete selected</button>
      <button class="btn btn-ghost btn-sm" onclick="clearFileSelection()">Clear</button>
    </div>
  `;
}

async function deleteSelectedFiles() {
  if (!currentServer || selectedFiles.size === 0) return;
  const names = Array.from(selectedFiles);
  const ok = await showModal({
    title: 'Delete selected',
    message: `Delete ${names.length} item${names.length === 1 ? '' : 's'}? This cannot be undone.`,
    confirmLabel: 'Delete',
    dangerMode: true,
  });
  if (!ok) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/files/delete`, {
      method: 'POST',
      body: { root: currentFilesDir, files: names },
    });
    toast(`Deleted ${names.length} item${names.length === 1 ? '' : 's'}`, 'success');
    selectedFiles.clear();
    loadFiles(currentFilesDir, true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function updateBreadcrumb() {
  const el = document.getElementById('files-breadcrumb');
  const parts = currentFilesDir.split('/').filter(Boolean);
  let html = `<span onclick="loadFiles('/')">~</span>`;
  let path = '';
  parts.forEach((p, i) => {
    path += '/' + p;
    const isLast = i === parts.length - 1;
    html += `<span class="sep">/</span>`;
    if (isLast) html += `<span class="current">${esc(p)}</span>`;
    else html += `<span onclick="loadFiles('${esc(path)}')">${esc(p)}</span>`;
  });
  el.innerHTML = html;
}

const TEXT_EXTENSIONS = [
  'txt', 'cfg', 'conf', 'config', 'ini', 'log', 'properties', 'json', 'yml', 'yaml',
  'xml', 'toml', 'env', 'sh', 'bat', 'cmd', 'py', 'js', 'ts', 'java', 'lua', 'md',
  'csv', 'html', 'css', 'htaccess', 'gitignore', 'dockerignore', 'dockerfile', 'sk',
  'mcmeta', 'lang', 'snbt', 'nbt', 'zs',
];

function isTextFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  return TEXT_EXTENSIONS.includes(ext) || name === 'eula.txt' || name === 'server.properties' || !name.includes('.');
}

async function openFile(dir, name) {
  if (!isTextFile(name)) {
    downloadFile(dir + '/' + encodeURIComponent(name));
    return;
  }

  const filePath = (dir === '/' ? '/' : dir + '/') + name;
  try {
    const res = await fetch(`/api/servers/${currentServer.clientId}/files/contents?file=${encodeURIComponent(filePath)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to read file');
    }
    const content = await res.text();
    editingFilePath = filePath;
    document.getElementById('file-editor-name').textContent = filePath;
    document.getElementById('file-editor-content').value = content;
    document.getElementById('file-editor').style.display = '';
    document.getElementById('file-editor').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    toast('Cannot open file: ' + e.message, 'error');
  }
}

async function saveFile() {
  if (!currentServer || !editingFilePath) return;
  try {
    const content = document.getElementById('file-editor-content').value;
    await api(`/api/servers/${currentServer.clientId}/files/write?file=${encodeURIComponent(editingFilePath)}`, {
      method: 'POST',
      body: { content },
    });
    toast('File saved!', 'success');
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

function closeFileEditor() {
  document.getElementById('file-editor').style.display = 'none';
  editingFilePath = null;
}

async function downloadFile(filePath) {
  if (!currentServer) return;
  try {
    const res = await fetch(`/api/servers/${currentServer.clientId}/files/download?file=${encodeURIComponent(filePath)}`);
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Download failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filePath.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameFile(name) {
  const newName = await showModal({ title: 'Rename', message: 'New name:', showInput: true, inputValue: name });
  if (!newName || newName === name) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/files/rename`, {
      method: 'POST',
      body: { root: currentFilesDir, files: [{ from: name, to: newName }] },
    });
    toast('Renamed!', 'success');
    loadFiles(currentFilesDir, true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteFile(name, isDir) {
  const ok = await showModal({ title: 'Delete', message: `Delete ${isDir ? 'folder' : 'file'} "${name}"?`, confirmLabel: 'Delete', dangerMode: true });
  if (!ok) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/files/delete`, {
      method: 'POST',
      body: { root: currentFilesDir, files: [name] },
    });
    selectedFiles.delete(name);
    toast('Deleted!', 'success');
    loadFiles(currentFilesDir, true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function filesNewFolder() {
  const name = await showModal({ title: 'New Folder', message: 'Folder name:', showInput: true });
  if (!name) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/files/create-folder`, {
      method: 'POST',
      body: { root: currentFilesDir, name },
    });
    toast('Folder created!', 'success');
    loadFiles(currentFilesDir);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function uploadFileToDir(input) {
  if (!currentServer || !input.files.length) return;
  const files = Array.from(input.files);
  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  toast(`Uploading ${label}...`, 'info');
  try {
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    const res = await fetch(`/api/servers/${currentServer.clientId}/files/upload?directory=${encodeURIComponent(currentFilesDir)}`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast(`Uploaded ${label}!`, 'success');
    loadFiles(currentFilesDir);
  } catch (e) {
    toast(e.message, 'error');
  }
  input.value = '';
}

async function uploadFolderToDir(input) {
  if (!currentServer || !input.files.length) return;
  const files = Array.from(input.files);
  const rootName = (files[0].webkitRelativePath || files[0].name).split('/')[0];
  toast(`Uploading folder "${rootName}" (${files.length} files)...`, 'info');
  try {
    const formData = new FormData();
    for (const f of files) {
      // Preserve the tree by sending the relative path as the filename
      formData.append('files', f, f.webkitRelativePath || f.name);
    }
    const res = await fetch(`/api/servers/${currentServer.clientId}/files/upload-folder?directory=${encodeURIComponent(currentFilesDir)}`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Folder upload failed');
    toast(`Uploaded folder "${rootName}" (${data.count} files)!`, 'success');
    loadFiles(currentFilesDir);
  } catch (e) {
    toast(e.message, 'error');
  }
  input.value = '';
}
function imageLabel(url, available) {
  if (!available) return url;
  for (const [label, u] of Object.entries(available)) {
    if (u === url) return label;
  }
  return url;
}

async function loadDockerImage() {
  if (!currentServer) return;
  const block = document.getElementById('stat-image-block');
  const valueEl = document.getElementById('stat-image');
  if (!block || !valueEl) return;
  const editLink = block.querySelector('.stat-edit-link');
  if (!can('servers.settings', currentServer.clientId)) {
    if (editLink) editLink.style.display = 'none';
  } else if (editLink) {
    editLink.style.display = '';
  }
  try {
    const data = await api(`/api/servers/${currentServer.appId}/docker-image`);
    currentServer.dockerImage = data.currentImage;
    currentServer.dockerImages = data.availableImages;
    valueEl.textContent = imageLabel(data.currentImage, data.availableImages);
  } catch (e) {
    valueEl.textContent = '--';
  }
}

async function changeDockerImage() {
  if (!currentServer) return;
  const available = currentServer.dockerImages || {};
  const entries = Object.entries(available);
  if (!entries.length) {
    toast('No alternate images defined for this egg', 'error');
    return;
  }
  const options = entries.map(([label, url]) => ({ value: url, label }));
  const chosen = await showModal({
    title: 'Change Java / Docker image',
    message: 'Select an image. Wings will pull it on the next server start.',
    selectOptions: options,
    selectValue: currentServer.dockerImage,
    confirmLabel: 'Apply',
  });
  if (!chosen || chosen === currentServer.dockerImage) return;
  try {
    await api(`/api/servers/${currentServer.appId}/docker-image`, {
      method: 'PATCH',
      body: { image: chosen },
    });
    currentServer.dockerImage = chosen;
    document.getElementById('stat-image').textContent = imageLabel(chosen, available);
    toast('Image updated. Restart the server for it to take effect.', 'success');
  } catch (e) {
    toast('Image change failed: ' + e.message, 'error');
  }
}

async function changePort() {
  if (!currentServer) return;
  const newPort = await showModal({ title: 'Change Port', message: 'Enter new port (1024-65535):', showInput: true, inputValue: String(currentServer.allocation?.port || '25565') });
  if (!newPort) return;
  const port = parseInt(newPort);
  if (isNaN(port) || port < 1024 || port > 65535) {
    toast('Invalid port (1024-65535)', 'error');
    return;
  }
  try {
    await api(`/api/servers/${currentServer.appId}/port`, {
      method: 'POST',
      body: { port },
    });
    toast(`Port changed to ${port}! Restart the server for it to take effect.`, 'success');
    const host = currentServer.allocation?.ip_alias || currentServer.allocation?.ip || '?';
    document.getElementById('stat-address').textContent = `${host}:${port}`;
    const data = await api('/api/servers');
    servers = data.data || [];
  } catch (e) {
    toast('Port change failed: ' + e.message, 'error');
  }
}

async function changeLimit(kind) {
  if (!currentServer) return;
  const lim = currentServer.limits || {};
  let title, message, current;

  if (kind === 'memory') {
    title = 'Change Memory Limit';
    current = lim.memory || 0;
    message = `Current: ${current ? current + ' MB' : '0 (unlimited)'}. Enter new memory limit (e.g. "4GB", "2048", "0" for unlimited):`;
  } else if (kind === 'disk') {
    title = 'Change Disk Limit';
    current = lim.disk || 0;
    message = `Current: ${current ? current + ' MB' : '0 (unlimited)'}. Enter new disk limit (e.g. "20GB", "10240", "0" for unlimited).`;
  } else if (kind === 'cpu') {
    title = 'Change CPU Limit';
    current = lim.cpu || 0;
    message = `Current: ${current ? current + '%' : '0 (unlimited)'}. Enter CPU limit as a percentage (100 = 1 core, 200 = 2 cores, "0" for unlimited):`;
  } else if (kind === 'backups') {
    title = 'Change Backup Retention';
    const data = await api(`/api/servers/${currentServer.clientId}/backup-hygiene`).catch(() => null);
    current = data?.backupLimit ?? 3;
    message = `Currently keeping the ${current} most recent backups. Enter new retention (e.g. "5"). Older backups are evicted automatically when the limit is hit.`;
  } else return;

  const raw = await showModal({
    title, message, showInput: true,
    inputValue: String(current),
    confirmLabel: 'Update',
  });
  if (raw === null) return;

  let value;
  if (kind === 'cpu' || kind === 'backups') {
    value = parseInt(String(raw).trim());
    if (isNaN(value) || value < 0) { toast(`Invalid ${kind} value`, 'error'); return; }
  } else {
    value = parseResourceInput(raw);
    if (value === null) { toast(`Invalid ${kind} value`, 'error'); return; }
  }

  const body = { [kind]: value };

  try {
    await api(`/api/servers/${currentServer.appId}/limits`, {
      method: 'PATCH',
      body,
    });
    if (kind !== 'backups' && currentServer.limits) {
      currentServer.limits[kind] = value;
    }
    const restartHint = (kind === 'backups') ? '' : ' Restart the server for it to take effect.';
    toast(`${kind.charAt(0).toUpperCase() + kind.slice(1)} updated.${restartHint}`, 'success');
    if (kind === 'backups') {
      loadBackupHygiene();
    } else {
      updateResources();
    }
  } catch (e) {
    toast(`Failed to update ${kind}: ` + e.message, 'error');
  }
}
function parseResourceInput(raw) {
  raw = String(raw).trim().toUpperCase();
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*GB?/gi, (_, n) => String(Math.round(parseFloat(n) * 1024)));
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*MB?/gi, (_, n) => String(Math.round(parseFloat(n))));
  if (/^[\d\s+\-*/().]+$/.test(raw)) {
    try {
      const result = Math.round(Function('"use strict"; return (' + raw + ')')());
      if (isFinite(result) && result >= 0) return result;
    } catch (e) {}
  }
  return null;
}

function smartInput(el) {
  const parsed = parseResourceInput(el.value);
  if (parsed !== null) el.value = parsed;
}
async function loadBackups() {
  if (!currentServer) return;
  loadBackupHygiene();
  const list = document.getElementById('backups-list');
  list.innerHTML = '<div class="loading">Loading backups...</div>';

  try {
    const data = await api(`/api/servers/${currentServer.clientId}/backups`);
    const backups = data.data || [];

    if (backups.length === 0) {
      list.innerHTML = '<div class="loading">No backups yet.</div>';
      return;
    }

    list.innerHTML = backups.map(b => {
      const a = b.attributes;
      const date = fmtDateTime(a.created_at);
      const size = formatBytes(a.bytes || 0);
      const statusCls = a.is_successful ? 'completed' : (a.completed_at ? 'failed' : 'in_progress');
      const statusText = a.is_successful ? 'Completed' : (a.completed_at ? 'Failed' : 'In Progress');
      const canAct = a.is_successful;

      return `
        <div class="backup-card">
          <div class="backup-card-info">
            <div class="backup-card-name">${esc(a.name || 'Backup')}</div>
            <div class="backup-card-meta">
              <span>${date}</span>
              <span>${size}</span>
              <span class="backup-status ${statusCls}">${statusText}</span>
            </div>
          </div>
          <div class="backup-card-actions">
            <button class="btn btn-secondary btn-sm" ${canAct ? '' : 'disabled'} onclick="downloadBackup('${esc(a.uuid)}')">Download</button>
            <button class="btn btn-green btn-sm" ${canAct ? '' : 'disabled'} onclick="restoreBackup('${esc(a.uuid)}', '${esc(a.name || 'Backup')}')">Restore</button>
            <button class="btn btn-danger btn-sm" onclick="deleteBackup('${esc(a.uuid)}', '${esc(a.name || 'Backup')}')">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    renderError(list, e, loadBackups);
  }
}

async function createBackup() {
  if (!currentServer) return;
  const result = await showModal({
    title: 'Create Backup',
    message: 'Enter a name for this backup (optional):',
    showInput: true,
    inputValue: '',
    confirmLabel: 'Create',
  });
  if (result === null) return;

  try {
    await api(`/api/servers/${currentServer.clientId}/backups`, {
      method: 'POST',
      body: { name: result || '' },
    });
    toast('Backup created', 'success');
    loadBackups();
    loadBackupStats();
  } catch (e) {
    toast('Failed to create backup: ' + e.message, 'error');
  }
}

async function downloadBackup(backupId) {
  if (!currentServer) return;
  try {
    const data = await api(`/api/servers/${currentServer.clientId}/backups/${backupId}/download`);
    const url = data.attributes?.url;
    if (url) {
      window.open(url, '_blank');
    } else {
      toast('No download URL returned', 'error');
    }
  } catch (e) {
    toast('Failed to get download link: ' + e.message, 'error');
  }
}

async function restoreBackup(backupId, name) {
  if (!currentServer) return;
  const ok = await showModal({
    title: 'Restore Backup',
    message: `Restore "${name}"? This will overwrite current server files.`,
    confirmLabel: 'Restore',
    dangerMode: true,
  });
  if (!ok) return;

  try {
    await api(`/api/servers/${currentServer.clientId}/backups/${backupId}/restore`, { method: 'POST' });
    toast('Backup restore started', 'success');
  } catch (e) {
    toast('Failed to restore: ' + e.message, 'error');
  }
}

async function deleteBackup(backupId, name) {
  if (!currentServer) return;
  const ok = await showModal({
    title: 'Delete Backup',
    message: `Delete "${name}"? This cannot be undone.`,
    confirmLabel: 'Delete',
    dangerMode: true,
  });
  if (!ok) return;

  try {
    await api(`/api/servers/${currentServer.clientId}/backups/${backupId}`, { method: 'DELETE' });
    toast('Backup deleted', 'success');
    loadBackups();
    loadBackupStats();
  } catch (e) {
    toast('Failed to delete backup: ' + e.message, 'error');
  }
}

async function loadBackupHygiene() {
  if (!currentServer) return;
  const wrap = document.getElementById('backup-hygiene');
  if (!wrap) return;
  try {
    const data = await api(`/api/servers/${currentServer.clientId}/backup-hygiene`);
    const parts = [];

    if (!data.pteroignore.worldOnly) {
      const reason = data.pteroignore.present
        ? 'A custom <code>.pteroignore</code> exists, but it does not match the recommended pattern.'
        : 'No <code>.pteroignore</code> is set, so each backup snapshots the entire server including mod backup output, logs, and caches.';
      parts.push(`
        <div class="hygiene-card hygiene-warn">
          <div class="hygiene-card-body">
            <div class="hygiene-card-title">Backups include mod-driven bloat</div>
            <div class="hygiene-card-desc">${reason} Apply the recommended denylist to skip <code>backups/</code>, <code>logs/</code>, <code>crash-reports/</code>, and <code>cache/</code>.</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="applyPteroignore()">Apply recommended</button>
        </div>
      `);
    } else {
      parts.push(`
        <div class="hygiene-card hygiene-ok">
          <div class="hygiene-card-body">
            <div class="hygiene-card-title">Recommended <code>.pteroignore</code> active</div>
            <div class="hygiene-card-desc">Snapshots skip <code>backups/</code>, <code>logs/</code>, <code>crash-reports/</code>, <code>cache/</code>.</div>
          </div>
        </div>
      `);
    }

    if (data.backupLimit != null) {
      parts.push(`
        <div class="hygiene-card">
          <div class="hygiene-card-body">
            <div class="hygiene-card-title">Backup retention</div>
            <div class="hygiene-card-desc">Keep the <strong>${data.backupLimit}</strong> most recent backup${data.backupLimit === 1 ? '' : 's'}; older ones are auto-evicted when a new backup is created.</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="changeLimit('backups')">Edit</button>
        </div>
      `);
    }

    if (data.detectedMods && data.detectedMods.length) {
      const items = data.detectedMods.map(m => {
        if (m.configPath) {
          const hint = m.hint ? ` &mdash; ${esc(m.hint)}` : '';
          return `<li><strong>${esc(m.name)}</strong> &mdash; edit <code>${esc(m.configPath)}</code>${hint}</li>`;
        }
        const candidates = (m.candidatePaths || []).map(p => `<code>${esc(p)}</code>`).join(' or ');
        return `<li><strong>${esc(m.name)}</strong> &mdash; config not found at known paths (${candidates}). May be a newer version &mdash; check <code>config/</code> for a matching file.</li>`;
      }).join('');
      parts.push(`
        <div class="hygiene-card hygiene-info">
          <div class="hygiene-card-body">
            <div class="hygiene-card-title">Auto-backup mod detected</div>
            <div class="hygiene-card-desc">
              To avoid double-backing-up, disable in-game scheduled backups. Use the Files tab to edit:
              <ul class="hygiene-list">${items}</ul>
            </div>
          </div>
        </div>
      `);
    }

    wrap.innerHTML = parts.join('');
    wrap.style.display = parts.length ? '' : 'none';
  } catch (e) {
    wrap.style.display = 'none';
  }
}

async function applyPteroignore() {
  if (!currentServer) return;
  const ok = await showModal({
    title: 'Apply world-only backups',
    message: 'This writes /.pteroignore at the server root so future Pterodactyl backups only contain world folders. Existing backups are unchanged. Continue?',
    confirmLabel: 'Apply',
  });
  if (!ok) return;
  try {
    await api(`/api/servers/${currentServer.clientId}/apply-pteroignore`, { method: 'POST' });
    toast('World-only .pteroignore applied', 'success');
    loadBackupHygiene();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

// --- Activity log ---

const ACTION_LABELS = {
  'power.start': { verb: 'started the server', icon: '▶', cls: 'green' },
  'power.stop': { verb: 'stopped the server', icon: '■', cls: 'red' },
  'power.restart': { verb: 'restarted the server', icon: '↻', cls: 'yellow' },
  'power.kill': { verb: 'killed the server', icon: '✕', cls: 'red' },
  'server.create': { verb: 'created the server', icon: '+', cls: 'green' },
  'server.delete': { verb: 'deleted the server', icon: '✕', cls: 'red' },
  'server.crash': { verb: 'detected a crash', icon: '!', cls: 'red' },
  'server.auto_restart': { verb: 'auto-restarted the server', icon: '↻', cls: 'yellow' },
  'config.port': { verb: 'changed the port', icon: '⚙', cls: '' },
  'config.image': { verb: 'changed the Java image', icon: '⚙', cls: '' },
  'config.startup': { verb: 'updated startup settings', icon: '⚙', cls: '' },
  'config.pteroignore': { verb: 'enabled world-only backups', icon: '⚙', cls: '' },
  'config.visibility': { verb: 'changed server visibility', icon: '⚙', cls: '' },
  'access.grant': { verb: 'granted access', icon: '+', cls: 'green' },
  'access.revoke': { verb: 'revoked access', icon: '✕', cls: 'red' },
  'backup.create': { verb: 'created a backup', icon: '⬇', cls: '' },
  'backup.restore': { verb: 'restored a backup', icon: '↶', cls: 'yellow' },
  'backup.delete': { verb: 'deleted a backup', icon: '✕', cls: 'red' },
  'worldbackup.create': { verb: 'ran a world backup', icon: '⬇', cls: '' },
  'schedule.create': { verb: 'created a schedule', icon: '⏱', cls: '' },
  'schedule.update': { verb: 'updated a schedule', icon: '⏱', cls: '' },
  'schedule.delete': { verb: 'deleted a schedule', icon: '✕', cls: 'red' },
  'schedule.task.create': { verb: 'added a task to a schedule', icon: '⏱', cls: '' },
  'schedule.task.delete': { verb: 'removed a task from a schedule', icon: '✕', cls: 'red' },
  'modpack.install': { verb: 'installed a modpack', icon: '⬇', cls: '' },
  'file.delete': { verb: 'deleted files', icon: '✕', cls: 'red' },
  'file.rename': { verb: 'renamed files', icon: '⚙', cls: '' },
};

function renderActivityDetails(action, d) {
  if (!d) return '';
  try {
    if (action === 'config.port') return ` <span class="activity-detail">${esc(String(d.from || '?'))} → ${esc(String(d.to))}</span>`;
    if (action === 'config.image') return ` <span class="activity-detail">${esc(d.image)}</span>`;
    if (action === 'server.create') return ` <span class="activity-detail">${esc(d.name || '')}${d.port ? ' · port ' + d.port : ''}</span>`;
    if (action === 'server.delete' && d.name) return ` <span class="activity-detail">${esc(d.name)}</span>`;
    if (action === 'backup.create' && d.name) return ` <span class="activity-detail">"${esc(d.name)}"</span>`;
    if (action === 'schedule.create' || action === 'schedule.update') return d.name ? ` <span class="activity-detail">"${esc(d.name)}"</span>` : '';
    if (action === 'schedule.delete' && d.name) return ` <span class="activity-detail">"${esc(d.name)}"</span>`;
    if (action === 'schedule.task.create') return d.action ? ` <span class="activity-detail">${esc(d.action)}${d.payload ? ': ' + esc(d.payload) : ''}</span>` : '';
    if (action === 'modpack.install') {
      const parts = [d.platform];
      if (d.filesInstalled) parts.push(d.filesInstalled + ' files');
      if (d.skipped) parts.push(d.skipped + ' skipped');
      return ` <span class="activity-detail">${esc(parts.filter(Boolean).join(' · '))}</span>`;
    }
    if ((action === 'file.delete' || action === 'file.rename') && Array.isArray(d.files)) {
      const n = d.files.length;
      return ` <span class="activity-detail">${n} item${n === 1 ? '' : 's'} in ${esc(d.root || '/')}</span>`;
    }
    if (action === 'config.visibility') return ` <span class="activity-detail">to ${d.isPublic ? 'public' : 'private'}</span>`;
    if ((action === 'access.grant' || action === 'access.revoke') && d.username) return ` <span class="activity-detail">@${esc(d.username)}</span>`;
  } catch (_) {}
  return '';
}

function formatActivityTime(iso) {
  if (!iso) return '';
  const t = iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(t);
  if (isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d ago`;
  return fmtDateTime(d);
}

let activityRows = [];
let activityHasMore = false;

async function loadActivity() {
  if (!currentServer) return;
  const list = document.getElementById('activity-list');
  if (!list) return;
  list.innerHTML = '<div class="loading">Loading activity...</div>';
  activityRows = [];
  activityHasMore = false;
  document.getElementById('activity-load-more').style.display = 'none';

  try {
    const data = await api(`/api/servers/${currentServer.clientId}/activity?limit=100`);
    activityRows = data.data || [];
    activityHasMore = activityRows.length === 100;
    renderActivity();
  } catch (e) {
    renderError(list, e, loadActivity);
  }
}

async function loadMoreActivity() {
  if (!currentServer || activityRows.length === 0) return;
  const oldest = activityRows[activityRows.length - 1];
  try {
    const data = await api(`/api/servers/${currentServer.clientId}/activity?limit=100&before=${oldest.id}`);
    const more = data.data || [];
    activityRows = activityRows.concat(more);
    activityHasMore = more.length === 100;
    renderActivity();
  } catch (e) {
    toast('Failed to load more: ' + e.message, 'error');
  }
}

function renderActivity() {
  const list = document.getElementById('activity-list');
  if (!list) return;
  if (activityRows.length === 0) {
    list.innerHTML = '<div class="loading">No activity recorded yet.</div>';
    document.getElementById('activity-load-more').style.display = 'none';
    return;
  }
  list.innerHTML = activityRows.map(r => {
    const meta = ACTION_LABELS[r.action] || { verb: r.action, icon: '•', cls: '' };
    const when = formatActivityTime(r.createdAt);
    const details = renderActivityDetails(r.action, r.details);
    return `
      <div class="activity-row">
        <div class="activity-icon ${meta.cls}">${meta.icon}</div>
        <div class="activity-body">
          <div class="activity-line"><strong>${esc(r.actorLabel)}</strong> ${meta.verb}${details}</div>
          <div class="activity-when" title="${esc(r.createdAt)}">${esc(when)}</div>
        </div>
      </div>
    `;
  }).join('');
  document.getElementById('activity-load-more').style.display = activityHasMore ? '' : 'none';
}

function switchAdminTab(tab) {
  document.querySelectorAll('.detail-tab[data-admin-tab]').forEach(t =>
    t.classList.toggle('active', t.dataset.adminTab === tab)
  );
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  const el = document.getElementById(`admin-tab-${tab}`);
  if (el) el.classList.add('active');
  history.replaceState({ page: 'admin', tab }, '', `/admin#${tab}`);
}

async function loadAdmin() {
  if (!currentUser?.isAdmin) { navigate('home'); return; }
  loadUsers();
  loadPeers();
  loadClientMods();
  populateCrashScanServers();
  const initialTab = window.location.hash.slice(1) || 'users';
  switchAdminTab(initialTab);
}

async function loadClientMods() {
  const list = document.getElementById('clientmods-list');
  if (!list) return;
  list.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const data = await api('/api/admin/client-mods');
    const rows = data.data || [];
    if (!rows.length) { list.innerHTML = '<div class="loading">Denylist is empty.</div>'; return; }
    list.innerHTML = rows.map(r => `
      <div class="clientmod-row">
        <div class="clientmod-info">
          <span class="clientmod-name">${esc(r.name)}</span>
          <code class="clientmod-pattern">${esc(r.pattern)}</code>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="removeClientMod(${r.id})">Remove</button>
      </div>
    `).join('');
  } catch (e) {
    renderError(list, e, loadClientMods);
  }
}

async function addClientMod(e) {
  e.preventDefault();
  const name = document.getElementById('clientmod-name').value.trim();
  const pattern = document.getElementById('clientmod-pattern').value.trim();
  if (!pattern) return;
  try {
    const res = await api('/api/admin/client-mods', { method: 'POST', body: { name, pattern } });
    toast(res.added ? 'Added to denylist' : 'Already in the denylist', res.added ? 'success' : 'info');
    document.getElementById('clientmod-name').value = '';
    document.getElementById('clientmod-pattern').value = '';
    loadClientMods();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeClientMod(id) {
  try {
    await api(`/api/admin/client-mods/${id}`, { method: 'DELETE' });
    toast('Removed', 'success');
    loadClientMods();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function populateCrashScanServers() {
  const sel = document.getElementById('crashscan-server');
  if (!sel) return;
  if (!servers.length) {
    try { const d = await api('/api/servers'); servers = d.data || []; } catch (_) {}
  }
  sel.innerHTML = servers.map(s =>
    `<option value="${esc(s.attributes.uuid)}">${esc(s.attributes.name)}</option>`
  ).join('') || '<option value="">No servers</option>';
}

async function runCrashScan() {
  const sel = document.getElementById('crashscan-server');
  const result = document.getElementById('crashscan-result');
  const uuid = sel?.value;
  if (!uuid) return;
  result.innerHTML = '<div class="loading">Scanning...</div>';
  try {
    const data = await api(`/api/servers/${uuid}/crash-scan`);
    if (!data.report) { result.innerHTML = '<div class="loading">No crash report or log found for this server.</div>'; return; }

    const suspectsHtml = (data.suspects || []).length ? `
      <div class="crashscan-suspects">
        <strong>Suspected client mods</strong>
        ${data.suspects.map(s => `
          <div class="clientmod-row">
            <div class="clientmod-info">
              <span class="clientmod-name">${esc(s.file)}</span>
              <code class="clientmod-pattern">${esc(s.prefix)}</code>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="quickAddClientMod('${esc(s.prefix)}')">Add to denylist</button>
          </div>
        `).join('')}
      </div>` : '<div class="loading">No mod files named in the report.</div>';

    const linesHtml = (data.lines || []).length
      ? `<pre class="crashscan-log">${esc(data.lines.join('\n'))}</pre>`
      : '';

    result.innerHTML = `
      <div class="crashscan-report">Source: <code>${esc(data.report)}</code></div>
      ${suspectsHtml}
      ${linesHtml}
    `;
  } catch (e) {
    renderError(result, e, runCrashScan);
  }
}

async function quickAddClientMod(prefix) {
  try {
    const res = await api('/api/admin/client-mods', { method: 'POST', body: { name: prefix, pattern: prefix } });
    toast(res.added ? `Added "${prefix}" to denylist` : `"${prefix}" already denied`, res.added ? 'success' : 'info');
    loadClientMods();
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function loadUsers() {
  const list = document.getElementById('users-list');
  list.innerHTML = '<div class="loading">Loading users...</div>';
  try {
    const users = await api('/api/auth/users');
    if (users.length === 0) {
      list.innerHTML = '<div class="loading">No users.</div>';
      return;
    }
    list.innerHTML = users.map(u => {
      const perms = u.permissions.filter(p => p.scope === '*').map(p => {
        const def = PERMISSIONS.find(d => d.key === p.permission);
        return def ? def.label : p.permission;
      }).join(', ');
      const scopedPerms = u.permissions.filter(p => p.scope !== '*').length;
      const permSummary = perms + (scopedPerms ? ` (+${scopedPerms} scoped)` : '');

      return `
        <div class="user-card">
          <div class="user-card-info">
            <div class="user-card-name">${esc(u.displayName || u.username)}${u.isAdmin ? '<span class="admin-badge">Admin</span>' : ''}</div>
            <div class="user-card-meta">
              <span>@${esc(u.username)}</span>
              ${u.lastLogin ? `<span>Last login: ${fmtDateTime(u.lastLogin)}</span>` : '<span>Never logged in</span>'}
              ${!u.isAdmin && permSummary ? `<span>${esc(permSummary)}</span>` : ''}
            </div>
          </div>
          <div class="user-card-actions">
            <button class="btn btn-secondary btn-sm" onclick="showEditUserModal(${u.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteUserAction(${u.id}, '${esc(u.username)}')">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    renderError(list, e, loadUsers);
  }
}

function showCreateUserModal() {
  document.getElementById('user-modal-title').textContent = 'Create User';
  document.getElementById('user-edit-id').value = '';
  document.getElementById('user-edit-username').value = '';
  document.getElementById('user-edit-username').disabled = false;
  document.getElementById('user-edit-display').value = '';
  document.getElementById('user-edit-password').value = '';
  document.getElementById('user-password-hint').textContent = 'Required for new users';
  document.getElementById('user-edit-admin').checked = false;
  buildPermGrid([]);
  document.getElementById('user-modal-overlay').style.display = 'flex';
}

async function showEditUserModal(userId) {
  const users = await api('/api/auth/users');
  const user = users.find(u => u.id === userId);
  if (!user) return;

  document.getElementById('user-modal-title').textContent = 'Edit User';
  document.getElementById('user-edit-id').value = user.id;
  document.getElementById('user-edit-username').value = user.username;
  document.getElementById('user-edit-username').disabled = true;
  document.getElementById('user-edit-display').value = user.displayName || '';
  document.getElementById('user-edit-password').value = '';
  document.getElementById('user-password-hint').textContent = 'Leave blank to keep current password';
  document.getElementById('user-edit-admin').checked = user.isAdmin;
  buildPermGrid(user.permissions);
  document.getElementById('user-modal-overlay').style.display = 'flex';
}

function buildPermGrid(existingPerms) {
  const grid = document.getElementById('user-perms-grid');
  grid.innerHTML = PERMISSIONS.map(p => {
    const existing = existingPerms.find(ep => ep.permission === p.key && ep.scope === '*');
    return `
      <label class="perm-item">
        <input type="checkbox" data-perm="${p.key}" ${existing ? 'checked' : ''}>
        ${esc(p.label)}
      </label>
    `;
  }).join('');
}

function closeUserModal() {
  document.getElementById('user-modal-overlay').style.display = 'none';
}

async function saveUser(e) {
  e.preventDefault();
  const id = document.getElementById('user-edit-id').value;
  const isEdit = !!id;

  const permissions = [];
  document.querySelectorAll('#user-perms-grid input[data-perm]').forEach(cb => {
    if (cb.checked) {
      permissions.push({ permission: cb.dataset.perm, scope: '*' });
    }
  });

  const body = {
    username: document.getElementById('user-edit-username').value,
    displayName: document.getElementById('user-edit-display').value || document.getElementById('user-edit-username').value,
    isAdmin: document.getElementById('user-edit-admin').checked,
    permissions,
  };

  const pw = document.getElementById('user-edit-password').value;
  if (pw) body.password = pw;
  if (!isEdit && !pw) { toast('Password is required for new users', 'error'); return; }

  try {
    if (isEdit) {
      await api(`/api/auth/users/${id}`, { method: 'PATCH', body });
    } else {
      body.password = pw;
      await api('/api/auth/users', { method: 'POST', body });
    }
    toast(isEdit ? 'User updated' : 'User created', 'success');
    closeUserModal();
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteUserAction(id, username) {
  const ok = await showModal({
    title: 'Delete User',
    message: `Delete user "${username}"? This cannot be undone.`,
    confirmLabel: 'Delete',
    dangerMode: true,
  });
  if (!ok) return;

  try {
    await api(`/api/auth/users/${id}`, { method: 'DELETE' });
    toast('User deleted', 'success');
    loadUsers();
  } catch (e) {
    toast(e.message, 'error');
  }
}
async function loadPeers() {
  const list = document.getElementById('peers-list');
  list.innerHTML = '<div class="loading">Loading peers...</div>';
  try {
    const peers = await api('/api/wireguard/peers');
    if (peers.length === 0) {
      list.innerHTML = '<div class="loading">No VPN peers.</div>';
      return;
    }
    list.innerHTML = peers.map(p => {
      const lastSeen = p.live?.latestHandshake
        ? fmtDateTime(new Date(p.live.latestHandshake * 1000))
        : 'Never';
      const activeRecently = p.live?.latestHandshake && (Date.now() / 1000 - p.live.latestHandshake) < 180;
      const statusClass = p.revoked ? 'offline' : (activeRecently ? 'running' : 'offline');
      const statusText = p.revoked ? 'Revoked' : (activeRecently ? 'Connected' : (p.live?.latestHandshake ? 'Inactive' : 'Never connected'));

      return `
        <div class="peer-card">
          <div class="peer-card-info">
            <div class="peer-card-name">${esc(p.label)}${p.displayName && p.displayName !== p.label ? ` - ${esc(p.displayName)}` : ''}</div>
            <div class="peer-card-meta">
              <span>${esc(p.ipAddress)}</span>
              <span class="status-badge ${statusClass}">${statusText}</span>
              <span>Last seen: ${lastSeen}</span>
              ${p.live ? `<span>RX: ${formatBytes(p.live.transferRx)} / TX: ${formatBytes(p.live.transferTx)}</span>` : ''}
            </div>
          </div>
          <div class="peer-card-actions">
            <button class="btn btn-ghost btn-sm" onclick="renamePeerAction(${p.id}, '${esc(p.label)}')">Rename</button>
            <button class="btn btn-ghost btn-sm" onclick="linkPeerAction(${p.id}, ${p.userId || null})">Link</button>
            ${!p.revoked ? `<button class="btn btn-secondary btn-sm" onclick="downloadPeerConfigAction(${p.id})">Config</button>` : ''}
            ${!p.revoked ? `<button class="btn btn-danger btn-sm" onclick="revokePeerAction(${p.id}, '${esc(p.label)}')">Revoke</button>` : ''}
            ${p.revoked ? `<button class="btn btn-green btn-sm" onclick="reactivatePeerAction(${p.id}, '${esc(p.label)}')">Re-activate</button>` : ''}
            ${p.revoked ? `<button class="btn btn-danger btn-sm" onclick="deletePeerAction(${p.id}, '${esc(p.label)}')">Delete</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    renderError(list, e, loadPeers);
  }
}

async function openPeerModal({ id = null, label = '', userId = null } = {}) {
  const users = await api('/api/auth/users');
  const sel = document.getElementById('peer-edit-user');
  sel.innerHTML = '<option value="">None</option>' +
    users.map(u => `<option value="${u.id}"${u.id === userId ? ' selected' : ''}>${esc(u.displayName || u.username)}</option>`).join('');

  document.getElementById('peer-edit-id').value = id || '';
  document.getElementById('peer-edit-label').value = label;
  document.getElementById('peer-label-group').style.display = id ? 'none' : '';
  document.getElementById('peer-modal-title').textContent = id ? 'Link Account' : 'Create VPN Peer';
  document.getElementById('peer-modal-submit').textContent = id ? 'Save' : 'Create';
  document.getElementById('peer-modal-overlay').style.display = 'flex';
}

function closePeerModal() {
  document.getElementById('peer-modal-overlay').style.display = 'none';
}

async function showCreatePeerModal() {
  openPeerModal();
}

async function linkPeerAction(id, currentUserId) {
  const peers = await api('/api/wireguard/peers');
  const peer = peers.find(p => p.id === id);
  openPeerModal({ id, label: peer?.label || '', userId: currentUserId });
}

async function savePeerModal(e) {
  e.preventDefault();
  const id = document.getElementById('peer-edit-id').value;
  const label = document.getElementById('peer-edit-label').value.trim();
  const userId = document.getElementById('peer-edit-user').value || null;

  if (id) {
    try {
      await api(`/api/wireguard/peers/${id}`, { method: 'PATCH', body: { userId: userId ? parseInt(userId) : null } });
      toast('Account linked', 'success');
      closePeerModal();
      loadPeers();
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  } else {
    try {
      const data = await api('/api/wireguard/peers', {
        method: 'POST',
        body: { label, userId: userId ? parseInt(userId) : null },
      });
      closePeerModal();
      document.getElementById('peer-config-text').value = data.config;
      document.getElementById('peer-config-text').dataset.label = label;
      document.getElementById('peer-config-modal').style.display = 'flex';
      loadPeers();
      toast(`Peer created: ${data.ip}`, 'success');
    } catch (e) {
      toast('Failed to create peer: ' + e.message, 'error');
    }
  }
}

async function downloadPeerConfigAction(id) {
  try {
    const data = await api(`/api/wireguard/peers/${id}/config`);
    document.getElementById('peer-config-text').value = data.config;
    document.getElementById('peer-config-text').dataset.label = 'peer';
    document.getElementById('peer-config-modal').style.display = 'flex';
  } catch (e) {
    toast('Failed to get config: ' + e.message, 'error');
  }
}

function closePeerConfigModal() {
  document.getElementById('peer-config-modal').style.display = 'none';
}

function copyPeerConfig() {
  const textarea = document.getElementById('peer-config-text');
  navigator.clipboard.writeText(textarea.value);
  toast('Copied to clipboard', 'success');
}

function downloadPeerConfig() {
  const config = document.getElementById('peer-config-text').value;
  const label = document.getElementById('peer-config-text').dataset.label || 'peer';
  const blob = new Blob([config], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${label}.conf`;
  a.click();
  URL.revokeObjectURL(url);
}

async function renamePeerAction(id, currentLabel) {
  const newLabel = await showModal({ title: 'Rename Peer', message: 'New name:', showInput: true, inputValue: currentLabel });
  if (!newLabel || newLabel === currentLabel) return;
  try {
    await api(`/api/wireguard/peers/${id}`, { method: 'PATCH', body: { label: newLabel } });
    toast('Peer renamed', 'success');
    loadPeers();
  } catch (e) {
    toast('Failed to rename: ' + e.message, 'error');
  }
}

async function revokePeerAction(id, label) {
  const ok = await showModal({
    title: 'Revoke Peer',
    message: `Revoke VPN access for "${label}"? They will be disconnected.`,
    confirmLabel: 'Revoke',
    dangerMode: true,
  });
  if (!ok) return;

  try {
    await api(`/api/wireguard/peers/${id}`, { method: 'DELETE' });
    toast('Peer revoked', 'success');
    loadPeers();
  } catch (e) {
    toast('Failed to revoke: ' + e.message, 'error');
  }
}

async function reactivatePeerAction(id, label) {
  const ok = await showModal({
    title: 'Re-activate Peer',
    message: `Re-activate VPN access for "${label}"?`,
    confirmLabel: 'Re-activate',
  });
  if (!ok) return;
  try {
    await api(`/api/wireguard/peers/${id}/reactivate`, { method: 'POST' });
    toast('Peer re-activated', 'success');
    loadPeers();
  } catch (e) {
    toast('Failed to re-activate: ' + e.message, 'error');
  }
}

async function deletePeerAction(id, label) {
  const ok = await showModal({
    title: 'Delete Peer',
    message: `Permanently delete "${label}"? This cannot be undone.`,
    confirmLabel: 'Delete',
    dangerMode: true,
  });
  if (!ok) return;
  try {
    await api(`/api/wireguard/peers/${id}/permanent`, { method: 'DELETE' });
    toast('Peer deleted', 'success');
    loadPeers();
  } catch (e) {
    toast('Failed to delete: ' + e.message, 'error');
  }
}

let currentModpackInfo = null;
let updateVersions = [];

async function loadModpackInfo() {
  if (!currentServer) return;
  const section = document.getElementById('modpack-update');
  section.style.display = 'none';
  currentModpackInfo = null;
  updateVersions = [];

  try {
    const info = await api(`/api/servers/${currentServer.clientId}/modpack-info`);
    if (!info || !info.platform || !info.projectId) return;

    currentModpackInfo = info;
    document.getElementById('modpack-update-title').textContent = info.projectTitle || 'Modpack';
    document.getElementById('modpack-update-current').textContent = 'Installed: ' + (info.versionName || info.versionId);
    section.style.display = '';

    await refreshModpackVersions();
  } catch (e) { /* no modpack installed */ }
}

async function refreshModpackVersions() {
  if (!currentModpackInfo) return;
  const select = document.getElementById('modpack-update-version');
  select.innerHTML = '<option>Loading...</option>';

  try {
    const info = currentModpackInfo;
    let versions = [];

    if (info.platform === 'modrinth') {
      versions = await api(`/api/modpacks/modrinth/project/${encodeURIComponent(info.projectId)}/versions`);
      updateVersions = versions.map(v => ({
        id: v.id,
        name: v.name || v.version_number,
        loaders: v.loaders || [],
        game_versions: v.game_versions || [],
        files: v.files,
        date: v.date_published,
      }));
    } else if (info.platform === 'curseforge') {
      const filesData = await api(`/api/modpacks/curseforge/mod/${info.projectId}/files`);
      const files = filesData.data || [];
      updateVersions = files.map(f => ({
        id: String(f.id),
        name: f.displayName || f.fileName,
        loaders: [],
        game_versions: f.sortableGameVersions?.map(g => g.gameVersionName).filter(v => v.match(/^\d/)) || [],
        files: [{ url: f.downloadUrl }],
        date: f.fileDate,
        _cfServerPackId: f.serverPackFileId,
      }));
    }

    select.innerHTML = updateVersions.map(v => {
      const mc = v.game_versions.join(', ') || '';
      const isCurrent = v.id === info.versionId;
      const label = v.name + (mc ? ' - MC ' + mc : '') + (isCurrent ? ' (installed)' : '');
      return `<option value="${esc(v.id)}" ${isCurrent ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');

  } catch (e) {
    select.innerHTML = '<option>Failed to load versions</option>';
    toast('Failed to load modpack versions: ' + e.message, 'error');
  }
}

async function updateModpack() {
  if (!currentServer || !currentModpackInfo) return;
  const select = document.getElementById('modpack-update-version');
  const versionId = select.value;
  const version = updateVersions.find(v => v.id === versionId);
  if (!version) return;

  if (versionId === currentModpackInfo.versionId) {
    const ok = await showModal({
      title: 'Reinstall',
      message: 'This version is already installed. Reinstall it?',
      confirmLabel: 'Reinstall',
    });
    if (!ok) return;
  } else {
    const action = updateVersions.indexOf(version) > updateVersions.findIndex(v => v.id === currentModpackInfo.versionId)
      ? 'Downgrade' : 'Update';
    const ok = await showModal({
      title: action + ' Modpack',
      message: `${action} from "${currentModpackInfo.versionName}" to "${version.name}"? Server files will be overwritten.`,
      confirmLabel: action,
      dangerMode: action === 'Downgrade',
    });
    if (!ok) return;
  }

  const platform = currentModpackInfo.platform;
  let fileUrl = null;
  let cfServerPack = null;

  if (platform === 'modrinth') {
    const mrpack = version.files?.find(f => f.filename?.endsWith('.mrpack')) || version.files?.[0];
    fileUrl = mrpack?.url;
  } else if (platform === 'curseforge') {
    fileUrl = version.files?.[0]?.url;
    if (version._cfServerPackId) cfServerPack = { projectId: currentModpackInfo.projectId, serverPackId: version._cfServerPackId };
  }

  if (!fileUrl) {
    toast('No download URL available for this version', 'error');
    return;
  }

  const modpackMeta = {
    platform,
    projectId: currentModpackInfo.projectId,
    projectTitle: currentModpackInfo.projectTitle,
    versionId: version.id,
    versionName: version.name,
    installedAt: new Date().toISOString(),
  };

  const btn = document.getElementById('modpack-update-btn');
  btn.disabled = true;
  btn.textContent = 'Updating...';

  saveInstallState({
    serverUuid: currentServer.clientId,
    serverName: currentServer.name,
    platform,
    startedAt: Date.now(),
    status: 'installing',
    progress: 0,
    message: 'Starting update...',
  });
  updateInstallOverlay('Starting update...', 0);

  try {
    await streamModpackInstall(currentServer.clientId, currentServer.name, platform, fileUrl, modpackMeta, cfServerPack);
    currentModpackInfo.versionId = version.id;
    currentModpackInfo.versionName = version.name;
    document.getElementById('modpack-update-current').textContent = 'Installed: ' + version.name;
    await refreshModpackVersions();
  } catch (e) {
    saveInstallState({ ...getInstallState(), status: 'error', message: e.message });
    updateInstallOverlay('Update failed: ' + e.message, -1);
    toast('Modpack update failed: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Update';
}
function esc(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function appendConsoleLine(output, text, forceClass) {
  const span = document.createElement('span');
  const clean = esc(text);
  let cls = forceClass || '';
  if (!cls) {
    if (/\b(ERROR|FATAL|Exception|SEVERE)\b/i.test(text))  cls = 'log-error';
    else if (/\bWARN(ING)?\b/i.test(text))                 cls = 'log-warn';
    else if (/^container@pterodactyl/i.test(text))          cls = 'log-container';
    else if (/\[Pterodactyl Daemon\]/i.test(text))          cls = 'log-daemon';
  }
  if (cls) span.className = cls;
  span.innerHTML = clean + '\n';
  output.appendChild(span);
  while (output.childNodes.length > 2000) output.removeChild(output.firstChild);
}

initAuth();
checkPendingInstall();
