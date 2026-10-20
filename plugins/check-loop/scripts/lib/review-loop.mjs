// Deterministic review loop for plans and research reports.
//
// The runner owns everything that should not depend on a model following prose:
// prompt construction, secret redaction, the reviewed snapshot and diff, finding
// IDs, the decision ledger, duplicate suppression, the re-raise budget, stall
// detection, round limits, and durable run state. The orchestrator owns evidence checks,
// decisions, and artifact edits.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { userConfigRoot } from "./review-config.mjs";

const RUN_VERSION = 1;
export const KINDS = Object.freeze({
  plan: { noun: "implementation plan", tag: "plan", prefix: "F" },
  research: { noun: "research report", tag: "report", prefix: "R" },
  step: { noun: "implementation step", tag: "diff", prefix: "S" },
});
export const DECISIONS = Object.freeze(["ACCEPT", "REJECT", "COUNTER", "WAIVE"]);
const BLOCKING_SEVERITIES = new Set(["critical", "important"]);
const FIXING_DECISIONS = new Set(["ACCEPT", "COUNTER"]);
// A rejected finding may be disputed once with new evidence; after that the
// rejection stands and further disputes are suppressed (bounded re-raise).
const DISPUTE_BUDGET = 1;

const FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "severity", "evidence_status", "title", "location", "claim", "evidence",
    "impact", "failure_condition", "recommended_correction", "origin", "reraise_of",
  ],
  properties: {
    severity: { type: "string", enum: ["critical", "important", "minor"] },
    evidence_status: { type: "string", enum: ["VERIFIED", "INFERENCE", "UNVERIFIED"] },
    title: { type: "string" },
    location: { type: "string" },
    claim: { type: "string" },
    evidence: { type: "string" },
    impact: { type: "string" },
    failure_condition: { type: "string" },
    recommended_correction: { type: "string" },
    origin: { type: "string", enum: ["new", "regression", "missed"] },
    reraise_of: { type: ["string", "null"] },
  },
};

export const REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "prior", "findings", "questions"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    prior: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "evidence"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["ADDRESSED", "NOT_ADDRESSED", "REJECTION_DISPUTED"] },
          evidence: { type: "string" },
        },
      },
    },
    findings: { type: "array", items: FINDING_SCHEMA },
    questions: { type: "array", items: { type: "string" } },
  },
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"'`,;]{8,})\3/gi;
const ENV_REFERENCE = /^(process\.env|\$\{?|os\.environ|env\.|ENV\[|<)/;

/** Redact credential-shaped values. Returns the redacted text and the count. */
export function redactSecrets(text) {
  let count = 0;
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => {
      count += 1;
      return "<redacted secret>";
    });
  }
  output = output.replace(SECRET_ASSIGNMENT, (match, key, sep, quote, value) => {
    if (ENV_REFERENCE.test(value) || value === "<redacted secret>") {
      return match;
    }
    count += 1;
    return `${key}${sep}${quote}<redacted secret>${quote}`;
  });
  return { text: output, count };
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function resolveRunFile(artifactPath, env = process.env) {
  const key = sha256(path.resolve(artifactPath)).slice(0, 16);
  return path.join(userConfigRoot(env), "check-loop", "runs", `${key}.json`);
}

export function loadRun(artifactPath, env = process.env) {
  const file = resolveRunFile(artifactPath, env);
  if (!fs.existsSync(file)) {
    return null;
  }
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  if (run.version !== RUN_VERSION) {
    throw new Error(`Unsupported check-loop run state version in ${file}. Start over with --new.`);
  }
  return run;
}

/** Write owner-only JSON through a rename so an interrupted write never truncates state. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function saveRun(run, env) {
  run.updatedAt = new Date().toISOString();
  return writeJsonAtomic(resolveRunFile(run.artifact, env), run);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Stable identity for "the same concern" across rounds. Line numbers are
 * dropped because edits shift them while the concern stays the same.
 */
export function fingerprint(finding) {
  const location = String(finding.location ?? "")
    .toLowerCase()
    .replace(/(?:[:#]l?|\bline\s*|\blines\s*)\d+(?:\s*[-–]\s*\d+)?/g, "");
  return sha256(`${normalize(finding.title)}|${normalize(location)}`).slice(0, 16);
}

function isBlockingCandidate(finding) {
  return finding.evidenceStatus === "VERIFIED" && BLOCKING_SEVERITIES.has(finding.severity);
}

function nextId(run) {
  run.nextNumber += 1;
  return `${KINDS[run.kind].prefix}${run.nextNumber}`;
}

function findById(run, id) {
  return run.findings.find((finding) => finding.id === id) ?? null;
}

function toRecord(raw, run, round) {
  return {
    id: nextId(run),
    round,
    severity: raw.severity,
    evidenceStatus: raw.evidence_status,
    title: raw.title,
    location: raw.location,
    claim: raw.claim,
    evidence: raw.evidence,
    impact: raw.impact,
    failureCondition: raw.failure_condition,
    correction: raw.recommended_correction,
    origin: raw.origin,
    reraiseOf: raw.reraise_of ?? null,
    fingerprint: fingerprint(raw),
    blocking: false,
    decision: null,
    reason: null,
    status: "open",
    disputes: 0,
  };
}

// ---------------------------------------------------------------------------
// Reviewer output validation
// ---------------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse and validate the reviewer's structured response. Throws on malformed output. */
export function parseReviewOutput(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Reviewer returned malformed JSON: ${error.message}. This is an incomplete review, not approval.`);
  }
  const fail = (detail) => {
    throw new Error(`Reviewer output violates the finding schema: ${detail}. This is an incomplete review, not approval.`);
  };
  if (!isObject(parsed)) fail("expected an object");
  if (!["approve", "changes"].includes(parsed.verdict)) fail("verdict");
  for (const key of ["prior", "findings", "questions"]) {
    if (!Array.isArray(parsed[key])) fail(key);
  }
  for (const item of parsed.prior) {
    if (!isObject(item) || typeof item.id !== "string") fail("prior.id");
    if (!["ADDRESSED", "NOT_ADDRESSED", "REJECTION_DISPUTED"].includes(item.status)) fail(`prior status for ${item.id}`);
  }
  for (const finding of parsed.findings) {
    if (!isObject(finding)) fail("finding");
    for (const key of FINDING_SCHEMA.required) {
      if (key === "reraise_of") {
        if (finding[key] !== null && typeof finding[key] !== "string") fail("reraise_of");
      } else if (typeof finding[key] !== "string" || !finding[key].trim()) {
        fail(`finding field ${key}`);
      }
    }
    if (!["critical", "important", "minor"].includes(finding.severity)) fail("severity");
    if (!["VERIFIED", "INFERENCE", "UNVERIFIED"].includes(finding.evidence_status)) fail("evidence_status");
    if (!["new", "regression", "missed"].includes(finding.origin)) fail("origin");
  }
  if (parsed.questions.some((question) => typeof question !== "string")) fail("questions");
  return parsed;
}

// ---------------------------------------------------------------------------
// Adjudication
// ---------------------------------------------------------------------------

/**
 * Apply the orchestrator's decisions to the pending blockers. Every pending ID needs a
 * decision and a reason; unknown or non-pending IDs are rejected so a typo
 * cannot silently leave a blocker undecided.
 */
export function applyAdjudication(run, adjudication) {
  if (!isObject(adjudication) || !Array.isArray(adjudication.decisions)) {
    throw new Error('Adjudication must be a JSON object: {"decisions":[{"id":"F1","decision":"ACCEPT","reason":"..."}]}.');
  }
  const pending = new Set(run.pending);
  const seen = new Set();
  for (const entry of adjudication.decisions) {
    if (!isObject(entry) || typeof entry.id !== "string") {
      throw new Error("Each adjudication entry needs an id.");
    }
    if (!pending.has(entry.id)) {
      throw new Error(`${entry.id} is not awaiting adjudication. Pending: ${run.pending.join(", ") || "none"}.`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate adjudication for ${entry.id}.`);
    }
    if (!DECISIONS.includes(entry.decision)) {
      throw new Error(`${entry.id}: decision must be one of ${DECISIONS.join(", ")}.`);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`${entry.id}: a reason citing the checked evidence is required.`);
    }
    seen.add(entry.id);
  }
  const missing = run.pending.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`Missing adjudication for ${missing.join(", ")}.`);
  }

  const fixing = [];
  for (const entry of adjudication.decisions) {
    const finding = findById(run, entry.id);
    finding.decision = entry.decision;
    finding.reason = entry.reason.trim();
    finding.decidedRound = run.round;
    finding.status = FIXING_DECISIONS.has(entry.decision) ? "fixing" : entry.decision === "WAIVE" ? "waived" : "rejected";
    if (FIXING_DECISIONS.has(entry.decision)) {
      fixing.push(finding.id);
    }
  }
  run.pending = [];
  return fixing;
}

// ---------------------------------------------------------------------------
// Applying a review
// ---------------------------------------------------------------------------

/**
 * Fold a validated reviewer response into the run. Returns the round summary.
 * Round 1 is discovery. Later rounds are closure: they confirm fixes, may
 * dispute a rejection once, and may only block on regressions introduced by
 * the changed text or on a missed VERIFIED critical issue. A closeout round
 * blocks on regressions only.
 */
export function applyReview(run, output, { round, closeout = false }) {
  const discovery = round === 1;
  const addressed = [];
  const notAddressed = [];
  const disputed = [];
  const unknownPrior = [];

  for (const verdict of output.prior) {
    const finding = findById(run, verdict.id);
    if (!finding) {
      unknownPrior.push(verdict.id);
      continue;
    }
    if (verdict.status === "ADDRESSED" && finding.status === "fixing") {
      finding.status = "addressed";
      finding.confirmedRound = round;
      addressed.push(finding.id);
    } else if (verdict.status === "NOT_ADDRESSED" && finding.status === "fixing") {
      finding.status = "not_addressed";
      finding.reviewerNote = verdict.evidence;
      notAddressed.push(finding.id);
    } else if (verdict.status === "REJECTION_DISPUTED" && finding.status === "rejected" && finding.disputes < DISPUTE_BUDGET) {
      finding.disputes += 1;
      finding.status = "disputed";
      finding.reviewerNote = verdict.evidence;
      disputed.push(finding.id);
    }
  }
  // Fixes the reviewer never confirmed stay visible rather than being assumed.
  const unconfirmed = run.findings
    .filter((finding) => finding.status === "fixing")
    .map((finding) => finding.id);

  const fresh = [];
  const notes = [];
  let suppressed = 0;
  const reappeared = [];
  for (const raw of output.findings) {
    const print = fingerprint(raw);
    const prior = run.findings.find((finding) => finding.fingerprint === print);
    const reraised = raw.reraise_of ? findById(run, raw.reraise_of) : null;
    const target = reraised ?? prior;
    if (target) {
      if (target.status === "addressed") {
        reappeared.push(target.id);
      } else if (target.status === "rejected" && target.disputes < DISPUTE_BUDGET) {
        target.disputes += 1;
        target.status = "disputed";
        target.reviewerNote = raw.evidence;
        disputed.push(target.id);
        continue;
      }
      if (target.status !== "addressed") {
        suppressed += 1;
        continue;
      }
    }

    const finding = toRecord(raw, run, round);
    const eligible = discovery
      || (closeout ? finding.origin === "regression" : finding.origin === "regression" || (finding.origin === "missed" && finding.severity === "critical"));
    finding.blocking = eligible && isBlockingCandidate(finding);
    finding.status = finding.blocking ? "pending" : "note";
    run.findings.push(finding);
    (finding.blocking ? fresh : notes).push(finding.id);
  }

  const pending = [...fresh, ...notAddressed, ...disputed];
  for (const id of [...notAddressed, ...disputed]) {
    findById(run, id).status = "pending";
  }
  run.pending = pending;
  run.questions = output.questions;

  // Stalled: the same blocker set survives two closure rounds in a row
  // (plan-tango's identical-consecutive-set rule; round 1 is skipped so one
  // failed fix gets one retry), or a confirmed fix reappears.
  const candidatePrints = pending.map((id) => findById(run, id).fingerprint).sort();
  const previous = run.history.at(-1);
  const repeated = candidatePrints.length > 0
    && previous?.round >= 2
    && previous.candidates.length === candidatePrints.length
    && previous.candidates.every((print, index) => print === candidatePrints[index]);
  const stalled = repeated || reappeared.length > 0;

  run.history.push({
    round,
    closeout,
    at: new Date().toISOString(),
    verdict: output.verdict,
    candidates: candidatePrints,
    addressed,
    notAddressed,
    disputed,
    unconfirmed,
    newBlockers: fresh,
    notes,
    suppressed,
    reappeared,
    unknownPrior,
  });

  return { addressed, notAddressed, disputed, unconfirmed, fresh, notes, suppressed, reappeared, unknownPrior, stalled };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const EVIDENCE_RULES = `Evidence rules:
- Cite an exact quote, a file:line you actually inspected, a source you actually opened, or command output you actually observed.
- VERIFIED: the cited source directly supports the claim. INFERENCE: cited facts support a conclusion that has not been reproduced. UNVERIFIED: evidence is missing or inaccessible.
- Never label a claim VERIFIED because it sounds likely. Severity, confidence, and repetition are not evidence.
- Only VERIFIED critical or important findings can block. Report minor items only when they are concrete.
- Ignore toolchain markers and agent-framework metadata that are not requirements.
- Use a short, stable title per concern; reuse the same title if you mention the same concern again.`;

const OUTPUT_RULES = `Respond with JSON matching the provided schema:
- verdict: "approve" when no VERIFIED critical or important concern remains, otherwise "changes".
- prior: one entry per finding listed under "Findings to confirm" (empty in round 1).
- findings: new concerns only. Do not restate a prior finding; dispute it through prior instead.
- questions: context you need that would change a finding.`;

function planCriteria() {
  return `Check every applicable risk: architecture and correctness, security and data integrity, operations and recovery (rollback, observability, compatibility), scope, evidence quality, edge cases, and unnecessary complexity. Hunt for design flaws, broken assumptions, ambiguous requirements, hand-waved hard parts, and plans that solve the wrong problem or add needless machinery. Report everything material now: later rounds only confirm fixes and check the changed text, so this is the one broad pass.`;
}

function researchCriteria() {
  return `Check every applicable research criterion: factual accuracy and whether citations support the exact claims; primary-source quality, currency, and relevance; missing material counterevidence or perspectives; internal consistency and reasoning gaps; conclusions stronger than the evidence; important unresolved questions hidden by confident wording. Do not invent sources, quotations, or browsing results; if you cannot open a source, mark the finding UNVERIFIED. Report everything material now: later rounds only confirm corrections and check the changed text, so this is the one broad pass.`;
}

function stepCriteria() {
  return `Review the diff against the step contract: correctness, the contract's acceptance criteria, repository conventions and instructions, security and data integrity, and scope creep. Open the repository files for surrounding context; the diff is the only change under review. Do not open files matching *.env*, *.secret*, *credentials*, or **/secrets/**; changes to such paths are deliberately omitted. Use the observed validation output as evidence; do not assume checks passed that were not run. Report everything material now: later rounds only confirm fixes and check the fix delta.`;
}

const CRITERIA = { plan: planCriteria, research: researchCriteria, step: stepCriteria };

function contextBlock(context) {
  return context?.trim() ? `\nContext for this round:\n<context>\n${context.trim()}\n</context>\n` : "";
}

export function buildDiscoveryPrompt(run, artifactText, context = "") {
  const kind = KINDS[run.kind];
  const where = run.kind === "step" ? `Working tree: ${run.cwd}.` : `The ${kind.tag} file is ${run.artifact}.`;
  return `Act as Codex, the adversarial reviewer of a ${kind.noun} owned by the orchestrator. Review only; do not edit files or rewrite the ${kind.tag}.

Round 1 of ${run.settings.maxRounds} (discovery).

${CRITERIA[run.kind]()}

${EVIDENCE_RULES}

Mark every finding origin "new" and reraise_of null.

${OUTPUT_RULES}

${where}

Original request:
<request>
${run.request}
</request>
${contextBlock(context)}
${kind.tag[0].toUpperCase()}${kind.tag.slice(1)}:
<${kind.tag}>
${artifactText}
</${kind.tag}>`;
}

function describeForConfirmation(finding) {
  return `- ${finding.id} [${finding.severity}] ${finding.title} (${finding.location}) — orchestrator: ${finding.decision}: ${finding.reason}`;
}

export function buildClosurePrompt(run, diffText, { round, closeout, context = "" }) {
  const kind = KINDS[run.kind];
  const toConfirm = run.findings.filter((finding) => finding.status === "fixing");
  const rejected = run.findings.filter((finding) => finding.status === "rejected" && finding.disputes < DISPUTE_BUDGET);
  const settled = run.findings.filter((finding) => ["addressed", "waived"].includes(finding.status)
    || (finding.status === "rejected" && finding.disputes >= DISPUTE_BUDGET));
  const scope = closeout
    ? `This is a closeout round: confirm the fixes and report only regressions introduced by the changed text. Do not report anything else.`
    : `This is a closure round, not a fresh review. Do not re-review unchanged text. Report a new finding only when:
- origin "regression": the changed text introduced it (cite the diff), or
- origin "missed": it is a VERIFIED critical defect that round 1 missed.
Anything else is out of scope for this round.`;

  return `Round ${round} of ${run.settings.maxRounds}${closeout ? " (closeout)" : " (closure)"}. The orchestrator independently checked every cited source and revised the ${kind.tag}.

${scope}

Findings to confirm (one prior entry each: ADDRESSED or NOT_ADDRESSED, with evidence from the current text):
${toConfirm.map(describeForConfirmation).join("\n") || "- none"}

Rejected findings (you may answer REJECTION_DISPUTED once, only with new evidence the orchestrator missed; otherwise omit them):
${rejected.map(describeForConfirmation).join("\n") || "- none"}

Settled (do not raise again):
${settled.map((finding) => `- ${finding.id} ${finding.title}`).join("\n") || "- none"}

${EVIDENCE_RULES}

${OUTPUT_RULES}
${contextBlock(context)}
Changes since your last review${run.kind === "step" ? "" : ` of ${run.artifact} (read the file for surrounding context)`}:
<diff>
${diffText || "(no textual changes)"}
</diff>`;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Unified diff from the last reviewed snapshot to the current text. */
export function unifiedDiff(before, after, label) {
  if (before === after) {
    return "";
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-loop-diff-"));
  try {
    const a = path.join(dir, "reviewed");
    const b = path.join(dir, "current");
    fs.writeFileSync(a, before);
    fs.writeFileSync(b, after);
    const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", a, b], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error(`Could not diff the ${label}: ${result.error?.message ?? result.stderr}`);
    }
    const hunks = result.stdout.slice(result.stdout.indexOf("\n@@") + 1);
    return `--- reviewed/${label}\n+++ current/${label}\n${hunks}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function lineDelta(before, after) {
  const diff = unifiedDiff(before, after, "artifact");
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n").slice(2)) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Round orchestration
// ---------------------------------------------------------------------------

function blockerView(finding) {
  return {
    id: finding.id,
    severity: finding.severity,
    evidenceStatus: finding.evidenceStatus,
    origin: finding.origin,
    title: finding.title,
    location: finding.location,
    claim: finding.claim,
    evidence: finding.evidence,
    impact: finding.impact,
    failureCondition: finding.failureCondition,
    correction: finding.correction,
    priorDecision: finding.decision,
    priorReason: finding.reason,
    reviewerNote: finding.reviewerNote ?? null,
  };
}

function noteView(finding) {
  return `${finding.id} [${finding.severity}/${finding.evidenceStatus}] ${finding.title}`;
}

// A fix the reviewer never confirmed is not silently counted as reviewed.
function convergedOutcome(run) {
  const unconfirmed = run.findings.filter((finding) => finding.status === "fixing").length;
  return unconfirmed ? `CONVERGED — ${unconfirmed} FIX(ES) UNCONFIRMED` : "CONVERGED";
}

function finish(run, status, env) {
  run.outcome = status;
  run.pending = [];
  return saveRun(run, env);
}

function result(run, fields, env, runFile) {
  return {
    status: 0,
    error: null,
    round: run.round,
    maxRounds: run.settings.maxRounds,
    reviewer: { model: run.reviewer.model, effort: run.reviewer.effort },
    runFile: runFile ?? resolveRunFile(run.artifact, env),
    ...fields,
  };
}

/** The default source: a Markdown file. Snapshots are stored redacted; the hash tracks the raw text. */
function fileSource(cwd, artifact) {
  const file = path.resolve(cwd, artifact);
  if (!fs.existsSync(file)) {
    throw new Error(`Artifact not found: ${file}`);
  }
  const label = path.relative(cwd, file) || path.basename(file);
  return {
    key: file,
    read() {
      const text = fs.readFileSync(file, "utf8");
      const redacted = redactSecrets(text);
      return { hash: sha256(text), text: redacted.text, redactions: redacted.count };
    },
    delta(reviewed, current) {
      return unifiedDiff(reviewed.text, current.text, label);
    },
  };
}

/**
 * Run one review step for an artifact. `transport(prompt, {threadId, model,
 * effort, outputSchema})` performs the reviewer turn and returns the
 * codex-invoke turn result shape. `source` supplies `{key, read(), delta()}`;
 * it defaults to the artifact file.
 */
export async function runReviewRound(options) {
  const env = options.env ?? process.env;
  const source = options.source ?? fileSource(options.cwd, options.artifact);
  const artifact = source.key;
  const current = source.read();
  let run = options.newRun ? null : loadRun(artifact, env);

  if (run && run.outcome && !options.closeout) {
    throw new Error(`The review of ${artifact} already finished (${run.outcome}). Use --new to start over${run.round >= run.settings.maxRounds && !run.closeoutUsed ? " or --closeout to confirm unreviewed fixes" : ""}.`);
  }

  if (!run) {
    if (!KINDS[options.kind]) {
      throw new Error("--kind must be plan or research.");
    }
    if (typeof options.requestText !== "string" || !options.requestText.trim()) {
      throw new Error("A new review needs --request-file with the original request.");
    }
    if (options.adjudication) {
      throw new Error("A new review has nothing to adjudicate yet.");
    }
    run = {
      version: RUN_VERSION,
      kind: options.kind,
      artifact,
      cwd: options.cwd,
      request: redactSecrets(options.requestText.trim()).text,
      settings: { ...options.settings },
      reviewer: { threadId: null, model: null, effort: null, ...options.reviewer },
      round: 0,
      closeoutUsed: false,
      nextNumber: 0,
      original: null,
      reviewed: null,
      findings: [],
      pending: [],
      questions: [],
      history: [],
      outcome: null,
      startedAt: new Date().toISOString(),
    };
  } else if (options.kind && options.kind !== run.kind) {
    throw new Error(`This run reviews a ${run.kind}, not a ${options.kind}.`);
  }

  // 1. Record the orchestrator's decisions on the previous round's blockers.
  let decidedFixes = [];
  if (run.pending.length > 0) {
    if (!options.adjudication) {
      throw new Error(`Adjudicate ${run.pending.join(", ")} first (--adjudication-file).`);
    }
    decidedFixes = applyAdjudication(run, options.adjudication);
  } else if (options.adjudication && options.adjudication.decisions?.length) {
    throw new Error("Nothing is awaiting adjudication.");
  }

  const changed = run.reviewed !== null && current.hash !== run.reviewed.hash;
  const fixing = run.findings.filter((finding) => finding.status === "fixing");

  // 2. Decide whether another reviewer turn is needed at all.
  if (run.round > 0 && !options.closeout) {
    if (decidedFixes.length === 0) {
      const outcome = convergedOutcome(run);
      const runFile = finish(run, outcome, env);
      return result(run, { next: "done", outcome, summary: `No verified blocker remains after ${run.round} round(s).` }, env, runFile);
    }
    if (!changed) {
      throw new Error(`Accepted ${decidedFixes.join(", ")} but ${path.basename(artifact)} is unchanged. Apply the fixes first.`);
    }
    if (run.round >= run.settings.maxRounds) {
      const runFile = finish(run, "FIXES APPLIED — UNCONFIRMED", env);
      return result(run, {
        next: "cap",
        outcome: "FIXES APPLIED — UNCONFIRMED",
        unconfirmed: fixing.map((finding) => finding.id),
        summary: `Round limit reached. Fixes for ${fixing.map((finding) => finding.id).join(", ")} are applied but unreviewed.`,
      }, env, runFile);
    }
  }

  if (options.closeout) {
    if (run.round === 0 || run.round < run.settings.maxRounds) {
      throw new Error("--closeout is only for confirming fixes after the round limit.");
    }
    if (run.closeoutUsed) {
      throw new Error("The closeout round was already used for this review.");
    }
    if (fixing.length === 0) {
      throw new Error("There are no unconfirmed fixes to close out.");
    }
    run.outcome = null;
  }

  // 3. Build the payload. Round 1 sends the whole artifact once; later rounds
  // send only the diff since the last reviewed text plus the open ledger.
  const round = run.round + 1;
  const context = options.context ?? "";
  const prompt = round === 1
    ? buildDiscoveryPrompt(run, current.text, context)
    : buildClosurePrompt(run, source.delta(run.reviewed, current), { round, closeout: Boolean(options.closeout), context });
  const redacted = redactSecrets(prompt);

  const turn = await options.transport(redacted.text, {
    threadId: run.reviewer.threadId,
    model: run.reviewer.threadId ? run.reviewer.model : run.settings.model,
    effort: run.reviewer.threadId ? run.reviewer.effort : run.settings.effort,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
  });
  if (turn.status !== 0) {
    // Nothing is recorded, so rerunning the same command retries this round.
    return {
      status: 1,
      error: turn.error ?? "Reviewer turn failed. This is an incomplete review, not approval.",
      round: run.round,
      maxRounds: run.settings.maxRounds,
      next: "retry",
      runFile: resolveRunFile(artifact, env),
    };
  }
  const output = parseReviewOutput(turn.response);

  // 4. Fold the review into the ledger and decide the next step in code.
  run.reviewer = {
    threadId: turn.threadId ?? run.reviewer.threadId,
    model: turn.model ?? run.reviewer.model ?? null,
    effort: turn.effort ?? run.reviewer.effort ?? null,
  };
  const redactions = redacted.count + (current.redactions ?? 0);
  delete current.redactions;
  if (round === 1) {
    run.original = current;
  }
  run.reviewed = current;
  run.round = round;
  if (options.closeout) {
    run.closeoutUsed = true;
  }
  const summary = applyReview(run, output, { round, closeout: Boolean(options.closeout) });

  let next;
  let outcome = null;
  if (run.pending.length === 0) {
    next = "done";
    outcome = convergedOutcome(run);
    run.outcome = outcome;
  } else if (summary.stalled) {
    next = "stalled";
  } else if (round >= run.settings.maxRounds) {
    next = "adjudicate-final";
  } else {
    next = "adjudicate";
  }
  const runFile = saveRun(run, env);

  const parts = [
    summary.addressed.length ? `${summary.addressed.length} fixed` : null,
    summary.notAddressed.length ? `${summary.notAddressed.length} not fixed (${summary.notAddressed.join(", ")})` : null,
    summary.disputed.length ? `${summary.disputed.length} rejection(s) disputed (${summary.disputed.join(", ")})` : null,
    summary.fresh.length ? `${summary.fresh.length} new blocker(s) (${summary.fresh.join(", ")})` : null,
    summary.notes.length ? `${summary.notes.length} note(s)` : null,
    summary.suppressed ? `${summary.suppressed} repeat(s) suppressed` : null,
    summary.reappeared.length ? `fixed finding(s) reappeared (${summary.reappeared.join(", ")})` : null,
  ].filter(Boolean);

  return result(run, {
    next,
    outcome,
    summary: `Round ${round}/${run.settings.maxRounds}${options.closeout ? " closeout" : ""}${round === 1 ? ` (reviewer ${run.reviewer.model ?? "Codex default"}/${run.reviewer.effort ?? "Codex default"})` : ""}: ${parts.join(", ") || "no findings"}.`,
    blockers: run.pending.map((id) => blockerView(findById(run, id))),
    notes: summary.notes.map((id) => noteView(findById(run, id))),
    unconfirmed: summary.unconfirmed,
    questions: output.questions,
    redactions,
    stalled: summary.stalled,
  }, env, runFile);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Compact final summary for the user. The run file holds the full ledger. */
export function renderReport(run, env = process.env) {
  const kind = KINDS[run.kind];
  const lines = [];
  const status = run.outcome ?? (run.pending.length ? `AWAITING ADJUDICATION (${run.pending.join(", ")})` : "IN PROGRESS");
  lines.push(`**${status}** — ${run.round}/${run.settings.maxRounds} round(s)${run.closeoutUsed ? " + closeout" : ""}; reviewer ${run.reviewer.model ?? "Codex default"} / ${run.reviewer.effort ?? "Codex default"}.`);
  if (run.original && run.kind !== "step") {
    const current = fs.existsSync(run.artifact) ? redactSecrets(fs.readFileSync(run.artifact, "utf8")).text : run.reviewed?.text ?? "";
    const { added, removed } = lineDelta(run.original.text, current);
    lines.push(`${path.basename(run.artifact)}: +${added} −${removed} lines since round 1.`);
  }

  const group = (label, filter, render) => {
    const items = run.findings.filter(filter);
    if (items.length) {
      lines.push("", `${label}:`);
      for (const finding of items) lines.push(`- ${render(finding)}`);
    }
  };
  group("Changed", (f) => ["addressed", "fixing"].includes(f.status) && FIXING_DECISIONS.has(f.decision),
    (f) => `${f.id} ${f.title}${f.decision === "COUNTER" ? " (countered)" : ""}${f.status === "fixing" ? " — fix not yet confirmed by reviewer" : ""}`);
  group("Rejected", (f) => f.status === "rejected", (f) => `${f.id} ${f.title} — ${f.reason}`);
  group("Waived by user", (f) => f.status === "waived", (f) => `${f.id} ${f.title} — ${f.reason}`);
  group("Still blocking", (f) => ["pending", "not_addressed", "disputed"].includes(f.status), (f) => `${f.id} [${f.severity}] ${f.title}`);
  group("Nonblocking notes", (f) => f.status === "note", (f) => `${f.id} [${f.severity}/${f.evidenceStatus}] ${f.title}`);
  if (run.questions?.length) {
    lines.push("", "Open questions:");
    for (const question of run.questions) lines.push(`- ${question}`);
  }
  lines.push("", `Full ${kind.tag} review ledger: ${resolveRunFile(run.artifact, env)}`);
  return lines.join("\n");
}
