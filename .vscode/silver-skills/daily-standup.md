description: Prepare a concise daily stand-up summary and draft a Jira comment

## Skill: daily-standup

### Purpose
Help the developer prepare their daily stand-up message: what was done yesterday,
what is planned today, and whether there are any blockers — all in under 60 seconds.

### Trigger
Use this skill when the user asks:
- "Prepare my standup"
- "Daily standup" / "Daily update"
- "What did I do yesterday?"
- "Write my standup for today"

### Behaviour
1. **Read recent activity** from the Knowledge Graph:
   - Work items touched in the last 24 hours
   - Commits or PR activity (if available via MCP/Git tools)
   - High-weight colleagues (likely reviewers or pair-partners)

2. **Ask clarifying questions** only if context is absent:
   - "What ticket were you working on yesterday?" (if no WorkItem nodes found)
   - "Any blockers to mention?"

3. **Generate a stand-up message** in this format:

```
🗓️ Stand-up — [Today's Date]

✅ Yesterday:
- <item 1>
- <item 2>

📌 Today:
- <item 1>
- <item 2>

🚧 Blockers:
- <none / description>
```

4. **Offer to post** the comment to the relevant Jira ticket (via HITL tool confirmation).

### Customisation
Override the template by editing this file. Add your team's standard format below:

```
<!-- TEAM TEMPLATE (optional — uncomment and edit)
Format: [YESTERDAY] / [TODAY] / [BLOCKERS]
Max 3 bullets per section. Always mention ticket key.
-->
```

### Notes
- Keep bullets short (one line each).
- Do NOT include internal meeting details.
- If working on multiple tickets, group by ticket key.
