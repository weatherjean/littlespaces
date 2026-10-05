import { OwnerStore } from '../../../scripts/owner-store.mjs';
import { dataDir } from './config';
let instance: OwnerStore | undefined;
export const ownerStore = () => instance ||= new OwnerStore(dataDir);
