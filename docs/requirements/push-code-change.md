---
name: push-code-change
description: Automatically generate a commit message from staged changes and push to the appropriate Git platform. The feature should infer the commit message format, prompt for missing fields, and handle push commands for GitHub, GitLab, Gerrit, Bitbucket, etc.
---

## Overview

This requirement describes a slash-command (@silver /run push-code-change) that simplifies the process of creating a commit message and pushing code. The goal is to make the experience as seamless and user-friendly as possible while supporting common workflows.

## Functional Requirements

1. **Invocation**
   - The user triggers the feature via a slash command.
   - Command example: @silver /run push-code-change.

2. **Commit Message Generation**
   - Only staged changes are considered when generating the message.
   - The system inspects the last five commits to infer the preferred commit message format (conventional commits, custom patterns, etc.).
   - Users may explicitly specify their own format; in that case, the system respects the provided template. Provide a configuration path or UI to input custom formats.
   - When the inferred or provided template contains placeholders or special fields (e.g. [JIRA]), prompt the user inline during the session to supply the required values.
     - Example: If the template includes a JIRA ticket field, ask: "Please provide the JIRA ticket to include in the commit message." The flow should pause, capture the input, then resume.

3. **Platform Detection and Push**
   - Automatically determine the target Git platform (GitHub, GitLab, Gerrit, Bitbucket, etc.) based on the repository configuration or remote URL.
   - Execute the appropriate `git push` command for the detected platform (e.g., `git push origin HEAD:refs/for/<branch>` for Gerrit).

## Non-functional Requirements

- **User-Friendly Workflow**: Design interactions to be intuitive and efficient for most developers. Avoid unnecessary prompts or complexity.
- **Extensibility**: Allow easy customization of commit formats and support for additional platforms in the future.
- **Reliability**: Handle edge cases such as no staged changes, unrecognized formats, or multiple remotes gracefully with clear feedback.

## Implementation Notes

- Provide clear status updates or progress in the chat/notification area as the command executes.
- Ensure configuration options (e.g., custom templates) are discoverable and editable.
