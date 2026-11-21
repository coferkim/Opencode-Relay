export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | "function";
  content: string | unknown[] | null;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ChatTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  };
  name?: string;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: ChatTool[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
