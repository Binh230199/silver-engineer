// ---------------------------------------------------------------------------
// Workflow Engine — type definitions
// ---------------------------------------------------------------------------
//
// Workflows live in .github/workflows/silver/*.yml (workspace-level).
// Each step declares its type, inputs, expected output, and failure strategy.
//
// Step types
//   agent  → loads .github/agents/<name>.agent.md, calls LLM with diff/context
//   prompt → loads .github/prompts/<file>, calls LLM, optionally captures output
//   shell  → runs a shell command, captures stdout
//
// Failure strategies
//   abort         → stop the entire workflow, report failure
//   continue      → log warning, proceed to next step (default for non-critical)
//   retry(max: N) → retry up to N times before falling back to on_fail_fallback
//
// Variable system
//   step.output: 'var_name' captures the step's LLM/shell output into a variable.
//   {{var_name}} in any field is replaced with the captured value at runtime.
//   Built-in inputs: git_diff_staged, git_diff_last_commit, commit_message_last
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  /** Unique identifier — used in conditions like "steps.review.passed" */
  id: string;

  /** Step type */
  type: 'agent' | 'prompt' | 'shell';

  /** [agent] Name of agent — reads .github/agents/<agent>.agent.md */
  agent?: string;

  /** [prompt] Path relative to workspace root, e.g. .github/prompts/create-commit-message.prompt.md */
  prompt?: string;

  /** [shell] Shell command to run. Supports {{variable}} interpolation */
  command?: string;

  /**
   * Input to pass to LLM steps.
   * Built-ins: 'git_diff_staged' | 'git_diff_last_commit' | 'commit_message_last'
   * Variable refs: '{{var_name}}'
   */
  input?: string;

  /** Capture the step's primary output into this variable name */
  output?: string;

  /**
   * Required substring in the output for the step to be considered PASSED.
   * Common value: '[PASS]'
   * If omitted, step passes unless it throws.
   */
  expect?: string;

  /**
   * What to do if the step fails (expect not met or error thrown).
   * 'abort'         → stop workflow
   * 'continue'      → keep going, mark step as failed
   * 'retry(max: N)' → retry up to N times  (e.g. 'retry(max: 2)')
   */
  on_fail?: string;

  /**
   * Optional JS-like boolean expression evaluated before running the step.
   * Supported: 'steps.<id>.passed', '&&', '||', '!', parentheses
   * Example: 'steps.review-style.passed && steps.review-static.passed'
   */
  condition?: string;

  /** Human-readable description shown in the chat stream */
  description?: string;
}

export interface WorkflowDefinition {
  /** The workflow name (used in @silver /run <name>) */
  name: string;

  /** Short description shown when listing workflows */
  description?: string;

  /** Ordered list of steps */
  steps: WorkflowStep[];
}

export interface StepResult {
  id: string;
  passed: boolean;
  output: string;
  skipped: boolean;
  failReason?: string;
}

export interface WorkflowRunResult {
  workflowName: string;
  passed: boolean;
  steps: StepResult[];
  abortedAt?: string;  // step id where workflow was aborted
}
