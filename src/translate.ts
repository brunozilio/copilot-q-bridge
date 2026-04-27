import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import type { ConversationState } from './q-client';

// One conversation ID per session key (derived from first message content)
const conversationIds = new Map<string, string>();

export function toQConversation(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): ConversationState {
  const sessionKey = extractText(messages[0] ?? messages[messages.length - 1]);
  if (!conversationIds.has(sessionKey)) {
    conversationIds.set(sessionKey, uuidv4());
    if (conversationIds.size > 50) {
      const firstKey = conversationIds.keys().next().value;
      if (firstKey !== undefined) conversationIds.delete(firstKey);
    }
  }
  const conversationId = conversationIds.get(sessionKey)!;

  const history = Array.from(messages).slice(0, -1).map(m => {
    const isUser = m.role === vscode.LanguageModelChatMessageRole.User;
    const key = isUser ? 'userInputMessage' : 'assistantResponseMessage';
    return { [key]: { content: extractText(m) } };
  });

  const last = messages[messages.length - 1];

  return {
    chatTriggerType: 'MANUAL',
    conversationId,
    currentMessage: {
      userInputMessage: {
        content: extractText(last),
        userInputMessageContext: buildEditorContext(),
      },
    },
    history: history.length > 0 ? history : undefined,
  };
}

function extractText(m: vscode.LanguageModelChatRequestMessage | undefined): string {
  if (!m) return '';
  return m.content
    .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
    .map(p => p.value)
    .join('');
}

function buildEditorContext(): Record<string, unknown> | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  const doc = editor.document;
  const sel = editor.selection;

  const selectedText = sel.isEmpty ? undefined : doc.getText(sel);
  const cursorLine = sel.active.line;

  const startLine = Math.max(0, cursorLine - 100);
  const endLine = Math.min(doc.lineCount - 1, cursorLine + 100);
  const snippet = doc.getText(
    new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, doc.lineAt(endLine).text.length),
    ),
  );

  return {
    editorState: {
      document: {
        relativeFilePath: vscode.workspace.asRelativePath(doc.uri),
        programmingLanguage: { languageName: doc.languageId },
        text: snippet,
        documentSymbol: [],
      },
      cursorState: [
        {
          range: {
            start: { line: sel.start.line, character: sel.start.character },
            end:   { line: sel.end.line,   character: sel.end.character   },
          },
        },
      ],
      ...(selectedText ? { selectedText } : {}),
    },
  };
}
