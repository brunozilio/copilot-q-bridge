import * as vscode from 'vscode';
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
  CreateTokenCommandOutput,
} from '@aws-sdk/client-sso-oidc';

// Builder ID OIDC endpoint — fixed, not region-specific
const OIDC_REGION = 'us-east-1';
const OIDC_ENDPOINT = 'https://oidc.us-east-1.amazonaws.com';
const START_URL = 'https://view.awsapps.com/start';
const SCOPES = ['codewhisperer:conversations', 'codewhisperer:completions'];
const CLIENT_NAME = 'copilot-q-bridge';
const TOKEN_KEY = 'copilotQ.accessToken';
const TOKEN_EXPIRY_KEY = 'copilotQ.tokenExpiry';
const REFRESH_KEY = 'copilotQ.refreshToken';
const CLIENT_ID_KEY = 'copilotQ.clientId';
const CLIENT_SECRET_KEY = 'copilotQ.clientSecret';

export interface QCredentials {
  accessToken: string;
}

export class AmazonQAuth {
  private readonly oidc: SSOOIDCClient;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.oidc = new SSOOIDCClient({
      region: OIDC_REGION,
      endpoint: OIDC_ENDPOINT,
    });
  }

  async getCredentials(): Promise<QCredentials | undefined> {
    const token = await this.getCachedToken();
    if (token) return { accessToken: token };
    return undefined;
  }

  async signIn(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Amazon Q: Signing in…', cancellable: false },
      () => this.doSignIn(),
    );
  }

  async signOut(): Promise<void> {
    await this.ctx.secrets.delete(TOKEN_KEY);
    await this.ctx.secrets.delete(REFRESH_KEY);
    await this.ctx.secrets.delete(CLIENT_SECRET_KEY);
    await this.ctx.globalState.update(TOKEN_EXPIRY_KEY, undefined);
    await this.ctx.globalState.update(CLIENT_ID_KEY, undefined);
    vscode.window.showInformationMessage('Amazon Q: Signed out.');
  }

  async showStatus(): Promise<void> {
    const token = await this.getCachedToken();
    if (token) {
      vscode.window.showInformationMessage('Amazon Q: Authenticated ✓');
    } else {
      const action = await vscode.window.showWarningMessage(
        'Amazon Q: Not authenticated.',
        'Sign In',
      );
      if (action === 'Sign In') await this.signIn();
    }
  }

  private async getCachedToken(): Promise<string | undefined> {
    const token = await this.ctx.secrets.get(TOKEN_KEY);
    if (!token) return undefined;

    const expiry = this.ctx.globalState.get<number>(TOKEN_EXPIRY_KEY, 0);
    if (Date.now() < expiry - 60_000) return token;

    // try refresh
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string | undefined> {
    const refreshToken = await this.ctx.secrets.get(REFRESH_KEY);
    const clientId = this.ctx.globalState.get<string>(CLIENT_ID_KEY);
    const clientSecret = await this.ctx.secrets.get(CLIENT_SECRET_KEY);

    if (!refreshToken || !clientId || !clientSecret) return undefined;

    try {
      const resp = await this.oidc.send(
        new CreateTokenCommand({
          clientId,
          clientSecret,
          grantType: 'refresh_token',
          refreshToken,
        }),
      );
      await this.saveToken(resp);
      return resp.accessToken ?? undefined;
    } catch {
      // refresh failed, user must sign in again
      return undefined;
    }
  }

  private async doSignIn(): Promise<void> {
    // Register a public client (or reuse cached registration)
    let clientId = this.ctx.globalState.get<string>(CLIENT_ID_KEY);
    let clientSecret = await this.ctx.secrets.get(CLIENT_SECRET_KEY);

    if (!clientId || !clientSecret) {
      const reg = await this.oidc.send(
        new RegisterClientCommand({
          clientName: CLIENT_NAME,
          clientType: 'public',
          scopes: SCOPES,
        }),
      );
      clientId = reg.clientId!;
      clientSecret = reg.clientSecret!;
      await this.ctx.globalState.update(CLIENT_ID_KEY, clientId);
      await this.ctx.secrets.store(CLIENT_SECRET_KEY, clientSecret);
    }

    const auth = await this.oidc.send(
      new StartDeviceAuthorizationCommand({
        clientId,
        clientSecret,
        startUrl: START_URL,
      }),
    );

    const verificationUri = auth.verificationUriComplete ?? auth.verificationUri!;
    const userCode = auth.userCode!;

    const action = await vscode.window.showInformationMessage(
      `Amazon Q: Open the browser and enter code **${userCode}** to sign in.`,
      { modal: false },
      'Open Browser',
    );
    if (action === 'Open Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
    }

    // Poll until authorized or expired
    const interval = (auth.interval ?? 5) * 1000;
    const expiresAt = Date.now() + (auth.expiresIn ?? 600) * 1000;

    while (Date.now() < expiresAt) {
      await sleep(interval);
      try {
        const token = await this.oidc.send(
          new CreateTokenCommand({
            clientId,
            clientSecret,
            grantType: 'urn:ietf:params:oauth:grant-type:device_code',
            deviceCode: auth.deviceCode!,
          }),
        );
        await this.saveToken(token);
        vscode.window.showInformationMessage('Amazon Q: Signed in successfully ✓');
        return;
      } catch (err: any) {
        if (err.name === 'AuthorizationPendingException') continue;
        if (err.name === 'SlowDownException') {
          await sleep(interval);
          continue;
        }
        throw err;
      }
    }

    throw new Error('Amazon Q sign-in timed out. Please try again.');
  }

  private async saveToken(resp: CreateTokenCommandOutput): Promise<void> {
    await this.ctx.secrets.store(TOKEN_KEY, resp.accessToken!);
    if (resp.refreshToken) {
      await this.ctx.secrets.store(REFRESH_KEY, resp.refreshToken);
    }
    const expiresIn = resp.expiresIn ?? 3600;
    await this.ctx.globalState.update(TOKEN_EXPIRY_KEY, Date.now() + expiresIn * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
