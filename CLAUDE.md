# CLAUDE.md

## Repository

Claude Code plugin `lordknows13-check-loop`. It provides adversarial plan refinement, peer-reviewed research, and supervised execution over the official Codex App Server transport. No compiled code or runtime npm dependencies.

## Architecture

```text
.claude-plugin/marketplace.json
package.json            # pi package manifest (skills only)
plugins/check-loop/
  plugin.json
  scripts/
    codex-invoke.mjs
    lib/
  skills/
    check-loop/SKILL.md
    research/SKILL.md
    execute/SKILL.md
    settings/SKILL.md
    execute/implementer-prompt.md
```

`plugin.json` discovers skills through `./skills/*`. Preserve the public skill names `check-loop`, `research`, `execute`, and `settings`.

## Model and settings contract

- The session model (whatever the user selected; skills never switch it) owns plan refinement, research, execution orchestration, repository validation, and review adjudication.
- Fresh subagents implement bounded steps and accepted fixes on `implementerModel`; null inherits the session model.
- Codex is the adversarial reviewer. Do not hardcode a model identity into prompts or transport defaults.

`scripts/lib/review-config.mjs` resolves each setting independently: invocation override → `.claude/check-loop.json` at the working directory → `~/.claude/check-loop/config.json` → defaults. `CLAUDE_CONFIG_DIR` relocates the user directory. Defaults: `{model: null, effort: null, maxRounds: 6, implementerModel: null}`. Null model/effort inherits Codex settings; null implementerModel inherits the session model; maximum rounds must be an integer from 1 through 40.

`codex-invoke.mjs config` inspects settings; setters persist only supplied keys (user-wide unless `--project`). `default` resets model/effort/implementerModel to null. `/check-loop:settings` exposes this interface to users. Reject unknown options rather than ignoring reviewer choices.

Every reviewer path is read-only. Explicit model/effort mismatches fail. New and resumed turns report actual settings and guard against rerouting. Native review may inherit a separate `review_model`; do not label its model with the primary thread's model when the reviewer is unknown. Setup verifies installation/authentication, not model access.

## Review policy

Every concern must contain a severity, evidence status, claim, exact evidence, impact, failure condition, and recommended correction.

Evidence statuses:

- `VERIFIED`: the cited source directly supports the claim.
- `INFERENCE`: cited facts support an unreproduced conclusion.
- `UNVERIFIED`: evidence is missing or inaccessible.

Only independently checked `VERIFIED` critical or important findings may block. The orchestrator records `ACCEPT`, `REJECT`, or `COUNTER`. Reviewer agreement, confidence, severity, and repetition are not evidence.
Secret or credential content is redacted from every Codex payload, including full plans, research reports, step diffs, validation output, and final review packets.
Require zero exit status and a valid nonempty review response before adjudication. Result JSON contains numeric `status` and `error`; incomplete or failed output is not approval. Preserve exact reviewer citations and uncertainty labels separately from the orchestrator's decisions.


## Skills

### `check-loop`

The orchestrator owns the plan; the configured Codex reviewer critiques it in one persistent thread through `codex-invoke.mjs round`. The runner (`scripts/lib/review-loop.mjs`) owns prompts, structured reviewer output (`REVIEW_OUTPUT_SCHEMA`), secret redaction, finding IDs, the decision ledger, repeat suppression, the one-time dispute budget, stall detection, the frozen round cap, the regression-only closeout, and resumable run state under `~/.claude/check-loop/runs/`. Round 1 is the only broad review and carries the full plan; later rounds carry the diff since the last review and block only on regressions or a missed VERIFIED critical defect. The orchestrator independently checks evidence, records ACCEPT/REJECT/COUNTER/WAIVE, and edits minimally. Never bypass the cap with a new run; stalled or capped runs require a named user choice and are never reported as approved.

### `research`

The orchestrator researches the user's question and writes one Markdown report with current primary-source citations, explicit inferences, counterevidence, and unresolved gaps. Codex reviews the draft through the same `round` runner (`--kind research`, findings `R1`...). The orchestrator independently checks every source before revising. The skill produces no code or implementation plan.

### `execute`

1. The orchestrator locks the approved plan; existing changes require worktree isolation or explicit user inclusion.
2. `codex-invoke.mjs step --begin` records the step base as a git tree object (temporary index, nothing staged) before a fresh subagent implements one bounded step.
3. The orchestrator inspects the changes and runs repository-native validation.
4. `codex-invoke.mjs step` (`scripts/lib/step.mjs`) diffs base to current tree, excludes protected paths by git pathspec, redacts secrets, and runs the same ledger as `round` with kind `step`, findings `S1`..., one persistent thread per execution, and a fixed cap of one review plus three fix re-reviews.
5. The orchestrator independently verifies and adjudicates; a fresh fixer handles only accepted or countered findings; re-reviews send only the fix delta.
6. `--step final` reviews everything since the execution base before the user approval gate.

Never hide, discard, stage, commit, or push existing user work automatically. Commit and push require explicit user approval.

### `settings`

Inspect or update model, effort, and maximum plan/research rounds through the config CLI. Explain user/project scope and inheritance; save only requested changes. Never claim setup certifies access to a model or fabricate available model IDs.

## Transport

```bash
# Plan or research review round (first call needs --kind and --request-file)
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" round --cwd /path --artifact PLAN [--kind plan|research] [--request-file F] [--adjudication-file F] [--new] [--closeout]

# Compact summary of a review run
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" report --cwd /path --artifact PLAN

# Execution step review: record the base before the implementer, then review the delta
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" step --cwd /path --plan PLAN --step N --begin
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" step --cwd /path --plan PLAN --step N|final [--contract-file F] [--validation-file F] [--adjudication-file F]

# Free-form review turn; --thread-id continues a thread
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" turn --cwd /path --prompt-file FILE [--thread-id ID]

# Optional native review of a scope confirmed to contain no protected content
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" review --cwd /path [--scope auto|working-tree|branch] [--base REF]

# Installation/authentication preflight and reviewer settings
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" setup [--cwd /path]

# Inspect effective settings; use config --model ID --effort LEVEL to save choices
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs" config [--cwd /path]
```

The transport spawns `codex app-server` per command, speaks JSON-RPC over stdio, and uses the local Codex OAuth session. Threads persist on disk, so `--thread-id` resumes across processes.

## Validation

```bash
node --test tests/
claude plugin validate ./plugins/check-loop
claude plugin validate ./.claude-plugin/marketplace.json
```

Also syntax-check changed `.mjs` files and run `git diff --check`.

## Versioning

Keep these values synchronized:

1. `.claude-plugin/marketplace.json` → `metadata.version`
2. `.claude-plugin/marketplace.json` → `plugins[0].version`
3. `plugins/check-loop/plugin.json` → `version`
4. `package.json` → `version` (pi package manifest)

Current version: **5.2.1**
