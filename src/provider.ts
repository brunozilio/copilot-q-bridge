import * as vscode from 'vscode';
import { AmazonQAuth } from './auth';
import { CodeWhispererStreamingClient } from './q-client';
import { toQConversation } from './translate';

const MODEL_INFO: vscode.LanguageModelChatInformation = {
  id: 'amazon-q-claude',
  name: 'Amazon Q (Claude)',
  family: 'q-developer',
  version: '1.0',
  maxInputTokens: 200_000,
  maxOutputTokens: 4_096,
  capabilities: { toolCalling: true },
};

export class AmazonQProvider implements vscode.LanguageModelChatProvider {
  constructor(private readonly auth: AmazonQAuth) {}

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return [MODEL_INFO];
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const creds = await this.auth.getCredentials();
    if (!creds) {
      throw vscode.LanguageModelError.NoPermissions(
        'Sign in to Amazon Q first (Cmd+Shift+P → Amazon Q: Sign In)',
      );
    }

    const client = new CodeWhispererStreamingClient({ accessToken: creds.accessToken });
    const conversationState = toQConversation(messages);

    for await (const event of client.generateAssistantResponse(conversationState)) {
      if (token.isCancellationRequested) break;

      if (event.error) {
        throw new Error(`Amazon Q error [${event.error.code}]: ${event.error.message}`);
      }

      if (event.assistantResponseEvent?.content) {
        progress.report(new vscode.LanguageModelTextPart(event.assistantResponseEvent.content));
      }

      if (event.toolUseEvent) {
        progress.report(
          new vscode.LanguageModelToolCallPart(
            event.toolUseEvent.toolUseId,
            event.toolUseEvent.name,
            JSON.parse(event.toolUseEvent.input ?? '{}'),
          ),
        );
      }
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    return Promise.resolve(Math.ceil(str.length / 4));
  }
}
