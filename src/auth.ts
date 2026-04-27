import * as vscode from 'vscode';
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
  CreateTokenCommandOutput,
} from '@aws-sdk/client-sso-oidc';

const BUILDER_ID_START_URL = 'https://view.awsapps.com/start';
const BUILDER_ID_REGION    = 'us-east-1';

// Scopes for Builder ID (free tier)
const BUILDER_ID_SCOPES = ['codewhisperer:conversations', 'codewhisperer:completions'];

// Scopes for IAM Identity Center (Q Developer Pro)
const SSO_SCOPES = [
  'sso:account:access',
  'codewhisperer:conversations',
  'codewhisperer:completions',
  'codewhisperer:analysis',
];

const CLIENT_NAME       = 'copilot-q-bridge';
const TOKEN_KEY         = 'copilotQ.accessToken';
const TOKEN_EXPIRY_KEY  = 'copilotQ.tokenExpiry';
const REFRESH_KEY       = 'copilotQ.refreshToken';
const CLIENT_ID_KEY     = 'copilotQ.clientId';
const CLIENT_SECRET_KEY = 'copilotQ.clientSecret';
// Store which startUrl the cached client was registered for
const CLIENT_URL_KEY    = 'copilotQ.clientStartUrl';

export interface QCredentials {
  accessToken: string;
}

export class AmazonQAuth {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private getConfig(): { startUrl: string; region: string; scopes: string[] } {
    const cfg = vscode.workspace.getConfiguration('copilotQ');
    const startUrl = (cfg.get<string>('startUrl') ?? '').trim();
    const region   = (cfg.get<string>('ssoRegion') ?? 'us-east-1').trim();

    if (startUrl) {
      return { startUrl, region, scopes: SSO_SCOPES };
    }
    return { startUrl: BUILDER_ID_START_URL, region: BUILDER_ID_REGION, scopes: BUILDER_ID_SCOPES };
  }

  private makeClient(region: string): SSOOIDCClient {
    return new SSOOIDCClient({ region });
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
    await Promise.all([
      this.ctx.secrets.delete(TOKEN_KEY),
      this.ctx.secrets.delete(REFRESH_KEY),
      this.ctx.secrets.delete(CLIENT_SECRET_KEY),
    ]);
    await Promise.all([
      this.ctx.globalState.update(TOKEN_EXPIRY_KEY, undefined),
      this.ctx.globalState.update(CLIENT_ID_KEY, undefined),
      this.ctx.globalState.update(CLIENT_URL_KEY, undefined),
    ]);
    vscode.window.showInformationMessage('Amazon Q: Signed out.');
  }

  async showStatus(): Promise<void> {
    const token = await this.getCachedToken();
    const { startUrl } = this.getConfig();
    const via = startUrl === BUILDER_ID_START_URL ? 'Builder ID' : startUrl;

    if (token) {
      vscode.window.showInformationMessage(`Amazon Q: Authenticated via ${via} ✓`);
    } else {
      const action = await vscode.window.showWarningMessage(
        `Amazon Q: Not authenticated (${via}).`,
        'Sign In',
      );
      if (action === 'Sign In') await this.signIn();
    }
  }

  private async getCachedToken(): Promise<string | undefined> {
    // Invalidate cache if startUrl changed since last registration
    const { startUrl } = this.getConfig();
    const cachedUrl = this.ctx.globalState.get<string>(CLIENT_URL_KEY);
    if (cachedUrl && cachedUrl !== startUrl) {
      await this.signOut();
      return undefined;
    }

    const token = await this.ctx.secrets.get(TOKEN_KEY);
    if (!token) return undefined;

    const expiry = this.ctx.globalState.get<number>(TOKEN_EXPIRY_KEY, 0);
    if (Date.now() < expiry - 60_000) return token;

    return this.refreshToken();
  }

  private async refreshToken(): Promise<string | undefined> {
    const [refreshToken, clientSecret] = await Promise.all([
      this.ctx.secrets.get(REFRESH_KEY),
      this.ctx.secrets.get(CLIENT_SECRET_KEY),
    ]);
    const clientId = this.ctx.globalState.get<string>(CLIENT_ID_KEY);
    const { region } = this.getConfig();

    if (!refreshToken || !clientId || !clientSecret) return undefined;

    try {
      const resp = await this.makeClient(region).send(
        new CreateTokenCommand({ clientId, clientSecret, grantType: 'refresh_token', refreshToken }),
      );
      await this.saveToken(resp);
      return resp.accessToken ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async doSignIn(): Promise<void> {
    const { startUrl, region, scopes } = this.getConfig();
    const oidc = this.makeClient(region);

    // Re-register client if startUrl changed
    const cachedUrl = this.ctx.globalState.get<string>(CLIENT_URL_KEY);
    let clientId     = cachedUrl === startUrl ? this.ctx.globalState.get<string>(CLIENT_ID_KEY) : undefined;
    let clientSecret = cachedUrl === startUrl ? await this.ctx.secrets.get(CLIENT_SECRET_KEY) : undefined;

    if (!clientId || !clientSecret) {
      const reg = await oidc.send(
        new RegisterClientCommand({ clientName: CLIENT_NAME, clientType: 'public', scopes }),
      );
      clientId     = reg.clientId!;
      clientSecret = reg.clientSecret!;
      await this.ctx.globalState.update(CLIENT_ID_KEY, clientId);
      await this.ctx.globalState.update(CLIENT_URL_KEY, startUrl);
      await this.ctx.secrets.store(CLIENT_SECRET_KEY, clientSecret);
    }

    const auth = await oidc.send(
      new StartDeviceAuthorizationCommand({ clientId, clientSecret, startUrl }),
    );

    const verificationUri = auth.verificationUriComplete ?? auth.verificationUri!;
    const userCode = auth.userCode!;

    const action = await vscode.window.showInformationMessage(
      `Amazon Q: Open the browser and enter code **${userCode}** to sign in.`,
      'Open Browser',
    );
    if (action === 'Open Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
    }

    const interval  = (auth.interval ?? 5) * 1000;
    const expiresAt = Date.now() + (auth.expiresIn ?? 600) * 1000;

    while (Date.now() < expiresAt) {
      await sleep(interval);
      try {
        const token = await oidc.send(
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
        if (err.name === 'SlowDownException') { await sleep(interval); continue; }
        throw err;
      }
    }

    throw new Error('Amazon Q sign-in timed out. Please try again.');
  }

  private async saveToken(resp: CreateTokenCommandOutput): Promise<void> {
    await this.ctx.secrets.store(TOKEN_KEY, resp.accessToken!);
    if (resp.refreshToken) await this.ctx.secrets.store(REFRESH_KEY, resp.refreshToken);
    const expiresIn = resp.expiresIn ?? 3600;
    await this.ctx.globalState.update(TOKEN_EXPIRY_KEY, Date.now() + expiresIn * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
