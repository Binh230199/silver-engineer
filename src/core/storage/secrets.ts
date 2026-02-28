import * as vscode from 'vscode';

/** Well-known secret keys stored in ExtensionContext.secrets (OS keychain) */
export const SECRET_KEYS = {
  JIRA_API_TOKEN:   'silver.jiraApiToken',
  JIRA_EMAIL:       'silver.jiraEmail',
  GITHUB_PAT:       'silver.githubPat',
  CUSTOM_API_TOKEN: 'silver.customApiToken',
} as const;

export type SecretKey = typeof SECRET_KEYS[keyof typeof SECRET_KEYS];

/**
 * SecretManager — thin wrapper around ExtensionContext.secrets.
 *
 * All API tokens and sensitive credentials flow through this class.
 * NOTHING sensitive is ever stored in settings.json, globalState, or
 * workspaceState — only in the OS keychain via VS Code SecretStorage.
 */
export class SecretManager {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Retrieve a stored secret, or undefined if not set */
  async get(key: SecretKey): Promise<string | undefined> {
    return this.ctx.secrets.get(key);
  }

  /** Store a secret in the OS keychain */
  async set(key: SecretKey, value: string): Promise<void> {
    await this.ctx.secrets.store(key, value);
  }

  /** Delete a secret */
  async delete(key: SecretKey): Promise<void> {
    await this.ctx.secrets.delete(key);
  }

  /**
   * Get a secret, prompting the user securely if it is missing or expired.
   * Returns undefined if the user cancels.
   */
  async getOrPrompt(
    key: SecretKey,
    label: string,
    placeHolder?: string,
  ): Promise<string | undefined> {
    const existing = await this.get(key);
    if (existing) {
      return existing;
    }

    const value = await vscode.window.showInputBox({
      title: `Silver Engineer — ${label}`,
      prompt: `Enter your ${label}. It will be stored securely in the OS keychain.`,
      placeHolder: placeHolder ?? label,
      password: true,
      ignoreFocusOut: true,
    });

    if (value) {
      await this.set(key, value);
    }
    return value;
  }

  /**
   * Prompt the user for all known credentials.
   * Called by the "Configure API Credentials" command.
   */
  async promptAll(): Promise<void> {
    const steps: Array<{ key: SecretKey; label: string; hint: string }> = [
      { key: SECRET_KEYS.JIRA_EMAIL,       label: 'Jira Email',       hint: 'user@company.com' },
      { key: SECRET_KEYS.JIRA_API_TOKEN,   label: 'Jira API Token',   hint: 'your-jira-api-token' },
      { key: SECRET_KEYS.GITHUB_PAT,       label: 'GitHub PAT',       hint: 'ghp_...' },
      { key: SECRET_KEYS.CUSTOM_API_TOKEN, label: 'Custom API Token', hint: 'optional' },
    ];

    for (const step of steps) {
      const current = await this.get(step.key);
      const value = await vscode.window.showInputBox({
        title: `Silver Engineer — ${step.label}`,
        prompt: current
          ? `Current value exists. Leave blank to keep it, or enter a new value.`
          : `Enter your ${step.label}. Will be stored securely in OS keychain.`,
        placeHolder: step.hint,
        password: true,
        ignoreFocusOut: true,
      });
      if (value) {
        await this.set(step.key, value);
      }
    }
    vscode.window.showInformationMessage('Silver Engineer: Credentials saved to OS keychain.');
  }
}
