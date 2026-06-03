import { test } from 'node:test';
import assert from 'node:assert';
import { goalsForPipeline, buildGoalBlock } from './goals';

test('goalsForPipeline: agent_outreach goals + owner', () => {
  const g = goalsForPipeline('agent_outreach');
  assert.match(g.immediateGoal, /deal submitted/i);
  assert.match(g.longTermGoal, /deal flow/i);
  assert.equal(g.owner, 'angel');
});

test('goalsForPipeline: seller_inbound goals + owner', () => {
  const g = goalsForPipeline('seller_inbound');
  assert.match(g.immediateGoal, /qualify/i);
  assert.match(g.longTermGoal, /referrals/i);
  assert.equal(g.owner, 'angel');
});

test('goalsForPipeline: unknown pipeline falls back to seller_inbound', () => {
  assert.deepEqual(goalsForPipeline('whatever'), goalsForPipeline('seller_inbound'));
});

test('buildGoalBlock embeds both goals and the GOAL_MET instruction', () => {
  const block = buildGoalBlock('Book the appointment', 'Stay in touch for referrals');
  assert.match(block, /Book the appointment/);
  assert.match(block, /Stay in touch for referrals/);
  assert.match(block, /\[GOAL_MET\]/);
});
