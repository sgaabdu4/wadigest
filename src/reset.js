// Choosing groups: groups already picked keep their switches and history; a newly added
// group starts fresh, so its first digest is at its next slot (nothing from before it was added).

import { saveConfig, newGroup } from './config.js';

/** @param {{jid: string, name: string, post?: boolean, pin?: boolean, dm?: boolean}[]} picked */
export function setGroups(cfg, picked) {
  const before = new Map((cfg.groups || []).map((g) => [g.jid, g]));
  cfg.groups = picked.filter((g) => g?.jid).map((g) => {
    const old = before.get(g.jid);
    const sw = Object.fromEntries(['post', 'pin', 'dm'].filter((k) => typeof g[k] === 'boolean').map((k) => [k, g[k]]));
    return old ? { ...old, name: g.name || old.name, ...sw } : newGroup(g, sw);
  });
  saveConfig(cfg);
  return { added: cfg.groups.filter((g) => !before.has(g.jid)).map((g) => g.name), removed: [...before.values()].filter((g) => !cfg.groups.some((x) => x.jid === g.jid)).map((g) => g.name) };
}
