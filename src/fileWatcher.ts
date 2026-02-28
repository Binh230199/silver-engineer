import * as vscode from 'vscode';
import * as path from 'path';
import type { SkillsLoader } from './skills/loader';

/**
 * FileWatcher
 *
 * Monitors `.vscode/silver-skills/*.md` workspace files.
 * Automatically registers / deregisters skills when files are created, changed,
 * or deleted — no restart required.
 *
 * The watcher injects new skill metadata into the SkillsLoader so the Chat
 * Participant picks them up on the next request (progressive disclosure).
 */
export class FileWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly skills: SkillsLoader,
  ) {}

  async start(): Promise<void> {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.workspace.workspaceFolders?.[0] ?? '',
        '.vscode/silver-skills/*.md',
      ),
    );

    // New skill file dropped in
    watcher.onDidCreate(uri => {
      this.skills.registerUserSkill(uri.fsPath);
      vscode.window.showInformationMessage(
        `Silver Engineer: New skill loaded — \`${path.basename(uri.fsPath, '.md')}\``,
      );
    });

    // Existing skill file edited
    watcher.onDidChange(uri => {
      this.skills.registerUserSkill(uri.fsPath); // re-parse updates in place
    });

    // Skill file removed
    watcher.onDidDelete(uri => {
      this.skills.unregisterUserSkill(uri.fsPath);
      vscode.window.showInformationMessage(
        `Silver Engineer: Skill removed — \`${path.basename(uri.fsPath, '.md')}\``,
      );
    });

    this.watchers.push(watcher);
    this.ctx.subscriptions.push(watcher);
  }

  dispose(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }
}
