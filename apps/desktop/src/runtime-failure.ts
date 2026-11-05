export const DATA_IN_USE = 'DESKTOP_DATA_IN_USE';

export class DesktopDataInUseError extends Error {
  readonly code = DATA_IN_USE;

  constructor(options?: ErrorOptions) {
    super(
      'Circle data folder already has an active writer; close the other application before retrying',
      options,
    );
    this.name = 'DesktopDataInUseError';
  }
}

export function isDesktopDataInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    [DATA_IN_USE, 'CIRCLE_DATABASE_BUSY'].includes(
      String((error as Error & { code?: unknown }).code),
    )
  );
}

export function runtimeFailure(
  value: unknown,
): DesktopDataInUseError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.type === 'runtime-failure' && message.code === DATA_IN_USE)
    return new DesktopDataInUseError();
}
