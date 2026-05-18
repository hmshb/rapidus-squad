// Shape of one line from `claude --output-format stream-json --verbose`.
// We model only the fields the bot actually reads.
export type SDKMessage =
  | SystemInitMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage;

export interface SystemInitMessage {
  type: 'system';
  subtype: 'init' | string;
  session_id: string;
  model?: string;
  tools?: string[];
  [k: string]: unknown;
}

export interface AssistantMessage {
  type: 'assistant';
  message: {
    // Content blocks are union-typed by Anthropic but we treat them as
    // loose records — handlers cast as needed. Matches mpociot's usage.
    content?: any[];
    [k: string]: unknown;
  };
  session_id?: string;
}

export interface UserMessage {
  type: 'user';
  message: { content?: unknown; [k: string]: unknown };
  session_id?: string;
}

export interface ResultMessage {
  type: 'result';
  subtype: 'success' | 'error' | string;
  result?: string;
  session_id?: string;
  [k: string]: unknown;
}

export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}