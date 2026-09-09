/** Offline Session snapshots use official codecs; callers own storage paths and write exclusion. */
import assert from 'node:assert/strict';

export function restoreSessionSnapshot(session, { catalog, v2, v3 }) {
  assert.ok(session && [2, 3].includes(session.header?.version), 'Unsupported Session snapshot format.');
  assert.ok(Array.isArray(session.events), 'Snapshot events must be an array.');
  const codec = session.header.version === 2 ? v2 : v3;
  const header = codec.encodeHeader(session.header, session.inheritedEventCount);
  const source = codec.createDecoder(header, 'strict');
  const discard = { emitEvent() {}, emitRun() {} };
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' });
  for (const event of session.events) {
    const row = codec.encodeEvent(event);
    source.decodeRow(row, discard);
    restore.decodeRow(row);
  }
  assert.equal(source.finish(discard), session.inheritedEventCount, 'Snapshot inherited boundary differs.');
  return restore.finish();
}

/** Preserve exact legacy versions/times. Any current put/delete takes precedence over its sidecar. */
export function mergeLegacyFeedback(session, row, formats) {
  if (row == null) return session;
  assert.deepEqual(Object.keys(row).sort(), ['items', 'session'], 'Invalid legacy feedback row.');
  assert.deepEqual(row.session, { createdAt: session.header.createdAt, cwd: session.header.cwd }, 'Feedback lifecycle differs.');
  assert.ok(Array.isArray(row.items), 'Invalid legacy feedback items.');
  const events = [...session.events], seen = new Set();
  const current = new Set(events.filter(e => ['feedback/message-put', 'feedback/message-delete'].includes(e.type) && e.data.sessionId === session.header.id)
    .map(e => e.type === 'feedback/message-put' ? e.data.item.messageId : e.data.messageId));
  const messages = new Set(events.filter(e => e.type === 'assistant/message').map(e => e.data.message.id));
  for (const item of row.items) {
    assert.ok(item && Object.keys(item).every(k => ['messageId', 'rating', 'note', 'version', 'createdAt', 'updatedAt'].includes(k)), 'Invalid legacy feedback item.');
    assert.ok(typeof item.version === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.version), 'Invalid legacy feedback version.');
    assert.ok(['positive', 'negative'].includes(item.rating) && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0 && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= item.createdAt, 'Invalid legacy feedback value.');
    assert.ok(item.note === undefined || typeof item.note === 'string' && item.note.trim().length > 0, 'Invalid legacy feedback note.');
    assert.ok(!seen.has(item.messageId) && messages.has(item.messageId), 'Duplicate or missing feedback message.');
    seen.add(item.messageId);
    // Validate skipped legacy entries too, so corrupt input cannot be silently accepted.
    const event = { type: 'feedback/message-put', seq: events.length, time: item.updatedAt, data: { sessionId: session.header.id, item } };
    restoreSessionSnapshot({ ...session, events: [...events, event] }, formats);
    if (!current.has(item.messageId)) events.push(event);
  }
  return restoreSessionSnapshot({ ...session, events }, formats);
}
