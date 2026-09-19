// Regression tests for a *partly* readable session tree.
//
//   node --test scripts/*.test.mjs
//
// The scan used to be all-or-nothing: `readSessions` guarded the top-level
// `readdirSync`, but the recursive walk did not, so one nested directory that
// listed to its parent and not to this process threw out of the whole scan. The
// CLI then exited 1 -- the drift code -- with a stack trace and no packet, while
// every readable session was lost too. Exit 1 is the one answer an operator must
// never be given by accident: it means "a pointer moved, go read it".
//
// Two properties are pinned here. A partially readable tree is reported as
// `partial` with the unreadable sessions named, and the pointers inside them are
// never reported as removed and never silently dropped by `--write`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	diffOrientations,
	main,
	PACKET_PATH,
	readSessions,
	WORKERS_ROOT_PATH_STATES,
	WORKERS_ROOT_STATES,
	WORKERS_ROOT_TAIL,
	workersRootState,
} from "./uctm-orient.mjs";

const ORIENT_SCRIPT = fileURLToPath(new URL("./uctm-orient.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function runOrient(argv, mainEnv, root) {
	const program =
		`import(${JSON.stringify(pathToFileURL(ORIENT_SCRIPT).href)})` +
		`.then((m) => process.exit(m.main(${JSON.stringify(argv)}, ${JSON.stringify(mainEnv)}, ${JSON.stringify(root)})))` +
		`.catch((error) => { process.stderr.write(String(error?.stack ?? error)); process.exit(70); })`;
	return spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
}

/** A committed fixture repo, so `collectWorktree` has a HEAD and a real status. */
function fixtureRepo() {
	const root = mkdtempSync(join(tmpdir(), "uctm-partial-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	writeFileSync(join(root, "docs", "uctm", "AO_F9_FIXTURE.md"), "# AO-F9 fixture receipt\n\nStatus: **partial**\n\n## Next gate\n\n1. Do the first thing.\n");
	writeFileSync(join(root, "docs", "uctm", "CONNECTION_PLAN_2026-09-18.md"), "# Plan\n\n## 10. Next actions\n\n1. First action.\n");
	const workers = join(root, WORKERS_ROOT_TAIL);
	mkdirSync(join(workers, "scratch-99", "notes"), { recursive: true });
	writeFileSync(join(workers, "scratch-99", "NOTES.md"), "# scratch-99 notes\n\nStatus: in flight\n");
	writeFileSync(join(workers, "scratch-99", "notes", "deep.md"), "# a pointer inside a subtree\n");
	const git = (args) => execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args], { cwd: root, stdio: "ignore" });
	git(["init", "-q"]);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "fixture"]);
	return root;
}

/** True when this reader really cannot list a 0o000 directory. */
function cannotList(path) {
	chmodSync(path, 0o000);
	const blocked = readSessions(join(path, "..", "..", "..", "..")).state !== "read";
	chmodSync(path, 0o755);
	return blocked;
}

test("a nested unreadable directory is named on its session and does not kill the scan", (t) => {
	const root = mkdtempSync(join(tmpdir(), "uctm-partial-nested-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-01", "blocked"), { recursive: true });
	mkdirSync(join(workers, "scratch-02"), { recursive: true });
	writeFileSync(join(workers, "scratch-01", "READABLE.md"), "# still collected\n");
	writeFileSync(join(workers, "scratch-01", "blocked", "hidden.md"), "# unreachable\n");
	writeFileSync(join(workers, "scratch-02", "NOTES.md"), "# other session\n");
	const blocked = join(workers, "scratch-01", "blocked");
	chmodSync(blocked, 0o000);
	const probe = readSessions(workers);
	if (probe.state !== "partial") {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
		t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
		return;
	}
	try {
		assert.equal(probe.detail, null);
		assert.deepEqual(probe.unreadable_sessions, ["scratch-01"]);
		assert.deepEqual(probe.sessions.map((session) => session.session), ["scratch-01", "scratch-02"]);
		const first = probe.sessions[0];
		assert.equal(first.state, "unreadable");
		assert.deepEqual(first.unreadable_dirs.map((entry) => entry.path), ["blocked"]);
		assert.match(first.unreadable_dirs[0].detail, /EACCES|EPERM/);
		// The readable siblings are still collected: the failure is scoped to the
		// directory that produced it instead of replacing the scan with a throw.
		assert.deepEqual(first.artifacts.map((artifact) => artifact.path), ["READABLE.md"]);
		const second = probe.sessions[1];
		assert.equal(second.state, undefined);
		assert.deepEqual(second.artifacts.map((artifact) => artifact.path), ["NOTES.md"]);
	} finally {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a session directory this process cannot list is unknown, not empty", (t) => {
	const root = mkdtempSync(join(tmpdir(), "uctm-partial-session-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-01"), { recursive: true });
	mkdirSync(join(workers, "scratch-02"), { recursive: true });
	writeFileSync(join(workers, "scratch-01", "NOTES.md"), "# unreadable to this process\n");
	writeFileSync(join(workers, "scratch-02", "NOTES.md"), "# readable\n");
	const blocked = join(workers, "scratch-01");
	chmodSync(blocked, 0o000);
	const probe = readSessions(workers);
	if (probe.state !== "partial") {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
		t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
		return;
	}
	try {
		assert.deepEqual(probe.unreadable_sessions, ["scratch-01"]);
		const first = probe.sessions[0];
		assert.equal(first.state, "unreadable");
		assert.deepEqual(first.artifacts, []);
		assert.equal(first.pointed_bytes, 0);
		assert.deepEqual(probe.sessions[1].artifacts.map((artifact) => artifact.path), ["NOTES.md"]);
	} finally {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI builds a packet over a partly readable root instead of exiting 1 with a stack trace", (t) => {
	const root = mkdtempSync(join(tmpdir(), "uctm-partial-cli-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-01", "blocked"), { recursive: true });
	writeFileSync(join(workers, "scratch-01", "READABLE.md"), "# collected\n");
	writeFileSync(join(workers, "scratch-01", "blocked", "hidden.md"), "# unreachable\n");
	chmodSync(join(workers, "scratch-01", "blocked"), 0o000);
	if (readSessions(workers).state !== "partial") {
		chmodSync(join(workers, "scratch-01", "blocked"), 0o755);
		rmSync(root, { recursive: true, force: true });
		t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
		return;
	}
	try {
		const result = runOrient(["--json", "--workers-root", workers], {}, REPO_ROOT);
		assert.equal(result.status, 0, `expected a packet, got exit ${result.status}: ${result.stderr.slice(0, 400)}`);
		assert.doesNotMatch(result.stderr, /scandir|at walk \(/);
		const packet = JSON.parse(result.stdout);
		assert.equal(packet.machine_local.workers_root_state, "partial");
		assert.deepEqual(packet.machine_local.unreadable_sessions, ["scratch-01"]);
		assert.deepEqual(packet.machine_local.workers_root, workers);
		assert.equal(packet.totals.session_artifacts, 1);
	} finally {
		chmodSync(join(workers, "scratch-01", "blocked"), 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("--check calls a partly compared session dimension incomplete, and never removed", (t) => {
	const root = fixtureRepo();
	const dataEnv = { AO_DATA_DIR: root };
	const workers = join(root, WORKERS_ROOT_TAIL);
	const blocked = join(workers, "scratch-99", "notes");
	try {
		assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
		const recorded = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		assert.equal(recorded.totals.session_artifacts, 2);
		chmodSync(blocked, 0o000);
		if (readSessions(workers).state !== "partial") {
			t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
			return;
		}
		const check = runOrient(["--check"], dataEnv, root);
		assert.equal(check.status, 3, check.stdout);
		assert.match(check.stdout, /^incomplete: /m);
		assert.doesNotMatch(check.stdout, /^  removed  /m);
		assert.match(check.stderr, /session workspace root is partial/);
		assert.match(check.stderr, /scratch-99/);

		// The mechanism, stated directly: the same diff without the named exclusion
		// reports the pointer inside the unreadable subtree as removed, which is the
		// false deletion this run must not print.
		const live = runOrient(["--json"], dataEnv, root);
		assert.equal(live.status, 0, live.stderr);
		const packet = JSON.parse(live.stdout);
		const naive = diffOrientations(recorded, packet, { includeSessions: true });
		assert.deepEqual(naive.removed, ["scratch-99/notes/deep.md"]);
		const guarded = diffOrientations(recorded, packet, { includeSessions: true, unreadableSessions: ["scratch-99"] });
		assert.deepEqual(guarded.removed, []);
		assert.deepEqual(guarded.sessions_unreadable, ["scratch-99"]);
		assert.deepEqual(guarded.dimensions_skipped, ["sessions:scratch-99"]);
	} finally {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a partial scan refuses to write rather than drop the pointers it could not read", (t) => {
	const root = fixtureRepo();
	const dataEnv = { AO_DATA_DIR: root };
	const workers = join(root, WORKERS_ROOT_TAIL);
	const blocked = join(workers, "scratch-99", "notes");
	try {
		assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
		chmodSync(blocked, 0o000);
		if (readSessions(workers).state !== "partial") {
			t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
			return;
		}
		const refused = runOrient(["--write"], dataEnv, root);
		assert.equal(refused.status, 2, refused.stdout);
		assert.match(refused.stderr, /refusing to write/);
		assert.match(refused.stderr, /scratch-99/);
		// The packet on disk still carries the pointer inside the unreadable subtree.
		assert.equal(JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8")).totals.session_artifacts, 2);
	} finally {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unreadable session the packet never recorded does not block the write", (t) => {
	const root = fixtureRepo();
	const dataEnv = { AO_DATA_DIR: root };
	const workers = join(root, WORKERS_ROOT_TAIL);
	const fresh = join(workers, "scratch-98");
	try {
		assert.equal(runOrient(["--write"], dataEnv, root).status, 0);
		mkdirSync(fresh, { recursive: true });
		writeFileSync(join(fresh, "NOTES.md"), "# a session the packet has never seen\n");
		chmodSync(fresh, 0o000);
		if (readSessions(workers).state !== "partial") {
			t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
			return;
		}
		// Nothing inside it was ever indexed, so there is no pointer to lose: the
		// refusal is about erasure, not about refusing every imperfect scan.
		const written = runOrient(["--write"], dataEnv, root);
		assert.equal(written.status, 0, written.stderr);
		const packet = JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
		assert.equal(packet.machine_local.workers_root_state, "partial");
		assert.deepEqual(packet.machine_local.unreadable_sessions, ["scratch-98"]);
		assert.equal(packet.totals.session_artifacts, 2);
		// And --where says so, in the same words, from the packet it just wrote.
		const where = runOrient(["--where"], dataEnv, root);
		assert.equal(where.status, 3, where.stdout);
		assert.match(where.stdout, /partial: scratch-98 unreadable/);
	} finally {
		chmodSync(fresh, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("the exported state vocabulary is the one readSessions actually emits", (t) => {
	// This is the guard the card's test cannot be: the card is hand-written prose,
	// so a fifth state added to the resolver would be explained nowhere unless
	// something compares the resolver to the list. Here every reachable state is
	// produced by a real call and checked against the export.
	const root = mkdtempSync(join(tmpdir(), "uctm-states-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-01", "blocked"), { recursive: true });
	writeFileSync(join(workers, "scratch-01", "NOTES.md"), "# notes\n");
	const blocked = join(workers, "scratch-01", "blocked");
	const observed = new Set();
	try {
		observed.add(readSessions(workers).state);
		observed.add(readSessions(join(root, "absent")).state);
		chmodSync(blocked, 0o000);
		observed.add(readSessions(workers).state);
		chmodSync(blocked, 0o755);
		chmodSync(workers, 0o000);
		observed.add(readSessions(workers).state);
		chmodSync(workers, 0o755);
	} finally {
		chmodSync(blocked, 0o755);
		chmodSync(workers, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
	if (observed.size < 4) {
		t.skip(`this reader cannot produce every state here; observed ${[...observed].sort().join(", ")}`);
		return;
	}
	assert.deepEqual([...observed].sort(), [...WORKERS_ROOT_STATES].sort());
});

test("workersRootState is a path predicate, so it cannot answer partial", () => {
	// The two vocabularies differ by exactly one value, and that value is the one
	// that decides whether a scan was a complete comparison. Naming the difference
	// is what stops a caller branching on the path state from reporting a partial
	// scan as a whole one.
	const scanOnly = WORKERS_ROOT_STATES.filter((state) => !WORKERS_ROOT_PATH_STATES.includes(state));
	assert.deepEqual(scanOnly, ["partial"]);
	assert.deepEqual(WORKERS_ROOT_PATH_STATES, ["read", "missing", "unreadable"]);
});

test("a partial root reads as `read` to the path predicate, and that divergence is asserted", (t) => {
	const root = mkdtempSync(join(tmpdir(), "uctm-path-vs-scan-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-01", "blocked"), { recursive: true });
	writeFileSync(join(workers, "scratch-01", "READABLE.md"), "# collected\n");
	writeFileSync(join(workers, "scratch-01", "blocked", "hidden.md"), "# unreachable\n");
	const blocked = join(workers, "scratch-01", "blocked");
	chmodSync(blocked, 0o000);
	const scan = readSessions(workers);
	if (scan.state !== "partial") {
		chmodSync(blocked, 0o755);
		rmSync(root, { recursive: true, force: true });
		t.skip("this reader can list a 0o000 directory, so the partial branch is unreachable here");
		return;
	}
	try {
		// The divergence is the point: the path was listable, so the path predicate
		// says `read`, while the scan that went looking inside it says `partial`.
		// A caller that reads the first as "the dimension was compared" is wrong
		// here, which is why the two vocabularies are exported separately.
		assert.equal(workersRootState(workers), "read");
		assert.equal(scan.state, "partial");
		assert.notEqual(workersRootState(workers), scan.state);
		// And on the three root-level facts, they agree.
		assert.equal(workersRootState(join(root, "nowhere")), "missing");
		chmodSync(workers, 0o000);
		assert.equal(workersRootState(workers), "unreadable");
		assert.equal(readSessions(workers).state, "unreadable");
		chmodSync(workers, 0o755);
		// The subtree has to be reopened too, or the scan is still partial and this
		// line asserts the divergence it just claimed to be testing agreement about
		// -- which is what the first version of this test did.
		chmodSync(blocked, 0o755);
		assert.equal(workersRootState(workers), readSessions(workers).state);
	} finally {
		chmodSync(blocked, 0o755);
		chmodSync(workers, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});
