/** Main-to-worker capability messages. Never accepted as public runtime commands. */
export interface PrivateExternalFileRequest {
  type: 'external-file-capability';
  id: string;
  operation: 'grant' | 'revoke';
  sessionId: string;
  path?: string;
  access?: 'read' | 'readwrite';
  grantId?: string;
}
export function validatePrivateExternalFileRequest(
  value: unknown,
): PrivateExternalFileRequest {
  const request = value as PrivateExternalFileRequest & {
    name?: unknown;
    payload?: unknown;
  };
  if (
    !request ||
    request.type !== 'external-file-capability' ||
    typeof request.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.id) ||
    typeof request.sessionId !== 'string' ||
    request.sessionId.length < 1 ||
    request.sessionId.length > 200 ||
    request.name !== undefined ||
    request.payload !== undefined ||
    !['grant', 'revoke'].includes(request.operation) ||
    (request.operation === 'grant' &&
      (typeof request.path !== 'string' ||
        !request.path ||
        request.path.length > 8000 ||
        !['read', 'readwrite'].includes(String(request.access)))) ||
    (request.operation === 'revoke' &&
      (typeof request.grantId !== 'string' ||
        !request.grantId ||
        request.grantId.length > 200))
  )
    throw Error('invalid private external file capability request');
  return request;
}
