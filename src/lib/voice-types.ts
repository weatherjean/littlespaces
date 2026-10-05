export type VoiceAction = {
  id: string;
  chatId: string;
  spaceId: string;
  appletId: string;
  appName: string;
  version: number;
  action: string;
  input: Record<string, unknown>;
  summary: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  createdAt: string;
  result?: unknown;
  error?: string;
};
