/** Carry only the identity returned by the server's command claim into receipts. */
export function commandReceiptIdentity(command: { stepId?: string; artifactRef?: string }) {
  return {
    ...(command.stepId ? { stepId: command.stepId } : {}),
    ...(command.artifactRef ? { artifactRef: command.artifactRef } : {}),
  };
}

/** A persisted artifact must have its own server projection; cache belongs to legacy show. */
export function commandPresentation<T>(
  projection: T | undefined,
  artifactRef: string | undefined,
  fallback: T | null | undefined,
): T | null | undefined {
  if (artifactRef && !projection)
    throw Object.assign(new Error('UNAVAILABLE'), { code: 'UNAVAILABLE' });
  return projection ?? fallback;
}
