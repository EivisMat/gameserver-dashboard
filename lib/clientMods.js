'use strict';

/**
 * Client-only mod detection for CurseForge installs.
 *
 * Some client mods don't correctly declare their side, so Forge tries to load
 * them on a dedicated server and they crash referencing client-only classes
 * (net.minecraft.client.*, com.mojang.blaze3d.*). Well-behaved client mods
 * declare `side=CLIENT` and Forge skips them; these don't, so we strip them
 * during install.
 *
 * The active denylist lives in the database and is editable from the admin
 * panel; DEFAULT_CLIENT_MODS below is only the initial seed. Each entry has a
 * `name` (display) and a `pattern` (a jar-filename prefix, matched as
 * `^<pattern>[-_]` case-insensitively so "oculus" matches "oculus-1.8.0.jar"
 * but not an unrelated "oculusium-*.jar").
 */

const DEFAULT_CLIENT_MODS = [
  { name: 'Oculus', pattern: 'oculus' },
  { name: 'Iris', pattern: 'iris' },
  { name: 'ItemPhysic Guns', pattern: 'itemphysicguns' },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn DB rows [{name, pattern}] into precompiled matchers [{name, re}]. */
function compileDenylist(rows) {
  return (rows || [])
    .filter((r) => r && r.pattern)
    .map((r) => ({ name: r.name || r.pattern, re: new RegExp(`^${escapeRegExp(r.pattern)}[-_]`, 'i') }));
}

/** Return the matching denylist entry for a jar filename, or null. */
function matchClientOnlyMod(filename, compiled) {
  return (compiled || []).find((m) => m.re.test(filename)) || null;
}

/** Derive a denylist prefix from a jar filename (the leading name token). */
function prefixFromFilename(filename) {
  return String(filename).replace(/\.jar$/i, '').split(/[-_]/)[0];
}

module.exports = { DEFAULT_CLIENT_MODS, compileDenylist, matchClientOnlyMod, prefixFromFilename };
