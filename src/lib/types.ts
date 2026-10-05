export type Applet = {
  id: string;
  title: string;
  description: string;
  version: number;
  updatedAt: string;
};
export type Space = {
  id: string;
  name: string;
  icon: string;
  updatedAt: string;
  appletCount: number;
};
export type ChatLaunch = {
  task: string;
  title?: string;
  welcome?: string;
  context?: unknown;
  recordKeys?: string[];
  photoIds?: string[];
};
export type Chat = {
  id: string;
  spaceId: string;
  title: string;
  updatedAt: string;
  launch?: ChatLaunch;
};
export type Revision = {
  version: number;
  title: string;
  description: string;
  source: string;
  bundle: string;
  backend?: string;
  backendBundle?: string;
  testReport?: string;
  chatInstructions?: string;
};
export type Message = {
  role: 'user' | 'assistant';
  content: string;
  photos?: string[];
  toolCalls?: ToolCall[];
};
export type Model = { slug: string; display_name: string; efforts?: string[] };
export type Account = { name: string; email: string; canUsePlan: boolean };
export type RecordEntry = { key: string; value: unknown };
export type Generation = {
  message: string;
  applet?: {
    title: string;
    description: string;
    source: string;
    backend?: string;
    chatInstructions?: string;
  };
};
export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  status: 'running' | 'complete' | 'error';
  startedAt: string;
  durationMs?: number;
  prompt?: string;
};
export type Notification = {
  id: string;
  spaceId: string;
  key: string;
  title: string;
  body: string;
  dueAt: string;
  read: boolean;
  href: string;
  source: string;
};
