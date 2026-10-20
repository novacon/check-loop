// Execution review: one persistent reviewer thread per plan, one review run per
// step. The working tree is snapshotted as a git tree object through a temporary
// index, so nothing is staged and ignored files never enter the diff.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRun, redactSecrets, resolveRunFile, runReviewRound, writeJsonAtomic } from "./review-loop.mjs";

const EXECUTION_VERSION = 1;
// Discovery plus three reviewer-driven fix re-reviews.
const STEP_ROUNDS = 4;
const PROTECTED = ["**/*.env*", "**/*.secret*", "**/*credentials*", "**/secrets/**"];
const EXCLUDES = PROTECTED.map((glob) => `:(exclude,glob)${glob}`);

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function git(root, args, env = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Hash of the whole working tree (tracked, modified, and untracked non-ignored files) without touching the index. */
export function snapshotTree(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-loop-index-"));
  try {
    const index = path.join(dir, "index");
    // Seeding from the real index lets `add -A` reuse its stat cache instead of
    // rehashing every file; the copy is discarded, so the real index is untouched.
    const real = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    git(root, ["add", "-A", "--", "."], env);
    return git(root, ["write-tree"], env).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Text diff between two trees with protected paths excluded and binaries summarized. */
export function treeDiff(root, from, to) {
  return from === to ? "" : git(root, ["diff", "--no-color", "--no-ext-diff", "-U3", from, to, "--", ".", ...EXCLUDES]);
}

/** Changed paths between two trees that the diff deliberately omits. */
export function protectedChanges(root, from, to) {
  if (from === to) return [];
  return git(root, ["diff", "--name-only", from, to, "--", ...PROTECTED.map((glob) => `:(glob)${glob}`)]).split("\n").filter(Boolean);
}

export function executionKey(plan) {
  return `${plan}#execution`;
}

export function loadExecution(plan, env = process.env) {
  const file = resolveRunFile(executionKey(plan), env);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function saveExecution(execution, env) {
  return writeJsonAtomic(resolveRunFile(executionKey(execution.plan), env), execution);
}

/**
 * Record a step's base tree before its implementer runs. The first call for a
 * plan also records the execution base. Returns the execution state.
 */
export function beginStep(options) {
  const env = options.env ?? process.env;
  const { execution, plan, created } = loadOrStartExecution(options, env);
  const id = String(options.step);
  const tree = created ? execution.baseTree : snapshotTree(options.root);
  execution.steps[id] = { ...(execution.steps[id] ?? {}), base: tree, outcome: null };
  saveExecution(execution, env);
  return { status: 0, error: null, step: id, baseTree: tree, head: execution.head, executionFile: resolveRunFile(executionKey(plan), env) };
}

function loadOrStartExecution(options, env) {
  const root = options.root;
  const plan = path.resolve(options.cwd, options.plan);
  if (!fs.existsSync(plan)) {
    throw new Error(`Plan not found: ${plan}`);
  }
  const planText = fs.readFileSync(plan, "utf8");
  let execution = options.newExecution ? null : loadExecution(plan, env);
  if (execution && execution.planHash !== sha(planText)) {
    throw new Error("The plan changed since execution started. Pass --new to start a new execution against the current plan.");
  }
  const created = !execution;
  if (created) {
    execution = {
      version: EXECUTION_VERSION,
      plan,
      planHash: sha(planText),
      head: git(root, ["rev-parse", "HEAD"]).trim(),
      baseTree: snapshotTree(root),
      reviewer: { threadId: null, model: null, effort: null },
      settings: { model: options.settings.model, effort: options.settings.effort },
      steps: {},
      startedAt: new Date().toISOString(),
    };
    saveExecution(execution, env);
  }
  return { execution, plan, planText, created };
}

/**
 * Review one step's working-tree delta from the base `beginStep` recorded.
 * `final` reviews everything since the execution base. `transport` is the
 * same reviewer function `runReviewRound` takes.
 */
export async function runStepRound(options) {
  const env = options.env ?? process.env;
  const root = options.root;
  const { execution, plan, planText } = loadOrStartExecution(options, env);

  const id = String(options.step);
  const stepKey = `${plan}#step-${id}`;
  const existing = options.newStep ? null : loadRun(stepKey, env);
  const base = id === "final" ? execution.baseTree : execution.steps[id]?.base;
  if (!base) {
    throw new Error(`Step ${id} has no recorded base. Run \`step --begin\` before dispatching its implementer.`);
  }
  const firstStep = !existing && !Object.values(execution.steps).some((step) => step.outcome);

  let requestText = options.contractText;
  if (!existing && !requestText?.trim()) {
    throw new Error(`Step ${id} needs --contract-file with the step contract.`);
  }
  if (firstStep && requestText) {
    requestText = `Approved plan:\n<plan>\n${planText}\n</plan>\n\nStep contract:\n${requestText}`;
  }

  let latest = null;
  const source = {
    key: stepKey,
    read() {
      const tree = snapshotTree(root);
      latest = tree;
      const redacted = redactSecrets(treeDiff(root, base, tree));
      return { hash: tree, text: redacted.text, redactions: redacted.count };
    },
    delta(reviewed, current) {
      return redactSecrets(treeDiff(root, reviewed.hash, current.hash)).text;
    },
  };

  const result = await runReviewRound({
    cwd: root,
    kind: "step",
    source,
    requestText,
    context: options.validationText,
    adjudication: options.adjudication,
    newRun: options.newStep === true,
    closeout: false,
    settings: { ...execution.settings, maxRounds: STEP_ROUNDS },
    reviewer: execution.reviewer,
    env,
    transport: options.transport,
  });

  const run = loadRun(stepKey, env);
  if (run) {
    execution.reviewer = run.reviewer;
    execution.steps[id] = {
      ...(execution.steps[id] ?? { base }),
      outcome: result.next === "done" ? result.outcome : null,
      ...(result.next === "done" ? { tree: run.reviewed.hash, finishedAt: new Date().toISOString() } : {}),
    };
    saveExecution(execution, env);
  }

  return {
    ...result,
    step: id,
    baseTree: base,
    omittedProtectedPaths: protectedChanges(root, base, latest),
    executionFile: resolveRunFile(executionKey(plan), env),
  };
}
