// Default conversation goals per pipeline, plus the prompt goal-block builder.
// Pure + unit-testable. See docs/superpowers/specs/2026-06-03-goal-engine-design.md.
export type GoalOwner = 'josh' | 'angel';

export interface PipelineGoals {
  immediateGoal: string;
  longTermGoal: string;
  owner: GoalOwner;
}

const GOALS: Record<string, PipelineGoals> = {
  agent_outreach: {
    immediateGoal: 'Build rapport and get an off-market or pre-foreclosure deal submitted.',
    longTermGoal: 'Stay top-of-mind for perpetual deal flow; when a deal closes or dies, re-engage for the next one.',
    owner: 'angel',
  },
  seller_inbound: {
    immediateGoal: 'Qualify the situation (property, condition, timeline, price/mortgage) and move toward an offer or a booked appointment.',
    longTermGoal: 'After they sell, follow up for referrals and any other properties they know about.',
    owner: 'angel',
  },
};

export function goalsForPipeline(pipeline: string): PipelineGoals {
  return GOALS[pipeline] ?? GOALS.seller_inbound;
}

export function buildGoalBlock(immediateGoal: string, longTermGoal: string): string {
  return [
    `YOUR GOAL FOR THIS CONVERSATION: ${immediateGoal}`,
    `WHY YOU'RE IN TOUCH (long-term): ${longTermGoal}`,
    `Lead the conversation toward the goal naturally (NEPQ-style) — don't read a script. Keep the big picture in mind.`,
    `When you have ACHIEVED the goal (e.g. appointment booked, deal agreed), include [GOAL_MET] on the tag line at the end.`,
  ].join('\n');
}
