import { desktopText } from './locale.js';
import {
  normalizeBaseUrl,
  probeSummary,
  resolveEndpoint,
  type ProbeResult,
} from './probe.js';
import {
  inferredPresetProvider,
  PROVIDER_PRESETS,
  providerPreset,
} from './providers.js';
import type { ModelAuth } from './settings.js';
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

/** Runtime model lists use the connection's selected source, never a failure fallback. */
export async function availableModels(
  auth: ModelAuth,
  apiKey: string,
  probe: typeof resolveEndpoint = resolveEndpoint,
): Promise<ConnectionModels> {
  const selected = auth.provider
    ? PROVIDER_PRESETS.find((item) => item.id === auth.provider)
    : inferredPresetProvider(auth.base_url, auth.protocol);
  if (
    selected?.source === 'preset' &&
    (selected.protocol ?? 'openai') === auth.protocol
  )
    return connectionModels(auth.base_url, apiKey, selected.id, probe);
  const base = normalizeBaseUrl(auth.base_url, auth.protocol);
  if (!apiKey) throw new Error(desktopText('missing API key'));
  return probe(base, apiKey, { protocol: auth.protocol });
}

export function connectionSummary(found: ConnectionModels): string {
  if (found.status === 'preset')
    return 'provider presets; model and key are unverified';
  return probeSummary({ ...found, status: found.status });
}
