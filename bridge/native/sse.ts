export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * SSE parser for OpenAI-compatible streams.
 * It accepts LF, CRLF and split chunks, and ignores comments.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let lastId: string | undefined;
  let retry: number | undefined;

  const dispatch = (): SSEEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = "";
      return undefined;
    }
    const event: SSEEvent = {
      event: eventName || "message",
      data: dataLines.join("\n"),
      ...(lastId !== undefined ? { id: lastId } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
    eventName = "";
    dataLines = [];
    return event;
  };

  const processLine = (line: string): SSEEvent | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) lastId = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
        break;
      }
    }
    return undefined;
  };

  try {
    let final = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        final = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      while (true) {
        let lineEnd = -1;
        let consume = 1;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] === "\n") {
            lineEnd = i;
            break;
          }
          if (buffer[i] === "\r") {
            if (i === buffer.length - 1 && !final) break;
            lineEnd = i;
            consume = buffer[i + 1] === "\n" ? 2 : 1;
            break;
          }
        }
        if (lineEnd < 0) break;

        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + consume);
        const event = processLine(line);
        if (event) yield event;
      }

      if (final) break;
    }

    if (buffer.length > 0) {
      const event = processLine(buffer);
      if (event) yield event;
    }
    const trailing = dispatch();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
