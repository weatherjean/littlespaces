export type BuildPlan = {
  id: string;
  chatId: string;
  spaceId: string;
  appletId?: string;
  version: number;
  title: string;
  emoji: string;
  summary: string;
  features: string[];
  caveats: string[];
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  publishedId?: string;
};

export function buildPlanText(plan: BuildPlan) {
  return [
    `Approved ${plan.appletId ? 'update' : 'build'}: ${plan.emoji} ${plan.title}`,
    plan.summary,
    ...(plan.features?.length ? ['Features:', ...plan.features.map((item) => `- ${item}`)] : []),
    ...(plan.caveats?.length ? ['Caveats:', ...plan.caveats.map((item) => `- ${item}`)] : []),
  ].join('\n');
}
