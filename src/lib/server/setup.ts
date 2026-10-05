import { setupAccess, initializeSetup } from '../../../scripts/setup-access.mjs';
import { origin, secureCookies } from './config';
import { ownerStore } from './owner';
export { setupAccess };
export const setupCookie = secureCookies ? '__Host-little_spaces_setup' : 'little_spaces_setup';
export function initializeOwnerSetup() {
  initializeSetup(ownerStore(), origin);
}
