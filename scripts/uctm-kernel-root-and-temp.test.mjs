// Regression tests for two ways this kernel stated a conclusion it had not read.
//
//   node --test scripts/*.test.mjs
//
// 1. The artifact dimension was compared against whatever root the caller named.
//    A readable directory that holds different sessions resolved every recorded
//    artifact to an absent path, and a bare `catch` filed the lot under `missing`
//    -- so pointing at the wrong tree produced "the world lost 102 artifacts"
//    instead of "this is another world". The session dimension already answers
//    that question by declining to compare; the artifact dimension is the same
//    dimension. It is now reported as `not_compared` and exits 3.
//
// 2. The dirty set excluded a derived index by EXACT PATH, so the same index
//    half-written by `writeFileAtomic` -- `.<name>.tmp-<pid>` in the target's
//    directory -- still entered `dirty`, and therefore `dirty_id`, and therefore
//    `orientation_id`. The pid makes the name permanent: no later write reuses or
//    sweeps it, so a writer killed inside the swap window leaves a phantom drift
//    row that explains the tool's own debris.
//
// Both properties are pinned with their controls in the same file, so an
// implementation that satisfies an assertion by refusing to compare anything, or
// by excluding every path that looks like a temp, fails the neighbouring test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectWorktree, isDerivedIndexPath } from "./uctm-orient.mjs";
import { verifyGraph } from "./uctm-graph.mjs";

const GRAPH_SCRIPT = fileURLToPath(new URL("./uctm-graph.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const runGraph = (argv) => spawnSync(process.execPath, [GRAPH_SCRIPT, ...argv], { cwd: REPO_ROOT, encoding: "utf8" });

// The dirty set is read out of `git status --porcelain=v1 -z`, so the stub speaks
// that protocol rather than the array `collectWorktree` hands back -- otherwise the
// test would be asserting on its own re-encoding.
function stubGit(statusRecords) {
	const raw = `${statusRecords.join("\0")}\0`;
	return (args) => {
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "probe\n";
		if (args[0] === "rev-parse") return `${"0".repeat(40)}\n`;
		if (args[0] === "status") return raw;
		throw new Error(`unexpected git call: ${args.join(" ")}`);
	};
}

test("a derived index mid-swap is not an input to its own dirty set", () => {
	const pid = 31337;
	const state = collectWorktree(
		// The root need not exist: every path resolves under it and the hash step fails
		// harmlessly, which is how the scan reads a file deleted from the worktree.
		join(tmpdir(), "uctm-kernel-test-nowhere"),
		stubGit([
			`?? docs/uctm/.ORIENTATION.v0.json.tmp-${pid}`,
			`?? docs/uctm/.GRAPH.v0.json.tmp-${pid}`,
			"?? docs/uctm/ORIENTATION.v0.json",
			"?? docs/uctm/GRAPH.v0.json",
			`?? docs/uctm/UNRELATED.tmp-${pid}`,
			" M backend/x.go",
		]),
	);
	assert.deepEqual(
		state.dirty.map((entry) => entry.path),
		["backend/x.go", `docs/uctm/UNRELATED.tmp-${pid}`],
		"both indexes and both of their in-flight copies must be excluded, and nothing else may be",
	);
});

test("the swap exclusion is scoped to a derived index, not to anything shaped like a temp", () => {
	assert.equal(isDerivedIndexPath("docs/uctm/ORIENTATION.v0.json"), true);
	assert.equal(isDerivedIndexPath("docs/uctm/.ORIENTATION.v0.json.tmp-31337"), true);
	assert.equal(isDerivedIndexPath("docs/uctm/.GRAPH.v0.json.tmp-1"), true);
	// A session's own artifact caught mid-write is the world moving, and a temp for
	// any other document is a document. Excluding by shape rather than by identity
	// would hide both.
	assert.equal(isDerivedIndexPath("docs/uctm/.NOT_AN_INDEX.tmp-31337"), false);
	assert.equal(isDerivedIndexPath("scratch-1/PLAN.md"), false);
	assert.equal(isDerivedIndexPath("docs/uctm/GRAPH.v0.json.bak"), false);
});

test("an artifact is not compared against a root the graph did not record", () => {
	const graph = {
		nodes: [{ id: "artifact:scratch-1/RECEIPT.md", role: "artifact", key: "scratch-1/RECEIPT.md", digest: `sha256:${"a".repeat(64)}` }],
		edges: [],
	};
	const elsewhere = join(tmpdir(), "uctm-kernel-test-elsewhere");
	const recorded = join(tmpdir(), "uctm-kernel-test-recorded");

	const foreign = verifyGraph(graph, { root: REPO_ROOT, workersRoot: elsewhere, recordedRoot: recorded });
	assert.equal(foreign.missing.length, 0, "a tree this process never read must not be reported as a deletion");
	assert.deepEqual(foreign.not_compared, ["artifact:scratch-1/RECEIPT.md"]);
	assert.equal(foreign.state, "incomplete_not_compared");

	// Control: when the named root IS the recorded one the artifact is compared, so
	// "never compare artifacts" cannot satisfy the assertion above. It is absent
	// there, and the control requires that to be reported as `missing` -- the very
	// claim the foreign case must not make.
	const same = verifyGraph(graph, { root: REPO_ROOT, workersRoot: elsewhere, recordedRoot: elsewhere });
	assert.equal(same.not_compared.length, 0);
	assert.equal(same.missing.length, 1, "the control must still call a genuinely absent artifact missing");
	assert.equal(same.state, "recorded_digests_moved");
});

test("--stale against a root that is not the recorded one exits 3 and reports no deletions", () => {
	const foreign = mkdtempSync(join(tmpdir(), "uctm-kernel-foreign-"));
	try {
		const run = runGraph(["--stale", "--workers-root", foreign]);
		assert.equal(run.status, 3, `expected the incomplete code, got ${run.status}:\n${run.stdout}${run.stderr}`);
		assert.equal(/^ {2}missing +artifact:/m.test(run.stdout), false, "a tree this process never read was reported as a deletion");
		assert.match(run.stdout, /not compared/);
	} finally {
		rmSync(foreign, { recursive: true, force: true });
	}
});

test("--check names a partially readable session root instead of passing in silence", () => {
	const root = mkdtempSync(join(tmpdir(), "uctm-kernel-partial-"));
	const blocked = join(root, "scratch-00", "blocked");
	let blockedWasCreated = false;
	try {
		mkdirSync(blocked, { recursive: true });
		blockedWasCreated = true;
		writeFileSync(join(root, "scratch-00", "READABLE.md"), "# probe\n");
		writeFileSync(join(blocked, "hidden.md"), "# probe\n");
		chmodSync(blocked, 0o000);
		const run = runGraph(["--check", "--workers-root", root]);
		// Keyed on what the tool SAID, not on its exit code: the exit code here is also
		// driven by whether the packet moved under a shared checkout, so an assertion on
		// it would go quiet the moment a peer wrote -- and would then be silent about
		// exactly the thing it is here to catch.
		assert.match(`${run.stdout}${run.stderr}`, /partial/i, "a root whose scan could not enter a workspace was described as a healthy one");
		assert.match(run.stderr, /scratch-00/, "the workspace that could not be read must be named");
	} finally {
		if (blockedWasCreated) chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});
