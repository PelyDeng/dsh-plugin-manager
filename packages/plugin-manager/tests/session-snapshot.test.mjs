import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog';
import { releasedV2SessionFormatCodec as v2, releasedV3SessionFormatCodec as v3 } from '@deepseek-ai/dsh-session-format-v2-to-v3';
import { releasedV4SessionFormatCodec as v4 } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { restoreSessionSnapshot, mergeLegacyFeedback } from '../src/session-snapshot.mjs';

// catalog 是现行格式的唯一事实源（0.1.7 起写 V4）：旧格式快照恢复后产出一律前进到
// catalog 的当前版本，因此 formats 必须携带全量历史 codec。离线快照没有子会话
// artifact 可供 V3→V4 收集证据，用空数组显式声明无子。
const catalog = createSessionFormatCatalogWithChildren([]);
const formats = { catalog, v2, v3, v4 };
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

test('official migration walks V2 snapshots to the current format across the full chain', () => {
  const seeded = { header: { ...header, isSeeded: true, parentSession: 'parent' }, inheritedEventCount: events.length,
    events: [...events, { type: 'session/end-seed', seq: events.length, time: 1150, data: { inherited: true } }] };
  const migrated = restoreSessionSnapshot(seeded, formats);
  assert.equal(migrated.header.version, catalog.currentVersion, 'restored header must be the catalog current version');
  assert.ok(migrated.events.some(event => event.type === 'system/message'), 'V2→V3 migration inserts the system head');
  assert.throws(() => restoreSessionSnapshot({ ...seeded, inheritedEventCount: 1 }, formats));
});

test('legacy feedback keeps versions and timestamps, while current put/delete wins on retry', () => {
  const source = snapshot(), migrated = mergeLegacyFeedback(source, row, formats);
  assert.equal(migrated.header.version, catalog.currentVersion);
  assert.deepEqual(migrated.events.at(-1).data.item, item);
  assert.equal(source.events.length + 1, migrated.events.length);
  // 幂等：迁移结果（已是现行格式）再次合并同一 legacy 行不得产生新事件。
  assert.deepEqual(mergeLegacyFeedback(migrated, row, formats), migrated);
  const deleted = { ...migrated, events: [...migrated.events, { type: 'feedback/message-delete', seq: migrated.events.length, time: 1400, data: { sessionId: header.id, messageId: item.messageId } }] };
  assert.deepEqual(mergeLegacyFeedback(deleted, row, formats), deleted);
  assert.throws(() => mergeLegacyFeedback(source, { ...row, session: { ...row.session, createdAt: 999 } }, formats));
  assert.throws(() => mergeLegacyFeedback(source, { ...row, items: [{ ...item, messageId: 'absent' }] }, formats));
  assert.throws(() => mergeLegacyFeedback(source, { ...row, items: [{ ...item, version: 'invalid' }] }, formats));
});
