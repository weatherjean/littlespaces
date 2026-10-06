import { account } from './auth';
import { localOAuth } from './config';
import { codexAccount } from './codex';
export const usesCodex = !localOAuth;
export async function connectedAccount() {
  return usesCodex ? codexAccount() : account();
}
