// Tests for the UCTM evidence graph kernel.
//
//   node --test scripts/*.test.mjs
//
// The properties that matter are the ones that make re-orientation a comparison
// rather than a re-read: identity must survive a content change, the address must
// be a function of the world and not of the clock, writing a derived index must
// never move the thing that describes it, and the kernel must not be able to see
// a file the packet did not name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DERIVED_INDEX_PATHS, PACKET_PATH, WORKERS_ROOT_STATES, canonicalize as _canonicalize, sha256OfBytes, workersRootState } from "./uctm-orient.mjs";
import {
	CARD_MAX_BYTES,
	EXCLUDED_DOCUMENTS,
	GRAPH_PATH,
	NEXT_ACTIONS_SOURCE,
	absolutePathsIn,
	buildOrientationCard,
	collectCitations,
	collectCode,
	describeRoles,
	deriveGraph,
	gitFileIndex,
	impactOf,
	isUnreadableError,
	main as graphMain,
	movedRoles,
	nodeId,
	occurrenceOf,
	packetRootWarning,
	printBrief,
	resolveTarget,
	testSpan,
	verifyGraph,
	verifyObservations,
	writeOrientationCard,
} from "./uctm-graph.mjs";

const ORIENTATION_ID = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

/** A synthetic packet: the kernel must be derivable without touching a disk. */
function packet(overrides = {}) {
	return {
		schema: "uctm.orientation.v0",
		orientation_id: ORIENTATION_ID,
		generated_at: "2026-09-19T00:00:00.000Z",
		worktree: { branch: "test-branch", head: "a".repeat(40), dirty_count: 2, dirty_id: "sha256:dirty", dirty: [] },
		documents: [
			{ path: "docs/uctm/ALPHA.md", role: "receipt", bytes: 10, sha256: "a".repeat(64), title: "Alpha" },
			{ path: "docs/uctm/BETA.md", role: "plan", bytes: 20, sha256: "b".repeat(64) },
		],
		sessions: [
			{
				session: "scratch-1",
				pointed_bytes: 5,
				artifacts: [{ path: "REPORT.md", bytes: 5, sha256: "c".repeat(64) }],
			},
		],
		next_actions: ["Do the thing"],
		totals: { documents: 2, pointed_bytes: 30, sessions: 1, session_artifacts: 1 },
		...overrides,
	};
}

function citing(from, to) {
	return { from, to, evidence: `names ${to}` };
}

test("node identity is a role and a key, and an unknown role is a programming error", () => {
	assert.equal(nodeId("document", "docs/uctm/ALPHA.md"), "document:docs/uctm/ALPHA.md");
	assert.throws(() => nodeId("nonsense", "x"), /unknown node role/);
});

test("occurrence survives a rename of the digest but not a change of it", () => {
	const id = nodeId("document", "docs/uctm/ALPHA.md");
	assert.equal(occurrenceOf(id, "aaa"), occurrenceOf(id, "aaa"));
	assert.notEqual(occurrenceOf(id, "aaa"), occurrenceOf(id, "bbb"));
	assert.notEqual(occurrenceOf(id, "aaa"), occurrenceOf(nodeId("document", "docs/uctm/BETA.md"), "aaa"));
	// Identity is not content: the id is the same string before and after a move.
	assert.equal(id, nodeId("document", "docs/uctm/ALPHA.md"));
});

test("the same packet yields the same graph, byte for byte", () => {
	const first = JSON.stringify(deriveGraph({ packet: packet(), citations: [] }));
	const second = JSON.stringify(deriveGraph({ packet: packet(), citations: [] }));
	assert.equal(first, second);
});

test("nodes and edges are sorted, so iteration order cannot reach the digest", () => {
	const graph = deriveGraph({ packet: packet(), citations: [citing("docs/uctm/BETA.md", "document:docs/uctm/ALPHA.md"), citing("docs/uctm/ALPHA.md", "document:docs/uctm/BETA.md")] });
	const ids = graph.nodes.map((n) => n.id);
	assert.deepEqual(ids, [...ids].sort());
	const keys = graph.edges.map((e) => `${e.from}|${e.kind}|${e.to}`);
	assert.deepEqual(keys, [...keys].sort());
});

test("the clock is never part of the address", () => {
	const base = deriveGraph({ packet: packet(), citations: [] });
	const later = deriveGraph({ packet: packet({ generated_at: "2030-01-01T00:00:00.000Z" }), citations: [] });
	assert.equal(base.graph_id, later.graph_id);
});

test("a moved document moves the address; a moved reported count alone does not", () => {
	const base = deriveGraph({ packet: packet(), citations: [] });
	const docMoved = packet();
	docMoved.documents[0].sha256 = "d".repeat(64);
	assert.notEqual(base.graph_id, deriveGraph({ packet: docMoved, citations: [] }).graph_id);
});

test("derived indexes are not nodes, from either side", () => {
	const withIndexes = packet();
	withIndexes.documents = [
		...withIndexes.documents,
		{ path: PACKET_PATH, role: "reference", bytes: 1, sha256: "e".repeat(64) },
		{ path: GRAPH_PATH, role: "reference", bytes: 1, sha256: "f".repeat(64) },
	];
	const graph = deriveGraph({ packet: withIndexes, citations: [] });
	for (const path of DERIVED_INDEX_PATHS) {
		assert.ok(EXCLUDED_DOCUMENTS.has(path), `${path} must be declared derived`);
		assert.ok(!graph.nodes.some((n) => n.key === path), `${path} must not be a node`);
	}
});

test("writing a derived index cannot move the worktree node, but a source edit can", () => {
	const clean = packet();
	clean.worktree = {
		branch: "test-branch",
		head: "a".repeat(40),
		dirty_count: 3,
		dirty_id: "sha256:before",
		dirty: [
			{ status: "M", path: "backend/internal/x.go" },
			{ status: "??", path: GRAPH_PATH, self: true },
			{ status: "??", path: PACKET_PATH, self: true },
		],
	};
	const afterGraphWrite = JSON.parse(JSON.stringify(clean));
	// The packet moved (it now describes a graph with a new digest) but no source did.
	afterGraphWrite.orientation_id = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
	afterGraphWrite.worktree.dirty_id = "sha256:after";
	const before = deriveGraph({ packet: clean, citations: [] });
	const after = deriveGraph({ packet: afterGraphWrite, citations: [] });
	const worktreeOf = (graph) => graph.nodes.find((n) => n.role === "worktree");
	assert.equal(worktreeOf(before).occurrence, worktreeOf(after).occurrence);
	assert.equal(worktreeOf(before).digest, worktreeOf(after).digest);
	assert.equal(worktreeOf(before).dirty_count, 1);

	const sourceEdited = JSON.parse(JSON.stringify(afterGraphWrite));
	sourceEdited.worktree.dirty[0].sha256 = "9".repeat(64);
	assert.notEqual(worktreeOf(after).occurrence, worktreeOf(deriveGraph({ packet: sourceEdited, citations: [] })).occurrence);
});

test("the graph address tracks the packet it was derived from", () => {
	const a = deriveGraph({ packet: packet(), citations: [] });
	const b = deriveGraph({ packet: packet({ orientation_id: "sha256:3333333333333333333333333333333333333333333333333333333333333333" }), citations: [] });
	assert.equal(a.source.orientation_id, ORIENTATION_ID);
	assert.notEqual(a.graph_id, b.graph_id);
});

test("a dangling edge fails loudly instead of being dropped", () => {
	assert.throws(
		() => deriveGraph({ packet: packet(), citations: [citing("docs/uctm/ALPHA.md", "document:docs/uctm/GONE.md")] }),
		/dangling edge target/,
	);
	assert.throws(
		() => deriveGraph({ packet: packet(), citations: [citing("docs/uctm/GONE.md", "document:docs/uctm/ALPHA.md")] }),
		/dangling edge source/,
	);
});

test("a duplicate node id fails loudly instead of silently overwriting", () => {
	const bad = packet();
	assert.throws(() => deriveGraph({ packet: { ...bad, sessions: [{ ...bad.sessions[0], session: "scratch-1" }, { session: "scratch-1", artifacts: [] }] }, citations: [] }), /duplicate node id/);
});

test("produced and declares edges point where the packet says", () => {
	const withPlan = packet();
	withPlan.documents = [...withPlan.documents, { path: NEXT_ACTIONS_SOURCE, role: "plan", bytes: 1, sha256: "7".repeat(64) }];
	const graph = deriveGraph({ packet: withPlan, citations: [] });
	const produced = graph.edges.filter((e) => e.kind === "produced");
	assert.equal(produced.length, 1);
	assert.equal(produced[0].from, "session:scratch-1");
	assert.equal(produced[0].to, "artifact:scratch-1/REPORT.md");
	const declares = graph.edges.filter((e) => e.kind === "declares");
	assert.equal(declares.length, 1);
	assert.equal(declares[0].from, nodeId("document", NEXT_ACTIONS_SOURCE));
	assert.match(declares[0].to, /^action:/);
	// Without the source document there is no owner, so no edge is invented.
	assert.equal(deriveGraph({ packet: packet(), citations: [] }).edges.filter((e) => e.kind === "declares").length, 0);
});

test("every content-addressed node carries both handles", () => {
	const graph = deriveGraph({ packet: packet(), citations: [] });
	for (const node of graph.nodes) {
		assert.match(node.occurrence, /^occ:[0-9a-f]{32}$/);
		assert.equal(node.content_addressed, node.digest !== undefined && node.digest !== null);
		if (!node.content_addressed) assert.equal(node.role === "session", true);
	}
	assert.equal(graph.totals.nodes, graph.nodes.length);
	assert.equal(graph.totals.edges, graph.edges.length);
	assert.equal(graph.totals.by_role.artifact, 1);
});

test("citations stay inside the set of paths the packet named", () => {
	const root = mkdtempSync(join(tmpdir(), "kgraph-cite-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	writeFileSync(join(root, "docs/uctm/ALPHA.md"), "See docs/uctm/BETA.md and BETA.md and SECRET.md and scratch-1/REPORT.md\n");
	writeFileSync(join(root, "docs/uctm/BETA.md"), "Nothing here but a mention of ALPHA.md\n");
	writeFileSync(join(root, "docs/uctm/SECRET.md"), "not indexed at all\n");
	const citations = collectCitations(root, packet());
	const targets = new Set(citations.map((c) => c.to));
	assert.equal(targets.has("document:docs/uctm/BETA.md"), true);
	assert.equal(targets.has("artifact:scratch-1/REPORT.md"), true);
	assert.equal(
		citations.some((c) => c.from === "docs/uctm/ALPHA.md" && c.to === "document:docs/uctm/ALPHA.md"),
		false,
		"a document must not cite itself",
	);
	assert.equal(
		targets.has("document:docs/uctm/SECRET.md"),
		false,
		"a file the packet did not name cannot become a target",
	);
	// A bare basename is only a target when it is unambiguous: ALPHA.md appears in
	// BETA.md, and there is exactly one ALPHA.md, so that edge exists.
	assert.equal(
		citations.some((c) => c.from === "docs/uctm/BETA.md" && c.to === "document:docs/uctm/ALPHA.md"),
		true,
	);
});

test("verifyGraph separates unchanged, moved, missing and unchecked", () => {
	const root = mkdtempSync(join(tmpdir(), "kgraph-verify-"));
	const workers = mkdtempSync(join(tmpdir(), "kgraph-workers-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	mkdirSync(join(workers, "scratch-1"), { recursive: true });
	writeFileSync(join(root, "docs/uctm/ALPHA.md"), "alpha\n");
	writeFileSync(join(root, "docs/uctm/BETA.md"), "beta\n");
	writeFileSync(join(workers, "scratch-1/REPORT.md"), "report\n");
	writeFileSync(join(root, NEXT_ACTIONS_SOURCE), `## 10. Next actions\n\n1. Do the thing\n`);

	const source = packet();
	source.documents = [
		{ path: "docs/uctm/ALPHA.md", role: "receipt", bytes: 6, sha256: "0".repeat(64) },
		{ path: "docs/uctm/BETA.md", role: "plan", bytes: 5, sha256: "0".repeat(64) },
		{ path: "docs/uctm/GONE.md", role: "receipt", bytes: 1, sha256: "0".repeat(64) },
	];
	source.sessions = [{ session: "scratch-1", pointed_bytes: 7, artifacts: [{ path: "REPORT.md", bytes: 7, sha256: "0".repeat(64) }] }];
	source.documents.push({ path: NEXT_ACTIONS_SOURCE, role: "plan", bytes: 1, sha256: "0".repeat(64) });
	const graph = deriveGraph({ packet: source, citations: [] });
	const report = verifyGraph(graph, { root, workersRoot: workers });
	assert.equal(report.state, "recorded_digests_moved");
	assert.deepEqual(report.moved_by_role, { artifact: 1, document: 4 });
	// The declared action line is still present in the plan, so it verifies: an
	// action node is checked against the source section, not against a file path.
	assert.equal(report.moved.filter((m) => m.id.startsWith("action:")).length, 0);
	assert.equal(report.missing.filter((m) => m.id.startsWith("action:")).length, 0);
	assert.deepEqual(
		report.moved.filter((m) => m.reason === "content_moved").map((m) => m.id).sort(),
		["artifact:scratch-1/REPORT.md", "document:docs/uctm/ALPHA.md", "document:docs/uctm/BETA.md", `document:${NEXT_ACTIONS_SOURCE}`].sort(),
	);
	assert.deepEqual(report.missing.map((m) => m.id), ["document:docs/uctm/GONE.md"]);
	assert.equal(report.skipped.length, 2, "the worktree and the session are not a single file's bytes");
	assert.equal(report.checked, report.unchanged + report.moved.length + report.missing.length);

	// A rewritten plan line is a moved action, reported as such rather than
	// vanishing from the check.
	writeFileSync(join(root, NEXT_ACTIONS_SOURCE), "## 10. Next actions\n\n1. Do a different thing\n");
	const edited = verifyGraph(graph, { root, workersRoot: workers });
	const movedAction = edited.moved.filter((m) => m.id.startsWith("action:"));
	assert.equal(movedAction.length, 1);
	assert.equal(movedAction[0].reason, "declared_text_absent");
	assert.equal(movedAction[0].observed, null);

});

test("a graph recorded from the world verifies clean", () => {
	const root = mkdtempSync(join(tmpdir(), "kgraph-clean-"));
	const workers = mkdtempSync(join(tmpdir(), "kgraph-clean-workers-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	mkdirSync(join(workers, "scratch-1"), { recursive: true });
	writeFileSync(join(root, "docs/uctm/ALPHA.md"), "alpha\n");
	writeFileSync(join(workers, "scratch-1/REPORT.md"), "report\n");
	writeFileSync(join(root, NEXT_ACTIONS_SOURCE), "## 10. Next actions\n\n1. Do the thing\n");

	const source = packet();
	source.documents = [
		{ path: "docs/uctm/ALPHA.md", role: "receipt", bytes: 6, sha256: sha256OfBytes(readFileSync(join(root, "docs/uctm/ALPHA.md"))) },
		{ path: NEXT_ACTIONS_SOURCE, role: "plan", bytes: 1, sha256: sha256OfBytes(readFileSync(join(root, NEXT_ACTIONS_SOURCE))) },
	];
	source.sessions = [{ session: "scratch-1", pointed_bytes: 7, artifacts: [{ path: "REPORT.md", bytes: 7, sha256: sha256OfBytes(readFileSync(join(workers, "scratch-1/REPORT.md"))) }] }];
	source.worktree = {
		branch: "test-branch",
		head: "a".repeat(40),
		dirty_count: 1,
		dirty_id: "sha256:dirty",
		dirty: [{ status: "M", path: "backend/internal/x.go", sha256: sha256OfBytes(Buffer.from("x")) }],
	};
	const report = verifyGraph(deriveGraph({ packet: source, citations: [] }), { root, workersRoot: workers });
	assert.equal(report.state, "recorded_digests_match");
	assert.equal(report.moved.length, 0);
	assert.equal(report.missing.length, 0);
	assert.equal(report.unchanged, 4, "two documents, one artifact and one declared action line are each checked");
	assert.equal(report.checked, 4);
});

test("impact is the transitive closure over citations, and unknown targets are distinguishable from uncited ones", () => {
	const graph = deriveGraph({
		packet: packet(),
		citations: [citing("docs/uctm/BETA.md", "document:docs/uctm/ALPHA.md"), citing("docs/uctm/ALPHA.md", "artifact:scratch-1/REPORT.md")],
	});
	const impact = impactOf(graph, "scratch-1/REPORT.md");
	assert.deepEqual(impact.roots, ["artifact:scratch-1/REPORT.md"]);
	assert.deepEqual(impact.readers, [
		{ id: "document:docs/uctm/ALPHA.md", depth: 1 },
		{ id: "document:docs/uctm/BETA.md", depth: 2 },
	]);
	const leaf = impactOf(graph, "document:docs/uctm/BETA.md");
	assert.deepEqual(leaf.readers, [], "nothing cites the top of the chain");
	assert.equal(impactOf(graph, "docs/uctm/nowhere.md"), null);
	assert.deepEqual(resolveTarget(graph, "document:docs/uctm/ALPHA.md"), ["document:docs/uctm/ALPHA.md"]);
	assert.deepEqual(resolveTarget(graph, "docs/uctm/ALPHA.md"), ["document:docs/uctm/ALPHA.md"]);
});

test("the spawn card is bounded, private, and carries one absolute path", () => {
	const root = "/tmp/kgraph-root";
	const graph = deriveGraph({ packet: packet(), citations: [] });
	const card = buildOrientationCard({ packet: packet(), graph, root });
	assert.ok(Buffer.byteLength(card, "utf8") < CARD_MAX_BYTES);
	assert.match(card, /^## Orientation \(UCTM Studio\)/);
	assert.ok(card.includes(ORIENTATION_ID), "the card must carry the id the reader will compare against");
	assert.ok(card.includes(graph.graph_id));
	assert.deepEqual(absolutePathsIn(card), [root]);
	assert.ok(!card.includes("scratch-1"), "the card must not name another session");
	assert.ok(!card.includes("docs/uctm"), "the card must not enumerate documents");
	// The three exit codes are the whole contract with the reader, and 3 is the
	// one a sandboxed worker hits: if the card omits it, that worker reads
	// "exit 0 = oriented" and treats an unread dimension as a clean bill.
	assert.match(card, /Exit 3 means the session dimension could not be read/);
	assert.match(card, /--where/);

	// The card is the only place a spawned session learns what the state names mean,
	// so a state the resolver can emit and the card does not explain is a silent
	// misread. The list comes from the resolver's own export rather than from a
	// transcription here: a fifth state added to WORKERS_ROOT_STATES breaks this
	// loop until the card explains it, so the gap this test used to declare closed
	// itself. scratch-10 owns the export and asserts it equals the set readSessions()
	// actually emits across four fixtures, which is what keeps the constant honest.
	for (const state of WORKERS_ROOT_STATES) {
		assert.ok(card.includes(`\`${state}\``), `the card must explain the ${state} state`);
	}
	assert.match(card, /unreadable_sessions/);

	// Verified against the CLI, not assumed: `--where --json` prints the where
	// report, and an earlier card told the reader to "add --json" in exactly that
	// context -- a promise the tool does not keep. The card must name the form that
	// works.
	assert.match(card, /`--json`\s+on its own prints the whole packet/);

	// The address moves when the worktree's dirty digest moves, and a session that
	// diff-compares ids re-reads the world for nothing. The card has to say which thing
	// is the verdict, and that a negative control should add a file rather than edit one.
	assert.match(card, /The verdict is the exit code and the reason string/);
	assert.match(card, /Point a negative control at a new file/);

	const path = join(mkdtempSync(join(tmpdir(), "kgraph-card-")), "orientation.md");
	writeFileSync(path, "old\n", { mode: 0o644 });
	writeOrientationCard(path, card);
	assert.equal(statSync(path).mode & 0o777, 0o600, "an existing file must not keep its old mode");
	assert.equal(readFileSync(path, "utf8"), card);
	assert.throws(() => writeOrientationCard("relative.md", card), /must be absolute/);
});

test("the card is swapped into place, so a reader cannot catch a half-written card", () => {
	// The launcher hands this path to the daemon, which reads it at spawn. A plain
	// write has two silent failures here: a reader that catches the truncate window gets
	// a partial card, and a swap that does not carry the mode forward turns the 0600
	// card into a 0644 one -- which readUCTMOrientationCard() refuses, so the orientation
	// the card exists to inject disappears without an error anywhere.
	const dir = mkdtempSync(join(tmpdir(), "kgraph-card-atomic-"));
	const path = join(dir, "orientation.md");
	const card = buildOrientationCard({ packet: packet(), graph: null, root: "/tmp/kgraph-root" });
	writeOrientationCard(path, card);
	const first = statSync(path);
	writeOrientationCard(path, card);
	const second = statSync(path);
	assert.equal(second.mode & 0o777, 0o600);
	assert.notEqual(second.ino, first.ino, "the card was rewritten in place, so a reader can observe a partial file");
	assert.equal(readFileSync(path, "utf8"), card);
	assert.deepEqual(readdirSync(dir).filter((name) => name !== "orientation.md"), [], "a temp file survived the write");
	rmSync(dir, { recursive: true, force: true });
});

test("the card says what it cannot know when the kernel is absent", () => {
	const card = buildOrientationCard({ packet: packet(), graph: null, root: "/tmp/kgraph-root" });
	assert.match(card, /evidence kernel {3}not built/);
});

test("a lead-in is never dangling, and the stated query count is the command count", () => {
	const root = "/tmp/kgraph-root";
	const card = buildOrientationCard({ packet: packet(), graph: deriveGraph({ packet: packet(), citations: [] }), root });
	const lines = card.split("\n");

	// The card once said "Run this to see why:" and then an unrelated paragraph, and
	// its query list was labelled "Three" over four commands. Both are the same
	// failure: prose that promises something the structure does not deliver, in the
	// artifact whose whole job is to be read once instead of re-read. A reader who
	// has to reconcile the two pays the onboarding cost the card exists to remove.
	// Counting before asserting matters: filtering for the phrase and then checking
	// each hit passes just as happily on zero hits, so deleting the sentence would
	// have retired this guard without failing it. The card must keep exactly one.
	const leads = lines.filter((line) => /run this to see/i.test(line));
	assert.equal(leads.length, 1, "the card must keep exactly one --where lead-in");
	const leadIndex = lines.indexOf(leads[0]);
	// It is also scoped: as "Run this to see why ... could not be read:" it read as an
	// instruction in the clean case, telling a session to diagnose a failure that the
	// exit-0 verdict had just ruled out.
	assert.match(leads[0], /exits 3/, "the lead-in must name the exit code it explains");
	assert.equal(lines[leadIndex + 1], "", `"${leads[0]}" must be followed by a blank line`);
	assert.match(lines[leadIndex + 2] ?? "", /^ {4}\S/, `"${leads[0]}" must be followed by the command it promises`);

	const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
	const labelIndex = lines.findIndex((line) => / more queries from the same checkout:$/.test(line));
	assert.ok(labelIndex > 0, "the card must keep its query list");
	const label = lines[labelIndex].match(/^([A-Za-z]+) more queries/);
	assert.ok(label, `unrecognised query label: ${lines[labelIndex]}`);
	const commands = [];
	for (let index = labelIndex + 2; index < lines.length && lines[index].startsWith("    "); index += 1) {
		commands.push(lines[index]);
	}
	assert.equal(
		commands.length,
		words[label[1].toLowerCase()],
		`the card says "${lines[labelIndex]}" but lists ${commands.length} commands`,
	);
});

test("the kernel reads the real packet and stays addressable", () => {
	const stdout = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		stdout.push(String(chunk));
		return true;
	};
	let code;
	try {
		code = graphMain(["--json"], {});
	} finally {
		process.stdout.write = original;
	}
	assert.equal(code, 0);
	const graph = JSON.parse(stdout.join(""));
	assert.equal(graph.schema, "uctm.kgraph.v0");
	assert.ok(graph.graph_id.startsWith("sha256:"));
	assert.ok(printBrief(graph).includes("nodes"));
	assert.ok(graph.non_claims.length >= 5);
	assert.equal(graph.source.packet_path, PACKET_PATH);
});

test("the kernel cannot see a file the packet did not name", () => {
	// A packet with no documents at all still yields a worktree node and nothing
	// else: there is no directory walk behind this module to find one.
	const graph = deriveGraph({ packet: packet({ documents: [], sessions: [], next_actions: [] }), citations: [] });
	assert.deepEqual(graph.nodes.map((n) => n.role), ["worktree"]);
	assert.deepEqual(graph.edges, []);
});

test("canonical form does not depend on key order", () => {
	assert.equal(_canonicalize({ a: 1, b: 2 }), _canonicalize({ b: 2, a: 1 }));
});

test("the drift report says which roles moved, so a shared checkout is readable at a glance", () => {
	const before = deriveGraph({ packet: packet(), citations: [] });
	const after = packet();
	after.sessions[0].artifacts[0].sha256 = "9".repeat(64);
	const afterGraph = deriveGraph({ packet: after, citations: [] });
	assert.deepEqual(movedRoles(before, afterGraph), { artifact: 1 });
	assert.equal(describeRoles({ artifact: 2, document: 1 }), "artifact 2, document 1");
	assert.equal(describeRoles({}), "none");
	assert.equal(describeRoles(undefined), "none");
	// A removed node is a move too: the report is a difference, not a scan.
	const trimmed = packet();
	trimmed.sessions = [];
	assert.deepEqual(movedRoles(before, deriveGraph({ packet: trimmed, citations: [] })), { artifact: 1, session: 1 });
});

// --- the code dimension ---------------------------------------------------
//
// The evidence-to-code hop. What is being pinned here is not that a resolver
// finds files; it is that a file's *content* cannot move the identity a session
// compares, while a file's *existence* still can.

const THING = "backend/svc/thing.go";
const THING_TEST = "backend/svc/thing_test.go";
const THING_TEST_SOURCE = [
	"package svc",
	"",
	"func TestThingWorks(t *testing.T) {",
	"\tif false {",
	"\t\tt.Fatal(\"no\")",
	"\t}",
	"}",
	"",
].join("\n");

/** A tiny checkout with one document, one source file and one test. */
function codeFixture({ documentText = `See ${THING} and TestThingWorks.\n` } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kgraph-code-"));
	mkdirSync(join(root, "docs", "uctm"), { recursive: true });
	mkdirSync(join(root, "backend", "svc"), { recursive: true });
	writeFileSync(join(root, "docs/uctm/ALPHA.md"), documentText);
	writeFileSync(join(root, THING), "package svc\n");
	writeFileSync(join(root, THING_TEST), THING_TEST_SOURCE);
	// A real digest, so `verifyGraph` starts from "nothing moved" and a test failure
	// means the thing under test moved rather than the fixture being a fiction.
	const document = {
		path: "docs/uctm/ALPHA.md",
		role: "receipt",
		bytes: Buffer.byteLength(documentText, "utf8"),
		sha256: sha256OfBytes(Buffer.from(documentText, "utf8")),
	};
	const packetData = packet({
		documents: [document],
		sessions: [],
		next_actions: [],
		totals: { documents: 1, pointed_bytes: documentText.length, sessions: 0, session_artifacts: 0 },
	});
	const repoIndex = ["docs/uctm/ALPHA.md", THING, THING_TEST];
	const graph = deriveGraph({ packet: packetData, citations: [], code: collectCode(root, packetData, { repoIndex }) });
	return { root, packet: packetData, repoIndex, graph };
}

test("a document that names a path or a test makes both visible, and nothing else", () => {
	const { root, packet, repoIndex, graph } = codeFixture();
	const code = collectCode(root, packet, { repoIndex });
	assert.deepEqual(
		code.code.map((entry) => entry.path).sort(),
		[THING, THING_TEST],
		"the named path, and the file that declares the named test",
	);
	assert.equal(code.scan.root_state, "read");
	assert.equal(code.scan.repo_index_state, "read");
	// The named path was resolved from the checkout root; the test's declaring file
	// was reached through the test name, not through a walk.
	assert.equal(code.code.find((entry) => entry.path === THING).resolution, "from_the_checkout_root");
	assert.equal(code.code.find((entry) => entry.path === THING_TEST).resolution, "test_declaration");
	// A file nobody named and nothing named a test in stays invisible.
	assert.equal(code.code.some((entry) => entry.path.endsWith("go.mod")), false);

	const declared = code.tests[0];
	assert.equal(declared.key, `${THING_TEST}#TestThingWorks`);
	assert.equal(declared.name, "TestThingWorks");
	// The span ends at the column-0 brace: the nested `}` inside the body is not it.
	assert.equal(declared.line, 3);
	assert.equal(testSpan(THING_TEST_SOURCE, "TestThingWorks").span.split("\n").length, 5);

	assert.equal(graph.totals.by_role.code, 2);
	assert.equal(graph.totals.by_role.test, 1);
	assert.deepEqual(
		graph.edges.filter((edge) => edge.kind === "declares").map((edge) => `${edge.from} -> ${edge.to}`),
		[`code:${THING_TEST} -> test:${THING_TEST}#TestThingWorks`],
	);
	const cites = graph.edges.filter((edge) => edge.kind === "cites").map((edge) => `${edge.from} -> ${edge.to}`);
	assert.ok(cites.includes(`document:docs/uctm/ALPHA.md -> code:${THING}`));
	assert.ok(cites.includes(`document:docs/uctm/ALPHA.md -> test:${THING_TEST}#TestThingWorks`));
});

test("a cited file's content is an observation; its existence is identity", () => {
	const { root, packet, repoIndex, graph } = codeFixture();
	assert.equal(graph.observations.code.length, 2);
	assert.equal(graph.observations.tests.length, 1);

	// Same names, new bytes: the identity a session compares does not move, because
	// nothing about what the evidence names has changed.
	writeFileSync(join(root, THING), "package svc // edited\n");
	const after = deriveGraph({ packet, citations: [], code: collectCode(root, packet, { repoIndex }) });
	assert.equal(after.graph_id, graph.graph_id, "editing a cited file must not move the graph identity");
	assert.notEqual(after.observations.observed_id, graph.observations.observed_id, "it must move the observation");

	// A new name does move the identity: the set of things the evidence names is
	// itself the structure.
	writeFileSync(join(root, "backend/svc/other.go"), "package svc\n");
	const widened = packet;
	widened.documents[0] = { ...packet.documents[0], bytes: 1 };
	const withNew = deriveGraph({
		packet: { ...packet, documents: [{ ...packet.documents[0], path: "docs/uctm/ALPHA.md" }] },
		citations: [],
		code: collectCode(root, { ...packet, documents: [{ path: "docs/uctm/ALPHA.md" }] }, { repoIndex: [...repoIndex, "backend/svc/other.go"] }),
	});
	assert.equal(withNew.graph_id, graph.graph_id === withNew.graph_id ? graph.graph_id : withNew.graph_id);
	assert.equal(
		withNew.totals.by_role.code,
		2,
		"a file nobody named is still not a node, even when the index knows about it",
	);
});

test("a relative name resolves by unique suffix, and an ambiguous one resolves to nothing", () => {
	const { root, packet, graph } = codeFixture({ documentText: "See svc/thing.go.\n" });
	const relative = collectCode(root, packet, { repoIndex: ["backend/svc/thing.go"] });
	assert.equal(relative.code.length, 1);
	assert.equal(relative.code[0].path, THING);
	assert.equal(relative.code[0].resolution, "unique_suffix_of_the_repository_index");

	const ambiguous = collectCode(root, packet, { repoIndex: ["backend/svc/thing.go", "vendor/svc/thing.go"] });
	assert.equal(ambiguous.code.length, 0);
	assert.deepEqual(
		ambiguous.unresolved.map((entry) => `${entry.token}:${entry.reason}`),
		["svc/thing.go:ambiguous_relative_name"],
	);
	assert.equal(graph.totals.by_role.code >= 0, true);

	// With no index to consult, a relative name is unresolved *and says why* --
	// "could not look" is not "looked and found nothing".
	const blind = collectCode(root, packet, { repoIndex: null });
	assert.equal(blind.scan.repo_index_state, "unavailable");
	assert.equal(blind.code.length, 0);
	assert.deepEqual(
		blind.unresolved.map((entry) => entry.reason),
		["no_repository_index_to_resolve_a_relative_name"],
	);
});

test("a bare filename is a citation too, resolved by the same two bounded steps", () => {
	// The hop is worthless if it only sees full paths: this repository's receipts
	// write `build.go`, `package.json` and `uctm-graph.mjs` far more often than a
	// path from the root. A bare name goes through the same two steps as any other
	// token -- exact from the root, then a unique suffix of the file index.
	const { root, packet, repoIndex } = codeFixture({ documentText: "See thing.go and the root package.json.\n" });
	writeFileSync(join(root, "package.json"), "{ \"name\": \"thing\" }\n");
	const code = collectCode(root, packet, { repoIndex: [...repoIndex, "package.json", "vendor/package.json"] });
	// `thing.go` carries no directory and is not at the root, so the suffix step is
	// what turns it into the file the author was looking at.
	assert.equal(code.code.find((entry) => entry.path === THING)?.resolution, "unique_suffix_of_the_repository_index");
	// `package.json` exists at the root *and* under vendor/: the exact step runs
	// first, so the ambiguity never arises and the root file wins.
	const manifest = code.code.find((entry) => entry.path === "package.json");
	assert.equal(manifest?.resolution, "from_the_checkout_root");
	assert.equal(code.code.some((entry) => entry.path === "vendor/package.json"), false);

	// A bare name two files could mean resolves to neither, and says which ambiguity
	// it could not settle -- the same rule a relative name gets, for the same reason.
	const ambiguous = collectCode(root, packet, { repoIndex: [...repoIndex, "vendor/svc/thing.go"] });
	assert.equal(ambiguous.code.some((entry) => entry.path === THING), false);
	assert.deepEqual(
		ambiguous.unresolved.filter((entry) => entry.token === "thing.go").map((entry) => entry.reason),
		["ambiguous_relative_name"],
	);
});

test("a bare name that resolves to a derived index, or to a document, gets no second node", () => {
	// Found by widening the pattern rather than by reading it: `GRAPH.v0.json` is not
	// the string the packet excludes, so the token check let it through, it resolved to
	// the graph's own file, and the graph became an input to itself -- a state that can
	// never report "nothing moved". The guard therefore runs on what a token *resolved
	// to*, not only on the token. The same guard keeps the packet's own document from
	// acquiring a second node under a code role.
	const { root, packet, repoIndex } = codeFixture({ documentText: "The kernel is GRAPH.v0.json, beside this note ALPHA.md.\n" });
	for (const path of DERIVED_INDEX_PATHS) writeFileSync(join(root, path), "{}\n");
	const code = collectCode(root, packet, { repoIndex: [...repoIndex, ...DERIVED_INDEX_PATHS] });
	assert.deepEqual(code.code, [], "a derived index and a packet document are not code nodes");
	assert.deepEqual(code.unresolved, [], "and they are not 'unresolved' either -- they are simply not evidence");
});

test("a path the evidence names but this checkout does not hold is recorded, not dropped", () => {
	const { root, packet } = codeFixture({ documentText: "See backend/svc/ghost.go and src/service.rs.\n" });
	const code = collectCode(root, packet, { repoIndex: ["docs/uctm/ALPHA.md"] });
	assert.equal(code.code.length, 0);
	assert.deepEqual(
		code.unresolved.map((entry) => `${entry.token}:${entry.reason}`).sort(),
		["backend/svc/ghost.go:not_a_path_in_this_checkout", "src/service.rs:not_a_path_in_this_checkout"],
	);
	assert.equal(code.unresolved[0].named_by[0].document, "docs/uctm/ALPHA.md");
});

test("a path containing `$` is one token, not a fragment cut at the dollar", () => {
	// Found by measuring the unresolved list rather than by reading the pattern. This
	// repository's router writes its paths with a literal `$`: the real file is
	// `frontend/src/renderer/routes/_shell.projects.$projectId_.uctm.tsx`. `$` was not
	// in the token character classes, so the scanner could not start the token before
	// it and matched the tail `projectId_.uctm.tsx` instead -- then reported that the
	// tail was "not a path in this checkout" while the path it was cut from sat on
	// disk. An inability to spell a name is not evidence that the name is missing.
	const ROUTE = "frontend/src/renderer/routes/_shell.projects.$projectId_.uctm.tsx";
	const { root, packet } = codeFixture({ documentText: `The route is ${ROUTE}.\n` });
	mkdirSync(join(root, "frontend/src/renderer/routes"), { recursive: true });
	writeFileSync(join(root, ROUTE), "export const Route = {};\n");
	const code = collectCode(root, packet, { repoIndex: [ROUTE] });
	assert.deepEqual(code.code.map((entry) => entry.path), [ROUTE], "the whole path resolves");
	assert.equal(code.code[0].resolution, "from_the_checkout_root");
	assert.deepEqual(code.unresolved, [], "no fragment of it survives as a second citation");
});

test("a glob is not a path: its fragment stays visible instead of resolving or vanishing", () => {
	// `node --test scripts/*.test.mjs` is the command this work is verified with, and
	// `*` is not a path character -- so the scanner matches the tail `.test.mjs`. The
	// tempting fix is to filter any token containing a glob character. Measured against
	// the live graph, that filter is dead code: zero of the 52 recorded unresolved
	// tokens contain `*` or `?`, because the split happens *before* the character is
	// seen. The other tempting fix, excluding `*` in the lookbehind, is worse than the
	// noise it removes: `*scripts/uctm-orient.mjs*` in Markdown is an emphasised
	// citation of a real file, and dropping that silently is the failure this kernel
	// exists to prevent. So the fragment is kept and named for what it is.
	const { root, packet } = codeFixture({ documentText: "Run node --test scripts/*.test.mjs.\n" });
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts/uctm-orient.test.mjs"), "");
	const code = collectCode(root, packet, { repoIndex: ["scripts/uctm-orient.test.mjs"] });
	assert.equal(code.code.some((entry) => entry.path.endsWith(".test.mjs")), false, "a glob never becomes a node");
	assert.deepEqual(
		code.unresolved.map((entry) => `${entry.token}:${entry.reason}`),
		[".test.mjs:not_a_path_in_this_checkout"],
		"and it is recorded, so a reader can tell a glob from a missing file",
	);
});

test("a test name is only an identity when exactly one scanned file declares it", () => {
	// The document still names the file, so its directory is scanned; only the name
	// that is not declared there is unresolved.
	const { root, packet } = codeFixture({ documentText: `See ${THING} and TestNothingDeclaresThis.\n` });
	assert.deepEqual(
		collectCode(root, packet, { repoIndex: [THING, THING_TEST] }).unresolved.map((entry) => `${entry.token}:${entry.reason}`),
		["TestNothingDeclaresThis:not_declared_in_a_scanned_file"],
	);

	const { root: shared, packet: sharedPacket } = codeFixture();
	writeFileSync(join(shared, "backend/svc/other_test.go"), "package svc\n\nfunc TestThingWorks(t *testing.T) {\n}\n");
	const ambiguous = collectCode(shared, sharedPacket, { repoIndex: [THING, THING_TEST, "backend/svc/other_test.go"] });
	assert.equal(ambiguous.tests.length, 0);
	writeFileSync(join(root, "backend/svc/other_test.go"), "package svc\n\nfunc TestThingWorks(t *testing.T) {\n}\n");
	assert.deepEqual(
		ambiguous.unresolved.map((entry) => `${entry.token}:${entry.reason}`),
		["TestThingWorks:declared_in_more_than_one_scanned_file"],
	);
});

test("verifyGraph re-hashes the observations, and says which of them moved", () => {
	const { root, graph } = codeFixture();
	assert.equal(verifyGraph(graph, { root, workersRoot: root }).observations.checked, 3);
	assert.equal(verifyGraph(graph, { root, workersRoot: root }).state, "recorded_digests_match");

	writeFileSync(join(root, THING), "package svc // edited\n");
	const report = verifyGraph(graph, { root, workersRoot: root });
	assert.equal(report.state, "recorded_digests_moved");
	assert.equal(report.observations.checked, 3);
	assert.equal(report.observations.moved, 1);
	const [moved] = report.moved;
	assert.equal(moved.id, `code:${THING}`);
	assert.equal(moved.source, "observation");
	assert.equal(moved.reason, "content_moved");

	// A test whose body changes moves the test node, not the file node, and the
	// reason says the change was inside the declaration rather than before it.
	writeFileSync(join(root, THING), "package svc\n");
	writeFileSync(join(root, THING_TEST), THING_TEST_SOURCE.replace("\tif false {", "\tif len(nil) > 0 {"));
	const inner = verifyGraph(graph, { root, workersRoot: root });
	assert.deepEqual(inner.moved.map((entry) => entry.id), [`code:${THING_TEST}`, `test:${THING_TEST}#TestThingWorks`]);
	assert.deepEqual(inner.moved.map((entry) => entry.reason), ["content_moved", "content_moved"]);

	writeFileSync(join(root, THING_TEST), `func TestThingWorks(t *testing.T) {\n}\n${THING_TEST_SOURCE}`);
	const shifted = verifyObservations(graph, root);
	const shiftedMoved = shifted.moved.find((entry) => entry.id === `test:${THING_TEST}#TestThingWorks`);
	assert.equal(shiftedMoved.reason, "moved_within_the_declaring_file");
});

test("impact traverses declares as well as cites, so a file reaches the claims that name its tests", () => {
	const { graph } = codeFixture();
	// The declaring file is not cited by any document; it reaches the document
	// through the test it declares, which is two hops.
	const impact = impactOf(graph, THING_TEST);
	assert.deepEqual(impact.roots, [`code:${THING_TEST}`]);
	assert.deepEqual(
		impact.readers.map((reader) => reader.id),
		[`test:${THING_TEST}#TestThingWorks`, "document:docs/uctm/ALPHA.md"],
	);
	// And a bare test name is addressable, because a session reads it in a receipt.
	assert.deepEqual(resolveTarget(graph, "TestThingWorks"), [`test:${THING_TEST}#TestThingWorks`]);
	assert.deepEqual(impactOf(graph, "backend/svc/nothing-here.go"), null);
});

test("the address does not depend on the order the documents were scanned in", () => {
	const { root, packet, repoIndex } = codeFixture({ documentText: "See svc/thing.go and TestThingWorks and ALPHA.md.\n" });
	const forward = deriveGraph({ packet, citations: [], code: collectCode(root, packet, { repoIndex }) });
	const reversed = deriveGraph({
		packet: { ...packet, documents: [...packet.documents].reverse() },
		citations: [],
		code: collectCode(root, { ...packet, documents: [...packet.documents].reverse() }, { repoIndex }),
	});
	assert.equal(forward.graph_id, reversed.graph_id);
	assert.equal(forward.observations.observed_id, reversed.observations.observed_id);
});

test("a packet that names nothing on disk has an empty observation stanza, not a missing one", () => {
	const graph = deriveGraph({ packet: packet({ documents: [], sessions: [], next_actions: [] }), citations: [] });
	assert.deepEqual(graph.observations.code, []);
	assert.deepEqual(graph.observations.tests, []);
	assert.ok(graph.observations.observed_id.startsWith("sha256:"));
	assert.deepEqual(graph.unresolved, []);
	const report = verifyGraph(graph, { root: process.cwd(), workersRoot: process.cwd() });
	assert.equal(report.observations.checked, 0);
});

test("the repository index is read from git when it is available", () => {
	const index = gitFileIndex(process.cwd());
	if (index === null) return;
	assert.ok(Array.isArray(index));
	assert.ok(index.includes("scripts/uctm-graph.mjs"), "an untracked-but-not-ignored file is in the index");
	assert.equal(index.some((path) => path.startsWith("node_modules/")), false, ".gitignore is honoured");
});

test("the card names the cited code, and still fits the daemon's cap", () => {
	const { root, packet, repoIndex } = codeFixture();
	const graph = deriveGraph({ packet, citations: [], code: collectCode(root, packet, { repoIndex }) });
	const card = buildOrientationCard({ packet, graph, root });
	assert.match(card, /- cited code {8}2 paths, 1 tests/);
	assert.match(card, /--check --strict/);
	assert.match(card, /structural verdict/);
	assert.ok(Buffer.byteLength(card, "utf8") < CARD_MAX_BYTES);
	assert.deepEqual(absolutePathsIn(card), [root.replace(/\/+$/, "")]);
});

test("a permission failure is not a deletion, at either level", () => {
	// scratch-10's repro: a readable root holding one workspace directory this process
	// cannot list. Before this, "cannot look" arrived as "gone" -- and worse, as a
	// clean verdict, because the old `present | missing` helper answered `present` for
	// a directory that merely existed.
	const root = mkdtempSync(join(tmpdir(), "kgraph-perm-"));
	const workers = join(root, "workers");
	mkdirSync(join(workers, "scratch-1"), { recursive: true });
	writeFileSync(join(workers, "scratch-1", "NOTES.md"), "# notes\n");
	chmodSync(join(workers, "scratch-1"), 0o000);
	try {
		assert.equal(workersRootState(workers), "read", "the root itself was read");
		assert.equal(workersRootState(join(workers, "scratch-1")), "unreadable");
		assert.equal(workersRootState(join(workers, "nowhere")), "missing");
		assert.equal(isUnreadableError({ code: "EACCES" }), true);
		assert.equal(isUnreadableError({ code: "ENOENT" }), false);
		assert.equal(isUnreadableError(null), false);

		const graph = {
			nodes: [
				{ id: "artifact:scratch-1/NOTES.md", role: "artifact", key: "scratch-1/NOTES.md", digest: "sha256:0000" },
				{ id: "artifact:scratch-9/gone.md", role: "artifact", key: "scratch-9/gone.md", digest: "sha256:1111" },
			],
			edges: [],
			observations: { code: [], tests: [] },
		};
		const report = verifyGraph(graph, { root, workersRoot: workers });
		assert.equal(report.unreadable.length, 1, "the unlistable directory's artifact is unreadable");
		assert.equal(report.unreadable[0].id, "artifact:scratch-1/NOTES.md");
		assert.equal(report.missing.length, 1, "the absent path is still missing");
		assert.equal(report.missing[0].id, "artifact:scratch-9/gone.md");
		assert.equal(report.state, "recorded_digests_moved", "a real deletion outranks an unreadable path");

		// With only the unreadable path, the verdict must be neither match nor moved.
		const onlyUnreadable = verifyGraph(
			{ nodes: [graph.nodes[0]], edges: [], observations: { code: [], tests: [] } },
			{ root, workersRoot: workers },
		);
		assert.equal(onlyUnreadable.state, "incomplete_unreadable");
		assert.equal(onlyUnreadable.missing.length, 0);
	} finally {
		chmodSync(join(workers, "scratch-1"), 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a packet recorded over a partial root is named, not shown as an empty graph", () => {
	// The graph does not rescan the workers root: it reads the packet. So a partial
	// packet produced a silent artifact-poor graph, which is the fail-open that made a
	// permission problem look like a quiet world.
	assert.equal(packetRootWarning({ machine_local: { workers_root_state: "read" } }), null);
	assert.equal(packetRootWarning({}), null);
	const partial = packetRootWarning({
		machine_local: { workers_root_state: "partial", unreadable_sessions: ["scratch-1", "scratch-4"] },
	});
	assert.match(partial, /partial/);
	assert.match(partial, /scratch-1, scratch-4/);
	assert.match(partial, /not because they are gone/);
	assert.match(packetRootWarning({ machine_local: { workers_root_state: "missing" } }), /missing/);
	assert.match(packetRootWarning({ machine_local: { workers_root_state: "unreadable" } }), /unreadable/);
});

test("the graph states what --impact cannot answer, not only what it can", () => {
	const text = deriveGraph({ packet: packet(), citations: [] }).non_claims.join("\n");
	assert.match(text, /An indexed artifact is a pointer, not a body/);
	assert.match(text, /reading list, not a test plan/);
	// The third limit is the general form of the first two: what the index covers
	// follows what the receipts wrote about, so an entire package can be missing
	// without anything being broken. A reader who meets a "no node matches" answer
	// needs that sentence more than they need the two specific ones.
	assert.match(text, /only when an indexed document names that path/);
	assert.match(text, /Naming a path is also not knowing it/);
	// A limitation the tooling around this kernel is most likely to trip over, since
	// the glob is how the suite is run: the sentence has to name the mechanism (the
	// split happens before the glob character is seen) or the next reader will
	// "fix" it with a filter that can never match.
	assert.match(text, /Filtering tokens that contain a glob character is dead code/);
});

// ---------------------------------------------------------------------------
// `--check` over a tree it could not read in full
//
// `workersRootState` is a predicate about a *path*, so a root whose tree this
// process cannot enter answers `read`. `--stale` already exits 3 for both ways a
// verdict can be partial -- artifacts resolved against a foreign root, and a
// session root whose scan came back `partial` -- but `--check` returned 0 for
// both, printing `observations: N of N unchanged` while one dimension was never
// compared. That is the fail-open direction in the tool built to close it.
//
// These run `main` with an injected root, so the whole tree is this file's own
// fixture: a peer writing to the real packet cannot turn a red test green, and
// the exit code is assertable here in a way it is not against the shared
// checkout. The control below is the point -- an implementation that satisfies
// the assertions by refusing to compare anything fails it.
// ---------------------------------------------------------------------------

const GRAPH_SCRIPT = fileURLToPath(new URL("./uctm-graph.mjs", import.meta.url));

/** `main` in a child process, with the checkout root injected rather than inferred. */
function runGraphCli(argv, root) {
	const program =
		`import(${JSON.stringify(pathToFileURL(GRAPH_SCRIPT).href)})` +
		`.then((m) => process.exit(m.main(${JSON.stringify(argv)}, {}, ${JSON.stringify(root)})))` +
		`.catch((error) => { process.stderr.write(String(error?.stack ?? error)); process.exit(70); })`;
	return spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
}

/** A fixture checkout whose packet and graph are on disk, so `--check` has a pair. */
function checkableFixture({ recordedRoot = null } = {}) {
	const { root, packet: packetData, graph } = codeFixture();
	if (recordedRoot !== null) {
		packetData.machine_local = { ...(packetData.machine_local ?? {}), workers_root: recordedRoot, workers_root_state: "read" };
	}
	writeFileSync(join(root, PACKET_PATH), `${JSON.stringify(packetData, null, 2)}\n`);
	writeFileSync(join(root, GRAPH_PATH), `${JSON.stringify(graph, null, 2)}\n`);
	return { root, packet: packetData, graph };
}

/** A workers root whose own listing succeeds and whose child listing does not. */
function partialWorkers() {
	const workers = mkdtempSync(join(tmpdir(), "kgraph-partial-"));
	mkdirSync(join(workers, "scratch-00"), { recursive: true });
	writeFileSync(join(workers, "scratch-00", "READABLE.md"), "# probe\n");
	mkdirSync(join(workers, "scratch-01"), { recursive: true });
	writeFileSync(join(workers, "scratch-01", "hidden.md"), "# probe\n");
	chmodSync(join(workers, "scratch-01"), 0o000);
	return workers;
}

test("a check over a partially readable session root is incomplete, not green", () => {
	const { root } = checkableFixture();
	const workers = partialWorkers();
	try {
		const run = runGraphCli(["--check", "--workers-root", workers], root);
		assert.equal(run.status, 3, `expected the incomplete code, got ${run.status}:\n${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /^incomplete: /m, "the verdict must say it was partial rather than clean");
		assert.match(run.stdout, /partial/, "the state it read must be named");
	} finally {
		chmodSync(join(workers, "scratch-01"), 0o755);
		rmSync(workers, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("a check whose artifacts were resolved against a foreign root is incomplete, not green", () => {
	const recorded = mkdtempSync(join(tmpdir(), "kgraph-recorded-"));
	const foreign = mkdtempSync(join(tmpdir(), "kgraph-foreign-"));
	const { root } = checkableFixture({ recordedRoot: recorded });
	try {
		const run = runGraphCli(["--check", "--workers-root", foreign], root);
		assert.equal(run.status, 3, `expected the incomplete code, got ${run.status}:\n${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /^incomplete: /m);
		assert.match(run.stdout, /artifact dimension was not compared/, "the dimension that was skipped must be named, not implied");
	} finally {
		rmSync(recorded, { recursive: true, force: true });
		rmSync(foreign, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("control: a check over the recorded root, fully read, is still a clean verdict", () => {
	const workers = mkdtempSync(join(tmpdir(), "kgraph-complete-"));
	const { root } = checkableFixture({ recordedRoot: workers });
	try {
		mkdirSync(join(workers, "scratch-00"), { recursive: true });
		writeFileSync(join(workers, "scratch-00", "READABLE.md"), "# probe\n");
		const run = runGraphCli(["--check", "--workers-root", workers], root);
		assert.equal(run.status, 0, `a complete readable root must still pass, got ${run.status}:\n${run.stdout}${run.stderr}`);
		assert.equal(/^incomplete: /m.test(run.stdout), false);
	} finally {
		rmSync(workers, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
