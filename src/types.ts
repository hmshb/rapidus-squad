// Shape of one line from `claude --output-format stream-json --verbose`.
// We model only the fields the bot actually reads. The name reflects that
// these come from the Claude Code CLI's stream-json output (we don't use the
// @anthropic-ai/claude-code SDK).
export type ClaudeStreamMessage =
  | SystemInitMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | StreamEventMessage;

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

// Emitted when `--include-partial-messages` is on. Wraps the raw Anthropic
// streaming events so we can render text deltas as they arrive instead of
// waiting for the full assistant message.
export interface StreamEventMessage {
  type: 'stream_event';
  event: {
    type: string;        // 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_start' | ...
    index?: number;
    delta?: {
      type?: string;     // 'text_delta' | 'input_json_delta' | ...
      text?: string;
      [k: string]: unknown;
    };
    content_block?: {
      type?: string;     // 'text' | 'tool_use' | ...
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  session_id?: string;
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
