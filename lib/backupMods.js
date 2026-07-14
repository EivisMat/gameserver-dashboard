'use strict';

/**
 * Backup-hygiene reference data.
 *
 * WORLD_ONLY_PTEROIGNORE is the recommended `.pteroignore`. An earlier `/*` +
 * `!world` allowlist was tried first, but Wings's gitignore implementation
 * didn't re-include directory contents reliably (whole `backups/` and `config/`
 * dirs leaked into snapshots). An explicit denylist of bloat-prone directories
 * is more predictable and keeps world + mods + configs.
 *
 * KNOWN_BACKUP_MODS lets the hygiene panel warn when an in-game backup mod is
 * installed (which would otherwise double up with Pterodactyl's own backups),
 * pointing at the config file where its scheduler can be disabled.
 */

const WORLD_ONLY_PTEROIGNORE = `# Managed by gameserver dashboard. Do not edit; click "Apply" in the Backups tab.
# Excludes mod-driven backup output, logs, and ephemeral caches from
# Pterodactyl snapshots; world, mods, and configs are kept.
backups/
logs/
crash-reports/
cache/
`;

const KNOWN_BACKUP_MODS = [
  {
    name: 'AdvancedBackups',
    match: /^advancedbackups.*\.jar$/i,
    candidates: [
      { path: 'config/AdvancedBackups.properties', hint: 'Set config.advancedbackups.enabled=false' },
      { path: 'config/advancedbackups-server.toml', hint: 'Set enabled = false (and any scheduling fields)' },
      { path: 'config/advancedbackups-common.toml', hint: 'Set enabled = false' },
    ],
  },
  {
    name: 'AromaBackup',
    match: /^aromabackup.*\.jar$/i,
    candidates: [
      { path: 'config/AromaBackuP.cfg', hint: 'Set "enable" / scheduling values to disable auto-runs' },
    ],
  },
  {
    name: 'FTBBackups2',
    match: /^ftbbackups2.*\.jar$/i,
    candidates: [
      { path: 'config/ftbbackups2/config.json', hint: 'Set "auto": false' },
    ],
  },
  {
    name: 'FTBBackups',
    match: /^ftbbackups.*\.jar$/i,
    candidates: [
      { path: 'config/ftbbackups/config.json', hint: 'Set "do_backups": false' },
    ],
  },
  {
    name: 'BetterBackups',
    match: /^betterbackups.*\.jar$/i,
    candidates: [
      { path: 'config/betterbackups-common.toml', hint: 'Disable scheduler' },
      { path: 'config/betterbackups.json', hint: 'Disable scheduler' },
    ],
  },
  {
    name: 'SimpleBackup',
    match: /^simplebackup.*\.jar$/i,
    candidates: [
      { path: 'config/simplebackup.json', hint: 'Disable scheduler' },
    ],
  },
];

module.exports = { WORLD_ONLY_PTEROIGNORE, KNOWN_BACKUP_MODS };
