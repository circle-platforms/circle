import { desktopText } from './locale.js';
import {
  normalizeBaseUrl,
  probeSummary,
  resolveEndpoint,
  type ProbeResult,
} from './probe.js';
import { providerPreset } from './providers.js';
export type ConnectionModels = Omit<ProbeResult, 'status'> & {
  status: ProbeResult['status'] | 'preset';
};
/** Explicit provider selection chooses the source before any request, never on failure. */
export async function connectionModels(
  baseUrl: string,
  apiKey: string,
  providerId = 'custom',
  probe: typeof resolveEndpoint = resolveEndpoint,
): Promise<ConnectionModels> {
  const provider = providerPreset(providerId);
  const base = normalizeBaseUrl(baseUrl, provider.protocol ?? 'openai');
  if (!apiKey) throw new Error(desktopText('missing API key'));
  if (provider.source === 'endpoint')
    return probe(base, apiKey, { protocol: provider.protocol });
  return {
    protocol: provider.protocol!,
    models: [...provider.models],
    inferred: false,
    base_url: base,
    status: 'preset',
    detail: '',
  };
}
export function connectionSummary(found: ConnectionModels): string {
  if (found.status === 'preset')
    return 'provider presets; model and key are unverified';
  return probeSummary({ ...found, status: found.status });
}
