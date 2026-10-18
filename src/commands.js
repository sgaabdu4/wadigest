// "!digest …" commands members send in the group (or by DM to the runner's number).
//   !digest join agents, n8n     opt in to a personal DM, with interests
//   !digest interests a, b, c    change interests
//   !digest status               what you're signed up for
//   !digest stop                 stop personal DMs
//   !digest help

import { COMMAND_PREFIX } from './rank.js';
import { findMember, upsertMember } from './members.js';
import { parseInterests } from './util.js';
import { describeSchedule } from './schedule.js';

export function parseCommand(text) {
  const t = String(text || '').trim();
  if (!COMMAND_PREFIX.test(t)) return null;
  const rest = t.replace(COMMAND_PREFIX, '').trim();
  const m = rest.match(/^(\w+)\s*[:\-]?\s*([\s\S]*)$/);
  const verb = (m?.[1] || 'help').toLowerCase();
  const arg = (m?.[2] || '').trim();
  const aliases = { join: 'join', start: 'join', subscribe: 'join', signup: 'join', optin: 'join', interests: 'interests', interest: 'interests', topics: 'interests', status: 'status', me: 'status', stop: 'stop', leave: 'stop', unsubscribe: 'stop', optout: 'stop', help: 'help' };
  return { verb: aliases[verb] || 'help', arg };
}

export function helpText(groupName) {
  return [
    `*Weekly digest${groupName ? ` for ${groupName}` : ''}*`,
    'On a schedule I post the top links, videos and threads in the group, and send a copy by DM with what matches your interests first ⭐.',
    '',
    '• *!digest interests agents, n8n, cursor*: set your interests',
    '• *!digest join …*: opt back in (with interests)',
    '• *!digest status*: see what you signed up for',
    '• *!digest stop*: no more DMs (the group post carries on)',
  ].join('\n');
}

/**
 * @param {{verb:string,arg:string}} cmd
 * @param {{senderJid:string,senderName:string}} who
 * @param {object[]} members (mutated)
 * @returns {{ reply: string, changed: boolean }}
 */
export function applyCommand(cmd, who, members, { groupName = '', schedule } = {}) {
  const when = schedule ? describeSchedule(schedule) : 'on a schedule';
  const existing = findMember(members, who.senderJid);
  switch (cmd.verb) {
    case 'join': {
      const interests = parseInterests(cmd.arg);
      const m = upsertMember(members, { jid: existing?.jid || who.senderJid, name: who.senderName, interests: interests.length ? interests : existing?.interests || [] });
      const list = m.interests.length ? m.interests.join(', ') : 'none yet (send *!digest interests …* to add some)';
      return {
        changed: true,
        reply: `✅ You're in. You'll get your personal digest${groupName ? ` for ${groupName}` : ''} ${when}.\nInterests: ${list}\n\nChange them with *!digest interests …*, stop with *!digest stop*.`,
      };
    }
    case 'interests': {
      const interests = parseInterests(cmd.arg);
      if (!interests.length) return { changed: false, reply: 'Send your interests after the command, e.g. *!digest interests agents, n8n, design*' };
      upsertMember(members, { jid: existing?.jid || who.senderJid, name: who.senderName, interests });
      return { changed: true, reply: `👍 Interests updated: ${interests.join(', ')}${existing?.active === false ? '\nYou were opted out; this opts you back in.' : ''}` };
    }
    case 'status': {
      if (existing && !existing.active) return { changed: false, reply: `You've opted out of the personal digest. Send *!digest join your, interests* to get it again.` };
      if (!existing) return { changed: false, reply: `You get the digest ${when}. Add interests to get your picks first: *!digest interests agents, n8n*` };
      return { changed: false, reply: `You're signed up ✅ (${when}).\nInterests: ${existing.interests.length ? existing.interests.join(', ') : 'none'}` };
    }
    case 'stop': {
      if (existing && !existing.active) return { changed: false, reply: `You're already opted out. Send *!digest join* any time to get it again.` };
      const m = existing || upsertMember(members, { jid: who.senderJid, name: who.senderName });
      m.active = false;
      m.updatedAt = new Date().toISOString();
      return { changed: true, reply: `Done, no more personal digests. The post in the group carries on. Send *!digest join* any time to come back.` };
    }
    default:
      return { changed: false, reply: helpText(groupName) };
  }
}
