import { account } from './auth';
import { localOAuth } from './config';
import { codexAccount } from './codex';
export const usesCodex = process.env.APP_INFERENCE_PROVIDER === 'codex' || !localOAuth;
export async function connectedAccount() {
  return usesCodex ? codexAccount() : account();
}
