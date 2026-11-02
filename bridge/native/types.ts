export interface ModelCost {
  input?: { price?: number; cache?: { read?: number; write?: number } };
  output?: { price?: number };
  [key: string]: unknown;
}

export interface Model {
  id: string;
  object?: string;
  owned_by?: string;
  name?: string;
  type?: string;
  api?: Record<string, { base_url?: string; [key: string]: unknown }>;
  cost?: { text?: ModelCost; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ModelList {
  object: string;
  data: Model[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[];
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

export interface ChatCompletionDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index?: number;
  message?: ChatCompletionMessage;
  delta?: ChatCompletionDelta;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: Usage;
  [key: string]: unknown;
}

export type ChatCompletionChunk = ChatCompletionResponse;
