import * as vscode from 'vscode';
import { AmazonQAuth } from './auth';
import { AmazonQProvider } from './provider';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const auth = new AmazonQAuth(ctx);
  const provider = new AmazonQProvider(auth);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('copilotQ.signIn',  () => auth.signIn()),
    vscode.commands.registerCommand('copilotQ.signOut', () => auth.signOut()),
    vscode.commands.registerCommand('copilotQ.status',  () => auth.showStatus()),

    vscode.lm.registerLanguageModelChatProvider('amazon', provider),
  );
}

export function deactivate(): void {
  // nothing — subscriptions cleaned up by VS Code
}
