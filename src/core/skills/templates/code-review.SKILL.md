description: Perform a thorough senior-engineer code review with actionable, prioritised feedback

## Skill: code-review

### Purpose
Conduct a comprehensive code review mimicking a senior engineer's perspective.

### Trigger
Use this skill when the user asks to:
- Review a diff / PR
- Check code quality or correctness
- Audit a file for security or performance issues

### Review dimensions (in priority order)

| Priority | Category | What to look for |
|---|---|---|
| P0 | **Correctness** | Logic errors, off-by-one, null dereferences, race conditions |
| P0 | **Security** | Injection, hardcoded secrets, improper auth, input validation gaps |
| P1 | **Performance** | O(n²) in hot paths, unnecessary re-renders, missing indexes, N+1 queries |
| P1 | **Reliability** | Missing error handling, unhandled rejections, fragile retries |
| P2 | **Maintainability** | Naming clarity, unnecessary complexity, magic numbers, duplication |
| P3 | **Style** | Consistency with surrounding code (do NOT rewrite stylistic issues that pass lint) |

### Output format
Structure every finding as:

> **[P{priority}] {Category}** — `<file>:<line>`
> _Issue_: < one sentence describing the problem >
> _Suggestion_: < concrete fix or alternative >

Then end with a **Summary** section:
```
## Summary
- 🔴 Blocking: <count> — must fix before merge
- 🟡 Non-blocking: <count> — should improve
- 🟢 Suggestions: <count> — optional improvements
```

### Notes
- Praise good patterns briefly (not excessively).
- Do NOT suggest changes that are purely stylistic if they pass automated linting.
- If you cannot determine context (e.g., missing imports), say so rather than guessing.
