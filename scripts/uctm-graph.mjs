#!/usr/bin/env node
// UCTM evidence graph kernel (v0): occurrence identity over the orientation
// packet, so "what moved, and who has to re-read because of it?" is a graph
// query instead of another pass over the receipts.
//
//   node scripts/uctm-graph.mjs --write            # regenerate docs/uctm/GRAPH.v0.json
//   node scripts/uctm-graph.mjs --check            # exit 0 kernel current, exit 1 moved
//   node scripts/uctm-graph.mjs --check --strict   # ...and exit 4 if named code moved
//   node scripts/uctm-graph.mjs --stale            # re-hash every file the graph names
//   node scripts/uctm-graph.mjs --impact <path>    # who cites this node, transitively
//
// The kernel is a *pure function of the packet*: deriveGraph() reads nothing and
// takes no clock, so the same packet always yields the same graph byte for byte.
// Three functions touch the filesystem, and none of them discovers a path the
// evidence did not already name: collectCitations() reads indexed documents to
// find cross-references, collectCode() reads the same documents to resolve the
// repository paths and test names they name, and verifyGraph() re-hashes
// recorded digests. Verification never widens the scan; it can only confirm or
// contradict what was recorded.
//
// Identity is not observation. A node's *existence* is structure -- it moves the
// graph address, because the set of things the evidence names has changed. A
// node's *content* is an observation: it is recorded in `observations`, outside
// the address, because this checkout is edited continuously and an identity that
// moved on every keystroke could never report "nothing moved". That split is why
// `--check` alone does not prove the code is unchanged, and why `--stale` exists.
//
// The point of a *kernel* rather than another index is occurrence identity. The
// spine's own open item says the fabric "still lacks native occurrence-to-graph
// IDs" (UCTM/ACTIVE_IMPLEMENTATION.md). Here every node carries two handles:
//
//   id          role:key      -- identity. Stable while the thing exists.
//   occurrence  occ:<hex32>   -- identity plus recorded content address.
//
// A file whose bytes change keeps its id and gets a new occurrence. That single
// property is what lets a session re-orient by comparison: "did any occurrence I
// depended on move?" is a set difference, not a re-read.

import { chmodSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DERIVED_INDEX_PATHS, PACKET_PATH, canonicalize, digestOf, extractSection, readSessions, resolveWorkersRoot, sha256OfBytes, workersRootState, writeFileAtomic } from "./uctm-orient.mjs";

export const SCHEMA = "uctm.kgraph.v0";
export const GRAPH_PATH = "docs/uctm/GRAPH.v0.json";
export const SELF = "GRAPH.v0.json";

/** The v0 node roles. Closed on purpose: a new role needs a builder and a test. */
export const NODE_ROLES = ["worktree", "document", "session", "artifact", "code", "test", "action"];

/** The v0 edge vocabulary. Every kind answers a different "why is this linked?". */
export const EDGE_KINDS = ["produced", "cites", "declares"];

// The kernel mirrors collectNextActions()'s single declared source. If that
// function ever reads a different document, this constant moves with it; the
// test suite pins the two together so the split cannot go unnoticed.
export const NEXT_ACTIONS_SOURCE = "docs/uctm/CONNECTION_PLAN_2026-09-18.md";

// Derived indexes are not inputs to derived indexes (see uctm-orient.mjs). The
// pair is kept convergent from both sides: the packet excludes this graph from
// its document scan and dirty digest, and this graph excludes both indexes from
// its node set. graph_id therefore covers the packet's orientation_id -- a
// world-derived value -- and never the packet's bytes.
export const EXCLUDED_DOCUMENTS = new Set(DERIVED_INDEX_PATHS);

const OCC_DOMAIN = "uctm.kgraph.occurrence.v0";
const MAX_LABEL = 160;
const MAX_EVIDENCE = 120;
const MAX_CITED_BYTES = 400_000;

// --- the code dimension ---------------------------------------------------
//
// v0 extracted cross-references between the documents the packet already named.
// That left the most load-bearing evidence link unedged: a receipt that says
// "TestBuild_MatchesEmbedded passes" or names `backend/.../build.go` produced no
// node, so "which claims have to be re-read because this file changed?" could not
// be asked. These bounds keep the widened scan finite and declared.
export const OBSERVATION_DOMAIN = "uctm.kgraph.observations.v0";
/** Extensions a token may carry to be a repository path rather than prose. */
export const CODE_EXTENSIONS = ["go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "sql", "sh", "swift", "kt", "java", "rb", "json", "yaml", "yml", "toml", "css"];
/** A test node is a name plus the file that declares it; Go only, deliberately. */
export const TEST_NAME_PATTERN = /\bTest[A-Z][A-Za-z0-9_]*\b/g;
export const MAX_CODE_NODES = 400;
export const MAX_TEST_NODES = 200;
/** Candidate files opened while resolving a test name to its declaration. */
export const MAX_TEST_FILES = 300;

export const HOW_TO_USE =
	"Re-orient by comparison, not by re-reading. `--check` exits 0 while every " +
	"recorded occurrence still matches the world; `--impact <path>` names the " +
	"readers that have to be revisited when an occurrence moves; `--stale` " +
	"re-hashes the files this graph names and prints the ones that no longer " +
	"match what was recorded. An edge here means one document names another path, " +
	"or that a file declares a test by name. It does not mean the claim is true, " +
	"and impact means \"may need re-reading\", not \"is wrong\". Code and test " +
	"nodes carry their content addresses in `observations`, outside the graph " +
	"address, so `--check` alone is a structural verdict: use `--check --strict` " +
	"or `--stale` when the code's own content has to be part of the answer.";

export const NON_CLAIMS = [
	"This graph carries identities, pointers, digests and short declared labels. It is not the evidence, and traversing it is not reading a receipt.",
	"An occurrence moving proves bytes moved. It does not prove the claim behind them is false, and it does not prove anyone acted on the change.",
	"A `cites` edge is a textual cross-reference found in an indexed document. It is not an author's acknowledgement, an approval, or a dependency the author declared.",
	"Labels on action nodes are excerpts of the plan's own declared list, for navigation only. The plan is the text; this graph is not.",
	"Dirty-file-level impact is deliberately absent: the worktree is one node with the dirty set's digest, so the kernel does not churn on every unsaved edit.",
	"The kernel is blind to changes in the derived indexes by construction: ORIENTATION.v0.json and GRAPH.v0.json are excluded from the node set and from the worktree digest, so re-writing an index is never reported as the world moving.",
	"Absence of an edge is not evidence of independence. v0 extracts cross-references between indexed documents, indexed artifacts, resolved repository paths and Go test names, and nothing else.",
	"A `code` node is a path an indexed document named that resolved to a regular file in this checkout. A name that did not resolve is recorded as unresolved rather than dropped, but the scan is bounded to the directories those documents name, so an unresolved name proves nothing about whether the thing exists elsewhere or under another spelling.",
	"A `code` node exists only when an indexed document names that path. A file, a directory or a whole package that no receipt happens to mention is absent from the graph and invisible to `--impact`; the AO phone app's view-model modules and the iOS port that shares their rules were both in that state until one document named them. Naming a path is also not knowing it -- a node created by a passing mention carries no more authority than the mention -- so coverage follows what the receipts chose to write about, not what exists in the repository.",
	"A `test` node means one scanned file contains `func <Name>(` at the start of a line. It is not a build result, not a passing run, and not proof the test has ever executed; a test that passes today and a test that was deleted both look like text here until one of them stops being text.",
	"Code and test nodes carry no content address in the graph identity, and their `line`, `bytes` and digest fields live in `observations` outside it. A live checkout is edited continuously, so folding content into the identity would make \"nothing moved\" unreportable. The consequence is stated rather than hidden: `--check` returns a structural verdict, and `--stale` (or `--check --strict`) is the gate for content.",
	"An indexed artifact is a pointer, not a body. A session receipt's own cross-references are not extracted -- foreign bodies are never parsed -- so `--impact <path>` will not name the receipt that quotes that path; only the session that produced it appears in the closure. That is the invariant working, and it means the impact closure omits the class of artifact most likely to go stale. The receipt is evidence about what its author wrote, never about the content of what they quoted.",
	"`--impact` answers \"which indexed documents cite this\", not \"what breaks if this moves\". A test file that no indexed document names is absent from the closure even when it pins the file in question, because the alternative -- inferring an edge from a `<name>.test.mjs` convention -- is a guess, and this kernel records non-resolutions instead of guessing. The closure is a reading list, not a test plan: running the suite is how that question is answered.",
	"A glob or a placeholder is not a path, and the scan says so by recording a fragment: `node --test scripts/*.test.mjs` matches the tail `.test.mjs`, because `*`, `<` and `>` are not path characters, and that tail is recorded as an unresolved name. It is kept rather than filtered for a reason. Filtering tokens that contain a glob character is dead code -- zero of the recorded unresolved names contain `*` or `?`, because the split happens before the character is seen -- and excluding the character in the lookbehind would also drop an emphasised citation such as `*scripts/uctm-orient.mjs*`. One recorded name on the live graph is of this shape, and the count is the honest price of not silently dropping a real citation.",
];

/** Stable identity for a node: role plus key. Never a content digest. */
export function nodeId(role, key) {
	if (!NODE_ROLES.includes(role)) throw new Error(`unknown node role: ${role}`);
	return `${role}:${key}`;
}

/** The occurrence handle: identity bound to the recorded content address. */
export function occurrenceOf(id, digest) {
	return `occ:${sha256OfBytes(Buffer.from(`${OCC_DOMAIN}\0${id}\0${digest ?? ""}`, "utf8")).slice(0, 32)}`;
}

function clamp(text, limit) {
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}\u2026`;
}

function node(role, key, { digest = null, facts = {} } = {}) {
	const id = nodeId(role, key);
	return {
		id,
		role,
		key,
		identity_basis: role === "action" ? "declared_text" : "path",
		content_addressed: digest !== null,
		occurrence: occurrenceOf(id, digest),
		...(digest === null ? {} : { digest }),
		...facts,
	};
}

/**
 * Derive the graph from a packet. Pure: no filesystem, no clock, no randomness.
 * `citations` and `code` are the only inputs beyond the packet, and both are
 * already-resolved facts: {from, to, evidence} triples from collectCitations(),
 * and the resolved paths/tests from collectCode(). Nothing here reads a disk.
 */
export function deriveGraph({ packet, citations = [], code = null }) {
	if (!packet || typeof packet !== "object") throw new Error("deriveGraph: packet required");
	const codeEntries = [...(code?.code ?? [])].sort((a, b) => a.path.localeCompare(b.path));
	const testEntries = [...(code?.tests ?? [])].sort((a, b) => a.key.localeCompare(b.key));
	const nodes = [];
	const byId = new Map();
	const add = (entry) => {
		if (byId.has(entry.id)) throw new Error(`duplicate node id: ${entry.id}`);
		byId.set(entry.id, entry);
		nodes.push(entry);
		return entry;
	};

	const worktree = packet.worktree ?? {};
	// Derived indexes are not evidence. The kernel's worktree node covers the
	// source dirty set only: ORIENTATION.v0.json and GRAPH.v0.json are removed
	// before the digest, because otherwise writing this graph would move the node
	// that told you the graph had moved -- the self-reference bug the orientation
	// index hit, one layer down. Re-writing an index is not the world moving.
	const sourceDirty = (worktree.dirty ?? []).filter((entry) => !entry.self && !EXCLUDED_DOCUMENTS.has(entry.path));
	add(
		node("worktree", String(worktree.branch ?? "unknown"), {
			digest: digestOf(
				sourceDirty.map((entry) => ({
					status: entry.status ?? null,
					path: entry.path,
					sha256: entry.sha256 ?? null,
				})),
			),
			facts: {
				head: worktree.head ?? null,
				dirty_count: sourceDirty.length,
				digest_scope: "source_dirty_set_excluding_derived_indexes",
			},
		}),
	);

	for (const document of packet.documents ?? []) {
		if (EXCLUDED_DOCUMENTS.has(document.path)) continue;
		add(
			node("document", document.path, {
				digest: document.sha256 ?? null,
				facts: {
					declared_role: document.role ?? null,
					bytes: document.bytes ?? null,
					declared_status: typeof document.status === "string" ? clamp(document.status, MAX_LABEL) : null,
				},
			}),
		);
	}

	for (const session of packet.sessions ?? []) {
		add(
			node("session", session.session, {
				facts: {
					artifact_count: (session.artifacts ?? []).length,
					pointed_bytes: session.pointed_bytes ?? 0,
				},
			}),
		);
		for (const artifact of session.artifacts ?? []) {
			add(
				node("artifact", `${session.session}/${artifact.path}`, {
					digest: artifact.sha256 ?? null,
					facts: {
						session: session.session,
						artifact_path: artifact.path,
						bytes: artifact.bytes ?? null,
						declared_status: typeof artifact.status === "string" ? clamp(artifact.status, MAX_LABEL) : null,
					},
				}),
			);
		}
	}

	for (const action of packet.next_actions ?? []) {
		const text = String(action);
		const digest = sha256OfBytes(Buffer.from(text, "utf8"));
		add(
			node("action", `${NEXT_ACTIONS_SOURCE}#${digest.slice(0, 8)}`, {
				digest,
				facts: {
					owner: NEXT_ACTIONS_SOURCE,
					label: clamp(text, MAX_LABEL),
					text_sha256: digest,
				},
			}),
		);
	}

	// Code and test nodes are *identity only*: no digest reaches the node, because
	// the digest of a file in a live checkout changes while you read it, and an
	// identity that moved on every keystroke could never report "nothing moved".
	// Their content addresses live in `observations`, below, outside graph_id.
	const namedBy = (entry) => [...new Set((entry.named_by ?? []).map((naming) => naming.document))].sort();
	for (const entry of codeEntries) {
		add(
			node("code", entry.path, {
				facts: {
					named_by: namedBy(entry),
					named_by_count: (entry.named_by ?? []).length,
				},
			}),
		);
	}
	for (const entry of testEntries) {
		add(
			node("test", entry.key, {
				facts: {
					name: entry.name,
					declared_in: entry.declared_in ?? null,
					named_by: namedBy(entry),
					named_by_count: (entry.named_by ?? []).length,
				},
			}),
		);
	}

	const edges = [];
	const seenEdges = new Set();
	const link = (from, to, kind, evidence) => {
		if (!EDGE_KINDS.includes(kind)) throw new Error(`unknown edge kind: ${kind}`);
		if (!byId.has(from)) throw new Error(`dangling edge source: ${from}`);
		if (!byId.has(to)) throw new Error(`dangling edge target: ${to}`);
		const key = `${from}\0${kind}\0${to}`;
		if (seenEdges.has(key)) return;
		seenEdges.add(key);
		edges.push({ from, to, kind, evidence: clamp(evidence, MAX_EVIDENCE) });
	};

	for (const session of packet.sessions ?? []) {
		for (const artifact of session.artifacts ?? []) {
			link(
				nodeId("session", session.session),
				nodeId("artifact", `${session.session}/${artifact.path}`),
				"produced",
				`packet lists this artifact under session ${session.session}`,
			);
		}
	}
	for (const citation of citations) {
		link(nodeId("document", citation.from), citation.to, "cites", citation.evidence);
	}
	// The evidence-to-code hop, both halves: a document that *names* a path or a
	// test is a reader of it, and a file that declares a test is its owner. The
	// `declares` half exists only when the declaring file is itself a node, so the
	// kernel still cannot see a file no document named -- the test node records
	// where it was declared either way, as a fact and an observation.
	for (const entry of codeEntries) {
		// A file that entered the graph because a document named a test it declares
		// is reached through that test node, not directly: the document wrote a test
		// name, and an edge saying it "names" the file would overstate the text.
		if (entry.resolution === "test_declaration") continue;
		for (const naming of entry.named_by ?? []) {
			link(nodeId("document", naming.document), nodeId("code", entry.path), "cites", `names ${naming.token}`);
		}
	}
	for (const entry of testEntries) {
		for (const naming of entry.named_by ?? []) {
			link(nodeId("document", naming.document), nodeId("test", entry.key), "cites", `names ${naming.token}`);
		}
		const owner = entry.declared_in ? nodeId("code", entry.declared_in) : null;
		if (owner !== null && byId.has(owner)) {
			link(owner, nodeId("test", entry.key), "declares", `declares func ${entry.name}(`);
		}
	}
	for (const action of packet.next_actions ?? []) {
		const digest = sha256OfBytes(Buffer.from(String(action), "utf8"));
		const owner = nodeId("document", NEXT_ACTIONS_SOURCE);
		if (!byId.has(owner)) continue;
		link(owner, nodeId("action", `${NEXT_ACTIONS_SOURCE}#${digest.slice(0, 8)}`), "declares", "declared in the plan's next-actions section");
	}

	nodes.sort((a, b) => a.id.localeCompare(b.id));
	edges.sort((a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to));

	const byRole = {};
	for (const role of NODE_ROLES) byRole[role] = nodes.filter((n) => n.role === role).length;
	const byKind = {};
	for (const kind of EDGE_KINDS) byKind[kind] = edges.filter((e) => e.kind === kind).length;

	const totals = {
		nodes: nodes.length,
		edges: edges.length,
		content_addressed_nodes: nodes.filter((n) => n.content_addressed).length,
		by_role: byRole,
		by_kind: byKind,
		observed_nodes: (code?.code ?? []).length + (code?.tests ?? []).length,
	};
	// Observations are outside the identity on purpose (see the header). They are
	// still part of the artifact, because `--stale` needs a recorded baseline to
	// compare against -- a wrong baseline is worse than none, and no baseline is
	// no check at all.
	const observations = {
		id_domain: OBSERVATION_DOMAIN,
		code: codeEntries.map((entry) => ({ id: nodeId("code", entry.path), path: entry.path, bytes: entry.bytes ?? null, sha256: entry.sha256 ?? null })),
		tests: testEntries.map((entry) => ({ id: nodeId("test", entry.key), name: entry.name, declared_in: entry.declared_in ?? null, line: entry.line ?? null, span_sha256: entry.span_sha256 ?? null })),
		scan: code?.scan ?? null,
	};
	const body = {
		schema: SCHEMA,
		how_to_use: HOW_TO_USE,
		source: {
			packet_path: PACKET_PATH,
			orientation_id: packet.orientation_id ?? null,
			next_actions_source: NEXT_ACTIONS_SOURCE,
			excluded_documents: [...EXCLUDED_DOCUMENTS].sort(),
			observation_domain: OBSERVATION_DOMAIN,
			code_scan_bounds: {
				max_code_nodes: MAX_CODE_NODES,
				max_test_nodes: MAX_TEST_NODES,
				max_test_files: MAX_TEST_FILES,
				extensions: CODE_EXTENSIONS,
			},
		},
		nodes,
		edges,
		unresolved: (code?.unresolved ?? []).slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.token.localeCompare(b.token)),
		totals,
		non_claims: NON_CLAIMS,
	};
	return { graph_id: digestOf(body), ...body, observations: { observed_id: digestOf(observations), ...observations } };
}

/**
 * Resolve cross-references from indexed documents to indexed documents and
 * session artifacts. Filesystem access is bounded twice over: only documents the
 * packet named are opened, and only documents/artifacts the packet named can be
 * a target. A bare filename resolves only when it is unambiguous.
 */
export function collectCitations(root, packet) {
	const documents = (packet.documents ?? []).filter((d) => !EXCLUDED_DOCUMENTS.has(d.path));
	const targets = new Map();
	const addTarget = (token, id) => {
		if (!targets.has(token)) targets.set(token, new Set());
		targets.get(token).add(id);
	};
	for (const document of documents) {
		addTarget(document.path, nodeId("document", document.path));
		const basename = document.path.slice(document.path.lastIndexOf("/") + 1);
		addTarget(basename, nodeId("document", document.path));
	}
	for (const session of packet.sessions ?? []) {
		for (const artifact of session.artifacts ?? []) {
			const key = `${session.session}/${artifact.path}`;
			addTarget(key, nodeId("artifact", key));
		}
	}

	const citations = [];
	for (const document of documents) {
		let text;
		try {
			const abs = join(root, document.path);
			if (!statSync(abs).isFile() || statSync(abs).size > MAX_CITED_BYTES) continue;
			text = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		const self = nodeId("document", document.path);
		for (const [token, ids] of targets) {
			if (ids.size !== 1) continue;
			const target = [...ids][0];
			if (target === self) continue;
			if (!text.includes(token)) continue;
			citations.push({ from: document.path, to: target, evidence: `names ${token}` });
		}
	}
	citations.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
	return citations;
}

/** Top-level names of a `func <Name>(` declaration line, column 0 only. */
function declaredTests(text) {
	const found = new Map();
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^func (Test[A-Z][A-Za-z0-9_]*)\s*\(/.exec(lines[i].replace(/\r$/, ""));
		if (match && !found.has(match[1])) found.set(match[1], i + 1);
	}
	return found;
}

/**
 * The byte span of one test's source: from its `func <Name>(` line to the next
 * line that is exactly `}`. This is a delimiter scan, not a Go parse -- gofmt
 * puts a top-level function's closing brace in column 0, which is the whole
 * assumption. A file that is not gofmt'd can only make the span wrong, and the
 * span is an observation, so a wrong span shows up as a moved digest rather than
 * as a false "nothing moved".
 */
export function testSpan(text, name) {
	const lines = String(text).split("\n");
	const start = lines.findIndex((line) => line.replace(/\r$/, "").startsWith(`func ${name}(`));
	if (start === -1) return null;
	for (let end = start; end < lines.length; end++) {
		if (lines[end].replace(/\r$/, "") === "}") {
			return { line: start + 1, span: lines.slice(start, end + 1).join("\n") };
		}
	}
	return { line: start + 1, span: lines.slice(start).join("\n") };
}

/**
 * The repository's own file index: tracked files plus untracked-but-not-ignored
 * ones, as git sees them. It is used for one thing -- turning a relative name the
 * evidence wrote into the file the author was looking at -- and an unavailable
 * git is reported as unavailable rather than as an empty repository.
 */
export function gitFileIndex(root) {
	try {
		const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
		if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
		return result.stdout.split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

/**
 * Resolve the repository paths and Go test names the indexed documents literally
 * name, so that "a file changed -- which claims have to be re-read?" is a graph
 * query. Bounded five ways, all declared: only indexed documents are read, only
 * tokens that look like a path in this checkout are considered, a token resolves
 * only if it is exact or a unique suffix of the repository index, only files at
 * most MAX_CITED_BYTES are hashed, and test names are resolved only against
 * `_test.go` files the resolved paths point at, capped at MAX_TEST_FILES. It never
 * walks the tree; the index is one `git ls-files`.
 */
export function collectCode(root, packet, { repoIndex = gitFileIndex(root) } = {}) {
	const documents = (packet.documents ?? []).filter((d) => !EXCLUDED_DOCUMENTS.has(d.path));
	const alreadyNodes = new Set(documents.map((d) => d.path));
	for (const session of packet.sessions ?? []) {
		for (const artifact of session.artifacts ?? []) alreadyNodes.add(`${session.session}/${artifact.path}`);
	}

	let rootState = "read";
	try {
		readdirSync(root);
	} catch {
		rootState = "unreadable";
	}

	// The lookbehind is what keeps a path inside another repository out: with a
	// preceding word character the token is part of a longer name, not a citation,
	// and for the same reason a bare name cannot be matched out of the tail of a
	// longer path. The directory part is optional on purpose: a receipt here writes
	// `build.go`, `package.json` or `uctm-graph.mjs` far more often than a full path,
	// and a bare name is resolved by the same two bounded steps as any other -- never
	// by a walk, and never by a guess. A bare name that two files could mean is
	// recorded as ambiguous instead of being resolved to the likelier one.
	//
	// `$` is in both classes because it is a legal filename character and this
	// repository's router uses it literally: `_shell.projects.$projectId_.uctm.tsx`.
	// Without it the pattern could not start the token before the `$`, matched the
	// tail `projectId_.uctm.tsx`, and reported that tail as a path this checkout does
	// not hold while the file it was cut from sat on disk.
	const pathPattern = new RegExp(`(?<![\\w.@/-])(?:[\\w.@$-]+/)*[\\w.@$.-]+\\.(?:${CODE_EXTENSIONS.join("|")})\\b`, "g");
	const testPattern = new RegExp(TEST_NAME_PATTERN.source, "g");
	const code = new Map();
	const tests = new Map();
	const names = new Map();
	const unresolved = new Map();
	const documentPaths = new Set(documents.map((d) => d.path));
	let documentsRead = 0;
	let filesHashed = 0;
	let testFilesRead = 0;
	let testDirsScanned = 0;
	let truncated = false;

	const recordName = (map, key, document, token) => {
		if (!map.has(key)) map.set(key, new Map());
		const byDocument = map.get(key);
		if (!byDocument.has(document)) byDocument.set(document, new Set());
		byDocument.get(document).add(token);
	};
	const namedBy = (map) =>
		[...map.entries()]
			.flatMap(([document, tokens]) => [...tokens].map((token) => ({ document, token })))
			.sort((a, b) => a.document.localeCompare(b.document) || a.token.localeCompare(b.token));
	const recordUnresolved = (kind, token, reason, map) => {
		const key = `${kind}\0${token}`;
		// The map is held, not copied: a later document may name the same token, and
		// an unresolved entry must list every document that named it, not the ones
		// that happened to arrive first.
		if (!unresolved.has(key)) unresolved.set(key, { kind, token, reasons: new Set(), table: map });
		unresolved.get(key).reasons.add(reason);
	};

	// One read per document. Resolution is a decision about the token text, and it
	// happens after every document has been read, so the answer does not depend on
	// which document happened to be scanned first.
	const pages = [];
	for (const document of documents) {
		let text;
		try {
			const abs = join(root, document.path);
			if (!statSync(abs).isFile() || statSync(abs).size > MAX_CITED_BYTES) continue;
			text = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		documentsRead += 1;
		pages.push({
			path: document.path,
			paths: [...new Set(text.match(pathPattern) ?? [])].sort(),
			tests: [...new Set(text.match(testPattern) ?? [])].sort(),
		});
	}

	/** A token worth trying to resolve: not a document, not prose with a slash in it. */
	const citable = (token) =>
		!documentPaths.has(token) && !alreadyNodes.has(token) && !EXCLUDED_DOCUMENTS.has(token) && !token.includes("..");

	const hashFile = (relative) => {
		try {
			const bytes = readFileSync(join(root, relative));
			if (bytes.length > MAX_CITED_BYTES) return { reason: "over_size_bound" };
			return { bytes: bytes.length, sha256: sha256OfBytes(bytes) };
		} catch {
			return { reason: "does_not_resolve_to_a_regular_file" };
		}
	};

	const placePath = (path, hashed, resolution, document, token) => {
		// The token is checked before it is resolved, and the *resolved* path has to be
		// checked too. A bare `GRAPH.v0.json` is not the string the packet excludes, but
		// it resolves to a derived index all the same -- and an index that is an input to
		// itself can never report "nothing moved". The same rule stops a document or a
		// session artifact from being given a second node under a code role.
		if (alreadyNodes.has(path) || EXCLUDED_DOCUMENTS.has(path)) return;
		recordName(names, path, document, token);
		if (code.has(path)) return;
		if (code.size >= MAX_CODE_NODES) {
			truncated = true;
			recordUnresolved("path", token, "code_node_cap_reached", names.get(path));
			return;
		}
		code.set(path, { path, bytes: hashed.bytes, sha256: hashed.sha256, resolution });
		filesHashed += 1;
	};

	// A document rarely writes a full path: "specgen/build.go" in a receipt about
	// the apispec package, "components/CommandPalette.tsx" in one about the
	// renderer. Two ways to resolve those, in order of confidence:
	//
	//   1. exactly, from the checkout root (unambiguous by construction);
	//   2. as a unique suffix of the repository's own file index, which is what
	//      makes a relative name mean the file the author was looking at.
	//
	// A name that matches two files resolves to neither: a guess here would be an
	// edge the evidence does not support. With no index available, step 2 is
	// skipped and relative names are recorded as unresolved rather than dropped.
	const index = Array.isArray(repoIndex) ? repoIndex.map((path) => String(path).replace(/^\.\//, "")).filter(Boolean) : null;
	for (const page of pages) {
		for (const token of page.paths) {
			const relative = token.replace(/^\.\//, "");
			if (!citable(relative)) continue;
			const hashed = hashFile(relative);
			if (hashed.sha256 !== undefined) {
				placePath(relative, hashed, "from_the_checkout_root", page.path, relative);
				continue;
			}
			if (index === null) {
				recordName(names, relative, page.path, relative);
				recordUnresolved("path", relative, "no_repository_index_to_resolve_a_relative_name", names.get(relative));
				continue;
			}
			const hits = index.filter((path) => path.endsWith(`/${relative}`));
			if (hits.length === 0) {
				recordName(names, relative, page.path, relative);
				recordUnresolved("path", relative, "not_a_path_in_this_checkout", names.get(relative));
				continue;
			}
			if (hits.length > 1) {
				recordName(names, relative, page.path, relative);
				recordUnresolved("path", relative, "ambiguous_relative_name", names.get(relative));
				continue;
			}
			const hashedHit = hashFile(hits[0]);
			if (hashedHit.sha256 === undefined) {
				recordName(names, hits[0], page.path, relative);
				recordUnresolved("path", relative, "in_the_index_but_not_on_disk", names.get(hits[0]));
				continue;
			}
			placePath(hits[0], hashedHit, "unique_suffix_of_the_repository_index", page.path, relative);
		}
	}

	for (const page of pages) {
		for (const name of page.tests) recordName(tests, name, page.path, name);
	}

	// Test names resolve only against `_test.go` siblings of the paths the
	// documents named. A name declared in a directory nothing named stays
	// unresolved, which is the honest answer rather than an unbounded walk.
	const candidates = new Set();
	const scannedDirs = new Set();
	for (const path of code.keys()) {
		if (path.endsWith("_test.go")) candidates.add(path);
		const dir = path.slice(0, path.lastIndexOf("/"));
		if (dir === "" || scannedDirs.has(dir)) continue;
		scannedDirs.add(dir);
		testDirsScanned += 1;
		try {
			for (const entry of readdirSync(join(root, dir))) {
				if (entry.endsWith("_test.go")) candidates.add(`${dir}/${entry}`);
			}
		} catch {
			/* a directory named but unreadable resolves nothing, and says so below */
		}
	}

	const declarations = new Map();
	const candidateText = new Map();
	const testNames = [...tests.keys()].sort();
	for (const path of [...candidates].sort()) {
		// Every candidate is opened, even after a name is found: stopping at the first
		// hit is exactly how a name declared in two files would look unambiguous.
		if (testFilesRead >= MAX_TEST_FILES) {
			truncated = true;
			break;
		}
		let text;
		try {
			const abs = join(root, path);
			if (!statSync(abs).isFile() || statSync(abs).size > MAX_CITED_BYTES) continue;
			text = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		testFilesRead += 1;
		candidateText.set(path, text);
		for (const [name, line] of declaredTests(text)) {
			if (!tests.has(name)) continue;
			if (!declarations.has(name)) declarations.set(name, []);
			declarations.get(name).push({ path, line });
		}
	}

	const resolved = [];
	for (const name of testNames) {
		const hits = declarations.get(name) ?? [];
		const table = tests.get(name);
		if (hits.length === 0) {
			recordUnresolved("test", name, truncated ? "not_found_before_scan_cap" : "not_declared_in_a_scanned_file", table);
			continue;
		}
		// A bare name is only an identity when it is unambiguous, the same rule
		// citations use for a bare filename: two files declaring `TestX` are two
		// different things, and picking one would be a guess.
		if (hits.length > 1) {
			recordUnresolved("test", name, "declared_in_more_than_one_scanned_file", table);
			continue;
		}
		if (resolved.length >= MAX_TEST_NODES) {
			truncated = true;
			recordUnresolved("test", name, "test_node_cap_reached", table);
			continue;
		}
		const [hit] = hits;
		const span = candidateText.has(hit.path) ? testSpan(candidateText.get(hit.path), name) : null;
		// The file that declares a test is part of the evidence's reach even when no
		// document wrote its path: a document named the test, and this is where the
		// name resolves. It becomes a node so the `declares` edge below always has
		// two ends -- an edge kind that can never fire is indistinguishable from one
		// that always does, which is a defect this repo has already recorded once.
		if (!code.has(hit.path)) {
			const hashed = hashFile(hit.path);
			if (hashed.sha256 === undefined) continue;
			for (const naming of namedBy(table)) recordName(names, hit.path, naming.document, naming.token);
			if (code.size >= MAX_CODE_NODES) {
				truncated = true;
			} else {
				code.set(hit.path, { path: hit.path, bytes: hashed.bytes, sha256: hashed.sha256, resolution: "test_declaration" });
				filesHashed += 1;
			}
		}
		resolved.push({
			key: `${hit.path}#${name}`,
			name,
			declared_in: hit.path,
			line: span?.line ?? hit.line,
			span_sha256: span ? sha256OfBytes(Buffer.from(span.span, "utf8")) : null,
			named_by: namedBy(table),
		});
	}

	const byReason = {};
	for (const entry of unresolved.values()) {
		for (const reason of entry.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
	}
	return {
		code: [...code.values()].map((entry) => ({ ...entry, named_by: namedBy(names.get(entry.path) ?? new Map()) })),
		tests: resolved,
		unresolved: [...unresolved.values()].map((entry) => ({
			kind: entry.kind,
			token: entry.token,
			reason: [...entry.reasons].sort().join(","),
			named_by: namedBy(entry.table),
		})),
		scan: {
			root_state: rootState,
			repo_index_state: index === null ? "unavailable" : "read",
			repo_index_entries: index === null ? 0 : index.length,
			documents_read: documentsRead,
			code_files_hashed: filesHashed,
			test_files_read: testFilesRead,
			test_dirs_scanned: testDirsScanned,
			truncated,
			unresolved_by_reason: Object.fromEntries(Object.keys(byReason).sort().map((reason) => [reason, byReason[reason]])),
		},
	};
}

/** "artifact 2, document 1" -- or "none" when nothing moved. */
export function describeRoles(byRole) {
	const parts = Object.entries(byRole ?? {}).map(([role, count]) => `${role} ${count}`);
	return parts.length === 0 ? "none" : parts.join(", ");
}

/** Role breakdown of the occurrence differences between two graphs. */
export function movedRoles(before, after) {
	const prior = new Map((before.nodes ?? []).map((n) => [n.id, n.occurrence]));
	const current = new Set((after.nodes ?? []).map((n) => n.id));
	const counts = {};
	for (const node of after.nodes ?? []) {
		if (prior.get(node.id) === node.occurrence) continue;
		counts[node.role] = (counts[node.role] ?? 0) + 1;
	}
	for (const node of before.nodes ?? []) {
		if (current.has(node.id)) continue;
		counts[node.role] = (counts[node.role] ?? 0) + 1;
	}
	return Object.fromEntries(Object.keys(counts).sort().map((role) => [role, counts[role]]));
}

/** Read the packet, or fail with the one instruction that fixes it. */
export function readPacketFile(root) {
	try {
		return JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
	} catch (error) {
		throw new Error(`no readable orientation packet at ${PACKET_PATH} (run: node scripts/uctm-orient.mjs --write) -- ${error.message}`);
	}
}

export function readGraphFile(root) {
	try {
		return JSON.parse(readFileSync(join(root, GRAPH_PATH), "utf8"));
	} catch {
		return null;
	}
}

/**
 * Re-hash only the `observations` stanza: the content addresses of the code and
 * test nodes, which deliberately are not part of the graph identity. Split out so
 * `--check` can report code drift without paying to re-hash every artifact too --
 * `--stale` is the verb that does the whole scan.
 */
export function verifyObservations(graph, root) {
	const moved = [];
	const missing = [];
	const unreadable = [];
	let unchanged = 0;
	let checked = 0;
	for (const entry of graph.observations?.code ?? []) {
		checked += 1;
		let observed;
		try {
			observed = sha256OfBytes(readFileSync(join(root, entry.path)));
		} catch (error) {
			// A permission failure is not a deletion. Reporting one as the other is the
			// defect this kernel sits downstream of, and it fails open: "could not look"
			// arriving as "gone" is a claim the scan never made.
			(isUnreadableError(error) ? unreadable : missing).push({
				id: entry.id,
				reason: isUnreadableError(error) ? "path_unreadable" : "path_missing",
				source: "observation",
			});
			continue;
		}
		if (observed === entry.sha256) unchanged += 1;
		else moved.push({ id: entry.id, recorded: entry.sha256, observed, reason: "content_moved", source: "observation" });
	}
	for (const entry of graph.observations?.tests ?? []) {
		checked += 1;
		let text;
		try {
			text = readFileSync(join(root, entry.declared_in), "utf8");
		} catch (error) {
			(isUnreadableError(error) ? unreadable : missing).push({
				id: entry.id,
				reason: isUnreadableError(error) ? "declaring_file_unreadable" : "declaring_file_missing",
				source: "observation",
			});
			continue;
		}
		const span = testSpan(text, entry.name);
		if (span === null) {
			moved.push({ id: entry.id, recorded: entry.span_sha256, observed: null, reason: "declaration_absent", source: "observation" });
			continue;
		}
		const observed = sha256OfBytes(Buffer.from(span.span, "utf8"));
		if (observed === entry.span_sha256) unchanged += 1;
		else {
			// A span that still starts on the same line changed in its body; one that
			// starts on a different line had a declaration inserted before it. Saying
			// which is the difference between "the test changed" and "the file did".
			moved.push({
				id: entry.id,
				recorded: entry.span_sha256,
				observed,
				reason: span.line === entry.line ? "content_moved" : "moved_within_the_declaring_file",
				source: "observation",
			});
		}
	}
	return { checked, unchanged, moved, missing, unreadable };
}

/**
 * "Cannot look" and "not there" are different facts. Everything in this kernel that
 * reads a path has to keep them apart: a bare `catch` that files both under
 * `missing` reports a permission problem as a deletion, and a verdict built on it
 * reports a dimension it never read as clean.
 */
export function isUnreadableError(error) {
	const code = error?.code ?? "";
	return code === "EACCES" || code === "EPERM";
}

/**
 * The packet already records whether its session dimension was read, and a partial
 * one is a fact about the graph too: the artifact nodes for the sessions the scan
 * could not enter are absent because nobody looked, not because they are gone. The
 * kernel used to be silent about that, which let a permission problem read as an
 * empty graph -- the fail-open direction, in the tool built to close it.
 */
export function packetRootWarning(packet) {
	const state = packet?.machine_local?.workers_root_state;
	if (!state || state === "read") return null;
	const sessions = packet?.machine_local?.unreadable_sessions ?? [];
	return (
		`warning: the packet was recorded over a ${state} session root` +
		(sessions.length > 0 ? ` (unreadable: ${sessions.join(", ")})` : "") +
		":\n" +
		"  artifact nodes for those sessions are absent from this graph because the scan could not read\n" +
		"  them, not because they are gone. Re-run node scripts/uctm-orient.mjs --write once the root is\n" +
		"  readable, then node scripts/uctm-graph.mjs --write.\n"
	);
}

/**
 * Re-hash what the graph recorded. This never discovers anything: a node whose
 * path is not named by the packet cannot appear here. Nodes that are not a single
 * file's bytes are reported as skipped with the reason, rather than counted as
 * verified, because "not checked" and "checked and unchanged" are different
 * claims.
 */
export function verifyGraph(graph, { root, workersRoot, recordedRoot = null }) {
	const moved = [];
	const missing = [];
	const unreadable = [];
	const notCompared = [];
	const skipped = [];
	let unchanged = 0;
	// A root this process did read is still not the root the graph was built over.
	// `join(workersRoot, entry.key)` against a different tree resolves to paths that
	// are absent there and present here, and a bare `catch` filed every one of them
	// under `missing` -- so naming a directory that exists but holds different
	// sessions produced "the world lost 102 artifacts" instead of "this is another
	// world". The resolver already answers this question by declining to compare
	// (see `--where`: "session dimension NOT compared ... not a drift report"), and
	// the artifact dimension is the same dimension, so it gets the same answer.
	const artifactsComparable = recordedRoot === null || recordedRoot === workersRoot;
	for (const entry of graph.nodes ?? []) {
		let abs = null;
		let digestFor = (bytes) => sha256OfBytes(bytes);
		switch (entry.role) {
			case "document":
				abs = join(root, entry.key);
				break;
			case "artifact":
				if (!artifactsComparable) {
					notCompared.push(entry.id);
					continue;
				}
				abs = join(workersRoot, entry.key);
				break;
			case "action": {
				let text;
				try {
					text = readFileSync(join(root, NEXT_ACTIONS_SOURCE), "utf8");
				} catch (error) {
					(isUnreadableError(error) ? unreadable : missing).push({
						id: entry.id,
						reason: isUnreadableError(error) ? "source_document_unreadable" : "source_document_missing",
					});
					break;
				}
				const present = extractSection(text, "10. Next actions").some(
					(action) => sha256OfBytes(Buffer.from(String(action), "utf8")) === entry.digest,
				);
				if (present) unchanged += 1;
				else moved.push({ id: entry.id, recorded: entry.digest, observed: null, reason: "declared_text_absent" });
				break;
			}
			default:
				skipped.push({
					id: entry.id,
					reason:
						entry.role === "worktree"
							? "aggregate_digest"
							: entry.role === "code" || entry.role === "test"
								? "digest_recorded_in_observations"
								: "not_a_file",
				});
				continue;
		}
		if (abs === null) continue;
		if (!(entry.digest ?? null)) {
			skipped.push({ id: entry.id, reason: "no_recorded_digest" });
			continue;
		}
		let observed;
		try {
			observed = digestFor(readFileSync(abs));
		} catch (error) {
			(isUnreadableError(error) ? unreadable : missing).push({
				id: entry.id,
				reason: isUnreadableError(error) ? "path_unreadable" : "path_missing",
			});
			continue;
		}
		if (observed === entry.digest) unchanged += 1;
		else moved.push({ id: entry.id, recorded: entry.digest, observed, reason: "content_moved" });
	}
	// The code and test nodes carry no digest of their own (see the header): their
	// content addresses are the `observations` stanza, so they are verified here and
	// counted separately. This is the only place the kernel reads a file the packet
	// did not name -- and only a name an indexed document did name.
	const observed = verifyObservations(graph, root);
	unchanged += observed.unchanged;
	moved.push(...observed.moved);
	missing.push(...observed.missing);
	unreadable.push(...observed.unreadable);
	const checked = unchanged + moved.length + missing.length + unreadable.length;
	// On a shared checkout other sessions are writing while you read, so a
	// non-empty moved list is normal. The breakdown is what makes the report
	// actionable: "0 documents, 2 artifacts" answers "is any of this mine?" at a
	// glance, instead of making the reader walk the ids to find out.
	const byRole = {};
	for (const entry of [...moved, ...missing, ...unreadable]) {
		const role = entry.id.slice(0, entry.id.indexOf(":"));
		byRole[role] = (byRole[role] ?? 0) + 1;
	}
	return {
		checked,
		unchanged,
		moved: moved.sort((a, b) => a.id.localeCompare(b.id)),
		missing: missing.sort((a, b) => a.id.localeCompare(b.id)),
		unreadable: unreadable.sort((a, b) => a.id.localeCompare(b.id)),
		not_compared: notCompared.sort((a, b) => a.localeCompare(b)),
		skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
		moved_by_role: Object.fromEntries(Object.keys(byRole).sort().map((role) => [role, byRole[role]])),
		observations: {
			checked: observed.checked,
			moved: observed.moved.length,
			missing: observed.missing.length,
			unreadable: observed.unreadable.length,
		},
		// Not two answers but four. A path this process may not read is not a match and
		// not a deletion, and neither is an artifact compared against a root that is not
		// the one the graph recorded: in both cases the honest verdict is that a
		// dimension was not compared, and saying so is the same rule the resolver
		// applies to the session root.
		state:
			moved.length > 0 || missing.length > 0
				? "recorded_digests_moved"
				: unreadable.length > 0
					? "incomplete_unreadable"
					: notCompared.length > 0
						? "incomplete_not_compared"
						: "recorded_digests_match",
	};
}

/**
 * Resolve a caller-supplied target to node ids: exact id, exact key, a path
 * suffix, or a bare test name -- because what a session reads in a receipt is
 * `TestBuild_MatchesEmbedded`, not the id this graph gave it.
 */
export function resolveTarget(graph, target) {
	const exact = (graph.nodes ?? []).filter((n) => n.id === target);
	if (exact.length > 0) return exact.map((n) => n.id);
	const byKey = (graph.nodes ?? []).filter(
		(n) => n.key === target || n.key.endsWith(`/${target}`) || n.key.endsWith(`#${target}`),
	);
	return byKey.map((n) => n.id);
}

/**
 * Who has to be revisited when `target` moves. A move propagates the other way
 * along each edge's reading: `cites` is written reader -> thing read, so it
 * propagates target -> reader, while `declares` is written file -> test, so the
 * file is the thing read and the test is what has to be re-read. Depth 0 is the
 * target itself, so a caller can see the node was found even when nothing reads it.
 */
export function impactOf(graph, target) {
	const roots = resolveTarget(graph, target);
	if (roots.length === 0) return null;
	const readers = new Map();
	for (const edge of graph.edges ?? []) {
		if (edge.kind !== "cites" && edge.kind !== "declares") continue;
		const [moved, revisited] = edge.kind === "cites" ? [edge.to, edge.from] : [edge.from, edge.to];
		if (!readers.has(moved)) readers.set(moved, []);
		readers.get(moved).push(revisited);
	}
	const depth = new Map(roots.map((id) => [id, 0]));
	const queue = [...roots];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const from of readers.get(current) ?? []) {
			if (depth.has(from)) continue;
			depth.set(from, depth.get(current) + 1);
			queue.push(from);
		}
	}
	const reached = [...depth.entries()]
		.map(([id, d]) => ({ id, depth: d }))
		.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
	return { target, roots, reached, readers: reached.filter((r) => r.depth > 0) };
}

export function printBrief(graph) {
	const totals = graph.totals ?? {};
	const lines = [
		`graph_id     ${graph.graph_id}`,
		`source       ${graph.source?.packet_path} @ ${graph.source?.orientation_id}`,
		`nodes        ${totals.nodes} (${totals.content_addressed_nodes} content-addressed)`,
		`edges        ${totals.edges}`,
		"",
		"by role:",
	];
	for (const [role, count] of Object.entries(totals.by_role ?? {})) lines.push(`  ${role.padEnd(10)} ${count}`);
	lines.push("", "by kind:");
	for (const [kind, count] of Object.entries(totals.by_kind ?? {})) lines.push(`  ${kind.padEnd(10)} ${count}`);
	lines.push("", `observed     ${totals.observed_nodes ?? 0} code/test nodes re-hashed by --stale`);
	lines.push(`observed_id  ${graph.observations?.observed_id ?? "(none)"}`);
	const unresolved = graph.unresolved ?? [];
	lines.push(`unresolved   ${unresolved.length} names an indexed document used that did not resolve here`);
	return lines.join("\n");
}

// --- the spawn card -------------------------------------------------------
//
// The kernel is only useful to a session that already knows to ask it. The card
// is that knowledge, at spawn time: a bounded, path-free-as-possible block the
// daemon appends to the system prompt. It carries one absolute path on purpose --
// the checkout root -- because a session spawned into an AO worktree has a cwd
// where none of these commands resolve, and a command the reader cannot run is
// not orientation. Everything else in the card is a count, a digest or a
// protocol, so the card cannot leak another session's workspace.
export const CARD_MAX_BYTES = 8192;
export const CARD_ENV = "UCTM_ORIENTATION_CARD_PATH";

/** Absolute-path-looking tokens in a block of text. Used to bound what the card can carry. */
export function absolutePathsIn(text) {
	return [...new Set((String(text).match(/(?:^|[\s`("'[])(\/[^\s`)"'\]]+)/gm) ?? []).map((hit) => hit.replace(/^[\s`("'[]/, "")))].sort();
}

export function buildOrientationCard({ packet, graph, root }) {
	// A trailing separator would make the printed command read as a directory that
	// does not exist; keep the root exactly the path the reader can cd into.
	const checkout = root.length > 1 ? root.replace(/\/+$/, "") : root;
	const totals = packet.totals ?? {};
	const worktree = packet.worktree ?? {};
	const kernel =
		graph && graph.totals
			? `${graph.totals.nodes} nodes / ${graph.totals.edges} edges (graph_id ${graph.graph_id})`
			: "not built -- run node scripts/uctm-graph.mjs --write";
	const lines = [
		"## Orientation (UCTM Studio)",
		"",
		"You are starting against a world that was already indexed. Do not rebuild the",
		"picture by reading receipts: re-orient by comparison against the line below.",
		"",
		`    cd "${checkout}" && node scripts/uctm-orient.mjs --check`,
		"",
		"Exit 0 means every dimension below was compared and nothing moved, so spend no",
		"further context on orientation. Exit 1 prints exactly the paths that moved; read",
		"only those. Exit 3 means the session dimension could not be read in this shell -- a",
		"host that rewrites $HOME does that, and so does a session workspace inside a root",
		"that listed -- so the answer is deliberately incomplete rather than \"oriented\".",
		"",
		"Exit 2 means the command was wrong rather than the world -- a `--since` path that",
		"cannot be read, or a write the run refused. Exit 70 means the tool itself failed;",
		"it is deliberately outside the verdict vocabulary, so a crash can never be read as",
		"a drift report that forgot to print its paths.",
		"",
		"Exit 4 appears only under `--check --strict`: everything matched except that a",
		"declared-volatile artifact moved, meaning a tool rewrote its own output. That is",
		"named rather than counted against the address, so exit 0 and exit 4 both mean the",
		"address is valid; only exit 4 says a generated file has new bytes.",
		"",
		"The verdict is the exit code and the reason string, not equality between two",
		"`orientation_id`s. The address covers more than the receipts: the worktree's dirty",
		"digest sits inside it, so an edit to any source file moves the id while no indexed",
		"artifact moved. `--check` names that case -- `id_moved_but_parts_match`, with the note",
		"that sources changed and receipts did not -- and still exits 0. A session that",
		"diff-compares ids re-reads the whole world for nothing, which is the cost this index",
		"exists to remove.",
		"",
		"`--write` records the whole fleet as it stands at that instant, so a session caught",
		"mid-edit is snapshotted and bytes nobody authored are recorded; when the experiment is",
		"undone they surface as drift. Point a negative control at a new file rather than an",
		"indexed one: it fails the check the same way, as an `added` row, without touching",
		"anything the packet already holds.",
		"",
		"If that check exits 3, run this to see why the session dimension could not be read:",
		"",
		"    node scripts/uctm-orient.mjs --where",
		"",
		"It prints the root this run resolved, the root the packet recorded, and every",
		"candidate tried; name one with --workers-root <dir> or UCTM_WORKERS_ROOT=<dir>.",
		"A root that is missing or unreadable is never reported as an empty one, and it",
		"never lets --write drop the session pointers the packet already holds. `--json`",
		"on its own prints the whole packet; combined with `--where` or `--check` it prints",
		"that report instead, so the JSON form is the single-flag one.",
		"",
		"`machine_local.workers_root_state` in that packet separates the cases for a reader",
		"who did not run the check. `read` means the session dimension was scanned; `missing`",
		"or `unreadable` means it is unknown -- not empty, and not gone; `partial` means the",
		"root listed but a session workspace inside it did not, and those are named in",
		"`unreadable_sessions`. A partial root is still compared session by session, with the",
		"unreadable ones excluded by name rather than reported as removed, so it can still end",
		"in a complete verdict -- and when it cannot, it says which comparison it skipped.",
		"",
		`- orientation_id    ${packet.orientation_id ?? "(none)"}`,
		`- indexed_at        ${packet.generated_at ?? "(unknown)"}`,
		`- documents         ${totals.documents ?? 0} (${totals.pointed_bytes ?? 0} bytes pointed at)`,
		`- sessions          ${totals.sessions ?? 0}, ${totals.session_artifacts ?? 0} artifacts`,
		`- evidence kernel   ${kernel}`,
		`- worktree          ${worktree.branch ?? "unknown"} @ ${String(worktree.head ?? "").slice(0, 12)}, ${worktree.dirty_count ?? 0} dirty`,
		`- cited code        ${graph?.totals?.by_role?.code ?? 0} paths, ${graph?.totals?.by_role?.test ?? 0} tests the indexed documents name`,
		"",
		"Four more queries from the same checkout:",
		"",
		"    node scripts/uctm-orient.mjs --where         which session root was actually read",
		"    node scripts/uctm-graph.mjs --impact <path>    who cites this, and must re-read",
		"    node scripts/uctm-graph.mjs --stale            re-hash every file this index names",
		"    node scripts/uctm-graph.mjs --check --strict   add the cited code's own content to the verdict",
		"",
		"`--check` alone is a structural verdict: it proves no document, session artifact or",
		"named path appeared or disappeared, not that the code behind a claim is unchanged.",
		"",
		"This card is a pointer set, not evidence. A digest proves a pointer moved; it",
		"does not prove any claim is true, and it cannot tell you who wrote anything:",
		"authorship lives in transcripts, and AO worker transcripts are written under the",
		"redirected CODEX_HOME the launcher pins, not the passwd home's ~/.codex -- so a",
		"search from the passwd home answers \"nobody\" for work that is right there.",
		"",
	];
	const text = lines.join("\n");
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > CARD_MAX_BYTES) {
		throw new Error(`orientation card is ${bytes} bytes, over the ${CARD_MAX_BYTES}-byte cap the daemon enforces`);
	}
	const foreign = absolutePathsIn(text).filter((path) => path !== checkout);
	if (foreign.length > 0) {
		throw new Error(`orientation card carries paths outside the checkout root: ${foreign.join(", ")}`);
	}
	return text;
}

/**
 * Write the card where the launcher will point the daemon. A private file is a
 * requirement, not a nicety: readUCTMOrientationCard() refuses anything group- or
 * world-readable, and the mode is forced rather than inherited. The write is swapped
 * in by rename for the same reason the mode matters: the launcher and the daemon read
 * this file while it is being written, and a card caught half-written is
 * indistinguishable from a corrupt one.
 */
export function writeOrientationCard(path, text) {
	if (!path) return { written: false, reason: "no_path" };
	if (!isAbsolute(path)) throw new Error(`orientation card path must be absolute: ${path}`);
	writeFileAtomic(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
	return { written: true, bytes: Buffer.byteLength(text, "utf8") };
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
	const args = new Map();
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			args.set(key, next);
			i++;
		} else {
			args.set(key, true);
		}
	}
	return args;
}

export function main(argv, env = process.env, root = fileURLToPath(new URL("..", import.meta.url))) {
	const args = parseArgs(argv);
	const namedRoot = args.get("workers-root");
	const workersRoot = resolveWorkersRoot(namedRoot === true ? undefined : namedRoot, env);
	// A predicate about a path is not a predicate about the tree below it.
	// `workersRootState` answers "is it there, can this process list it" and its own
	// comment says it therefore cannot answer `partial` -- a root whose scan could
	// not enter one workspace reports `read` here. Branching on that alone made the
	// tree-predicate question unasked, so a partly unreadable tree was described as
	// a healthy root and the artifact nodes resting on it were reported as clean or
	// as gone. `readSessions().state` is the function the kernel points at for the
	// tree question, and the scan is one directory walk over a root this process has
	// already stat'd.
	const rootState = workersRootState(workersRoot);
	const liveScan = rootState === "read" ? readSessions(workersRoot) : null;
	const treeState = liveScan ? liveScan.state : rootState;
	const unreadableAtScan = liveScan?.unreadable_sessions ?? [];
	if (treeState !== "read") {
		// `present | missing` could not see a permission failure at all, so a root
		// that merely existed produced this warning's silence and a graph with no
		// artifact nodes. One vocabulary, and it names the state it actually read.
		process.stderr.write(
			`warning: session workspace root is ${treeState}${unreadableAtScan.length > 0 ? ` (unreadable: ${unreadableAtScan.join(", ")})` : ""}: ${workersRoot}\n` +
				"  Artifact nodes are unavailable or partial, so the graph carries what it could read and\n" +
				"  says so rather than reporting the rest as absent. Run node scripts/uctm-orient.mjs --where\n" +
				"  to see every candidate that was tried, and name one with --workers-root.\n",
		);
	}

	let packet;
	try {
		packet = readPacketFile(root);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		return 2;
	}
	const recordedRootWarning = packetRootWarning(packet);
	if (recordedRootWarning) process.stderr.write(recordedRootWarning);
	// The packet records the root it was scanned over, so a live root that is not
	// that one is detectable before anything is compared against it. Saying it here
	// is what keeps the artifact dimension from being read as a deletion below.
	const recordedRoot = packet?.machine_local?.workers_root ?? null;
	const rootDiffers = recordedRoot !== null && recordedRoot !== workersRoot;
	if (rootDiffers) {
		process.stderr.write(
			`warning: --workers-root names ${workersRoot}, but ${PACKET_PATH} recorded ${recordedRoot}\n` +
				"  A different root is a different world, so the artifact dimension is not compared: nodes under\n" +
				"  it are reported as not compared, never as missing. Pass the recorded root, or re-run\n" +
				"  node scripts/uctm-orient.mjs --write to record this one.\n",
		);
	}
	const graph = deriveGraph({ packet, citations: collectCitations(root, packet), code: collectCode(root, packet) });
	const cardPath = args.get("card") === true ? env[CARD_ENV] : args.get("card") || (args.has("write") ? env[CARD_ENV] : null);

	if (args.has("impact")) {
		const target = args.get("impact");
		if (target === true) {
			process.stderr.write("--impact needs a node id or a path\n");
			return 2;
		}
		const impact = impactOf(graph, target);
		if (impact === null) {
			process.stderr.write(`no node in the graph matches ${target}\n`);
			return 2;
		}
		if (args.has("json")) {
			process.stdout.write(`${JSON.stringify(impact, null, 2)}\n`);
			return 0;
		}
		process.stdout.write(`target ${impact.roots.join(", ")}\n`);
		if (impact.readers.length === 0) {
			process.stdout.write("no recorded document cites this node; nothing has to be re-read because of it\n");
			return 0;
		}
		// Depth 1 is the answer to "who names this?"; the closure past it is a walk
		// through documents that cite documents, which on this checkout reaches most
		// of the plan. Printing all of it would bury the answer in its own transitive
		// hull, so the deeper set is summarised and --json still carries it whole.
		const direct = impact.readers.filter((reader) => reader.depth === 1);
		const deeper = impact.readers.filter((reader) => reader.depth > 1);
		for (const reader of direct) process.stdout.write(`  depth 1  ${reader.id}\n`);
		if (deeper.length > 0) {
			const byRole = {};
			for (const reader of deeper) {
				const role = reader.id.slice(0, reader.id.indexOf(":"));
				byRole[role] = (byRole[role] ?? 0) + 1;
			}
			const deepest = Math.max(...deeper.map((reader) => reader.depth));
			process.stdout.write(
				`  deeper   ${deeper.length} more at depth 2..${deepest} (${describeRoles(byRole)}) -- --json for the full closure\n`,
			);
		}
		return 0;
	}

	if (args.has("stale")) {
		const report = verifyGraph(graph, { root, workersRoot, recordedRoot });
		if (args.has("json")) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			process.stdout.write(`state     ${report.state}\n`);
			process.stdout.write(`checked   ${report.checked} (${report.unchanged} unchanged, ${report.moved.length} moved, ${report.missing.length} missing, ${report.unreadable.length} unreadable)\n`);
			process.stdout.write(`observed  ${report.observations.checked} code/test nodes (${report.observations.moved} moved)\n`);
			process.stdout.write(`skipped   ${report.skipped.length} (aggregate digests and nodes whose digest lives in observations)\n`);
			process.stdout.write(`by role   ${describeRoles(report.moved_by_role)}\n`);
			for (const entry of report.moved) process.stdout.write(`  moved    ${entry.id}\n`);
			for (const entry of report.missing) process.stdout.write(`  missing  ${entry.id}  (${entry.reason})\n`);
			for (const entry of report.unreadable) process.stdout.write(`  unreadable  ${entry.id}  (${entry.reason})\n`);
			if (report.not_compared.length > 0) {
				process.stdout.write(`  not compared  ${report.not_compared.length} artifact(s) under a root that is not the recorded one\n`);
			}
		}
		// Same rule as `--check`: a verdict is complete only when every dimension was
		// compared. An artifact resolved against a different tree, or a session root
		// that could not be read in full, is a dimension that was not -- so it exits 3
		// rather than 1, and never reports a deletion it did not read.
		if (report.not_compared.length > 0) {
			process.stdout.write(`incomplete: ${report.not_compared.length} artifact(s) were not compared (the root resolved to a different tree than the one recorded)\n`);
			return 3;
		}
		if (report.unreadable.length > 0) {
			process.stdout.write(`incomplete: ${report.unreadable.length} path(s) this shell could not read were not compared\n`);
			return 3;
		}
		if (treeState !== "read") {
			process.stdout.write(`incomplete: the session root could not be read in full (${treeState}), so this verdict covers what it could read\n`);
			return 3;
		}
		return report.state === "recorded_digests_match" ? 0 : 1;
	}

	if (args.has("write")) {
		const existing = readGraphFile(root);
		const unchanged = existing && existing.graph_id === graph.graph_id;
		const out = unchanged ? { ...graph, generated_at: existing.generated_at } : { ...graph, generated_at: new Date().toISOString() };
		writeFileAtomic(join(root, GRAPH_PATH), `${JSON.stringify(out, null, 2)}\n`);
		let card = { written: false };
		if (cardPath) {
			card = writeOrientationCard(cardPath, buildOrientationCard({ packet, graph: out, root }));
		}
		process.stdout.write(`${args.has("json") ? JSON.stringify(out) : printBrief(out)}\n`);
		process.stdout.write(`\nwrote ${GRAPH_PATH}${unchanged ? " (unchanged world, byte-identical)" : ""}\n`);
		if (card.written) process.stdout.write(`wrote spawn card ${cardPath} (${card.bytes} bytes, mode 0600)\n`);
		return 0;
	}

	if (args.has("check")) {
		const existing = readGraphFile(root);
		if (!existing) {
			process.stdout.write("drift: no_graph_recorded\n");
			return 1;
		}
		if (existing.graph_id === graph.graph_id) {
			process.stdout.write(`kernel current: ${graph.graph_id}\n`);
			// Scope, stated rather than implied: this answers "does the kernel match
			// the packet on disk?", not "has the world moved?". The packet is what
			// touches the world; uctm-orient --check is the gate for that question.
			process.stdout.write(`scope: matches ${PACKET_PATH} @ ${packet.orientation_id ?? "(none)"}; run node scripts/uctm-orient.mjs --check to test the packet against the world\n`);
			// The code and tests are content, not identity, so they cannot move this
			// address -- which is exactly why the answer has to be said out loud
			// rather than left for the reader to assume the address covered it.
			const observed = verifyObservations(graph, root);
			const unseen = observed.unreadable.length;
			// A verdict is complete only when every dimension was compared, and exit 3 is
			// the vocabulary the resolver already uses for "I could not check". Three ways
			// this one is partial, in the order `--stale` applies them, because two
			// commands that answer the same question with different reasons are two
			// vocabularies rather than two views: artifacts resolved against a tree that
			// is not the recorded one, named paths this shell could not read, and a
			// session root whose *tree* could not be entered. The last is the one that
			// hid: `workersRootState` is a predicate about a path, so a root holding an
			// unreadable workspace answers `read` while the scan below it is `partial`,
			// and this branch then printed a clean line about the observations while the
			// artifact dimension had not been compared at all -- fail-open, in the tool
			// built to close it.
			const incompleteReason = () => {
				if (rootDiffers) return "the artifact dimension was not compared (the resolved session root is not the one the packet recorded)";
				if (unseen > 0) return `${unseen} named path(s) could not be read in this shell, so this verdict is partial rather than clean`;
				if (treeState !== "read") return `the session root could not be read in full (${treeState}), so this verdict covers only what it could read`;
				return null;
			};
			if (observed.checked === 0) {
				process.stdout.write("observations: none recorded (no indexed document named a repository path or test)\n");
				const why = incompleteReason();
				if (why) {
					process.stdout.write(`incomplete: ${why}\n`);
					return 3;
				}
				return 0;
			}
			const drifted = observed.moved.length + observed.missing.length;
			process.stdout.write(
				`observations: ${observed.checked - drifted - unseen} of ${observed.checked} unchanged` +
					(drifted === 0
						? `; every named code path and test matches what was recorded${unseen > 0 ? ", except the ones this shell could not read" : ""}\n`
						: `; ${drifted} moved (re-run with --stale to see which, then --impact <path> for who must re-read)\n`),
			);
			const incompleteWhy = incompleteReason();
			if (incompleteWhy) {
				process.stdout.write(`incomplete: ${incompleteWhy}\n`);
				return 3;
			}
			if (args.has("strict") && drifted > 0) return 4;
			return 0;
		}
		process.stdout.write(`drift: graph_moved\n  live:     ${graph.graph_id}\n  recorded: ${existing.graph_id}\n`);
		const before = new Map((existing.nodes ?? []).map((n) => [n.id, n.occurrence]));
		const after = new Map((graph.nodes ?? []).map((n) => [n.id, n.occurrence]));
		for (const [id, occurrence] of after) {
			if (!before.has(id)) process.stdout.write(`  added    ${id}\n`);
			else if (before.get(id) !== occurrence) process.stdout.write(`  moved    ${id}\n`);
		}
		for (const id of before.keys()) if (!after.has(id)) process.stdout.write(`  removed  ${id}\n`);
		process.stdout.write(`  by role  ${describeRoles(movedRoles(existing, graph))}\n`);
		const beforeEdges = new Set((existing.edges ?? []).map((e) => `${e.from}\0${e.kind}\0${e.to}`));
		const afterEdges = new Set((graph.edges ?? []).map((e) => `${e.from}\0${e.kind}\0${e.to}`));
		for (const edge of afterEdges) if (!beforeEdges.has(edge)) process.stdout.write(`  link     ${edge.replaceAll("\0", " -> ")}\n`);
		for (const edge of beforeEdges) if (!afterEdges.has(edge)) process.stdout.write(`  unlink   ${edge.replaceAll("\0", " -> ")}\n`);
		return 1;
	}

	if (args.has("card")) {
		if (cardPath === null || cardPath === undefined) {
			process.stderr.write("--card needs an absolute path, or set UCTM_ORIENTATION_CARD_PATH\n");
			return 2;
		}
		const text = buildOrientationCard({ packet, graph, root });
		const result = writeOrientationCard(cardPath, text);
		process.stdout.write(`${args.has("json") ? JSON.stringify({ path: cardPath, ...result }) : text}\n`);
		return 0;
	}

	process.stdout.write(`${args.has("json") ? JSON.stringify(graph, null, 2) : printBrief(graph)}\n`);
	return 0;
}

/**
 * Whether this file was invoked as the program, rather than imported.
 *
 * The paths are compared after realpath, because the naive comparison is false
 * through a symlinked directory -- and the failure is silent: `/var` is a symlink
 * to `/private/var` on macOS, so `node /var/.../uctm-orient.mjs --check` matched
 * nothing, ran no branch, and exited 0. Doing nothing and reporting success is the
 * worst available answer, and it is the same "no answer reported as a good one"
 * shape as an unread root reported as an empty one.
 */
function invokedAsProgram() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedAsProgram()) {
	// Same rule as the orientation CLI: exit 1 means drift, so an uncaught exception
	// may not exit 1 and impersonate one. A failure of the tool says so and uses a
	// code outside the verdict vocabulary.
	//
	// `process.exitCode`, not `process.exit()`, for the reason spelled out at the same
	// place in uctm-orient.mjs: the pipe write is asynchronous, and this file's own
	// `--json` document is over 200 KB, so exiting immediately cut it at one pipe
	// buffer with exit 0 -- a graph a consumer could half-read and believe.
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`internal: the kernel failed, so this is not a report about the world\n${error?.stack ?? error}\n`);
		process.exitCode = 70;
	}
}

export { canonicalize };
