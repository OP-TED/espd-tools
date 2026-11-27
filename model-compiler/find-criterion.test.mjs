// findCriterion: a code that several criteria share must not silently resolve to the first one.
// Uses a small synthetic espd-edm.json, so it needs no inputs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { findCriterion, readStructuralCore } from './read-structural-core.mjs';

const criterion = (code, tag, extra = {}) => ({ type: 'CRITERION', code, tag, uuid: `uuid-${tag}`, cardinality: '1..1', components: [], ...extra });
const edm = [
  { part: 'partII', sections: [{ section: 'A', criteria: [criterion('unique', 'C01'), criterion('OT', 'OT65'), criterion('OT', 'OT57')] }] },
  { part: 'partV', sections: [{ section: 'A', criteria: [criterion('OT', 'OT63'), { type: 'INFORMATION', code: 'unique', tag: 'I01' }] }] },
];

test('a unique code is found, with or without a tag, and information blocks are ignored', () => {
  assert.equal(findCriterion(edm, 'unique').tag, 'C01');
  assert.equal(findCriterion(edm, 'unique', 'C01').tag, 'C01');
});

test('a code shared by several criteria needs a tag, and the tag picks the criterion', () => {
  assert.equal(findCriterion(edm, 'OT', 'OT57').tag, 'OT57');
  assert.equal(findCriterion(edm, 'OT', 'OT63').uuid, 'uuid-OT63', 'a tag also finds one in another part');
});

test('a shared code without a tag is an error that names the candidates', () => {
  assert.throws(() => findCriterion(edm, 'OT'), (err) => {
    assert.match(err.message, /matches 3 criteria/);
    for (const tag of ['OT65', 'OT57', 'OT63']) assert.ok(err.message.includes(tag), `lists ${tag}`);
    assert.match(err.message, /give the tag/);
    return true;
  });
  assert.throws(() => readStructuralCore(edm, 'OT'), /matches 3 criteria/, 'the reader fails the same way');
});

test('a tag that is not unique is still ambiguous', () => {
  const twice = [{ part: 'partII', sections: [{ section: 'A', criteria: [criterion('x', 'T1'), criterion('x', 'T1')] }] }];
  assert.throws(() => findCriterion(twice, 'x', 'T1'), /matches 2 criteria/);
});

test('nothing found is undefined; the reader reports it as a missing criterion', () => {
  assert.equal(findCriterion(edm, 'nope'), undefined);
  assert.equal(findCriterion(edm, 'OT', 'OT99'), undefined);
  assert.throws(() => readStructuralCore(edm, 'nope'), /Criterion not found in espd-edm\.json: nope/);
});
