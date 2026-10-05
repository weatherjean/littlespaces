declare global {
  namespace App { interface Locals { owner: {email:string} | null } }
  interface Window {
    applet: {
      notifications: {send(input:{key:string;title:string;body:string;dueAt?:string}):Promise<import('./lib/types').Notification>;list():Promise<import('./lib/types').Notification[]>;cancel(key:string):Promise<{cancelled:boolean}>};
      chat: { open(options: import('./lib/types').ChatLaunch): Promise<{id:string}> }; 
      photos: {
        pick(): Promise<import('./lib/photo-types').PhotoData | null>;
        get(id:string): Promise<import('./lib/photo-types').PhotoData>;
        list(): Promise<import('./lib/photo-types').Photo[]>;
        analyze(photoIds:string[],prompt:string,options?:{format?:'text'|'plant'}): Promise<import('./lib/photo-types').PhotoAnalysis>;
      };
      call<T = any>(action: string, input?: unknown): Promise<T>;
      list<T = unknown>(): Promise<Array<{ key: string; value: T }>>;
      set(key: string, value: unknown): Promise<void>;
      remove(key: string): Promise<void>;
    };
  }
}
export {};
