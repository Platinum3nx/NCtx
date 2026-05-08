export type Trigger = "session-end" | "precompact" | "manual";

export type MemoryType = "scratchpad" | "episodic" | "fact" | "procedural";

export type HookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name?: "SessionEnd" | "PreCompact" | string;
  reason?: string;
  trigger?: string;
  custom_instructions?: string;
};

export type NctxMode = "direct";

export type NctxConfig = {
  mode: "direct";
  nia_api_key: string;
  nia_base_url: string;
  project_name: string;
  version: string;
};

export type HostedNctxConfig = {
  mode: "hosted";
  install_token: string;
  proxy_url: string;
  project_name: string;
  version: string;
};

export type DirectNctxConfig = NctxConfig;

export type ToolAction = {
  tool: string;
  file_path?: string;
  operation?: "read" | "edit" | "command" | "tool";
};

export type ExtractionResult = {
  summary: string;
  tags: string[];
  files_touched: string[];
  decisions: Array<{
    title: string;
    rationale: string;
    files?: string[];
  }>;
  gotchas: Array<{
    problem: string;
    cause: string;
    fix: string;
    files?: string[];
  }>;
  patterns: Array<{
    pattern: string;
    rationale: string;
    files?: string[];
  }>;
  state: {
    in_progress?: string | null;
    next_steps?: string[];
    files?: string[];
  };
};

export type ContextDraft = {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  agent_source?: string;
  memory_type: Exclude<MemoryType, "scratchpad">;
  metadata: Record<string, unknown>;
  edited_files?: Array<{
    file_path: string;
    operation: string;
    changes_description: string;
  }>;
};

export type SavedContext = {
  id: string;
  title?: string;
  summary?: string;
  content?: string;
  tags?: string[];
  agent_source?: string;
  memory_type?: MemoryType;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  edited_files?: Array<Record<string, unknown>>;
  relevance_score?: number;
  score?: number;
  match_highlights?: string[];
  highlights?: string[];
  match_metadata?: Record<string, unknown>;
};

export type NormalizedSearchResult = {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  agent_source?: string;
  memory_type?: MemoryType;
  created_at?: string;
  metadata: Record<string, unknown>;
  edited_files: Array<Record<string, unknown>>;
  score: number | null;
  highlights: string[];
  match_metadata: Record<string, unknown>;
};
