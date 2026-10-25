<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.png">
    <img src="docs/logo.svg" alt="checkloop" width="420">
  </picture>
</p>


check-loop is a plugin for Claude Code and pi that asks Codex to review a plan before you build it, check a research draft, or review code as you work through an approved plan.

The model your session runs on is the orchestrator. It runs the workflow and checks the review findings. A fresh subagent implements each step on the same model unless you set an implementer model. Codex reviews the work with the model and reasoning effort you choose, or with your Codex defaults.

A review finding needs evidence before it can block progress. The orchestrator opens the cited source instead of accepting a concern because another model raised it.

Current version: 5.2.1. The first release shipped in March 2026, ten days before OpenAI's own Codex plugin for Claude Code and before the other cross-model review loops credited in the changelog.

## Install

You need Claude Code 2.1.257 or later or pi, plus Node.js 18 or later and an authenticated Codex CLI.

Install Codex and sign in from your terminal:

```bash
npm install -g @openai/codex
codex login
```

On a headless machine, use `codex login --device-auth`.

### Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add Novacon/check-loop
/plugin install check-loop@lordknows13-check-loop
/reload-plugins
```

The skills do not switch models. Start the session on the model and effort you want, for example with `claude --model fable`.

To update:

```text
/plugin marketplace update lordknows13-check-loop
/plugin update check-loop@lordknows13-check-loop
/reload-plugins
```

Restart Claude Code if the update asks you to. Updates keep your settings, because they live outside the plugin cache.

### pi

```bash
pi install git:github.com/Novacon/check-loop
```

To use a local clone, pass its path instead: `pi install ./check-loop`. pi names the skills `/skill:check-loop`, `/skill:research`, `/skill:execute`, and `/skill:settings`. The examples below use the Claude Code names.

## Use it

### Review a plan

```text
/check-loop path/to/plan.md
/check-loop --quick path/to/plan.md
```

The orchestrator reads the plan and the repository files it refers to, then sends the plan to Codex. The first round is the only broad review. The orchestrator checks each finding and fixes the plan where the evidence supports a change. Later rounds confirm those fixes and check the changed text. They don't reopen parts of the plan that didn't change.

You see one line per round. The loop stops when no verified blocking concern remains, or after six rounds by default. `--quick` runs a single review pass. If the same blockers keep coming back, or the run hits the limit with fixes Codex hasn't confirmed, the orchestrator asks you what to do: keep fixing, waive the named risks, run one confirmation round, or stop. The result lists what changed, what the orchestrator rejected and why, and any open questions.

An interrupted review resumes where it stopped the next time you run the command on the same plan.

### Research a question

```text
/check-loop:research "Compare SQLite and PostgreSQL for this offline-first application"
```

The orchestrator gathers sources and writes a draft. Codex checks the facts, sources, gaps, and conclusions. The orchestrator verifies the findings and revises the draft through the same review loop.

You get one Markdown report with sources, remaining questions, and a record of the review. This command does not implement code or write an implementation plan.

### Execute a plan

```text
/check-loop:execute path/to/plan.md
```

The orchestrator records the approved plan and the repository's starting state. Before each step it records the working tree as a git tree object, without staging anything. It then gives a fresh subagent one bounded task, runs the project's checks, and sends Codex the diff since that snapshot together with the check output.

If the orchestrator verifies a blocking finding, a fresh subagent fixes it. Execution stops after three unsuccessful fix attempts on a step. At the end, the orchestrator runs the full checks and asks Codex for a final review before handing the work back to you.

If you have uncommitted changes, execution asks before it starts whether to work in a separate worktree or include them. Implementers never stage or commit. The orchestrator commits or pushes only after you approve.

You can omit the plan path or research question when the conversation already identifies exactly one.

## Settings

```text
/check-loop:settings
```

You can change the Codex model, reasoning effort, plan and research round limit, and implementer model. For example:

```text
/check-loop:settings Use the Codex default model, high effort, and six review rounds for my user settings.
```

| Setting | Default | Options |
|---|---|---|
| Model | Your Codex configuration | An exact model ID your account supports, or `default` |
| Reasoning effort | Your Codex configuration | An effort the selected model supports, or `default` |
| Maximum review rounds | 6 | An integer from 1 to 40 |
| Implementer model | Your session model | A model name your host accepts for subagents, such as `opus` or `sonnet` in Claude Code or `provider/id` in pi, or `default` |

Ask for user-wide settings or project-only settings. Model, effort, and round limit apply to Codex. The implementer model applies only to the subagents that `execute` starts. The round limit applies to plans and research and does not change execution's three-fix limit.

Each plan or research run keeps the round limit and reviewer it started with. Reviews stop early when no verified blocker remains.

### Settings files and CLI

Each setting uses the first value defined in this order:

1. Command-line override.
2. `.claude/check-loop.json` in the working directory selected by `--cwd`.
3. `~/.claude/check-loop/config.json`.
4. The plugin default.

`CLAUDE_CONFIG_DIR` changes the user configuration directory. An omitted key inherits the next level. A `null` model or effort selects Codex's own setting, and a `null` implementer model selects the session model, even when a lower level specifies a different value.

From a clone of this repository, you can inspect or change settings directly:

```bash
# Show the effective settings without starting Codex.
node plugins/check-loop/scripts/codex-invoke.mjs config

# Save user-wide settings.
node plugins/check-loop/scripts/codex-invoke.mjs config \
  --model YOUR_CODEX_MODEL_ID --effort high --max-rounds 6

# Change only the current project's effort.
node plugins/check-loop/scripts/codex-invoke.mjs config --project --effort medium

# Use Codex defaults for this project instead of user-level model and effort overrides.
node plugins/check-loop/scripts/codex-invoke.mjs config \
  --project --model default --effort default
```

Setters preserve the other saved keys. They write user-wide settings unless you pass `--project`. The `setup`, `turn`, and `review` commands also accept temporary `--model` and `--effort` overrides.

## How reviews work

Codex must cite a plan passage, source file, command result, or research source for each finding. Findings carry one of these evidence labels:

- `VERIFIED` means the cited source supports the claim.
- `INFERENCE` means the source suggests a conclusion that has not been reproduced.
- `UNVERIFIED` means the evidence is missing or inaccessible.

Only verified critical or important findings can block progress. The orchestrator checks the citation and records whether it accepts, rejects, or counters the finding. Minor findings, inferences, and unanswered questions remain in the report without blocking the work.

After the first round, a new finding can block only if the revision introduced it or it is a verified critical defect the first round missed. Codex can dispute a rejected finding once, with new evidence. The runner drops repeats of findings that already have a decision.

The reviewer runs in a read-only sandbox on your repository. The scripts redact credential-shaped values from every payload they send and from saved run state. Step reviews omit diffs of files matching `*.env*`, `*.secret*`, `*credentials*`, or `**/secrets/**`, and report which paths they withheld. The reviewer can still open any file on disk, so keep secrets out of the checkout or in ignored paths.

Reviewer turns time out after 20 minutes by default. The scripts retry a failed, empty, malformed, or timed-out response once and then stop the workflow. Such a response never counts as approval.

## Check your setup

From the repository root:

```bash
node plugins/check-loop/scripts/codex-invoke.mjs setup
```

`Status: ready` means the Codex CLI is installed and authenticated. It does not confirm access to a particular model. The first review checks the effective model and effort. Unsupported choices and explicit setting mismatches fail instead of silently selecting a different reviewer.

## Local development

```bash
git clone https://github.com/Novacon/check-loop.git
claude --plugin-dir ./check-loop/plugins/check-loop
```

When working in another project, pass the absolute path to the clone's `plugins/check-loop` directory. Keep the whole plugin directory together. The skills need the scripts alongside them.

The skills live in `plugins/check-loop/skills/`. `scripts/codex-invoke.mjs` handles settings and talks to the Codex App Server over JSON-RPC. Each command starts its own short-lived `codex app-server` process and uses your local Codex login. The plugin has no runtime npm dependencies and needs no separate API key when you use Codex login.

### Call the reviewer directly

```bash
# Run one plan review round. The first call needs the original request.
node plugins/check-loop/scripts/codex-invoke.mjs round \
  --cwd "$(pwd)" --kind plan --artifact plan.md --request-file request.md

# After editing the plan, record decisions and run the next round.
node plugins/check-loop/scripts/codex-invoke.mjs round \
  --cwd "$(pwd)" --artifact plan.md --adjudication-file decisions.json

# Execution: record a step base, implement, then review the delta.
node plugins/check-loop/scripts/codex-invoke.mjs step --cwd "$(pwd)" --plan plan.md --step 1 --begin
node plugins/check-loop/scripts/codex-invoke.mjs step --cwd "$(pwd)" --plan plan.md --step 1 \
  --contract-file step1.md --validation-file validation.txt

# Summarize a review.
node plugins/check-loop/scripts/codex-invoke.mjs report --cwd "$(pwd)" --artifact plan.md

# Free-form turns on a persistent thread.
node plugins/check-loop/scripts/codex-invoke.mjs turn \
  --cwd "$(pwd)" --prompt-file prompt.md [--thread-id THREAD_ID]
```

`round` and `step` print the blocking findings, a one-line summary, and the next action, which is one of `adjudicate`, `stalled`, `cap`, `done`, or `retry`. `step` also lists any changed protected paths it withheld from the reviewer. Run state lives in `~/.claude/check-loop/runs/`. `turn` results include `threadId`, `response`, `model`, `effort`, `status`, and `error`. A status of `0` means the call succeeded, not that the reviewer approved the work.

Successful turns report their effective model and effort, and later rounds reuse them. Native review can use a separate Codex `review_model`. If you did not request a model explicitly, native review reports `model: null` rather than guessing which model ran.

### Run the checks

```bash
node --test tests/
claude plugin validate ./plugins/check-loop
claude plugin validate ./.claude-plugin/marketplace.json
```

The tests cover settings precedence, invalid configuration, reviewer setting mismatches, failed or empty responses, and the review loop's rules: diff-only later rounds, closure gating, repeat suppression, one-time disputes, stall detection, the round limit and closeout, retries, and secret redaction. The step tests cover tree snapshots that skip ignored and protected files, step-scoped diffs, base chaining across steps, the three-fix cap, and a plan that changes mid-execution. None of them need model access. For a live check, use an authenticated Codex CLI and a disposable repository.

## Changes in 5.2.1

- **Faster step snapshots.** The runner copies the repository's index before recording the working tree, so git rehashes only changed files instead of every file. On a 20,000-file repository a snapshot dropped from about 2 seconds to 50 ms, and each `step` call takes two or three. The real index is still never touched.
- **One fewer snapshot per step.** A step review reuses the tree it just reviewed to list omitted protected paths, and the first `--begin` reuses the execution base.
- **Safer execution state.** The execution file is now written through a rename, like review runs, so an interrupted write can't truncate it.

## Changes in 5.2.0

- **Execution runs in code.** A new `step` command records each step's base without staging, diffs the working tree against it, drops protected paths, redacts secrets, and runs the same ledger as plan review. The execute skill is a third of its old length because it no longer describes those mechanics in prose.
- **One app-server per command.** Each command spawns its own short-lived `codex app-server` and exits with it. The shared broker from earlier versions never exited and left a process pair running for every directory it was used in.
- **Smaller scripts.** Removed modules inherited from the upstream Codex plugin that nothing called, and the duplicate CLI probes that ran before every command. The scripts went from about 4,900 lines to 1,900.

## Changes in 5.1.0

- **Uses your session model.** The skills no longer switch to Fable. They run on the model and effort the session uses.
- **Configurable implementer model.** The implementer and fixer subagents in `execute` use the session model by default. Set `--implementer-model ID` in settings to choose another, or `default` to go back.
- **Works in [pi](https://pi.dev).** The repository is also a pi package. See [pi install](#pi).

## Changes in 5.0.0

Reviews were slow and kept finding new problems in text the loop itself had just added. This release changes how rounds work, using ideas from other review tools:

- **Later rounds only check the fixes.** Round 1 is the full review. Later rounds confirm each fix and report only regressions in the changed text or a missed critical defect, following the fix re-review in [Superpowers](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/re-review-prompt.md). The rotating focus areas from 4.1 are gone, because they reopened text that hadn't changed.
- **Diffs instead of the whole plan.** Round 1 sends the full plan or report. Later rounds send only the diff since the last review.
- **The loop runs in code.** A new `round` command builds prompts, requests structured findings, numbers them, keeps the decision ledger, and decides when to stop. It detects stalls the way [Plan Tango](https://github.com/egsok/plan-tango) does, where a stall means the same blockers twice or a fixed finding coming back. It drops repeats and allows one dispute per rejection, as in [Comfy's review ledger](https://github.com/Comfy-Org/github-workflows/tree/main/.github/cursor-review).
- **A confirmation round at the limit.** If a run hits the limit with unconfirmed fixes, you can run one confirmation-only round instead of starting over.
- **Resume.** The runner saves state after each round, so an interrupted review continues where it stopped.
- **Less noise.** One line per round and a short final report, with the full ledger in a file, as in [PGHQ second-opinion](https://github.com/PGHQdev/second-opinion).
- **`--quick`** runs a single review pass.
- **Execution** fix re-reviews send only the fix and the findings being fixed.
- **Reliability.** The transport interrupts reviewer turns after 20 minutes, `turn` accepts `--prompt-file`, and the scripts redact credential-shaped values.

## Changes in 4.1.0

- Choose the reviewer model and effort, or inherit your Codex settings. Astra is no longer required.
- Set the plan and research round limit. Later rounds checked additional risks, with a review rotation inspired by [Claudex](https://github.com/promptadvisers/claudex). 5.0.0 replaced the rotation.
- Treat missing or failed reviews as errors. The response handling draws on the [official Codex plugin's guidance](https://github.com/openai/codex-plugin-cc/blob/main/plugins/codex/skills/codex-result-handling/SKILL.md).
- Fix ignored reviewer flags, missing effort on the initial thread, and truncated prompts containing `=`.

## License

[MIT](LICENSE).
