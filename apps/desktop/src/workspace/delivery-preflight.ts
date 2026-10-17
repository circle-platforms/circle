const messages = {
  GITHUB_CANDIDATE_REFRESH_REQUIRED:
    'GitHub candidate changed or the revision is not the inspected opaque revision; read github_candidate and review its current head, revision and paths before publishing; nothing was pushed',
  DELIVERY_WORKSPACE_DIRTY:
    'commit remaining workspace changes or move them to another branch, then refresh before publishing; nothing was pushed',
  DELIVERY_CANDIDATE_CHANGED:
    'repository changed; refresh and review the current changes before publishing; nothing was pushed',
  DELIVERY_FEATURE_BRANCH_REQUIRED:
    'switch to a feature branch before publishing; nothing was pushed',
} as const;
export type DeliveryPreflightCode = keyof typeof messages;
/** Only the initial, side-effect-free delivery checks may construct this error. */
export class DeliveryPreflightError extends Error {
  constructor(readonly code: DeliveryPreflightCode) {
    super(messages[code]);
    this.name = 'DeliveryPreflightError';
  }
  static fromCode(code: unknown): DeliveryPreflightError | undefined {
    return typeof code === 'string' && Object.hasOwn(messages, code)
      ? new DeliveryPreflightError(code as DeliveryPreflightCode)
      : undefined;
  }
}

/** A publication was sent; only its read-only confirmation is pending. Never replay the write. */
export class DeliveryConfirmationPendingError extends Error {
  readonly code = 'DELIVERY_CONFIRMATION_PENDING';
  constructor() {
    super(
      'publication was sent, but GitHub has not confirmed the reviewed commit; refresh PR checks before retrying and do not repeat the push',
    );
    this.name = 'DeliveryConfirmationPendingError';
  }
}
