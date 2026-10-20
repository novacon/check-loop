#!/usr/bin/env node

/**
 * CLI wrapper around the Codex App Server transport.
 *
 * Reviewer settings are resolved per key from command options, project
 * configuration, user configuration, and finally Codex/default plugin values.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import {
  getCodexAvailability,
  getCodexLoginStatus,
  runAppServerReview,
  runAppServerTurn,
} from "./lib/codex.mjs";
import { resolveReviewTarget } from "./lib/git.mjs";
import { resolveReviewConfig, updateReviewConfig } from "./lib/review-config.mjs";
import { loadRun, renderReport, runReviewRound } from "./lib/review-loop.mjs";
import { beginStep, runStepRound } from "./lib/step.mjs";
import { buildReviewResult } from "./lib/review-result.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseMaxRounds(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error("Invalid maximum review rounds: expected an integer from 1 through 40.");
  }
  const maxRounds = Number(value);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 40) {
    throw new Error("Invalid maximum review rounds: expected an integer from 1 through 40.");
  }
  return maxRounds;
}

function reviewOverrides(options, includeMaxRounds = false) {
  const overrides = {};
  for (const key of ["model", "effort"]) {
    if (hasOwn(options, key)) {
      overrides[key] = options[key] === "default" ? null : options[key];
    }
  }
  if (includeMaxRounds && hasOwn(options, "max-rounds")) {
    overrides.maxRounds = parseMaxRounds(options["max-rounds"]);
  }
  return overrides;
}

function displaySetting(value) {
  return value ?? "Codex default";
}

const DEFAULT_TIMEOUT_MINUTES = 20;

function parseTimeoutMs(options) {
  const raw = options["timeout-minutes"];
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MINUTES * 60_000;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 240) {
    throw new Error("Invalid --timeout-minutes: expected an integer from 1 through 240.");
  }
  return Number(raw) * 60_000;
}

function readPrompt(options, command) {
  if (options.prompt !== undefined && options["prompt-file"] !== undefined) {
    throw new Error(`Invalid ${command} options: use either --prompt or --prompt-file, not both.`);
  }
  if (options["prompt-file"] !== undefined) {
    const file = options["prompt-file"];
    return fs.readFileSync(file === "-" ? 0 : path.resolve(process.cwd(), file), "utf8");
  }
  return options.prompt;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} ${file}: ${error.message}`);
  }
}

function writeProgress(message) {
  process.stderr.write(`[codex] ${message}\n`);
}

function writePayload(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (payload.status !== 0) {
    process.stderr.write(`[codex] ${payload.error}\n`);
    process.exitCode = 1;
  }
}

function writeCommandResult(result, response) {
  writePayload(buildReviewResult(result, response));
}

/** The read-only, persistent reviewer turn that `round` and `step` drive. */
function reviewTransport(root, timeoutMs) {
  return async (prompt, turn) => {
    const result = await runAppServerTurn(root, {
      resumeThreadId: turn.threadId,
      prompt,
      model: turn.model,
      effort: turn.effort,
      outputSchema: turn.outputSchema,
      sandbox: "read-only",
      persistThread: true,
      timeoutMs,
      onProgress: writeProgress,
    });
    return buildReviewResult(result, result.finalMessage);
  };
}

// ---------------------------------------------------------------------------
// turn -- start or continue a Codex conversation
// ---------------------------------------------------------------------------

async function handleTurn(argv) {
  const options = parseArgs(argv, {
    valueOptions: ["prompt", "prompt-file", "thread-id", "cwd", "model", "effort", "timeout-minutes"],
  }, "turn");

  const prompt = readPrompt(options, "turn");
  if (!prompt?.trim()) {
    throw new Error(
      "Usage: node codex-invoke.mjs turn (--prompt <text> | --prompt-file <path|->) [--thread-id <id>] [--cwd <path>] [--model <id|default>] [--effort <level|default>] [--timeout-minutes <n>]"
    );
  }

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = resolveReviewConfig(cwd, reviewOverrides(options));

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId: options["thread-id"] ?? null,
    prompt,
    model: config.model,
    effort: config.effort,
    sandbox: "read-only",
    persistThread: true,
    timeoutMs: parseTimeoutMs(options),
    onProgress: writeProgress,
  });

  writeCommandResult(result, result.finalMessage);
}

// ---------------------------------------------------------------------------
// round -- one deterministic plan or research review round
// ---------------------------------------------------------------------------

async function handleRound(argv) {
  const options = parseArgs(argv, {
    valueOptions: [
      "kind", "artifact", "request-file", "adjudication-file", "cwd",
      "model", "effort", "max-rounds", "timeout-minutes",
    ],
    booleanOptions: ["new", "closeout"],
  }, "round");

  if (!options.artifact) {
    throw new Error(
      "Usage: node codex-invoke.mjs round --artifact <path> [--kind plan|research] [--request-file <path>] [--adjudication-file <path>] [--new] [--closeout] [--model <id|default>] [--effort <level|default>] [--max-rounds <1..40>] [--timeout-minutes <n>] [--cwd <path>]"
    );
  }

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const overrides = reviewOverrides(options, true);
  const existing = options.new ? null : loadRun(path.resolve(cwd, options.artifact));
  if (existing && Object.keys(overrides).length > 0) {
    throw new Error("Reviewer settings are frozen for a run in progress. Pass --new to start over with different settings.");
  }
  const timeoutMs = parseTimeoutMs(options);

  writePayload(await runReviewRound({
    cwd,
    artifact: options.artifact,
    kind: options.kind,
    newRun: options.new === true,
    closeout: options.closeout === true,
    requestText: options["request-file"] ? fs.readFileSync(path.resolve(cwd, options["request-file"]), "utf8") : undefined,
    adjudication: options["adjudication-file"] ? readJsonFile(options["adjudication-file"], "adjudication file") : null,
    settings: existing ? undefined : resolveReviewConfig(cwd, overrides),
    transport: reviewTransport(workspaceRoot, timeoutMs),
  }));
}

// ---------------------------------------------------------------------------
// step -- review one execution step's working-tree delta
// ---------------------------------------------------------------------------

async function handleStep(argv) {
  const options = parseArgs(argv, {
    valueOptions: ["plan", "step", "contract-file", "validation-file", "adjudication-file", "cwd", "timeout-minutes"],
    booleanOptions: ["begin", "new", "new-step"],
  }, "step");
  if (!options.plan || !options.step) {
    throw new Error(
      "Usage: node codex-invoke.mjs step --plan <path> --step <N|final> (--begin | [--contract-file <path>] [--validation-file <path>] [--adjudication-file <path>] [--new-step]) [--new] [--timeout-minutes <n>] [--cwd <path>]"
    );
  }
  const cwd = resolveCwd(options);
  const root = resolveWorkspaceRoot(cwd);
  if (options.begin) {
    const payload = beginStep({ cwd, root, plan: options.plan, step: options.step, newExecution: options.new === true, settings: resolveReviewConfig(cwd) });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const timeoutMs = parseTimeoutMs(options);
  const readText = (key) => (options[key] ? fs.readFileSync(path.resolve(cwd, options[key]), "utf8") : undefined);

  writePayload(await runStepRound({
    cwd,
    root,
    plan: options.plan,
    step: options.step,
    contractText: readText("contract-file"),
    validationText: readText("validation-file"),
    adjudication: options["adjudication-file"] ? readJsonFile(options["adjudication-file"], "adjudication file") : null,
    newExecution: options.new === true,
    newStep: options["new-step"] === true,
    settings: resolveReviewConfig(cwd),
    transport: reviewTransport(root, timeoutMs),
  }));
}

function handleReport(argv) {
  const options = parseArgs(argv, { valueOptions: ["artifact", "plan", "step", "cwd"] }, "report");
  const cwd = resolveCwd(options);
  let key;
  if (options.plan && options.step) {
    key = `${path.resolve(cwd, options.plan)}#step-${options.step}`;
  } else if (options.artifact) {
    key = path.resolve(cwd, options.artifact);
  } else {
    throw new Error("Usage: node codex-invoke.mjs report (--artifact <path> | --plan <path> --step <N|final>) [--cwd <path>]");
  }
  const run = loadRun(key);
  if (!run) {
    throw new Error(`No check-loop review found for ${options.artifact ?? `${options.plan} step ${options.step}`}.`);
  }
  process.stdout.write(`${renderReport(run)}\n`);
}

// ---------------------------------------------------------------------------
// review -- native Codex code review via review/start
// ---------------------------------------------------------------------------

async function handleReview(argv) {
  const options = parseArgs(argv, {
    valueOptions: ["scope", "base", "cwd", "model", "effort", "timeout-minutes"],
  }, "review");

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = resolveReviewConfig(cwd, reviewOverrides(options));

  const target = resolveReviewTarget(cwd, { base: options.base ?? null, scope: options.scope ?? "auto" });
  const nativeTarget = target.mode === "working-tree"
    ? { type: "uncommittedChanges" }
    : { type: "baseBranch", branch: target.baseRef };

  const result = await runAppServerReview(workspaceRoot, {
    target: nativeTarget,
    model: config.model,
    effort: config.effort,
    timeoutMs: parseTimeoutMs(options),
    onProgress: writeProgress,
  });

  writeCommandResult(result, result.reviewText);
}

// ---------------------------------------------------------------------------
// setup -- verify Codex CLI readiness
// ---------------------------------------------------------------------------

function handleSetup(argv) {
  const options = parseArgs(argv, {
    valueOptions: ["cwd", "model", "effort", "max-rounds"],
  }, "setup");

  const cwd = resolveCwd(options);
  const config = resolveReviewConfig(cwd, reviewOverrides(options, true));
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = codexStatus.available ? getCodexLoginStatus(cwd) : { loggedIn: false, detail: codexStatus.detail };

  const lines = [
    "# Codex Setup (check-loop)",
    "",
    `Model: ${displaySetting(config.model)}`,
    `Reasoning effort: ${displaySetting(config.effort)}`,
    `Maximum review rounds: ${config.maxRounds}`,
    "Model availability is checked when a review starts; setup checks installation and authentication only.",
    "",
    "Checks:",
    `- codex CLI: ${codexStatus.available ? "installed" : "NOT FOUND"} -- ${codexStatus.detail}`,
    `- auth: ${authStatus.loggedIn ? "authenticated" : "NOT AUTHENTICATED"} -- ${authStatus.detail}`,
    "",
  ];

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!codex login` to authenticate.");
    nextSteps.push("If browser login is blocked, try `!codex login --device-auth` or `!codex login --with-api-key`.");
  }

  if (nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  } else {
    lines.push("Status: ready");
  }

  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
  if (!codexStatus.available || !authStatus.loggedIn) {
    process.exitCode = 1;
  }
}

function handleConfig(argv) {
  const options = parseArgs(argv, {
    valueOptions: ["cwd", "model", "effort", "max-rounds", "implementer-model"],
    booleanOptions: ["project"],
  }, "config");

  const cwd = resolveCwd(options);
  const updates = reviewOverrides(options, true);
  if (hasOwn(options, "implementer-model")) {
    const value = options["implementer-model"];
    updates.implementerModel = value === "default" ? null : value;
  }
  const config = Object.keys(updates).length > 0
    ? updateReviewConfig(cwd, updates, { project: options.project === true })
    : resolveReviewConfig(cwd);
  process.stdout.write(`${JSON.stringify(config)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    process.stdout.write([
      "Usage:",
      "  node codex-invoke.mjs config [--cwd <path>] [--project] [--model <id|default>] [--effort <level|default>] [--max-rounds <1..40>] [--implementer-model <id|default>]",
      "  node codex-invoke.mjs round --artifact <path> [--kind plan|research] [--request-file <path>] [--adjudication-file <path>] [--new] [--closeout] [--model <id|default>] [--effort <level|default>] [--max-rounds <1..40>] [--timeout-minutes <n>] [--cwd <path>]",
      "  node codex-invoke.mjs step --plan <path> --step <N> --begin [--new] [--cwd <path>]",
      "  node codex-invoke.mjs step --plan <path> --step <N|final> [--contract-file <path>] [--validation-file <path>] [--adjudication-file <path>] [--new-step] [--timeout-minutes <n>] [--cwd <path>]",
      "  node codex-invoke.mjs report (--artifact <path> | --plan <path> --step <N|final>) [--cwd <path>]",
      "  node codex-invoke.mjs turn (--prompt <text> | --prompt-file <path|->) [--thread-id <id>] [--cwd <path>] [--model <id|default>] [--effort <level|default>] [--timeout-minutes <n>]",
      "  node codex-invoke.mjs review [--scope <auto|working-tree|branch>] [--base <ref>] [--cwd <path>] [--model <id|default>] [--effort <level|default>] [--timeout-minutes <n>]",
      "  node codex-invoke.mjs setup [--cwd <path>] [--model <id|default>] [--effort <level|default>] [--max-rounds <1..40>]",
      "",
      "Reviewer model and effort default to the effective Codex settings. Reviewer turns time out after 20 minutes by default.",
      "Implementer model defaults to the session model (null); it is only read by the execute skill.",
      "",
    ].join("\n"));
    return;
  }

  switch (subcommand) {
    case "config":
      handleConfig(argv);
      break;
    case "round":
      await handleRound(argv);
      break;
    case "step":
      await handleStep(argv);
      break;
    case "report":
      handleReport(argv);
      break;
    case "turn":
      await handleTurn(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "setup":
      handleSetup(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}. Use: config, round, step, report, turn, review, setup`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
