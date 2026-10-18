/** DeepSeek exposes thinking as a switch; high is the enabled runtime setting. */
export type AgentThinkingLevel = 'off' | 'high';

type ThinkingOptions = { thinkingLevel?: AgentThinkingLevel; runtimeTimeoutMs?: number };

export function thinkingPolicy(options: ThinkingOptions, legacyMaxTokens: number) {
  const thinkingLevel = options.thinkingLevel ?? 'high';
  return {
    thinkingLevel,
    maxTokens: thinkingLevel === 'off' ? legacyMaxTokens : legacyMaxTokens === 500 ? 8192 : 16384,
    // The task controller owns the total deadline across all model and tool calls.
    timeoutMs: Math.min(
      thinkingLevel === 'off' ? 60_000 : 120_000,
      options.runtimeTimeoutMs ?? 180_000,
    ),
  };
}
