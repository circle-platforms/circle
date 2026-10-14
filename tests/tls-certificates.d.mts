export function tlsCertificates(
  folder: string,
  host: string,
  env?: NodeJS.ProcessEnv,
): { ca: string; key: Buffer; cert: Buffer };
