export type HttpDiagnostic = {
  origin: string;
  path: string;
  method: string;
  status?: number;
  code?: string;
  providerReason?: string;
  message?: string;
  secrets: { name: string; warnings: string[] }[];
};
export type ConnectionProbe = {
  action: string;
  checkedAt: string;
  ok: boolean;
  verified: boolean;
  requests: HttpDiagnostic[];
  result?: unknown;
  error?: string;
  note?: string;
};
export type ApiConnectionProbe = {
  checkedAt: string;
  ok: boolean;
  verified: boolean;
  status?: number;
  requests: HttpDiagnostic[];
  responsePreview?: string;
  previewTruncated?: boolean;
  error?: string;
};
