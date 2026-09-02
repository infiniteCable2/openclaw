// Shared configuration for host-managed provider sidecar processes.
export type ProviderLocalServiceConfig = {
  /** Executable started before provider requests are sent. */
  command: string;
  /** Arguments passed without shell expansion. */
  args?: string[];
  /** Working directory for the local service process. */
  cwd?: string;
  /** Environment variables added to the service process. */
  env?: Record<string, string>;
  /** Optional health endpoint polled before the provider is considered ready. */
  healthUrl?: string;
  /** Startup readiness timeout in milliseconds. */
  readyTimeoutMs?: number;
  /** Idle timeout in milliseconds before stopping the local service. */
  idleStopMs?: number;
};
