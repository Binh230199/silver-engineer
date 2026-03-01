---
name: review-code-change
description: Use AI agents to review code changes either from the local working tree or a commit/merge request on a hosted Git server. The system identifies language, platform, framework, and commit type to pick the appropriate review agent and checklist.
---

## Overview

This requirement describes a slash-command (@silver /run review-code-change [<commit-link>|<diff-path>]) that lets developers request an automated code review of:

- locally staged or unstaged modifications, or
- a specific commit, pull request, or merge request on a remote repository (GitHub, GitLab, Gerrit, etc.).

Based on the diff content, the feature determines the languages, frameworks, and nature of the change to select the most suitable review agent and checklist. It should also be flexible enough to support custom checklists and extensible for new languages, frameworks, and platforms.

## Functional Requirements

1. **Invocation**
   - The user invokes the command via a slash command in chat.
   - Basic usage: @silver /run review-code-change.
   - Optional argument may specify a remote commit/MR URL or a local diff file path.
   - If no argument is given, default to current working changes (staged by default; config should allow unstaged).

2. **Source Resolution**
   - For remote references, fetch the diff using the Git server's API (support at least GitHub, GitLab, Gerrit).
     - In air‑gapped or authenticated environments, use the existing MCP tooling to request diffs instead of direct HTTP fetches.
   - For a local path, read the diff file or generate one with Git (`git diff`, `git show`).
   - Validate that the diff exists and contains changes; report errors if not.
   - If the diff is extremely large (e.g. hundreds of files or thousands of lines), warn the user and optionally decline to review, since context and agent performance degrade on massive changes.

3. **Change Analysis**
   - Parse the diff to identify:
     - Primary programming language(s) modified.
     - Project type or platform (e.g., C/C++, Java, Python, web frontend, embedded).
     - Frameworks present (React, Spring, Android, etc.).
     - Nature of the change: feature, bug fix, refactor, test, documentation, etc. (using commit message prefixes or file patterns).
   - Optionally run heuristics or lightweight static analysis to improve detection accuracy.

4. **Agent Selection**
   - Map change characteristics to review agents:
     - `reviewer-feature` → feature implementation.
     - `reviewer-bug` → bug fix.
     - `reviewer-static` → static/lint fixes.
     - `reviewer-unittest` → new/updated tests.
   - Choose a language-specific checklist when available (e.g., C/C++ checklist for C++ files).
   - Allow the user to override the chosen agent or checklist via command options or configuration.

5. **Custom Checklists**
   - Users may define their own review checklists (language, project, or change-type specific).
   - Provide a mechanism for loading these configurations from workspace settings, a .silverrc file, or via an interactive prompt.

6. **Review Output**
   - Display results in chat, including:
     - A summary of files changed and line counts.
     - The agent and checklist used.
     - A list of issues, suggestions, and any follow-up questions.
   - When appropriate, post the review as a comment on the remote commit/MR.

## Non-functional Requirements

- **User Experience**
  - Minimal friction: a single slash invocation should cover most use cases.
  - Provide clear progress/status messages and actionable error diagnostics.
  - Format output for easy scanning.

- **Extensibility**
  - New languages, frameworks, and agents should be addable without modifying core logic.
  - Support plugin-style checklists or configuration hooks.

- **Reliability**
  - Gracefully handle network failures or invalid remote links.
  - Sanitize diff content to prevent injection attacks.
  - Cache recent remote diffs to minimize API usage.
  - Detect extremely large diffs and either truncate or decline the review with an explanatory message to avoid losing context.

- **Performance**
  - Provide timely responses; for large diffs, stream partial results or update status incrementally.

## Implementation Notes

- Leverage existing agent infrastructure; pass metadata such as languages and frameworks to the agents.
- For change-type detection, inspect commit messages for conventional prefixes (feat:, fix:, etc.) and file paths (e.g., `tests/`).
- Allow command-line flags or configuration entries to force a specific agent or skip auto-detection entirely.
- Expose relevant settings in settings.json or via workspace configuration commands.
- Consider integrating with Git hooks (e.g., pre-push) so reviews can run automatically before push.
- Design an abstraction layer for fetching diffs from various Git servers to simplify future platform additions.

---

### 💡 Suggested Enhancements

- **Batch Reviews**: Review a range of commits or an entire branch at once.
- **Interactive Follow-up**: Allow users to ask clarifying questions or refine the review after the initial pass.
- **Auto-Fix Suggestions**: Optionally apply simple fixes (formatting, import order) directly to the local workspace.
- **Security Scanning**: Integrate light SAST checks depending on language/platform.
- **Reporting/Analytics**: Track review trends, common issues, and agent performance over time.

These changes deliver a robust, flexible review command and outline avenues for future improvement.
