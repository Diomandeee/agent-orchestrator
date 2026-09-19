// Tests for the UCTM orientation index.
//
//   node --test scripts/*.test.mjs
//
// Two properties matter most, because they are what makes re-orientation cheap
// instead of merely shorter: the content address must depend on the world and
// not on the clock, and the packet must carry pointers rather than other
// sessions' prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	buildOrientation,
	buildWorktreeState,
	canonicalize,
	classifyDocument,
	collectDocuments,
	collectNextActions,
	collectSessions,
	collectWorktree,
	diffOrientations,
	digestOf,
	extractSection,
	extractStatus,
	extractStatuses,
	extractTitle,
	main,
	PACKET_PATH,
	matchesVolatileDeclaration,
	readSessions,
	resolveWorkersRoot,
	SELF,
	sha256OfBytes,
	VOLATILE_DECLARATION,
	volatileMovement,
	WORKERS_ROOT_TAIL,
	WORKERS_ROOT_SUFFIX,
	workersRootCandidates,
	workersRootState,
	writeRefusal,
} from "./uctm-orient.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "uctm-orient-"));
	mkdirSync(join(root, "root", "docs", "uctm"), { recursive: true });
	writeFileSync(
		join(root, "root", "docs", "uctm", "AO_F9_FIXTURE.md"),
		"# AO-F9 — fixture receipt\n\nStatus: **partial**, and the second line continues it.\n\n## Next gate\n\n1. Do the first thing.\n2. Do the second thing.\n\n## Body\n\nUNIQUE_BODY_MARKER_DO_NOT_INDEX\n",
	);
	writeFileSync(
		join(root, "root", "docs", "uctm", "CONNECTION_PLAN_2026-09-18.md"),
		"# Plan\n\n## 10. Next actions\n\n1. First action.\n2. Second action.\n",
	);
	mkdirSync(join(root, "workers", "scratch-99"), { recursive: true });
	writeFileSync(
		join(root, "workers", "scratch-99", "NOTES.md"),
		"# scratch-99 notes\n\nStatus: in flight\n\nFOREIGN_BODY_MARKER_DO_NOT_INDEX\n",
	);
	writeFileSync(join(root, "workers", "scratch-99", "tiny.json"), '{"ok":true}\n');
	// The index must ignore itself, or every write would move the world it describes.
	writeFileSync(join(root, "root", "docs", "uctm", SELF), '{"orientation_id":"sha256:self"}\n');
	return root;
}

test("canonicalize is independent of object key order, so a digest cannot depend on write order", () => {
	assert.equal(canonicalize({ b: 1, a: [{ y: 1, x: 2 }] }), canonicalize({ a: [{ x: 2, y: 1 }], b: 1 }));
	assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
});

test("the content address covers the world and ignores the clock", () => {
	const documents = [{ path: "docs/uctm/A.md", bytes: 3, sha256: "aa", status: "partial" }];
	const first = buildOrientation({ generatedAt: "2026-01-01T00:00:00Z", documents, sessions: [], worktree: { head: "h" }, nextActions: [], machineLocal: {} });
	const second = buildOrientation({ generatedAt: "2027-07-07T11:11:11Z", documents, sessions: [], worktree: { head: "h" }, nextActions: [], machineLocal: {} });
	assert.equal(first.orientation_id, second.orientation_id);

	const moved = buildOrientation({ generatedAt: "2027-07-07T11:11:11Z", documents: [{ ...documents[0], sha256: "bb" }], sessions: [], worktree: { head: "h" }, nextActions: [], machineLocal: {} });
	assert.notEqual(first.orientation_id, moved.orientation_id);
});

test("a re-orienting reader is told exactly what moved", () => {
	const base = { orientation_id: "sha256:one", documents: [{ path: "a", sha256: "1" }, { path: "b", sha256: "2" }], sessions: [{ session: "s", artifacts: [{ path: "x", sha256: "9" }] }] };
	assert.equal(diffOrientations(base, { ...base, generated_at: "later" }).unchanged, true);

	const next = {
		orientation_id: "sha256:two",
		documents: [{ path: "a", sha256: "1" }, { path: "b", sha256: "CHANGED" }, { path: "c", sha256: "3" }],
		sessions: [{ session: "s", artifacts: [{ path: "x", sha256: "9" }, { path: "y", sha256: "8" }] }],
	};
	const diff = diffOrientations(base, next);
	assert.equal(diff.unchanged, false);
	assert.deepEqual(diff.changed, ["b"]);
	assert.deepEqual(diff.added, ["c", "s/y"]);
	assert.deepEqual(diff.removed, []);
});

test("markdown declarations are read, not guessed", () => {
	const md = "# Title here\n\nStatus: **partial**, and the second line continues it.\n\n## Next gate\n\n1. Do the first thing.\n2. Do the second thing.\n\n## Other\n\n- not a gate item\n";
	assert.equal(extractTitle(md), "Title here");
	assert.equal(extractStatus(md), "partial, and the second line continues it.");
	assert.deepEqual(extractSection(md, "Next gate"), ["Do the first thing.", "Do the second thing."]);
	assert.equal(extractStatus("# No status marker\n"), null);
});

test("documents are classified by the name the repo already uses", () => {
	assert.equal(classifyDocument("AO_F3_FRONTEND_PROJECTION_2026-09-19.md"), "receipt");
	assert.equal(classifyDocument("AO_ORIENTATION_INDEX_2026-09-19.md"), "receipt");
	assert.equal(classifyDocument("READINESS_CONTRACT.json"), "contract");
	assert.equal(classifyDocument("CONNECTION_PLAN_2026-09-18.md"), "plan");
	assert.equal(classifyDocument("CONTEXT_PIPELINE_GATE_2026-09-18.md"), "gate");
	assert.equal(classifyDocument("TEST_BASELINE.v0.json"), "baseline");
});

test("a document with one status per section reports every one of them", () => {
	const plan = "### AO-F1 — first\n\nStatus: **blocked**.\n\n### AO-F2 — second\n\nStatus: **implemented**.\n";
	assert.deepEqual(extractStatuses(plan), [
		{ section: "AO-F1 — first", status: "blocked." },
		{ section: "AO-F2 — second", status: "implemented." },
	]);
	assert.equal(extractStatus(plan), "blocked.");
});

test("a status with no heading above it still reports, without a section", () => {
	assert.deepEqual(extractStatuses("Status: done.\n"), [{ status: "done." }]);
	// A heading above the marker becomes the section, so a reader knows which
	// part of a long document answered.
	assert.deepEqual(extractStatuses("# R\n\nStatus: done.\n"), [{ section: "R", status: "done." }]);
});

test("document classification is a closed set", () => {
	assert.equal(classifyDocument("AO_F3_FRONTEND_PROJECTION_2026-09-19.md"), "receipt");
	assert.equal(classifyDocument("READINESS_CONTRACT.json"), "contract");
	assert.equal(classifyDocument("CONNECTION_PLAN_2026-09-18.md"), "plan");
	assert.equal(classifyDocument("CONTEXT_PIPELINE_GATE_2026-09-18.md"), "gate");
	assert.equal(classifyDocument("TEST_BASELINE.v0.json"), "baseline");
});

test("the dirty-set digest changes with a file's bytes and not with listing order", () => {
	const a = { status: "M", path: "x", sha256: "1" };
	const b = { status: "??", path: "y" };
	assert.equal(buildWorktreeState({ branch: "br", head: "h", entries: [a, b] }).dirty_id, buildWorktreeState({ branch: "br", head: "h", entries: [b, a] }).dirty_id);
	assert.notEqual(
		buildWorktreeState({ branch: "br", head: "h", entries: [a] }).dirty_id,
		buildWorktreeState({ branch: "br", head: "h", entries: [{ ...a, sha256: "2" }] }).dirty_id,
	);
});

test("the packet carries pointers, never another session's prose", () => {
	const root = fixture();
	try {
		const documents = collectDocuments(join(root, "root"));
		const sessions = collectSessions(join(root, "workers"));
		const packet = buildOrientation({ generatedAt: "2026-01-01T00:00:00Z", documents, sessions, worktree: { head: "h" }, nextActions: collectNextActions(join(root, "root")), machineLocal: {} });

		const receipt = documents.find((d) => d.path.endsWith("AO_F9_FIXTURE.md"));
		assert.equal(receipt.role, "receipt");
		assert.equal(receipt.title, "AO-F9 — fixture receipt");
		assert.equal(receipt.status, "partial, and the second line continues it.");
		assert.deepEqual(receipt.next_gate, ["Do the first thing.", "Do the second thing."]);
		assert.deepEqual(packet.next_actions, ["First action.", "Second action."]);

		assert.equal(sessions.length, 1);
		assert.deepEqual(sessions[0].artifacts.map((a) => a.path).sort(), ["NOTES.md", "tiny.json"]);
		assert.equal(sessions[0].artifacts.find((a) => a.path === "NOTES.md").status, "in flight");

		const serialized = canonicalize(packet);
		assert.ok(!serialized.includes("UNIQUE_BODY_MARKER_DO_NOT_INDEX"), "a receipt body must not be copied into the index");
		assert.ok(!serialized.includes("FOREIGN_BODY_MARKER_DO_NOT_INDEX"), "another session's body must not be copied into the index");
		assert.ok(!documents.some((d) => d.path.endsWith(SELF)), "the index must not index itself");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the live repo yields a readable worktree state and its receipts", () => {
	const worktree = collectWorktree(REPO_ROOT, (args) => {
		return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
	});
	assert.match(worktree.dirty_id, /^sha256:[0-9a-f]{64}$/);
	assert.ok(worktree.head.length >= 12);
	for (const entry of worktree.dirty) assert.ok(entry.path.length > 0);

	const documents = collectDocuments(REPO_ROOT);
	const receipts = documents.filter((d) => d.role === "receipt");
	assert.ok(receipts.length >= 3, "the AO-F* receipts must be indexed");
	assert.ok(documents.some((d) => d.path.endsWith("INTEGRATION_ENDPOINTS.v0.json") && d.safe_claim));
});

test("the session root does not follow $HOME into the harness", () => {
	// An AO worker runs with HOME set to the harness home, so a $HOME-derived
	// default resolved to a directory that does not exist. A missing root scans
	// as zero sessions, which reports every recorded pointer as `removed` -- the
	// permanent false drift this tool exists to prevent.
	const harnessHome = join(tmpdir(), "uctm-harness-home-not-real");
	const realHome = mkdtempSync(join(tmpdir(), "uctm-real-home-"));
	try {
		mkdirSync(join(realHome, WORKERS_ROOT_SUFFIX), { recursive: true });
		assert.deepEqual(collectSessions(join(harnessHome, WORKERS_ROOT_SUFFIX)), [], "a missing root is the whole bug, so it is asserted here");
		assert.equal(workersRootState(join(harnessHome, WORKERS_ROOT_SUFFIX)), "missing");
		assert.equal(resolveWorkersRoot(undefined, {}, [harnessHome, realHome]), join(realHome, WORKERS_ROOT_SUFFIX));
		// The harness home is still a candidate -- it is simply not the one that
		// exists, and the resolver picks the first candidate that does.
		assert.deepEqual(workersRootCandidates({ env: {}, homes: [harnessHome, realHome] }), [join(harnessHome, WORKERS_ROOT_SUFFIX), join(realHome, WORKERS_ROOT_SUFFIX)]);
		assert.equal(workersRootCandidates({ env: {}, homes: [realHome, realHome] }).length, 1, "the same home is not listed twice");
		// A named root is honoured whether or not it exists: an operator who says
		// where the sessions are gets told when they are wrong.
		assert.equal(resolveWorkersRoot("/named/root", {}, [realHome]), "/named/root");
		assert.equal(resolveWorkersRoot(undefined, { UCTM_WORKERS_ROOT: "/env/root" }, [realHome]), "/env/root");
	} finally {
		rmSync(realHome, { recursive: true, force: true });
	}
});

test("a write that would erase the session list is refused", () => {
	const existing = { totals: { session_artifacts: 34 } };
	assert.match(writeRefusal({ rootPresent: false, existing, next: { totals: { session_artifacts: 0 } } }), /refusing to write/);
	// A present root makes an empty list a real observation, not a silent failure.
	assert.equal(writeRefusal({ rootPresent: true, existing, next: { totals: { session_artifacts: 0 } } }), null);
	// Nothing indexed to lose, nothing to refuse.
	assert.equal(writeRefusal({ rootPresent: false, existing: { totals: { session_artifacts: 0 } }, next: { totals: { session_artifacts: 0 } } }), null);
	assert.equal(writeRefusal({ rootPresent: false, existing: null, next: { totals: { session_artifacts: 0 } } }), null);
});

// --- the session-root defect -------------------------------------------------
//
// `collectSessions` used to end in a bare `catch { return [] }`, so "this
// process cannot read the root" and "there are no sessions" produced the same
// value. Every recorded pointer then diffed as `removed`, and `--write` would
// persist a packet with `sessions: []` over one that had thirty-four artifacts.
// These tests pin the distinction, because a tool that reports other people's
// work as deleted when it merely failed to look is worse than no tool.

const ORIENT_SCRIPT = join(REPO_ROOT, "scripts", "uctm-orient.mjs");

/**
 * Run the real CLI entry point against a fixture, in a child process, so exit
 * codes and streams are the ones a worker would actually see. The `mainEnv` is
 * passed explicitly: the index resolves the session root from *its* environment,
 * and that is the variable under test.
 */
function runOrient(argv, mainEnv, root) {
	const program =
		`import(${JSON.stringify(pathToFileURL(ORIENT_SCRIPT).href)})` +
		`.then((m) => process.exit(m.main(${JSON.stringify(argv)}, ${JSON.stringify(mainEnv)}, ${JSON.stringify(root)})))` +
		`.catch((error) => { process.stderr.write(String(error?.stack ?? error)); process.exit(70); })`;
	return spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
}

/** A committed fixture repo, so `collectWorktree` has a HEAD and a real status. */
/** A packet over the fixture's workers, so the volatile split is tested end to end. */
function packetOf(workers) {
	return buildOrientation({
		generatedAt: "2026-01-01T00:00:00Z",
		documents: [],
		sessions: collectSessions(workers),
		worktree: { head: "h" },
		nextActions: [],
		machineLocal: {},
	});
}

test("a declared-volatile artifact keeps its identity and loses only its content", () => {
	const root = fixture();
	try {
		const workers = join(root, "workers");
		writeFileSync(join(workers, "scratch-99", VOLATILE_DECLARATION), '{ "volatile": ["tiny.json"] }\n');
		const first = packetOf(workers);
		assert.deepEqual(
			first.sessions[0].artifacts.find((a) => a.path === "tiny.json"),
			{ path: "tiny.json", volatile: true },
			"the declared file stays in the structure, with no digest in it",
		);
		assert.equal(first.observations.volatile_artifacts.length, 1);
		assert.equal(first.observations.volatile_artifacts[0].sha256, sha256OfBytes(readFileSync(join(workers, "scratch-99", "tiny.json"))));

		// A tool rewrites its own output with a new clock reading inside it. This is
		// the case that made the contract self-invalidating: the guard suite runs, and
		// every run used to move the address the spawn card compares against.
		writeFileSync(join(workers, "scratch-99", "tiny.json"), '{"ok":true,"observed_at":"2026-09-19T09:00:00Z"}\n');
		const second = packetOf(workers);
		assert.equal(second.orientation_id, first.orientation_id, "a rewrite of a declared output must not move the address");
		assert.notEqual(second.observations.observed_id, first.observations.observed_id, "it must still move the observation");
		assert.deepEqual(volatileMovement(first, second), ["scratch-99/tiny.json"]);
		const diff = diffOrientations(first, second);
		assert.equal(diff.unchanged, true, "the verdict stays 'nothing that matters moved'");
		assert.deepEqual(diff.volatile_moved, ["scratch-99/tiny.json"], "and it is still named, not swallowed");

		// An authored artifact keeps the old behaviour, so the split narrows nothing
		// that was working: its bytes are still in the address.
		writeFileSync(join(workers, "scratch-99", "NOTES.md"), "# scratch-99 notes\n\nStatus: changed\n");
		assert.notEqual(packetOf(workers).orientation_id, second.orientation_id, "editing an authored artifact is still drift");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a declared-volatile artifact's existence is still structure", () => {
	const root = fixture();
	try {
		const workers = join(root, "workers");
		writeFileSync(join(workers, "scratch-99", VOLATILE_DECLARATION), '{ "volatile": ["tiny.json"] }\n');
		const before = packetOf(workers);
		rmSync(join(workers, "scratch-99", "tiny.json"));
		const after = packetOf(workers);
		assert.notEqual(after.orientation_id, before.orientation_id, "removing a declared output is a change of shape");
		assert.deepEqual(diffOrientations(before, after).removed, ["scratch-99/tiny.json"]);
		assert.deepEqual(
			after.observations.volatile_declaration_missing.map((entry) => `${entry.session}/${entry.path}`),
			["scratch-99/tiny.json"],
			"and the declaration that no longer matches anything is recorded, so a rename fails loudly",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a volatile declaration matches exact paths and directory prefixes, and nothing else", () => {
	assert.equal(matchesVolatileDeclaration("a/b.json", "a/b.json"), true);
	assert.equal(matchesVolatileDeclaration("a/b/c.json", "a/"), true);
	assert.equal(matchesVolatileDeclaration("ab/c.json", "a/"), false, "a prefix is a directory boundary, not a string start");
	assert.equal(matchesVolatileDeclaration("a/b.json", "b.json"), false, "an exact entry does not match a suffix");
});

function fixtureRepo() {
	const root = mkdtempSync(join(tmpdir(), "uctm-cli-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	writeFileSync(join(root, "docs", "uctm", "AO_F9_FIXTURE.md"), "# AO-F9 fixture receipt\n\nStatus: **partial**\n\n## Next gate\n\n1. Do the first thing.\n");
	writeFileSync(join(root, "docs", "uctm", "CONNECTION_PLAN_2026-09-18.md"), "# Plan\n\n## 10. Next actions\n\n1. First action.\n");
	mkdirSync(join(root, WORKERS_ROOT_TAIL, "scratch-99"), { recursive: true });
	writeFileSync(join(root, WORKERS_ROOT_TAIL, "scratch-99", "NOTES.md"), "# scratch-99 notes\n\nStatus: in flight\n");
	const git = (args) => execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { cwd: root, stdio: "ignore" });
	git(["init", "-q"]);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "fixture"]);
	return root;
}

test("the tool-state deny-list prunes by name and says which names it pruned", (t) => {
	// A deny-list fails in two directions and both are silent. A tree that is on the
	// list disappears without a word, so a workspace can quietly stop covering
	// something; a tree that is not on the list gets walked, so an `npm install` can
	// turn 10k files into artifacts and every one of them into a drift candidate.
	// The recording is what makes both visible, so this test asserts the record, not
	// just the pruning.
	const root = mkdtempSync(join(tmpdir(), "uctm-skip-"));
	const workers = join(root, "workers");
	const session = join(workers, "scratch-42");
	mkdirSync(join(session, "settlement-layer", "node_modules", "left-pad"), { recursive: true });
	mkdirSync(join(session, "settlement-layer", ".cache"), { recursive: true });
	// Enough files that "it happened to index none" cannot pass by luck.
	for (let i = 0; i < 40; i++) {
		writeFileSync(join(session, "settlement-layer", "node_modules", "left-pad", `f${i}.js`), "module.exports = 1;\n");
	}
	writeFileSync(join(session, "settlement-layer", ".cache", "plan.json"), "{}\n");
	writeFileSync(join(session, "settlement-layer", "contracts.clar"), "(define-public (x) (ok true))\n");
	try {
		const only = readSessions(workers).sessions;
		assert.equal(only.length, 1);
		const paths = only[0].artifacts.map((a) => a.path);
		assert.deepEqual(
			paths.filter((p) => /node_modules|\\.cache/.test(p)),
			[],
			"pruned tool state must not become artifacts",
		);
		assert.deepEqual(paths, ["settlement-layer/contracts.clar"]);
		assert.deepEqual(only[0].skipped_names, [".cache", "node_modules"]);

		// A session with none of it keeps the field absent rather than empty, so a
		// workspace that never installs anything does not carry a churning `[]`.
		mkdirSync(join(workers, "scratch-43"), { recursive: true });
		writeFileSync(join(workers, "scratch-43", "NOTES.md"), "# notes\n");
		const clean = readSessions(workers).sessions.find((s) => s.session === "scratch-43");
		assert.equal("skipped_names" in clean, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unreadable session root is a fact about this process, not an empty world", (t) => {
	const root = mkdtempSync(join(tmpdir(), "uctm-unreadable-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-99"), { recursive: true });
	writeFileSync(join(workers, "scratch-99", "NOTES.md"), "# notes\n");
	try {
		const readable = readSessions(workers);
		assert.equal(readable.state, "read");
		assert.equal(readable.detail, null);
		assert.deepEqual(readable.sessions.map((s) => s.session), ["scratch-99"]);

		const absent = readSessions(join(root, "absent"));
		assert.equal(absent.state, "missing");
		assert.equal(absent.detail, "ENOENT");
		assert.deepEqual(absent.sessions, []);

		chmodSync(workers, 0o000);
		if (readSessions(workers).state !== "unreadable") {
			t.skip("this reader can list a 0o000 directory, so the unreadable branch is unreachable here");
			return;
		}
		const blocked = readSessions(workers);
		assert.equal(blocked.state, "unreadable");
		assert.match(blocked.detail, /EACCES|EPERM/);
		assert.deepEqual(blocked.sessions, []);
		// `collectSessions` stays the plain accessor, so a caller that ignores the
		// state still cannot tell "unreadable" from "empty". That is exactly why
		// every drift decision below uses the state and not the array.
		assert.deepEqual(collectSessions(workers), []);
	} finally {
		chmodSync(workers, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a diff that could not read the session dimension does not report every pointer as removed", () => {
	const previous = {
		orientation_id: "sha256:one",
		documents: [{ path: "docs/uctm/A.md", sha256: "aa" }],
		sessions: [{ session: "scratch-5", artifacts: [{ path: "README.md", sha256: "bb" }] }],
	};
	const current = { orientation_id: "sha256:two", documents: [{ path: "docs/uctm/A.md", sha256: "aa" }], sessions: [] };

	const blind = diffOrientations(previous, current, { includeSessions: false });
	assert.equal(blind.removed.includes("scratch-5/README.md"), false, "an unread root must not delete another session's artifact on paper");
	assert.deepEqual(blind.dimensions_skipped, ["sessions"]);
	assert.equal(blind.unchanged, true);
	// The same comparison with the dimension left in is the false report the flag
	// exists to suppress, asserted here so the flag cannot be quietly dropped.
	assert.deepEqual(diffOrientations(previous, current).removed, ["scratch-5/README.md"]);
});

test("an id that moved without any pointer moving is named, not called oriented-anyway", () => {
	const base = {
		orientation_id: "sha256:one",
		documents: [{ path: "a", sha256: "1" }],
		sessions: [],
		worktree: { branch: "b", head: "h", dirty_id: "sha256:d1", dirty_count: 3 },
		next_actions: ["x"],
		machine_local: { workers_root: "/a" },
	};
	const same = { ...base, orientation_id: "sha256:two" };
	const equal = diffOrientations(base, same);
	assert.equal(equal.unchanged, true);
	assert.equal(equal.reason, "id_moved_but_parts_match", "the id covers more than the pointers, so a moved id must be named");
	assert.equal(equal.worktree_moved, false);
	assert.equal(equal.actions_moved, false);
	assert.equal(equal.machine_moved, false);

	const dirtyMoved = diffOrientations(base, { ...same, worktree: { ...base.worktree, dirty_id: "sha256:d2", dirty_count: 4 } });
	assert.equal(dirtyMoved.unchanged, true);
	assert.equal(dirtyMoved.worktree_moved, true);
	assert.deepEqual(dirtyMoved.worktree_counts, { previous: 3, current: 4 });
	assert.deepEqual(dirtyMoved.removed, []);
	assert.equal(diffOrientations(base, { ...same, next_actions: ["y"] }).actions_moved, true);
	assert.equal(diffOrientations(base, { ...same, machine_local: { workers_root: "/b" } }).machine_moved, true);
});

/** Copy the CLI into a throwaway tree so the *program entry* can be exercised. */
function programEntryRepo({ git }) {
	const root = mkdtempSync(join(tmpdir(), "uctm-entry-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	// The CLI derives its root from its own location as `<script dir>/..`, so the
	// copy has to sit one level down or it would index the temp directory that
	// contains the fixture.
	mkdirSync(join(root, "scripts"), { recursive: true });
	for (const name of ["uctm-orient.mjs", "uctm-graph.mjs"]) {
		copyFileSync(join(dirname(ORIENT_SCRIPT), name), join(root, "scripts", name));
	}
	writeFileSync(join(root, "docs", "uctm", "CONNECTION_PLAN_2026-09-18.md"), "# Plan\n\n## 10. Next actions\n\n1. First action.\n");
	// A local workers root, so the run reads the fixture instead of falling through
	// the candidate chain to this machine's real AO data directory.
	mkdirSync(join(root, WORKERS_ROOT_TAIL, "scratch-99"), { recursive: true });
	writeFileSync(join(root, WORKERS_ROOT_TAIL, "scratch-99", "NOTES.md"), "# scratch-99 notes\n");
	if (git) {
		const run = (args) => execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { cwd: root, stdio: "ignore" });
		run(["init", "-q"]);
		run(["add", "-A"]);
		run(["commit", "-q", "-m", "fixture"]);
	}
	return root;
}

test("a wrong --since path is a refused command, not a drift report", () => {
	// `--check --since <typo>` used to throw out of main: a stack trace, and exit 1.
	// Exit 1 is the code the spawn card defines as drift, so a mistyped path
	// impersonated a drift report and printed no paths. Exit 2 already means "the
	// command was wrong" for a refused write.
	const run = spawnSync(process.execPath, [ORIENT_SCRIPT, "--check", "--since", join(tmpdir(), "no-such-packet-uctm.json")], { encoding: "utf8" });
	assert.equal(run.status, 2, run.stdout);
	assert.match(run.stderr, /cannot be read as a packet/);
	assert.match(run.stderr, /ENOENT/);
	assert.doesNotMatch(run.stderr, /at .*\.mjs:/, "a wrong path is a message, not a stack trace");
	assert.doesNotMatch(run.stdout, /drift:/);
});

test("a failure of the tool exits 70, never the drift code", () => {
	// Two distinct defects, one instrument, because they are the same promise: the
	// exit code must mean what the card says it means.
	//
	// (1) The entry block compared process.argv[1] to import.meta.url without
	//     resolving symlinks. `/var` is a symlink to `/private/var` on macOS, so
	//     invoking the CLI through such a path matched nothing, ran no branch, and
	//     exited 0 -- doing nothing and reporting success.
	// (2) An exception escaping main() exited 1, the drift code, with a stack trace
	//     where the moved-path list belongs.
	const withGit = programEntryRepo({ git: true });
	const withoutGit = programEntryRepo({ git: false });
	try {
		const ran = spawnSync(process.execPath, [join(withGit, "scripts", "uctm-orient.mjs"), "--write"], {
			encoding: "utf8",
			env: { ...process.env, AO_DATA_DIR: withGit },
		});
		assert.equal(ran.status, 0, ran.stderr);
		assert.match(ran.stdout, /orientation_id/, "the entry must actually run through a symlinked path");

		// The kernel CLI has the same entry block and the same symlink exposure, so
		// it is exercised through the same instrument rather than assumed.
		const kernel = spawnSync(process.execPath, [join(withGit, "scripts", "uctm-graph.mjs"), "--write"], {
			encoding: "utf8",
			env: { ...process.env, AO_DATA_DIR: withGit },
		});
		assert.equal(kernel.status, 0, kernel.stderr);
		assert.match(kernel.stdout, /graph_id/);

		const failed = spawnSync(process.execPath, [join(withoutGit, "scripts", "uctm-orient.mjs"), "--check"], { encoding: "utf8" });
		assert.equal(failed.status, 70, `a tool failure must not borrow exit 1:\n${failed.stdout}${failed.stderr}`);
		assert.match(failed.stderr, /^internal: the index failed/m);
		assert.doesNotMatch(failed.stdout, /drift:/);
	} finally {
		rmSync(withGit, { recursive: true, force: true });
		rmSync(withoutGit, { recursive: true, force: true });
	}
});

test("the exclusion transition does not read as a deletion at the CLI", (t) => {
	// scratch-10's repro: take the packet as it was written before an exclusion
	// existed, and check the world it describes. The derived index is in that packet
	// and not in the current scan, so the diff used to report it as `removed` -- the
	// scanner's coverage changing, presented as drift, exit 1.
	const root = fixtureRepo();
	const dataEnv = { AO_DATA_DIR: root };
	const planted = join(root, "pre-exclusion-packet.json");
	try {
		const write = runOrient(["--write"], dataEnv, root);
		assert.equal(write.status, 0, write.stderr);

		const packet = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		const sample = packet.documents[0];
		packet.documents.push({ ...sample, path: "docs/uctm/GRAPH.v0.json" });
		// The id is what the pre-exclusion scanner would have computed, so it differs.
		packet.orientation_id = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
		writeFileSync(planted, JSON.stringify(packet));

		const check = runOrient(["--check", "--since", planted], dataEnv, root);
		assert.equal(check.status, 0, `an exclusion must not be reported as drift:\n${check.stdout}${check.stderr}`);
		assert.match(check.stdout, /^oriented: /m);
		assert.match(check.stdout, /no longer read by policy/);
		assert.match(check.stdout, /excluded docs\/uctm\/GRAPH\.v0\.json/);
		assert.doesNotMatch(check.stdout, /^  removed  /m, "a policy exclusion may not be printed as a deletion");

		// The control: remove a document that is not excluded and the same verb is
		// still available for the real thing.
		const gone = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		gone.documents.push({ ...sample, path: "docs/uctm/DELETED.md" });
		gone.orientation_id = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
		writeFileSync(planted, JSON.stringify(gone));
		const drift = runOrient(["--check", "--since", planted], dataEnv, root);
		assert.equal(drift.status, 1, drift.stdout);
		assert.match(drift.stdout, /^  removed  docs\/uctm\/DELETED\.md$/m);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a declared-volatile rewrite exits 0, and only --strict makes it non-zero", (t) => {
	// The unit test above asserts the *verdict* (diff.unchanged) for a volatile
	// rewrite. It does not assert the *exit code*, and the exit code is what the
	// spawn card tells a session to read: "exit 1 prints exactly the paths that
	// moved". A session whose own verifier rewrites its own generated outputs must
	// therefore land on exit 0, or the instruction is unreachable for exactly the
	// sessions most likely to need it. That is a different claim, so it gets its
	// own instrument rather than riding on the unit assertion.
	const root = fixtureRepo();
	// AO_DATA_DIR is the AO data dir, not its parent: the resolver looks for
	// <AO_DATA_DIR>/worktrees/scratch/workers, which is where fixtureRepo puts the
	// fixture. Naming a subdirectory makes that candidate miss, and the chain then
	// falls through to the real $HOME -- so the test would silently describe the
	// machine's actual worker root instead of the fixture, and still pass. That is
	// asserted below rather than trusted.
	const dataEnv = { AO_DATA_DIR: root };
	try {
		const workers = join(root, WORKERS_ROOT_TAIL);
		const session = join(workers, "scratch-99");
		mkdirSync(session, { recursive: true });
		writeFileSync(join(session, VOLATILE_DECLARATION), '{ "volatile": ["derived.json"] }\n');
		writeFileSync(join(session, "derived.json"), '{"observed_at":"2026-01-01T00:00:00Z"}\n');

		const write = runOrient(["--write"], dataEnv, root);
		assert.equal(write.status, 0, write.stderr);
		const written = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		assert.equal(written.machine_local.workers_root, join(root, WORKERS_ROOT_TAIL), "the fixture root must be the root that was read, not a fallthrough");
		assert.deepEqual(written.sessions.map((s) => s.session), ["scratch-99"]);

		// Only the generator runs. No source file anywhere is touched.
		writeFileSync(join(session, "derived.json"), '{"observed_at":"2026-01-02T00:00:00Z"}\n');

		const check = runOrient(["--check"], dataEnv, root);
		assert.equal(check.status, 0, `a declared-volatile rewrite must not be drift:\n${check.stdout}${check.stderr}`);
		assert.match(check.stdout, /^oriented: /m);
		assert.match(check.stdout, /1 declared-volatile artifact\(s\) moved/);
		assert.match(check.stdout, /volatile scratch-99\/derived\.json/);
		assert.doesNotMatch(check.stdout, /^  changed  /m, "it is named as volatile, not reported as a moved path");

		// The same world under --strict is the caller asking for content too, and
		// exit 4 is the vocabulary that keeps it distinct from drift.
		const strict = runOrient(["--check", "--strict"], dataEnv, root);
		assert.equal(strict.status, 4, strict.stdout);

		// The counterfactual, so this cannot pass by being blind to movement: an
		// authored artifact rewritten the same way is still exit 1.
		writeFileSync(join(session, "NOTES.md"), "# scratch-99 notes\n\nStatus: moved\n");
		const drift = runOrient(["--check"], dataEnv, root);
		assert.equal(drift.status, 1, drift.stdout);
		assert.match(drift.stdout, /^  changed  scratch-99\/NOTES\.md$/m);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("declaring a path volatile is named reclassified, not reported as a moved file", () => {
	// Adding or dropping a declaration changes which band records a file's *content*.
	// It does not change the file. Before this, the next --check counted the untouched
	// file as `changed` and exited 1, so a session doing the documented thing -- declaring
	// a generated file -- sent the whole fleet a false drift report until someone
	// re-anchored. That is the exclusion defect one scanner decision over: a change in
	// what was read, reported as a change in the world. Named by cause instead, and the
	// digest both sides recorded keeps a real move from hiding behind the declaration.
	const declare = (root, session, files) => {
		writeFileSync(join(session, VOLATILE_DECLARATION), `{ "volatile": [${files.map((f) => JSON.stringify(f)).join(", ")}] }\n`);
	};
	const repo = () => {
		const root = fixtureRepo();
		const session = join(root, WORKERS_ROOT_TAIL, "scratch-99");
		mkdirSync(session, { recursive: true });
		return { root, session, dataEnv: { AO_DATA_DIR: root } };
	};

	// (1) Newly declared, bytes untouched.
	{
		const { root, session, dataEnv } = repo();
		try {
			writeFileSync(join(session, "derived.json"), '{"observed_at":"v1"}\n');
			assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
			declare(root, session, ["derived.json"]);
			const check = runOrient(["--check"], dataEnv, root);
			// Exit 1 is correct here and is not this test's subject: volatile.json is itself
			// an indexed artifact, so creating it is a real addition. What matters is that
			// derived.json, whose bytes never moved, is named by cause rather than sent to a
			// reader as a path that changed.
			assert.equal(check.status, 1, check.stdout);
			assert.match(check.stdout, /^  added  scratch-99\/volatile\.json$/m);
			assert.match(check.stdout, /^  reclassified scratch-99\/derived\.json  \(declared-volatile status changed/m);
			assert.doesNotMatch(check.stdout, /^  changed  scratch-99\/derived\.json$/m, "an untouched file is not a moved file");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	// (2) Un-declared, bytes untouched -- the same hole in the other direction, where the
	// digest re-enters the address.
	{
		const { root, session, dataEnv } = repo();
		try {
			writeFileSync(join(session, "derived.json"), '{"observed_at":"v1"}\n');
			declare(root, session, ["derived.json"]);
			assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
			writeFileSync(join(session, VOLATILE_DECLARATION), '{ "volatile": [] }\n');
			const check = runOrient(["--check"], dataEnv, root);
			assert.equal(check.status, 1, check.stdout);
			assert.match(check.stdout, /^  changed  scratch-99\/volatile\.json$/m, "the declaration file itself did move");
			assert.match(check.stdout, /^  reclassified scratch-99\/derived\.json  \(declared-volatile status changed/m);
			assert.doesNotMatch(check.stdout, /^  changed  scratch-99\/derived\.json$/m, "an untouched file is not a moved file");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	// (3) The counterfactual, so (1) and (2) cannot pass by being blind to movement: the
	// same declaration change, but the bytes moved too, is still drift.
	{
		const { root, session, dataEnv } = repo();
		try {
			writeFileSync(join(session, "derived.json"), '{"observed_at":"v1"}\n');
			assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
			declare(root, session, ["derived.json"]);
			writeFileSync(join(session, "derived.json"), '{"observed_at":"v2"}\n');
			const drift = runOrient(["--check"], dataEnv, root);
			assert.equal(drift.status, 1, drift.stdout);
			assert.match(drift.stdout, /^  changed  scratch-99\/derived\.json$/m, "a real move may not hide behind a declaration");
			assert.match(drift.stdout, /^  reclassified scratch-99\/derived\.json  \(declared-volatile status changed/m, "and both facts are reported, not one");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("a path that stops being read by policy is named excluded, not removed", () => {
	// Adding an exclusion made every entry it covers report as `removed` until the next
	// --write: the scanner changing what it reads, reported as the world losing files.
	// Same failure as an unreadable root reported as an empty one. The two are now
	// separated by cause, and this asserts both sides so the separation cannot be
	// implemented as "never say removed".
	const base = {
		orientation_id: "sha256:before",
		documents: [
			{ path: "docs/uctm/PLAN.md", sha256: "1" },
			{ path: "docs/uctm/GRAPH.v0.json", sha256: "2" },
			{ path: "docs/uctm/GONE.md", sha256: "3" },
		],
		sessions: [
			{
				session: "scratch-99",
				artifacts: [
					{ path: "NOTES.md", sha256: "a" },
					{ path: "settlement-layer/node_modules/left-pad/index.js", sha256: "b" },
				],
			},
		],
		worktree: { branch: "b", head: "h", dirty_id: "sha256:d", dirty_count: 1 },
		next_actions: [],
		machine_local: { workers_root: "/w" },
	};
	const current = {
		...base,
		orientation_id: "sha256:after",
		// The derived index left the scan by policy, the artifact left by policy, and
		// GONE.md is the control: it simply is not there any more.
		documents: [{ path: "docs/uctm/PLAN.md", sha256: "1" }],
		sessions: [{ session: "scratch-99", artifacts: [{ path: "NOTES.md", sha256: "a" }] }],
	};
	const diff = diffOrientations(base, current);
	assert.deepEqual(diff.excluded, ["docs/uctm/GRAPH.v0.json", "scratch-99/settlement-layer/node_modules/left-pad/index.js"]);
	assert.deepEqual(diff.removed, ["docs/uctm/GONE.md"], "a genuine disappearance is still drift");
	assert.equal(diff.unchanged, false, "and the control keeps the verdict honest");

	// With only the exclusions taking effect, nothing moved: no drift, and the
	// exclusion is still named rather than swallowed.
	const onlyExclusions = diffOrientations(base, {
		...current,
		documents: [{ path: "docs/uctm/PLAN.md", sha256: "1" }, { path: "docs/uctm/GONE.md", sha256: "3" }],
		sessions: base.sessions.map((session) => ({ ...session, artifacts: [session.artifacts[0]] })),
	});
	assert.deepEqual(onlyExclusions.removed, []);
	assert.equal(onlyExclusions.unchanged, true, "an exclusion is not the world moving");
	assert.equal(onlyExclusions.excluded.length, 2);
});

test("a write is refused when the resolved session root is not the recorded one", () => {
	const existing = { totals: { session_artifacts: 34 }, machine_local: { workers_root: "/recorded/workers" } };
	const next = { totals: { session_artifacts: 12 }, machine_local: { workers_root: "/somewhere/else" } };
	const refusal = writeRefusal({ rootPresent: true, rootChanged: true, existing, next });
	assert.match(refusal, /refusing to write/);
	assert.match(refusal, /\/recorded\/workers/);
	assert.match(refusal, /\/somewhere\/else/);
	// Nothing indexed to lose is just a new machine, not a refusal.
	assert.equal(writeRefusal({ rootPresent: true, rootChanged: true, existing: { totals: { session_artifacts: 0 } }, next }), null);
	// The same root read fine is never a root change.
	assert.equal(writeRefusal({ rootPresent: true, rootChanged: false, existing, next }), null);
});

test("the AO data dir outranks both $HOME guesses, and a named root outranks everything", () => {
	const home = join(tmpdir(), "uctm-home-guess");
	assert.deepEqual(workersRootCandidates({ env: { AO_DATA_DIR: "/data" }, homes: [home] }), [join("/data", WORKERS_ROOT_TAIL), join(home, WORKERS_ROOT_SUFFIX)]);
	assert.equal(workersRootCandidates({ env: { AO_DATA_DIR: "/data", UCTM_WORKERS_ROOT: "/named" }, homes: [home] })[0], "/named");
	assert.equal(workersRootCandidates({ explicit: "/explicit", env: { UCTM_WORKERS_ROOT: "/named" }, homes: [home] })[0], "/explicit");

	// A worker shell rewrites $HOME but not AO_DATA_DIR, so the candidate that
	// actually exists is authoritative even when $HOME points at the harness.
	const dataDir = mkdtempSync(join(tmpdir(), "uctm-ao-data-"));
	try {
		mkdirSync(join(dataDir, WORKERS_ROOT_TAIL), { recursive: true });
		assert.equal(resolveWorkersRoot(undefined, { AO_DATA_DIR: dataDir }, [join(tmpdir(), "uctm-no-such-home")]), join(dataDir, WORKERS_ROOT_TAIL));
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("a derived index is not an input to its own dirty set, not merely to its own hash", () => {
	// The packet used to list ORIENTATION.v0.json and GRAPH.v0.json as
	// `self: true` entries: unhashed, but still inside `dirty`, `dirty_count` and
	// `dirty_id`, all of which sit inside orientation_id. Writing an index
	// therefore moved the index's own content address, and the next `--check`
	// reported "the worktree dirty set moved" about the tool's own write.
	const execGit = (args) => {
		if (args[0] !== "status") return args[1] === "--abbrev-ref" ? "main\n" : `${"0".repeat(40)}\n`;
		return " M docs/uctm/ORIENTATION.v0.json\0 M docs/uctm/GRAPH.v0.json\0 M scripts/uctm-orient.mjs\0";
	};
	const state = collectWorktree("/need-not-exist", execGit);
	assert.deepEqual(state.dirty.map((e) => e.path), ["scripts/uctm-orient.mjs"]);
	assert.equal(state.dirty_count, 1);
	const sourcesOnly = collectWorktree("/need-not-exist", (args) => (args[0] === "status" ? " M scripts/uctm-orient.mjs\0" : execGit(args)));
	assert.equal(sourcesOnly.dirty_id, state.dirty_id, "the digest must not depend on whether an index is present or modified");
});

test("the CLI refuses to call a world oriented when it could not read the session dimension", () => {
	const root = fixtureRepo();
	const dataEnv = { AO_DATA_DIR: root };
	try {
		const wrote = runOrient(["--write"], dataEnv, root);
		assert.equal(wrote.status, 0, wrote.stderr);
		const packet = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		assert.equal(packet.machine_local.workers_root, join(root, WORKERS_ROOT_TAIL));
		assert.equal(packet.machine_local.workers_root_state, "read");
		assert.equal(packet.totals.sessions, 1);
		assert.equal(packet.totals.session_artifacts, 1);
		assert.equal(packet.worktree.dirty_count, 0, "the index it just wrote is not part of its own dirty set");

		const firstBytes = readFileSync(join(root, PACKET_PATH), "utf8");
		assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
		assert.equal(readFileSync(join(root, PACKET_PATH), "utf8"), firstBytes, "a write over an unchanged world is byte-identical, generated_at included");

		const check = runOrient(["--check"], dataEnv, root);
		assert.equal(check.status, 0, check.stderr);
		assert.match(check.stdout, /^oriented: /);

		const where = runOrient(["--where"], dataEnv, root);
		assert.equal(where.status, 0, where.stderr);
		assert.match(where.stdout, /state\s+read/);
		assert.match(where.stdout, /recorded root.*\(same\)/);

		// The same packet, read from a shell that cannot see the recorded root.
		const blind = runOrient(["--check"], { UCTM_WORKERS_ROOT: join(root, "absent") }, root);
		assert.equal(blind.status, 3, blind.stdout);
		assert.match(blind.stdout, /^incomplete: /m);
		assert.doesNotMatch(blind.stdout, /oriented/, "a dimension that was not read may not borrow the word that means stop looking");
		assert.doesNotMatch(blind.stdout, /^  removed  /m, "an unread root must not delete another session's artifacts on paper");
		assert.match(blind.stderr, /session dimension NOT compared/);

		const blindWhere = runOrient(["--where"], { UCTM_WORKERS_ROOT: join(root, "absent") }, root);
		assert.equal(blindWhere.status, 3);
		assert.match(blindWhere.stdout, /DIFFERENT/);
		assert.match(blindWhere.stdout, /not read \(unknown, not zero\)/);

		// The escape hatch: an operator who names a different root gets a packet
		// about that root, not a refusal.
		mkdirSync(join(root, "elsewhere", "scratch-77"), { recursive: true });
		writeFileSync(join(root, "elsewhere", "scratch-77", "NOTES.md"), "# elsewhere\n");
		const named = runOrient(["--write"], { UCTM_WORKERS_ROOT: join(root, "elsewhere") }, root);
		assert.equal(named.status, 0, named.stderr);
		const namedPacket = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		assert.equal(namedPacket.machine_local.workers_root, join(root, "elsewhere"));
		assert.deepEqual(namedPacket.sessions.map((s) => s.session), ["scratch-77"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a write refuses to erase session pointers it could not read", (t) => {
	const root = fixtureRepo();
	const dataEnv = { AO_DATA_DIR: root };
	const workers = join(root, WORKERS_ROOT_TAIL);
	try {
		assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
		chmodSync(workers, 0o000);
		if (readSessions(workers).state !== "unreadable") {
			t.skip("this reader can list a 0o000 directory, so the refusal cannot be provoked here");
			return;
		}
		const refused = runOrient(["--write"], dataEnv, root);
		assert.equal(refused.status, 2, refused.stdout);
		assert.match(refused.stderr, /refusing to write/);
		// The packet on disk still carries the session it recorded, and the read
		// that failed is reported as unknown rather than as a deletion.
		assert.equal(JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8")).totals.session_artifacts, 1);
		const check = runOrient(["--check"], dataEnv, root);
		assert.equal(check.status, 3, check.stdout);
		assert.match(check.stdout, /^incomplete: /m);
		assert.doesNotMatch(check.stdout, /^  removed  /m);
	} finally {
		chmodSync(workers, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a write swaps the packet in by rename, so a reader cannot catch a half-written index", () => {
	// The packet is read by other sessions while this writer runs. writeFileSync
	// truncates in place, so a reader that lands in the window parses a partial JSON
	// document -- and cannot tell that from an index published broken. A peer hit
	// exactly that on the *source* file at 05:20:50, where a half-saved script read as
	// a shipped SyntaxError. rename(2) inside a directory is atomic, so the swap is the
	// only step a reader can observe: old bytes or new ones. The inode is the check,
	// because it is the one property a rewrite-in-place cannot fake.
	const root = fixtureRepo();
	const env = { AO_DATA_DIR: root };
	const packetPath = join(root, PACKET_PATH);
	try {
		assert.equal(runOrient(["--write"], env, root).status, 0);
		const before = statSync(packetPath).ino;
		assert.equal(runOrient(["--write"], env, root).status, 0);
		const after = statSync(packetPath).ino;
		assert.notEqual(after, before, "the packet was rewritten in place, so a reader can observe a truncated packet");
		assert.ok(JSON.parse(readFileSync(packetPath, "utf8")).orientation_id);
		assert.deepEqual(
			readdirSync(join(root, "docs", "uctm")).filter((name) => name.includes(".tmp-")),
			[],
			"a temp file survived the write",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
