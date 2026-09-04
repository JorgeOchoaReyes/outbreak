export interface ApiSpec {
  type: 'openapi' | 'raw';
  content: string;
}

export interface GenerateOptions {
  name: string;
  docsUrl: string;
  skipPR?: boolean;
}

/** Outcome of one Claude Agent SDK run against a package directory. */
export interface AgentRun {
  /** Package-relative paths the agent left behind, sorted. */
  files: string[];
  numTurns: number;
  costUsd: number;
  durationMs: number;
}
