import { backendHttp } from './backend-http';
import { diagnosticValue } from './diagnostics';
import type { ApiConnectionProbe, HttpDiagnostic } from '../http-diagnostic-types';

// The agent supplies an HTTP request, never a shell command. Credentials are
// injected by the existing broker; all its SSRF, origin and response limits apply.
export async function probeApiConnection(
  request: unknown,
  dependencies?: Parameters<typeof backendHttp>[1],
): Promise<ApiConnectionProbe> {
  const requests: HttpDiagnostic[] = [];
  const checkedAt = new Date().toISOString();
  try {
    const response = await backendHttp(true, dependencies, (item) => requests.push(item))(
      request,
      new AbortController().signal,
    );
    const preview = response.ok ? JSON.stringify(diagnosticValue(response.data)) : undefined;
    return {
      checkedAt,
      ok: response.ok,
      verified: response.ok,
      status: response.status,
      requests,
      ...(!response.ok
        ? {
            error: `API returned HTTP ${response.status}${requests[0]?.providerReason ? ` (${requests[0].providerReason})` : ''}. ${requests[0]?.message || 'Check the provider diagnostics.'}`,
          }
        : {}),
      ...(preview
        ? { responsePreview: preview.slice(0, 6000), previewTruncated: preview.length > 6000 }
        : {}),
    };
  } catch (error) {
    return {
      checkedAt,
      ok: false,
      verified: false,
      requests,
      error: error instanceof Error ? error.message : 'API connection test failed.',
    };
  }
}
