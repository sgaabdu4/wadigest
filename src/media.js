// Photos, videos and voice notes stay out of a group's summary unless its tick is on.
// A left-out photo or video still counts as a text message when it has a caption.

const TICK = { image: 'photos', video: 'videos', audio: 'voice', ptt: 'voice' };

export const mediaTick = (m) => TICK[String(m.MediaType || '').toLowerCase()];

/** Message types to turn into text for this group: videos and/or voice notes. */
export function transcribeKinds(group) {
  return [...(group?.videos === true ? ['video'] : []), ...(group?.voice === true ? ['audio', 'ptt'] : [])];
}

/** @param {Record<string, string>} transcripts message id -> transcript */
export function filterMedia(messages, group, transcripts = {}) {
  return messages.flatMap((m) => {
    const tick = mediaTick(m);
    if (!tick) return [m];
    if (group?.[tick] === true) {
      if (tick !== 'voice') return [m];
      return transcripts[m.MsgID] ? [{ ...m, MediaType: 'voice note', Text: transcripts[m.MsgID] }] : [];
    }
    const text = String(m.MediaCaption || m.Text || '').trim();
    return text ? [{ ...m, MediaType: '', Text: text, MediaCaption: '' }] : [];
  });
}
