import type { RuntimeReply } from './runtime-protocol';

export function unwrapBotTransferReply(result: RuntimeReply): unknown {
  if (!result.ok) {
    throw Object.assign(Error(result.error ?? 'file transfer failed'), {
      ...(result.errorStatus !== undefined
        ? { status: result.errorStatus }
        : {}),
      ...(result.errorCode !== undefined ? { code: result.errorCode } : {}),
      ...(result.errorDetail !== undefined
        ? { detail: result.errorDetail }
        : {}),
      ...(result.errorScope !== undefined ? { scope: result.errorScope } : {}),
      ...(result.errorUploaded !== undefined
        ? { uploaded: result.errorUploaded }
        : {}),
      ...(result.errorTotal !== undefined ? { total: result.errorTotal } : {}),
      ...(result.errorFileName !== undefined
        ? { fileName: result.errorFileName }
        : {}),
      ...(result.errorReason !== undefined
        ? { reason: result.errorReason }
        : {}),
    });
  }
  return result.data;
}

export async function runBotTransferEnvelope(run: () => Promise<unknown>) {
  try {
    return { ok: true as const, data: await run() };
  } catch (error) {
    const meta =
      error && typeof error === 'object'
        ? (error as {
            status?: unknown;
            code?: unknown;
            detail?: unknown;
            remoteMessage?: unknown;
            scope?: unknown;
            uploaded?: unknown;
            total?: unknown;
            fileName?: unknown;
            reason?: unknown;
          })
        : undefined;
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      ...(typeof meta?.status === 'number' ? { errorStatus: meta.status } : {}),
      ...(typeof meta?.code === 'string' ? { errorCode: meta.code } : {}),
      ...(typeof meta?.detail === 'string'
        ? { errorDetail: meta.detail }
        : typeof meta?.remoteMessage === 'string'
          ? { errorDetail: meta.remoteMessage }
          : {}),
      ...(typeof meta?.scope === 'string' && meta.scope
        ? { errorScope: meta.scope }
        : {}),
      ...(typeof meta?.uploaded === 'number'
        ? { errorUploaded: meta.uploaded }
        : {}),
      ...(typeof meta?.total === 'number' ? { errorTotal: meta.total } : {}),
      ...(typeof meta?.fileName === 'string'
        ? { errorFileName: meta.fileName }
        : {}),
      ...(typeof meta?.reason === 'string' ? { errorReason: meta.reason } : {}),
    };
  }
}
