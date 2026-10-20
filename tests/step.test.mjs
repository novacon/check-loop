import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { beginStep, loadExecution, protectedChanges, runStepRound, snapshotTree, treeDiff } from "../plugins/check-loop/scripts/lib/step.mjs";

function finding(overrides = {}) {
  return {
    severity: "important", evidence_status: "VERIFIED", title: "Off by one", location: "src/a.js:1",
    claim: "Loop skips the last item.", evidence: "+for (i < n - 1)", impact: "Last item unprocessed.",
    failure_condition: "Any list.", recommended_correction: "Use i < n.", origin: "new", reraise_of: null, ...overrides,
  };
}
const review = (body) => JSON.stringify({ verdict: "changes", prior: [], findings: [], questions: [], ...body });

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "check-loop-step-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  sh("init", "-q");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "t");
  writeFileSync(join(root, "plan.md"), "# Plan\n1. Fix the loop.\n");
  writeFileSync(join(root, "src.js"), "for (i < n - 1)\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  sh("add", "-A");
  sh("commit", "-qm", "init");
  const config = mkdtempSync(join(tmpdir(), "check-loop-step-config-"));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: config };
  const responses = [];
  const prompts = [];
  const transport = async (prompt, turn) => {
    prompts.push({ prompt, turn });
    return { status: 0, error: null, threadId: turn.threadId ?? "thread-exec", model: "reviewer-x", effort: "high", response: responses.shift() };
  };
  const settings = { model: null, effort: null, maxRounds: 6, implementerModel: null };
  const begin = (step) => beginStep({ cwd: root, root, plan: "plan.md", env, settings, step });
  const step = (extra) => runStepRound({ cwd: root, root, plan: "plan.md", env, transport, settings, ...extra });
  return { root, sh, env, responses, prompts, begin, step };
}

test("tree snapshots see untracked files, skip ignored ones, and leave the index alone", (t) => {
  const { root, sh } = repo(t);
  const base = snapshotTree(root);
  writeFileSync(join(root, "new.js"), "x\n");
  writeFileSync(join(root, "ignored.txt"), "y\n");
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "prod.env"), "API_KEY=abc123def456ghi789\n");
  const after = snapshotTree(root);
  const diff = treeDiff(root, base, after);
  assert.match(diff, /\+\+\+ b\/new\.js/);
  assert.doesNotMatch(diff, /ignored\.txt/);
  assert.doesNotMatch(diff, /prod\.env|abc123/);
  assert.deepEqual(protectedChanges(root, base, after), ["config/prod.env"]);
  assert.equal(sh("diff", "--cached", "--name-only").trim(), "", "index must stay clean");

  // The snapshot reuses the real index's stat cache but must still reflect the
  // working tree, not staged content, and must leave staged state as it was.
  writeFileSync(join(root, "src.js"), "staged\n");
  sh("add", "src.js");
  writeFileSync(join(root, "src.js"), "worktree\n");
  rmSync(join(root, ".gitignore"));
  const seeded = treeDiff(root, base, snapshotTree(root));
  assert.match(seeded, /\+worktree/);
  assert.doesNotMatch(seeded, /\+staged/);
  assert.match(seeded, /deleted file mode[\s\S]*\.gitignore|\.gitignore[\s\S]*deleted file mode/);
  assert.equal(sh("diff", "--cached", "--name-only").trim(), "src.js");
  assert.equal(sh("show", ":src.js"), "staged\n");
});

test("a step reviews the delta from its base, re-reviews only the fix, and chains bases across steps", async (t) => {
  const { root, env, responses, prompts, begin, step } = repo(t);

  await assert.rejects(step({ step: 1, contractText: "c" }), /no recorded base/);
  begin(1);
  writeFileSync(join(root, "src.js"), "for (i < n - 1) // tweak\n");
  responses.push(review({ findings: [finding()] }));
  let r = await step({ step: 1, contractText: "Fix the loop bound.", validationText: "npm test: 1 failed" });
  assert.equal(r.next, "adjudicate");
  assert.deepEqual(r.blockers.map((b) => b.id), ["S1"]);
  assert.match(prompts[0].prompt, /Approved plan:[\s\S]*# Plan/);
  assert.match(prompts[0].prompt, /<context>\nnpm test: 1 failed/);
  assert.match(prompts[0].prompt, /\+for \(i < n - 1\) \/\/ tweak/);
  assert.equal(prompts[0].turn.threadId, null);

  // Fix only the bound; the re-review must carry just that delta.
  writeFileSync(join(root, "src.js"), "for (i < n) // tweak\n");
  responses.push(review({ verdict: "approve", prior: [{ id: "S1", status: "ADDRESSED", evidence: "+for (i < n)" }] }));
  r = await step({
    step: 1,
    validationText: "npm test: all passed",
    adjudication: { decisions: [{ id: "S1", decision: "ACCEPT", reason: "bound verified" }] },
  });
  assert.equal(r.next, "done");
  assert.equal(r.outcome, "CONVERGED");
  assert.equal(prompts[1].turn.threadId, "thread-exec");
  assert.match(prompts[1].prompt, /-for \(i < n - 1\) \/\/ tweak\n\+for \(i < n\) \/\/ tweak/);
  assert.doesNotMatch(prompts[1].prompt, /Approved plan/);

  const execution = loadExecution(join(root, "plan.md"), env);
  assert.equal(execution.reviewer.threadId, "thread-exec");
  assert.equal(execution.steps["1"].outcome, "CONVERGED");

  // Step 2 starts from step 1's approved tree, so step 1's change is not re-sent.
  begin(2);
  writeFileSync(join(root, "other.js"), "ok\n");
  responses.push(review({ verdict: "approve" }));
  r = await step({ step: 2, contractText: "Add other." });
  assert.equal(r.next, "done");
  assert.match(prompts[2].prompt, /\+\+\+ b\/other\.js/);
  assert.doesNotMatch(prompts[2].prompt, /src\.js/);
  assert.equal(loadExecution(join(root, "plan.md"), env).steps["2"].base, execution.steps["1"].tree);

  // Final review covers everything since the execution base.
  responses.push(review({ verdict: "approve" }));
  r = await step({ step: "final", contractText: "Final verification.", validationText: "full suite green" });
  assert.equal(r.next, "done");
  assert.match(prompts[3].prompt, /src\.js/);
  assert.match(prompts[3].prompt, /other\.js/);
});

test("accepting a finding without changing the tree is refused, and three failed fixes cap the step", async (t) => {
  const { root, responses, begin, step } = repo(t);
  begin(1);
  writeFileSync(join(root, "src.js"), "v1\n");
  responses.push(review({ findings: [finding()] }));
  await step({ step: 1, contractText: "c" });
  const accept = { decisions: [{ id: "S1", decision: "ACCEPT", reason: "r" }] };
  await assert.rejects(step({ step: 1, adjudication: accept }), /unchanged/);

  for (let attempt = 2; attempt <= 4; attempt += 1) {
    writeFileSync(join(root, "src.js"), `v${attempt}\n`);
    responses.push(review({ prior: [{ id: "S1", status: "NOT_ADDRESSED", evidence: "still wrong" }] }));
    const r = await step({ step: 1, adjudication: accept });
    assert.ok(["adjudicate", "adjudicate-final", "stalled"].includes(r.next), r.next);
  }
  writeFileSync(join(root, "src.js"), "v5\n");
  const r = await step({ step: 1, adjudication: accept });
  assert.equal(r.next, "cap");
});

test("a changed plan cannot silently continue an execution", async (t) => {
  const { root, responses, begin, step } = repo(t);
  begin(1);
  responses.push(review({ verdict: "approve" }));
  await step({ step: 1, contractText: "c" });
  writeFileSync(join(root, "plan.md"), "# Different plan\n");
  assert.throws(() => begin(2), /plan changed/);
  assert.equal(readFileSync(join(root, "plan.md"), "utf8"), "# Different plan\n");
});
