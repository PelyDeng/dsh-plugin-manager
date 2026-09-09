import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFormatCatalog as catalog } from '@deepseek-ai/dsh-session-format-catalog';
import { releasedV2SessionFormatCodec as v2, releasedV3SessionFormatCodec as v3 } from '@deepseek-ai/dsh-session-format-v2-to-v3';
import { restoreSessionSnapshot, mergeLegacyFeedback } from '../src/session-snapshot.mjs';

const formats = { catalog, v2, v3 };
const header = { version: 2, id: 'fixture', createdAt: 1000, cwd: '/work', isSeeded: false, delegationDepth: 0 };
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'answer', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'answer' }] } } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
].map((e, seq) => ({ ...e, seq, time: 1100 + seq }));
const item = { messageId: 'answer', rating: 'positive', note: 'keep', version: '7ac3360b-068c-4f00-aa2b-26699c3a55cd', createdAt: 1200, updatedAt: 1300 };
const row = { session: { createdAt: 1000, cwd: '/work' }, items: [item] };
const snapshot = () => restoreSessionSnapshot({ header, events, inheritedEventCount: 0 }, formats);

test('official migration adds system head and remaps the inherited boundary', () => {
  const seeded = { header: { ...header, isSeeded: true, parentSession: 'parent' }, inheritedEventCount: events.length,
    events: [...events, { type: 'session/end-seed', seq: events.length, time: 1150, data: { inherited: true } }] };
  const migrated = restoreSessionSnapshot(seeded, formats);
  assert.equal(migrated.header.version, 3);
  assert.equal(migrated.events[2].type, 'system/message');
  assert.equal(migrated.inheritedEventCount, events.length + 1);
  assert.throws(() => restoreSessionSnapshot({ ...seeded, inheritedEventCount: 1 }, formats));
});

test('legacy feedback keeps versions and timestamps, while current put/delete wins on retry', () => {
  const source = snapshot(), migrated = mergeLegacyFeedback(source, row, formats);
  assert.deepEqual(migrated.events.at(-1).data.item, item);
  assert.equal(source.events.length + 1, migrated.events.length);
  assert.deepEqual(mergeLegacyFeedback(migrated, row, formats), migrated);
  const deleted = { ...migrated, events: [...migrated.events, { type: 'feedback/message-delete', seq: migrated.events.length, time: 1400, data: { sessionId: header.id, messageId: item.messageId } }] };
  assert.deepEqual(mergeLegacyFeedback(deleted, row, formats), deleted);
  assert.throws(() => mergeLegacyFeedback(source, { ...row, session: { ...row.session, createdAt: 999 } }, formats));
  assert.throws(() => mergeLegacyFeedback(source, { ...row, items: [{ ...item, messageId: 'absent' }] }, formats));
  assert.throws(() => mergeLegacyFeedback(source, { ...row, items: [{ ...item, version: 'invalid' }] }, formats));
});
