/**
 * Thin wrapper around the CodeWhisperer Streaming HTTP API.
 *
 * The official extension uses a generated SDK client (@amzn/codewhispererstreaming)
 * that isn't published to npm. This file reimplements the one command we need
 * (GenerateAssistantResponse) using raw fetch + NDJSON streaming, which removes
 * the dependency on the private package while keeping the same interface.
 *
 * Endpoint docs:
 *   https://docs.aws.amazon.com/codewhisperer/latest/APIReference/API_streaming_GenerateAssistantResponse.html
 */

export interface QClientConfig {
  /** Builder ID access token obtained via SSO OIDC */
  accessToken: string;
  region?: string;
}

export interface AssistantResponseEvent {
  content: string;
}

export interface ToolUseEvent {
  toolUseId: string;
  name: string;
  input?: string;
}

export interface StreamEvent {
  assistantResponseEvent?: AssistantResponseEvent;
  toolUseEvent?: ToolUseEvent;
  messageMetadataEvent?: { conversationId: string };
  error?: { message: string; code: string };
}

export interface ConversationState {
  chatTriggerType: string;
  conversationId?: string;
  currentMessage: {
    userInputMessage: {
      content: string;
      userInputMessageContext?: Record<string, unknown>;
    };
  };
  history?: Array<Record<string, { content: string }>>;
}

export class CodeWhispererStreamingClient {
  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor(config: QClientConfig) {
    const region = config.region ?? 'us-east-1';
    this.endpoint = `https://codewhisperer.${region}.amazonaws.com`;
    this.accessToken = config.accessToken;
  }

  async *generateAssistantResponse(conversationState: ConversationState): AsyncGenerator<StreamEvent> {
    const url = `${this.endpoint}/chat/generateAssistantResponse`;

    const body = JSON.stringify({ conversationState });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Bearer token auth — Builder ID path does not use SigV4
        Authorization: `Bearer ${this.accessToken}`,
        'x-amzn-codewhisperer-optout': 'true',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CodeWhisperer API error ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('No response body');

    // The API returns newline-delimited JSON (one event per line)
    yield* parseNDJSON(response.body);
  }
}

async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as StreamEvent;
        } catch {
          // malformed line — skip
        }
      }
    }

    // flush remainder
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim()) as StreamEvent;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}
