// Which AI pipeline an inbound contact belongs to, based on the WIH number they texted.
// Pure + env-driven so it is unit-testable. Unknown numbers degrade to the seller pipeline.
export type InboundPipeline = 'agent_outreach' | 'seller_inbound';

export function pipelineForNumber(toNumber: string | undefined): InboundPipeline {
  const outreach = process.env.TWILIO_OUTREACH_NUMBER;
  return toNumber && outreach && toNumber === outreach ? 'agent_outreach' : 'seller_inbound';
}

export function contactTypeForPipeline(pipeline: string): 'agent' | 'seller' {
  return pipeline === 'agent_outreach' ? 'agent' : 'seller';
}

export function firstStageName(pipeline: string): string {
  return pipeline === 'agent_outreach' ? 'New Agent Lead' : 'New Lead';
}
