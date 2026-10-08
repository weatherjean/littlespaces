/** Applet SDK v1. Reference declarations for JavaScript/JSDoc authoring.
 * Applet source remains plain JavaScript; TypeScript syntax is not executed.
 */
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
type JSONSchema = boolean | { [key: string]: JSONValue };
type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface HttpPermission {
  origin: string;
  methods: HttpMethod[];
  secrets: string[];
}
type HeaderValue = string | { secret: string; prefix?: string };
interface HttpRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, HeaderValue>;
  query?: Record<string, HeaderValue>;
  body?: JSONValue;
}
interface HttpResponse {
  status: number;
  ok: boolean;
  data: JSONValue;
}
interface BackendContext {
  db: {
    get(key: string): JSONValue;
    list(): { key: string; value: JSONValue }[];
    set(key: string, value: JSONValue): void;
    remove(key: string): boolean;
  };
  uuid(): string;
  now(): string;
  http: { request(input: HttpRequest): Promise<HttpResponse> };
}
interface Action<Input = JSONValue, Output = JSONValue> {
  description: string;
  readOnly: boolean;
  parameters: JSONSchema;
  output?: JSONSchema;
  /** Both this declaration and owner-managed per-app grants must permit each request. */
  http?: HttpPermission[];
  run(input: Input, context: BackendContext): Output | Promise<Output>;
}
interface HttpMock {
  url: string;
  method?: HttpMethod;
  response: HttpResponse;
}
interface AppletSDK {
  call<T extends JSONValue = JSONValue>(action: string, input?: JSONValue): Promise<T>;
  onDataChanged(listener: () => void | Promise<void>): () => void;
  debug: {
    report(message: string, context?: JSONValue): Promise<void>;
    snapshot(): Promise<void>;
  };
}
