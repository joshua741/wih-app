import { test } from 'node:test';
import assert from 'node:assert';
import { pipelineForNumber, contactTypeForPipeline, firstStageName } from './pipelineRouting';

test('pipelineForNumber: the outreach number maps to agent_outreach', () => {
  process.env.TWILIO_OUTREACH_NUMBER = '+18065551111';
  assert.equal(pipelineForNumber('+18065551111'), 'agent_outreach');
});

test('pipelineForNumber: any other or missing number maps to seller_inbound', () => {
  process.env.TWILIO_OUTREACH_NUMBER = '+18065551111';
  assert.equal(pipelineForNumber('+18065559999'), 'seller_inbound');
  assert.equal(pipelineForNumber(undefined), 'seller_inbound');
});

test('contactTypeForPipeline maps pipeline to contact_type', () => {
  assert.equal(contactTypeForPipeline('agent_outreach'), 'agent');
  assert.equal(contactTypeForPipeline('seller_inbound'), 'seller');
});

test('firstStageName maps pipeline to its first stage', () => {
  assert.equal(firstStageName('agent_outreach'), 'New Agent Lead');
  assert.equal(firstStageName('seller_inbound'), 'New Lead');
});
