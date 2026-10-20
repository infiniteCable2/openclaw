/** Publication proof belongs to host ingress, never public transcript append options. */
export function publicTranscriptAppendOptions<T extends object>(
  options: T,
): Omit<T, "conversationPublication"> {
  const { conversationPublication: _publication, ...publicOptions } = {
    conversationPublication: undefined,
    ...options,
  };
  return publicOptions;
}
