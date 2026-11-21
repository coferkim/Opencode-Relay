export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly code: string = "upstream_error",
    readonly errorType: string = "api_error",
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export function errorBody(message: string, code: string, errorType = "api_error") {
  return { error: { message, type: errorType, param: null, code } };
}

/**
 * Anthropic's error envelope is different from OpenAI's:
 *   { "type": "error", "error": { "type": "<anthropic_type>", "message": "…" } }
 * Relay codes map onto the Anthropic error taxonomy clients branch on.
 */
const ANTHROPIC_ERROR_TYPES: Record<string, string> = {
  invalid_api_key: "authentication_error",
  session_expired: "authentication_error",
  invalid_request: "invalid_request_error",
  upstream_key_not_allowed: "invalid_request_error",
  not_found: "not_found_error",
  model_not_found: "not_found_error",
  cross_origin_request: "permission_error",
  rate_limit_error: "rate_limit_error",
  overloaded: "overloaded_error",
};

export function anthropicErrorType(code: string, status: number): string {
  if (ANTHROPIC_ERROR_TYPES[code]) return ANTHROPIC_ERROR_TYPES[code];
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529 || status === 503) return "overloaded_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

export function anthropicErrorBody(message: string, code: string, status: number) {
  return { type: "error", error: { type: anthropicErrorType(code, status), message } };
}
