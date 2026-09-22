#!/usr/bin/env node
// UCTM orientation index: one read instead of twenty.
//
//   node scripts/uctm-orient.mjs --check        # exit 0 oriented, exit 1 drifted
//                                               # exit 3: a dimension could not be read here
//   node scripts/uctm-orient.mjs --where        # which session root was actually read
//   node scripts/uctm-orient.mjs --write        # regenerate docs/uctm/ORIENTATION.v0.json
//   node scripts/uctm-orient.mjs --since <id>   # print only what moved since <id>
//
// A session joining this workstream otherwise rebuilds its picture by reading
// every receipt, every contract, every other session's workspace and then
// running git status -- and it cannot tell whether any of it moved since the
// last time it looked. This index records what is claimed, by whom, with a
// content address over the pointers, so re-orientation is one artifact read and
// "nothing changed" is a digest comparison rather than an act of faith.
//
// It carries pointers, sizes and digests. It never copies a foreign file's
// body: the index says where a fact lives and how to check it, not what it
// says. Short declared fields that the repo already publishes (a receipt's
// Status line, a contract's safe_claim) are quoted because they are the claim
// vocabulary a reader needs; nothing from another session's workspace is.
//
// PUBLISHED MESSAGE SURFACE. Six printed strings in this file are read literally
// by a consumer outside this checkout (scratch-10's scripts/verify-orientation.mjs,
// GUARD_DEPENDENCIES), which tests each one as a substring of this file's bytes
// and names the arm it disables when one is missing. Re-word or delete a string
// and that arm stops firing without failing -- absence indistinguishable from
// success, the fail-open shape. The dependency is deliberate and runs one way:
// this file owns the strings; the consumer asserts they are still here. So
// re-wording one is expected to turn that verifier red -- that is the contract
// working, and the fix is to retire the arm in the same change.
//
// The six phrases are deliberately not listed here. A substring test cannot tell
// a printed string from a comment, so quoting one in this header would keep the
// test passing after the code moved -- the exact failure the dependency exists to
// catch. Read them from the consumer's list.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "uctm.orientation.v0";
/**
 * The domain string for the packet's observation band -- the second handle on the
 * same artifact, for content that is deliberately outside `orientation_id`.
 */
export const PACKET_OBSERVATION_DOMAIN = "uctm.orientation.observations.v0";

/** Stable JSON: object keys sorted, so the digest cannot depend on write order. */
export function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

export function digestOf(value) {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function sha256OfBytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** First `# ` heading, or null. Used as the human label for a pointer. */
export function extractTitle(markdown) {
	for (const line of markdown.split("\n")) {
		if (line.startsWith("# ")) return line.slice(2).trim();
	}
	return null;
}

/**
 * The text a document declares after a `Status:` marker, up to the first blank
 * line, heading or table row. Receipts and plans already state their own status;
 * re-deriving it from prose would be a second, disagreeing copy.
 */
export function extractStatus(markdown) {
	const all = extractStatuses(markdown);
	return all.length > 0 ? all[0].status : null;
}

/**
 * Every `Status:` declaration in a document, with the heading it sits under.
 * A plan that states one status per gate has more than one honest answer, and
 * keeping only the first would report AO-F1's status as the whole plan's.
 */
export function extractStatuses(markdown) {
	const lines = markdown.split("\n");
	const found = [];
	let section = "";
	for (let i = 0; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			section = lines[i].replace(/^#+\s*/, "").trim();
			continue;
		}
		// Receipts write both "Status: **value**" and "**Status:** value".
		const match = /^(?:\*\*)?Status(?:\*\*)?:?\s*(.*)$/i.exec(lines[i].trim());
		if (!match) continue;
		const parts = [match[1].trim()];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j].trim();
			if (next === "" || next.startsWith("#") || next.startsWith("|")) break;
			parts.push(next);
		}
		const status = parts.join(" ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
		if (status) found.push(section ? { section, status } : { status });
	}
	return found;
}

/** Bullet or numbered items under a `## <heading>` section, in file order. */
export function extractSection(markdown, heading) {
	const lines = markdown.split("\n");
	const wanted = heading.trim().toLowerCase();
	const items = [];
	let inside = false;
	for (const line of lines) {
		const isHeading = /^#{1,6}\s/.test(line);
		if (isHeading) {
			inside = line.replace(/^#+\s*/, "").trim().toLowerCase() === wanted;
			continue;
		}
		if (!inside) continue;
		const item = /^\s*(?:\d+\.|[-*])\s+(.*)$/.exec(line);
		if (item) items.push(stripMarkdown(item[1]));
	}
	return items;
}

function stripMarkdown(text) {
	return text
		.replace(/~~(.*?)~~/g, "$1")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/`(.*?)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

export function classifyDocument(name) {
	// Every receipt in this workstream is named AO_<something>; the gate letters
	// have changed once already, so the rule is the prefix, not the letter.
	if (/^AO_/.test(name)) return "receipt";
	if (name === "INTEGRATION_ENDPOINTS.v0.json" || name === "READINESS_CONTRACT.json") return "contract";
	if (name === "TEST_BASELINE.v0.json") return "baseline";
	if (/^CONNECTION_PLAN|^INTERFACE_ABSORPTION_PLAN/.test(name)) return "plan";
	if (/GATE|QUALIFICATION|RECALL/.test(name)) return "gate";
	return "reference";
}

/**
 * Build the packet. `documents` and `sessions` are already-digested pointers;
 * this function only assembles, so the digest below covers declared facts and
 * never a clock reading.
 */
export function buildOrientation({ generatedAt, documents, sessions, worktree, nextActions, machineLocal }) {
	// Identity is a path; content is an observation -- applied to session artifacts,
	// not only to cited code. A session that declares a file tool-regenerated keeps
	// that file in the structure and its digest out of it: the file still appears and
	// disappears (which is "did this session produce anything new?"), but a rewrite
	// on a timer cannot move the address. Without this, running a guard suite would
	// invalidate the index it just satisfied, and the spawn card's comparand would go
	// stale as a side effect of normal work.
	const identitySessions = sessions.map((session) => ({
		...session,
		artifacts: session.artifacts.map((artifact) => (artifact.volatile ? { path: artifact.path, volatile: true } : artifact)),
		pointed_bytes: session.artifacts.reduce((sum, artifact) => sum + (artifact.volatile ? 0 : artifact.bytes), 0),
	}));
	const volatileArtifacts = [];
	const volatileMissing = [];
	for (const session of sessions) {
		for (const artifact of session.artifacts) {
			if (artifact.volatile) {
				volatileArtifacts.push({ session: session.session, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 });
			}
		}
		for (const path of session.volatile_declaration_missing ?? []) volatileMissing.push({ session: session.session, path });
	}
	const body = {
		schema: SCHEMA,
		how_to_use: "Record orientation_id when you finish orienting. On return, run `node scripts/uctm-orient.mjs --check`: exit 0 means every dimension here was compared and nothing moved, so do not re-read. Exit 1 prints the exact paths that moved, and you read only those. Exit 3 means a dimension could not be read in this shell -- most often the session root, when $HOME is rewritten -- so the run says `incomplete:` and deliberately does not say `oriented`; run `--where` to see the root it resolved, the root this packet recorded, and every candidate it tried, then name one with --workers-root or UCTM_WORKERS_ROOT. A root that is missing or unreadable is never reported as an empty one, and `--write` refuses rather than drop pointers it could not read. `--write` regenerates; a write over an unchanged world is byte-identical on purpose. A check that exits 0 has oriented you even when `orientation_id` differs from the one recorded here: the id also covers the worktree's dirty digest, so an edit to any source file moves it without moving a receipt. `--check` names that case and still exits 0, so key on the exit code and the reason string rather than on id equality -- an id that moved is not by itself a reason to re-read. `--write` records the whole fleet as it stands at that instant, including another session's in-flight edit, so a temporary experiment surfaces as drift once it is undone; point a negative control at a new file instead of editing one the packet already records.",
		worktree,
		documents,
		sessions: identitySessions,
		next_actions: nextActions,
		machine_local: machineLocal,
		totals: {
			documents: documents.length,
			pointed_bytes: documents.reduce((sum, d) => sum + d.bytes, 0),
			sessions: sessions.length,
			session_artifacts: sessions.reduce((sum, s) => sum + s.artifacts.length, 0),
		},
		non_claims: [
			"This index carries pointers, sizes and digests. It is not the evidence itself, and reading it is not the same as reading a receipt.",
			"A digest here proves a pointer moved. It does not prove the fact behind it is true.",
			"Derived indexes are not inputs to each other. ORIENTATION.v0.json and GRAPH.v0.json are excluded from the document scan and from the worktree dirty set, so writing an index is never reported here as the world moving. That is also why the worktree node is the source dirty set only.",
			"Session artifact lists are machine-local observations of the AO worker root only. A session whose real workspace is elsewhere -- a checkout on the desktop, a shared checkout, a terminal agent -- appears with few or no artifacts. Absence here is not evidence of inactivity, and it is not evidence of authorship: authorship lives in transcripts, not in a workspace, and AO worker transcripts are written under the redirected CODEX_HOME the launcher pins (<AO data dir>/codex/sessions), not the passwd home's ~/.codex/sessions -- so an index built from the passwd home cannot see them. One session's lineage slice was attributed only after reading that redirected root.",
			"`observations` is outside `orientation_id` on purpose. It holds the content of artifacts a session declared tool-regenerated (`<session>/volatile.json`): their existence is structure, their bytes are not. `--check` names them when they move and exits 0, because a generator rewriting its own output is not the world changing shape; `--check --strict` makes that non-zero for a caller who wants it. A declared path that no longer exists is recorded as `volatile_declaration_missing` rather than ignored, so a rename fails visibly instead of silently un-pinning the wrong file.",
			"`skipped_names` on a session lists what the tool-state deny-list pruned there (a dependency tree, a VCS directory, a tool cache). Names only, never counts or contents, so installing dependencies does not move the address but a *new* kind of tree appearing in a workspace does. It is recorded because a deny-list fails quietly in both directions: an unlisted cache becomes thousands of artifacts, and a listed one vanishes unmentioned. Seeing a name here that is not tool state means the list is wrong for that workspace, and seeing a large tree indexed that should be here means the list is incomplete.",
		],
	};
	const observations = {
		id_domain: PACKET_OBSERVATION_DOMAIN,
		volatile_artifacts: volatileArtifacts,
		volatile_declaration_missing: volatileMissing,
	};
	return {
		generated_at: generatedAt,
		orientation_id: digestOf(body),
		...body,
		observations: { observed_id: digestOf(observations), ...observations },
	};
}

/** Compare a previous orientation id against the current packet's parts. */
/**
 * Which declared-volatile artifacts changed content, by `session/path`. Kept as
 * its own function because it is the one comparison that is deliberately *not* part
 * of the verdict: a tool rewriting its own output is a fact worth naming and not a
 * reason to send a reader back to re-read three generated files.
 */
export function volatileMovement(previous, current) {
	const before = new Map((previous?.observations?.volatile_artifacts ?? []).map((a) => [`${a.session}/${a.path}`, a.sha256]));
	const after = new Map((current?.observations?.volatile_artifacts ?? []).map((a) => [`${a.session}/${a.path}`, a.sha256]));
	const moved = [];
	for (const [key, sha] of after) if (before.has(key) && before.get(key) !== sha) moved.push(key);
	return moved.sort();
}

export function diffOrientations(previous, current, { includeSessions = true, unreadableSessions = [] } = {}) {
	const skipped = includeSessions ? [] : ["sessions"];
	// A session this scan could not read in full is unknown, not deleted. Its
	// recorded pointers are carried out of the comparison by name, so the only
	// verdict left for them is "not checked" and never "removed".
	const unreadable = [...new Set(unreadableSessions)].sort();
	for (const name of unreadable) skipped.push(`sessions:${name}`);
	// A declared-volatile artifact is compared here, not in the identity diff: its
	// bytes are an observation, so a generator rewriting them is reported and never
	// changes the verdict. Named, so the reader can decide, rather than silent.
	const volatileMoved = volatileMovement(previous, current);
	if (previous?.orientation_id === current.orientation_id && volatileMoved.length === 0) {
		return { unchanged: true, reason: "content_address_matches", changed: [], added: [], removed: [], dimensions_skipped: skipped, volatile_moved: [], volatile_unchanged: true, sessions_unreadable: unreadable };
	}
	if (!previous) return { unchanged: false, reason: "no_previous_orientation", changed: [], added: [], removed: [], dimensions_skipped: skipped, volatile_moved: volatileMoved, sessions_unreadable: unreadable };
	if (previous.orientation_id === current.orientation_id) {
		return { unchanged: true, reason: "content_address_matches", changed: [], added: [], removed: [], dimensions_skipped: skipped, volatile_moved: volatileMoved, sessions_unreadable: unreadable };
	}
	const before = new Map((previous.documents ?? []).map((d) => [d.path, d.sha256]));
	const after = new Map((current.documents ?? []).map((d) => [d.path, d.sha256]));
	// A session dimension that could not be read is unknown, not empty. Diffing it
	// anyway turns "this process cannot see the root" into "eight sessions deleted
	// their workspaces", so the caller asks for it to be left out instead.
	if (includeSessions) {
		for (const session of previous.sessions ?? []) {
			if (unreadable.includes(session.session)) continue;
			for (const artifact of session.artifacts) before.set(`${session.session}/${artifact.path}`, artifact.sha256);
		}
		for (const session of current.sessions ?? []) {
			if (unreadable.includes(session.session)) continue;
			for (const artifact of session.artifacts) after.set(`${session.session}/${artifact.path}`, artifact.sha256);
		}
	}
	// Which session artifacts each side declared tool-regenerated, and what content
	// digest each side recorded for them. A volatile artifact carries no digest in the
	// identity list -- that is the point -- so its bytes live in the observations band,
	// and a declaration appearing or vanishing moves a path between the two bands
	// without touching the file. Collecting both here is what lets that be named as a
	// classification change instead of a moved file.
	const classification = (packet) => {
		const keys = new Set();
		const digests = new Map();
		for (const session of packet?.sessions ?? []) {
			if (unreadable.includes(session.session)) continue;
			for (const artifact of session.artifacts) {
				const key = `${session.session}/${artifact.path}`;
				if (artifact.volatile) keys.add(key);
				else digests.set(key, artifact.sha256);
			}
		}
		for (const artifact of packet?.observations?.volatile_artifacts ?? []) {
			digests.set(`${artifact.session}/${artifact.path}`, artifact.sha256);
		}
		return { keys, digests };
	};
	const beforeClass = classification(previous);
	const afterClass = classification(current);
	const changed = [];
	const added = [];
	const removed = [];
	const excluded = [];
	const reclassified = [];
	for (const [key, sha] of after) {
		if (!before.has(key)) {
			added.push(key);
			continue;
		}
		if (before.get(key) === sha) continue;
		// A path that changed band without moving its bytes is a declaration change, not
		// a moved file: the scanner now records its content somewhere else. Reporting it
		// as `changed` made the documented act of declaring a generated file -- or
		// dropping the declaration -- a false drift report for every reader until someone
		// re-anchored. Same cause-separation as an exclusion, one scanner decision over.
		if (beforeClass.keys.has(key) === afterClass.keys.has(key)) {
			changed.push(key);
			continue;
		}
		reclassified.push(key);
		// Both bands carry a digest, so the digest survives the change of band even
		// though the identity list stops carrying it. Comparing the two is what keeps a
		// real content move from hiding behind the declaration that revealed it.
		const was = beforeClass.digests.get(key);
		const now = afterClass.digests.get(key);
		if (was !== undefined && now !== undefined && was !== now) changed.push(key);
	}
	// A path that stopped being *read* is not a path that stopped existing. Adding an
	// exclusion makes every entry it covers report as `removed` until the next --write,
	// which says "the world lost these" when what happened is that the scanner changed
	// its mind. That is the same failure as reporting an unreadable root as an empty
	// one, one level up: it survives in the exclusion path. So the two are separated by
	// cause rather than by consequence -- a deliberate exclusion is named as such and
	// never counted as drift.
	const sessionNames = new Set([...(previous.sessions ?? []), ...(current.sessions ?? [])].map((session) => session.session));
	const excludedByPolicy = (key) => {
		if (DERIVED_INDEX_PATHS.includes(key)) return true;
		const slash = key.indexOf("/");
		if (slash === -1) return false;
		// Only a session artifact is checked against the tool-state deny-list: a
		// document that happens to live under a directory called `build` is not tool
		// state, and mislabelling a deletion as an exclusion would be the same error
		// in the other direction.
		if (!sessionNames.has(key.slice(0, slash))) return false;
		return key
			.slice(slash + 1)
			.split("/")
			.some((segment) => SESSION_SKIP.has(segment));
	};
	for (const key of before.keys()) {
		if (after.has(key)) continue;
		if (excludedByPolicy(key)) excluded.push(key);
		else removed.push(key);
	}
	// `orientation_id` covers more than the artifact pointers: the worktree dirty
	// digest, the declared next-actions list and the machine-local block are all in
	// it. Diffing only the pointers therefore reported "oriented" while the id had
	// moved -- a false negative that is worse than noise, because the reader is
	// told to stop looking. Name the dimension that moved instead.
	const previousWorktree = previous.worktree ?? {};
	const currentWorktree = current.worktree ?? {};
	const worktreeMoved = ["branch", "head", "dirty_id"].some((field) => previousWorktree[field] !== currentWorktree[field]);
	const actionsMoved = canonicalize(previous.next_actions ?? null) !== canonicalize(current.next_actions ?? null);
	const machineMoved = canonicalize(previous.machine_local ?? null) !== canonicalize(current.machine_local ?? null);
	// A reclassification counts here even though it is not a moved file: the declaration
	// that caused it is itself an indexed artifact, so that write already carries the
	// exit code. Counting it keeps this bucket from being the one diff a caller can
	// receive without the report ever naming it.
	const partsMoved = changed.length + added.length + removed.length + reclassified.length;
	return {
		unchanged: partsMoved === 0,
		// `content_address_matches` is returned above, only when the ids really are
		// equal. Reaching this line means they differ, so the fallback may not claim
		// they matched: it used to return `part_digests_moved` here with empty
		// changed/added/removed lists, so a caller that read only `reason` was told
		// digests had moved while the diff could not name one. The dimension that
		// did move is carried by worktree_moved / actions_moved / machine_moved.
		reason: partsMoved > 0 ? "part_digests_moved" : "id_moved_but_parts_match",
		changed: changed.sort(),
		added: added.sort(),
		removed: removed.sort(),
		excluded: excluded.sort(),
		reclassified: reclassified.sort(),
		dimensions_skipped: skipped,
		worktree_moved: worktreeMoved,
		worktree_counts: { previous: previousWorktree.dirty_count ?? null, current: currentWorktree.dirty_count ?? null },
		actions_moved: actionsMoved,
		machine_moved: machineMoved,
		volatile_moved: volatileMoved,
		sessions_unreadable: unreadable,
	};
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SESSION_SCAN_DEPTH = 4;
/**
 * Tool state, not artifacts: dependency trees, VCS internals, and the caches
 * test and contract tools write. A deny-list is inherently incomplete -- the next
 * tool invents the next cache directory -- so what this list prunes is *recorded*
 * per session as `skipped_names` rather than silently dropped. Otherwise a cache
 * tree that is not on the list gets indexed (10k files becoming artifacts), and
 * one that is on the list disappears without a trace, which are the two ways a
 * deny-list fails quietly.
 */
const SESSION_SKIP = new Set(["node_modules", ".git", "__pycache__", ".vite", ".tanstack", ".cache", ".turbo", ".next", ".pytest_cache", ".venv", "dist", "build"]);
/** The index cannot be an input to itself: a self-referencing digest moves every time it is written. */
export const SELF = "ORIENTATION.v0.json";
export const PACKET_PATH = "docs/uctm/ORIENTATION.v0.json";
/**
 * Derived indexes are not inputs to each other either. The packet describes the
 * sources; the evidence kernel is derived from the packet. If the packet digests
 * the kernel's bytes, then writing the kernel moves the packet, which moves the
 * kernel's provenance, which moves the kernel -- a cycle that never settles. So
 * every derived index is excluded from the document scan and from the dirty
 * digest, the same way the packet excludes itself. Adding an index here is the
 * one change that keeps the pair convergent; a test asserts both stay out.
 */
export const GRAPH_PATH = "docs/uctm/GRAPH.v0.json";
export const DERIVED_INDEX_PATHS = [PACKET_PATH, GRAPH_PATH];
const DERIVED_INDEX_NAMES = new Set(DERIVED_INDEX_PATHS.map((path) => path.slice(path.lastIndexOf("/") + 1)));
const ATOMIC_SWAP_NAME = /^\.(.+)\.tmp-\d+$/;

/**
 * A derived index, or that same index mid-swap by `writeFileAtomic`. The dirty-set
 * filter tested `DERIVED_INDEX_PATHS.includes(path)` -- an exact path -- so the
 * finished index was excluded and the same index half-written was not. A writer
 * killed inside the swap window leaves `.ORIENTATION.v0.json.tmp-<pid>` behind,
 * and because the name carries the pid no later write reuses or sweeps it: the
 * record is permanent, it names a file no receipt mentions, and `dirty` sits
 * inside `orientation_id`, so the packet's own address moves on account of the
 * tool's debris. That is the same false-signal class the exact-path filter was
 * added to end, one level down -- the finished artifact is not an input to a
 * derived index, and neither is its half-written copy.
 */
export function isDerivedIndexPath(path) {
	if (DERIVED_INDEX_PATHS.includes(path)) return true;
	const slash = path.lastIndexOf("/");
	const swap = ATOMIC_SWAP_NAME.exec(path.slice(slash + 1));
	if (!swap) return false;
	return DERIVED_INDEX_PATHS.includes(`${path.slice(0, slash + 1)}${swap[1]}`);
}

/**
 * Where the other sessions' workspaces live. This was derived from `homedir()`
 * alone, and `homedir()` follows $HOME -- but an AO worker runs with
 * HOME=<harness home>, not the user's home, so the default resolved to
 * `<harness home>/.ao/uctm-studio/data/worktrees/scratch/workers`, which does
 * not exist. A missing root scans as zero sessions, and zero sessions is
 * indistinguishable from "every session deleted its workspace", so `--check`
 * reported every recorded pointer as `removed`: permanent false drift in
 * exactly the environment the index is meant for. A named root wins, then the
 * environment, then the first candidate that exists -- with the passwd home as
 * a fallback, because it does not move when a harness rewrites $HOME.
 */
export const WORKERS_ROOT_TAIL = "worktrees/scratch/workers";
export const WORKERS_ROOT_SUFFIX = `.ao/uctm-studio/data/${WORKERS_ROOT_TAIL}`;

function passwdHome() {
	try {
		return userInfo().homedir;
	} catch {
		return null;
	}
}

export function workersRootCandidates({ explicit, env = process.env, homes }) {
	const candidates = [];
	if (explicit) candidates.push(explicit);
	if (env && env.UCTM_WORKERS_ROOT) candidates.push(env.UCTM_WORKERS_ROOT);
	// An AO worker shell rewrites $HOME but always carries the daemon's data dir,
	// so this candidate is the one that is actually authoritative there. It also
	// saves the two $HOME-derived guesses below from having to be right, and it
	// needs no passwd lookup (which a sandbox can refuse).
	if (env && env.AO_DATA_DIR) candidates.push(join(env.AO_DATA_DIR, WORKERS_ROOT_TAIL));
	for (const home of homes ?? [homedir(), passwdHome()]) {
		if (home) candidates.push(join(home, WORKERS_ROOT_SUFFIX));
	}
	return [...new Set(candidates)];
}

export function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function resolveWorkersRoot(explicit, env = process.env, homes) {
	// A named root is honoured whether or not it exists: an operator who says
	// where the sessions are gets told when they are wrong, not silently
	// redirected somewhere else.
	if (explicit) return explicit;
	if (env && env.UCTM_WORKERS_ROOT) return env.UCTM_WORKERS_ROOT;
	const candidates = workersRootCandidates({ env, homes });
	return candidates.find(isDirectory) ?? candidates[0];
}

export function workersRootState(path) {
	// The state of a *path*, before any session inside it is read. This used to
	// answer `present` for any directory that stats, so a root this process could
	// not list -- mode, ACL, a sandbox -- came back as present and a caller that
	// branched on it reported nothing wrong about a dimension it had not read.
	//
	// It answers exactly three questions -- is it there, can this process list it,
	// neither -- and so it CANNOT answer `partial`, which is a fact about the tree
	// below the root. A root whose scan is `partial` answers `read` here. That is
	// not a bug to be fixed by walking the tree on every call; it is a boundary
	// that has to be named, because a caller that treats this as "the session
	// dimension was compared" will report a partial scan as a complete one.
	// Use readSessions().state for that question; use this only when the question
	// is about the path itself.
	if (!isDirectory(path)) return "missing";
	try {
		readdirSync(path);
		return "read";
	} catch {
		return "unreadable";
	}
}

/**
 * Read the other sessions' workspaces, and report *how* the read went.
 *
 * "Unreadable" and "empty" are different facts, and conflating them is the
 * failure this function exists to prevent: a bare `catch { return [] }` reports
 * every recorded pointer as removed, which reads as "eight sessions deleted
 * their workspaces", and it lets `--write` persist a packet with zero sessions
 * over one that had thirty-four artifacts. A directory that stats but cannot be
 * listed (mode, ACL, a sandbox) is exactly that case, so the state is returned
 * instead of being inferred from an empty array.
 */
/**
 * Every value `readSessions().state` can take, in one place.
 *
 * The card generator's prose explains these names to a reader who never ran the
 * check, and its test pins them -- but hand-written prose cannot be checked
 * against a resolver it does not consult, so a fifth state would be added here
 * and explained nowhere. Exporting the set is what lets that test iterate the
 * vocabulary instead of transcribing it.
 */
export const WORKERS_ROOT_STATES = ["read", "partial", "missing", "unreadable"];

/**
 * The subset of `WORKERS_ROOT_STATES` that a *path* can be in, which
 * `workersRootState` answers: everything except `partial`. Exported so the two
 * vocabularies are nameable instead of confusable -- the difference between them
 * is exactly one value, and it is the one that decides whether a scan was a
 * complete comparison or only part of one.
 */
export const WORKERS_ROOT_PATH_STATES = ["read", "missing", "unreadable"];

export function readSessions(workersRoot) {
	let names;
	try {
		names = readdirSync(workersRoot).sort();
	} catch (error) {
		const state = error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : "unreadable";
		return { state, detail: error?.code ?? error?.message ?? "unknown", sessions: [] };
	}
	const scanned = collectSessionsAt(workersRoot, names);
	// A root that listed is not the same as a tree that was read. One nested
	// directory that lists to its parent but not to this process used to throw out
	// of the scan entirely: every readable session was lost with it and the CLI
	// exited 1 -- the drift code -- with a stack trace, so an operator read "a
	// pointer moved" where the truth was "a permission stopped the listing". The
	// readable sessions are kept, the unreadable ones are named, and the state
	// says the dimension is partial instead of pretending it is whole.
	return {
		state: scanned.unreadable.length === 0 ? "read" : "partial",
		detail: null,
		sessions: scanned.sessions,
		...(scanned.unreadable.length > 0 ? { unreadable_sessions: scanned.unreadable } : {}),
	};
}

/**
 * A missing root scans as zero sessions. Writing that would erase live pointers
 * from the index and call the result a snapshot, so a write that would drop a
 * populated session list is refused instead.
 */
/**
 * Write a file so that no reader can observe it half-written.
 *
 * writeFileSync truncates in place, and these artifacts are read by other sessions
 * while this writer runs: a reader that lands in the window parses a partial JSON
 * document and cannot tell that from an index that was published broken. That is not
 * hypothetical -- a peer read a half-saved *source* file at 05:20:50 and got a
 * SyntaxError from a script that was merely mid-save. `rename(2)` inside one directory
 * is atomic, so the swap is the only step a reader can see: the old bytes or the new
 * ones. fsync before it, so a crash cannot publish the truncated copy either.
 *
 * The mode is taken from the existing target, because a plain write preserves it and a
 * rename does not. That is load-bearing for the spawn card: it is 0600 by contract and
 * the daemon refuses anything group- or world-readable, so a swap that dropped the mode
 * would silently disable the orientation the card exists to inject.
 */
export function writeFileAtomic(path, contents, { mode } = {}) {
	const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
	let target = mode;
	if (target === undefined) {
		// A new file lets the umask decide, exactly as a plain write would; an existing
		// one keeps the mode it already had.
		try {
			target = statSync(path).mode & 0o777;
		} catch {
			target = undefined;
		}
	}
	const fd = target === undefined ? openSync(temp, "w") : openSync(temp, "w", target);
	try {
		writeFileSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// The create mode is masked by the umask, so an existing mode is forced back on.
	if (target !== undefined) chmodSync(temp, target);
	try {
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Nothing left to clean up.
		}
		throw error;
	}
	return { bytes: Buffer.byteLength(contents, "utf8") };
}

export function writeRefusal({ rootPresent, rootComplete = rootPresent, unreadableSessions = [], rootChanged = false, existing, next }) {
	const indexed = existing?.totals?.session_artifacts ?? 0;
	if (rootChanged && indexed > 0) {
		return `refusing to write: this scan resolved the session root to ${next?.machine_local?.workers_root ?? "(unknown)"}, but ${PACKET_PATH} recorded ${existing?.machine_local?.workers_root ?? "(unknown)"} with ${indexed} artifacts.\n  A different root is a different world, so writing would replace real coverage with a scan of somewhere else. Pass --workers-root or set UCTM_WORKERS_ROOT to read the recorded root.`;
	}
	if (!rootPresent) {
		if (indexed > 0 && (next?.totals?.session_artifacts ?? 0) === 0) {
			return `refusing to write: ${PACKET_PATH} records ${indexed} session artifacts and this scan found none, because the session root could not be read.\n  Writing would erase pointers that are still on disk. Pass --workers-root or set UCTM_WORKERS_ROOT, then re-run --write.`;
		}
		return null;
	}
	// A root that listed is not a tree that was read. A partial scan keeps the
	// readable sessions, so the "found none" guard above stays silent while the
	// unreadable sessions' pointers quietly disappear from the packet -- the same
	// erasure, one directory deeper. Refuse on the pointers that would go missing,
	// named, and let a complete scan or a fixed permission make the write possible.
	if (!rootComplete) {
		const unreadableNames = [...new Set(unreadableSessions)].sort();
		const stranded = (existing?.sessions ?? [])
			.filter((session) => unreadableNames.includes(session.session))
			.reduce((sum, session) => sum + (session.artifacts?.length ?? 0), 0);
		if (stranded > 0) {
			return `refusing to write: this scan could not read ${unreadableNames.length} session workspace(s) in full -- ${unreadableNames.join(", ")} -- and ${PACKET_PATH} records ${stranded} artifact pointer(s) inside them.\n  Writing would drop pointers that are still on disk. Fix the permission (or pass --workers-root for a complete root), then re-run --write.`;
		}
	}
	return null;
}

function digestFile(absPath) {
	const bytes = readFileSync(absPath);
	return { bytes: bytes.length, sha256: sha256OfBytes(bytes), text: bytes.length < 400_000 ? bytes.toString("utf8") : null };
}

/** Every declared document under docs/uctm, as a pointer plus its own declared fields. */
export function collectDocuments(root) {
	const dir = join(root, "docs", "uctm");
	const documents = [];
	for (const name of readdirSync(dir).sort()) {
		if (DERIVED_INDEX_NAMES.has(name)) continue;
		if (name.endsWith(".pre-reconcile-20260918")) continue;
		if (!name.endsWith(".md") && !name.endsWith(".json")) continue;
		const abs = join(dir, name);
		if (!statSync(abs).isFile()) continue;
		const file = digestFile(abs);
		const entry = {
			path: `docs/uctm/${name}`,
			role: classifyDocument(name),
			bytes: file.bytes,
			sha256: file.sha256,
		};
		if (name.endsWith(".md") && file.text !== null) {
			entry.title = extractTitle(file.text);
			const statuses = extractStatuses(file.text);
			if (statuses.length > 0) entry.status = statuses[0].status;
			// More than one declared status is only useful with its heading.
			if (statuses.length > 1) entry.statuses = statuses;
			const nextGate = extractSection(file.text, "Next gate");
			if (nextGate.length > 0) entry.next_gate = nextGate;
		}
		if (name.endsWith(".json") && file.text !== null) {
			const parsed = JSON.parse(file.text);
			if (typeof parsed.status === "string") entry.status = parsed.status;
			if (typeof parsed.safe_claim === "string") entry.safe_claim = parsed.safe_claim;
			if (Array.isArray(parsed.forbidden_claims)) entry.forbidden_claims = parsed.forbidden_claims;
			if (Array.isArray(parsed.authority_invariants)) entry.authority_invariants = parsed.authority_invariants;
			if (Array.isArray(parsed.domains)) {
				entry.readiness = parsed.domains.map((d) => ({ domain: d.domain, status: d.status }));
			}
			if (parsed.known_failures) entry.known_failures = parsed.known_failures;
		}
		documents.push(entry);
	}
	return documents;
}

/**
 * A session may declare which files in its own workspace are *regenerated by a
 * tool* rather than authored. The declaration lives in that session's workspace,
 * so the producing session owns the judgement and no other session has to guess:
 *
 *   { "volatile": ["verification/evidence-pipeline-receipt.json", "derived/"] }
 *
 * An exact path matches one file; a trailing slash matches a directory prefix.
 * A declared file keeps its identity -- it is still listed, still counted, and its
 * appearance or disappearance still moves orientation_id -- but its *content*
 * leaves the identity and is recorded as an observation instead. Without that
 * split, a generator that stamps a clock into its output invalidates the index on
 * every run: the index would report a rewrite the tooling caused rather than a
 * change in the world, and the honest workflow would become "run the guards, then
 * --write", forever, with the spawn card's comparand stale in between.
 *
 * A declaration naming a path that does not exist is recorded loudly rather than
 * ignored. A declaration entry that can never match looks exactly like one that
 * matches, which is how a rename silently un-pins the wrong thing.
 */
export const VOLATILE_DECLARATION = "volatile.json";

/** Read one session's volatile declaration. Absence is not an error; malformation is recorded. */
export function readVolatileDeclaration(sessionRoot) {
	let text;
	try {
		text = readFileSync(join(sessionRoot, VOLATILE_DECLARATION), "utf8");
	} catch {
		return { declared: [], present: false };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { declared: [], present: true, error: "unparseable_json" };
	}
	if (!Array.isArray(parsed?.volatile)) return { declared: [], present: true, error: "no_volatile_array" };
	return { declared: parsed.volatile.map((entry) => String(entry)).filter(Boolean), present: true };
}

/** Exact path, or a directory prefix when the declaration entry ends in a slash. */
export function matchesVolatileDeclaration(path, entry) {
	return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

/** "## 10. Next actions" from the connection plan: one declared list, read once. */
export function collectNextActions(root) {
	const plan = readFileSync(join(root, "docs", "uctm", "CONNECTION_PLAN_2026-09-18.md"), "utf8");
	return extractSection(plan, "10. Next actions");
}

/**
 * Other sessions' workspaces, as pointers only. Kept as the plain accessor so
 * existing callers and tests keep working; use readSessions() when the *state* of
 * the read matters, which it does for every drift decision.
 */
export function collectSessions(workersRoot) {
	return readSessions(workersRoot).sessions;
}

function collectSessionsAt(workersRoot, names) {
	const sessions = [];
	const unreadable = [];
	for (const name of names) {
		const sessionRoot = join(workersRoot, name);
		let stats;
		try {
			stats = statSync(sessionRoot);
		} catch (error) {
			// A name the listing returned that this process cannot stat: it is in the
			// directory and invisible to the reader. Recorded as unknown for that
			// session rather than dropped, for the same reason the root is.
			sessions.push({ session: name, state: "unreadable", detail: error?.code ?? "unknown", artifacts: [], pointed_bytes: 0 });
			unreadable.push(name);
			continue;
		}
		if (!stats.isDirectory()) continue;
		const artifacts = [];
		const unreadableDirs = [];
		const skippedNames = new Set();
		let skippedLarge = 0;
		const walk = (dir, depth) => {
			if (depth > SESSION_SCAN_DEPTH) return;
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
			} catch (error) {
				// The failure is named on the session and the rest of the tree is still
				// read. It is never swallowed: an unreadable subtree whose pointers were
				// recorded would otherwise be diffed as "every artifact in it was
				// deleted", which is the false-drift class this file exists to end.
				unreadableDirs.push({ path: relative(sessionRoot, dir) || ".", detail: error?.code ?? "unknown" });
				return;
			}
			for (const entry of entries) {
				if (SESSION_SKIP.has(entry.name)) {
					// Recorded, not dropped: the name set is structure and stable, so a
					// new cache tree appearing in a workspace moves the address -- which
					// is right, an unindexed opaque tree is news -- while re-installing
					// dependencies does not, because only the name is kept.
					skippedNames.add(entry.name);
					continue;
				}
				const abs = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(abs, depth + 1);
					continue;
				}
				if (!entry.isFile()) continue;
				let size;
				try {
					size = statSync(abs).size;
				} catch (error) {
					// Vanished between the listing and the stat: a race, not a deletion to
					// report. Named so the session is not called complete.
					unreadableDirs.push({ path: relative(sessionRoot, abs), detail: error?.code ?? "unknown" });
					continue;
				}
				if (size > MAX_ARTIFACT_BYTES) {
					skippedLarge += 1;
					continue;
				}
				let file;
				try {
					file = digestFile(abs);
				} catch (error) {
					unreadableDirs.push({ path: relative(sessionRoot, abs), detail: error?.code ?? "unknown" });
					continue;
				}
				const artifact = { path: relative(sessionRoot, abs), bytes: file.bytes, sha256: file.sha256 };
				if (entry.name.endsWith(".md") && file.text !== null) {
					artifact.title = extractTitle(file.text);
					artifact.status = extractStatus(file.text);
				}
				artifacts.push(artifact);
			}
		};
		walk(sessionRoot, 1);
		const declaration = readVolatileDeclaration(sessionRoot);
		for (const artifact of artifacts) {
			if (declaration.declared.some((entry) => matchesVolatileDeclaration(artifact.path, entry))) artifact.volatile = true;
		}
		const declaredMissing = declaration.declared.filter(
			(entry) => !artifacts.some((artifact) => matchesVolatileDeclaration(artifact.path, entry)),
		);
		sessions.push({
			session: name,
			...(unreadableDirs.length > 0 ? { state: "unreadable", unreadable_dirs: unreadableDirs } : {}),
			...(skippedNames.size > 0 ? { skipped_names: [...skippedNames].sort() } : {}),
			artifacts,
			pointed_bytes: artifacts.reduce((sum, a) => sum + a.bytes, 0),
			...(declaredMissing.length > 0 ? { volatile_declaration_missing: declaredMissing } : {}),
			...(declaration.error ? { volatile_declaration_error: declaration.error } : {}),
			...(skippedLarge > 0 ? { skipped_large_files: skippedLarge } : {}),
		});
		if (unreadableDirs.length > 0) unreadable.push(name);
	}
	return { sessions, unreadable };
}

/**
 * The shared checkout's dirty set, content-addressed. The point is not the file
 * list -- `git status` prints that -- it is that the list has a digest, so
 * "has anyone touched anything since I last oriented?" is one comparison.
 */
export function buildWorktreeState({ branch, head, entries }) {
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
	return { branch, head, dirty_count: sorted.length, dirty_id: digestOf(sorted), dirty: sorted };
}

export function collectWorktree(root, execGit) {
	const branch = execGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	const head = execGit(["rev-parse", "HEAD"]).trim();
	const raw = execGit(["status", "--porcelain=v1", "-z"]);
	const entries = [];
	const seen = new Set();
	for (const record of raw.split("\0")) {
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (seen.has(path)) continue;
		seen.add(path);
		// Same rule as the document scan, stated the way the kernel states it: a
		// derived index is not an input to a derived index. Skipping it from the
		// dirty set -- and not merely from the hash -- is what makes that true.
		// While it was listed as `self: true` it still entered `dirty`,
		// `dirty_count` and `dirty_id`, all of which sit inside orientation_id, so
		// writing the packet moved the packet's own content address and the next
		// `--check` blamed "the worktree dirty set" for an edit the tool had just
		// made itself. A drift report that explains its own writes is the same
		// false-signal class this file exists to end. The test is `isDerivedIndexPath`
		// rather than an exact-path list because the writer's own in-flight copy --
		// `.<index>.tmp-<pid>` -- is the same non-input listed under a name that
		// changes per process; an exact-path filter excludes the finished index and
		// lets its half-written twin through.
		if (isDerivedIndexPath(path)) continue;
		const entry = { status: status.trim() || status, path };
		try {
			const abs = join(root, path);
			if (statSync(abs).isFile() && statSync(abs).size <= MAX_ARTIFACT_BYTES) {
				entry.sha256 = sha256OfBytes(readFileSync(abs));
			}
		} catch {
			// A deletion has no bytes to hash; the status code carries that fact.
		}
		entries.push(entry);
	}
	return buildWorktreeState({ branch, head, entries });
}

export function buildPacket(root, workersRoot, now = new Date().toISOString()) {
	const observed = readSessions(workersRoot);
	return buildOrientation({
		generatedAt: now,
		documents: collectDocuments(root),
		sessions: observed.sessions,
		worktree: collectWorktree(root, (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })),
		nextActions: collectNextActions(root),
		machineLocal: {
			// The resolved root, not the intended one. A reader of the packet can
			// then tell "this scan had no root" from "the sessions are gone".
			workers_root: workersRoot,
			// read | partial | missing | unreadable. "missing" is a fact about this
			// machine; "unreadable" is a fact about this process; "partial" is a fact
			// about one entry inside a root that did list. All three stop a run from
			// writing a session-less packet, and "partial" additionally names the
			// sessions whose pointers this scan could not check.
			workers_root_state: observed.state,
			...(observed.detail ? { workers_root_detail: observed.detail } : {}),
			...(observed.unreadable_sessions ? { unreadable_sessions: observed.unreadable_sessions } : {}),
			note: "Session workspaces are machine-local. The list is an observation of what has been written, not a roster of who is running.",
		},
	});
}

function readPacket(root) {
	try {
		return JSON.parse(readFileSync(join(root, PACKET_PATH), "utf8"));
	} catch {
		return null;
	}
}

function printBrief(packet) {
	const lines = [
		`orientation_id  ${packet.orientation_id}`,
		`generated_at    ${packet.generated_at}`,
		`worktree        ${packet.worktree.branch} @ ${packet.worktree.head.slice(0, 12)}, ${packet.worktree.dirty_count} dirty (${packet.worktree.dirty_id.slice(0, 23)}…)`,
		`documents       ${packet.totals.documents} (${packet.totals.pointed_bytes} bytes pointed at)`,
		`sessions        ${packet.totals.sessions} with ${packet.totals.session_artifacts} artifacts`,
		"",
		"declared state:",
	];
	for (const doc of packet.documents) {
		if (!doc.status) continue;
		lines.push(`  ${doc.path}  [${doc.role}]`);
		if (doc.statuses) {
			for (const entry of doc.statuses) lines.push(`    ${entry.section ? `${entry.section}: ` : ""}${entry.status.slice(0, 200)}`);
		} else {
			lines.push(`    ${doc.status.slice(0, 260)}`);
		}
	}
	lines.push("", `next actions: ${packet.next_actions.length} declared list lines from the plan's own section`);
	// The count is markdown lines, not tasks: extractSection flattens indentation, so a
	// numbered item with twelve sub-bullets contributes thirteen. A reader sizing work from
	// the number is reading one document's sub-bullet shape, which is why the label says
	// what it counts instead of leaving it to be inferred.
	lines.push("  (sub-bullets are flattened into that count, so it measures list lines rather than tasks)");
	return lines.join("\n");
}

/**
 * `root` is a parameter rather than a constant so a test can run the whole CLI
 * against a fixture repo. It is deliberately not a flag: a caller who can point
 * the index anywhere can point it at the wrong world.
 */
export function main(argv, env = process.env, root = fileURLToPath(new URL("..", import.meta.url))) {
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
	const namedRoot = args.get("workers-root");
	const explicitRoot = (namedRoot !== undefined && namedRoot !== true) || Boolean(env && env.UCTM_WORKERS_ROOT);
	const workersRoot = resolveWorkersRoot(namedRoot === true ? undefined : namedRoot, env);
	const packet = buildPacket(root, workersRoot);
	// read | missing | unreadable -- recorded in the packet, so a reader can tell
	// "this scan had no root" from "the sessions are gone", and so a drift report
	// can say which of its dimensions it actually compared.
	const rootState = packet.machine_local.workers_root_state;
	const unreadableSessions = packet.machine_local.unreadable_sessions ?? [];
	if (rootState === "partial") {
		process.stderr.write(
			`warning: session workspace root is partial: ${workersRoot}\n` +
				`  ${unreadableSessions.length} session workspace(s) could not be read in full: ${unreadableSessions.join(", ")}\n` +
				"  Their recorded pointers are unknown to this run, never removed, and --write refuses while it\n" +
				"  would drop pointers inside them. Fix the permission, or pass --workers-root.\n",
		);
	} else if (rootState !== "read") {
		process.stderr.write(
			`warning: session workspace root is ${rootState}: ${workersRoot}\n` +
				"  Session pointers are unavailable to this process. They are reported as unknown, never as\n" +
				"  removed. Run with --where to see every candidate that was tried.\n" +
				"  Pass --workers-root <dir> or set UCTM_WORKERS_ROOT if the sessions live elsewhere.\n",
		);
	}

	// A rewritten $HOME is the most expensive ambient fact in this repo. `~` resolves
	// into the harness home, which is empty, and an empty read is byte-identical to
	// "not configured" -- so a path built from `~` reports a missing file instead of a
	// wrong root, and the session concludes the estate was never set up. This index
	// survives the rewrite, because AO_DATA_DIR outranks both $HOME guesses, and that
	// is exactly why the rewrite has to be said out loud: without this line the run
	// exits 0 with `oriented`, and the rewrite is discovered much later by a command
	// that returned nothing. One line, here, because this is the command sessions run
	// first. It is a warning and never a verdict -- the exit code still reports only
	// what the packet could be compared against.
	const shellHome = env && env.HOME;
	const estateHome = passwdHome();
	if (shellHome && estateHome && shellHome !== estateHome) {
		process.stderr.write(
			`warning: $HOME is rewritten: HOME=${shellHome} estate_home=${estateHome}\n` +
				"  Paths built from `~` resolve into the harness home, which is empty, and an empty read is\n" +
				"  indistinguishable from a missing one. Resolve the estate home from the account database --\n" +
				"  bridge/estate_home.py is the one shared answer -- or set UCTM_ESTATE_HOME, before trusting\n" +
				"  any `~` path in this shell.\n",
		);
	}

	if (args.has("where")) {
		const existingPacket = readPacket(root);
		const recordedRoot = existingPacket?.machine_local?.workers_root ?? null;
		const lines = [
			`resolved root   ${workersRoot}`,
			`state           ${rootState}${packet.machine_local.workers_root_detail ? ` (${packet.machine_local.workers_root_detail})` : ""}`,
			// Zero is a count. "Not read" is not zero, and printing `0 workspaces`
			// beside `state missing` is how a missing root starts reading as an
			// empty one -- the confusion this whole flag exists to end.
			`sessions        ${
				rootState === "read"
					? `${packet.totals.sessions} workspaces, ${packet.totals.session_artifacts} artifacts`
					: rootState === "partial"
						? `${packet.totals.sessions} workspaces, ${packet.totals.session_artifacts} artifacts (partial: ${unreadableSessions.join(", ")} unreadable)`
						: "not read (unknown, not zero)"
			}`,
			"",
			"candidates, in order:",
		];
		for (const candidate of workersRootCandidates({ explicit: namedRoot === true ? undefined : namedRoot, env })) {
			lines.push(`  ${isDirectory(candidate) ? "EXISTS " : "missing"}  ${candidate}`);
		}
		if (recordedRoot !== null) {
			lines.push("", `recorded root   ${recordedRoot}${recordedRoot === workersRoot ? "  (same)" : "  (DIFFERENT: sessions are not comparable)"}`);
		}
		lines.push("", "override with --workers-root <dir> or UCTM_WORKERS_ROOT=<dir>");
		process.stdout.write(`${lines.join("\n")}\n`);
		return rootState === "read" && (recordedRoot === null || recordedRoot === workersRoot) ? 0 : 3;
	}

	if (args.has("write")) {
		const existing = readPacket(root);
		const recordedRoot = existing?.machine_local?.workers_root ?? null;
		const refusal = writeRefusal({
			rootPresent: rootState === "read" || rootState === "partial",
			rootComplete: rootState === "read",
			unreadableSessions,
			// A deliberately named root is honoured even when it differs: the operator
			// said so, and the packet is about to record the new one. A *derived* root
			// that differs means the environment moved underneath the index.
			rootChanged: !explicitRoot && recordedRoot !== null && recordedRoot !== workersRoot,
			existing,
			next: packet,
		});
		if (refusal) {
			process.stderr.write(`${refusal}\n`);
			return 2;
		}
		// Writing an unchanged world must not churn the file: keep the previous
		// timestamp so the artifact is byte-identical, not merely equivalent.
		// "Unchanged" has to mean the whole artifact, not only the address: the
		// observations band is outside the address by design, so a move there would
		// otherwise be written under the old timestamp and reported as byte-identical.
		const out =
			existing && existing.orientation_id === packet.orientation_id && existing.observations?.observed_id === packet.observations?.observed_id
				? { ...packet, generated_at: existing.generated_at }
				: packet;
		writeFileAtomic(join(root, PACKET_PATH), `${JSON.stringify(out, null, 2)}\n`);
		process.stdout.write(`${args.has("json") ? JSON.stringify(out) : printBrief(out)}\n`);
		process.stdout.write(`\nwrote ${PACKET_PATH}\n`);
		return 0;
	}

	if (args.has("check") || args.has("since")) {
		// A packet path that cannot be read is a wrong command, not a moved world. Left
		// to throw, it produced a stack trace and exit 1 -- and exit 1 is the code the
		// spawn card defines as "drift, read only the paths it prints", so a typo
		// impersonated a drift report. Exit 2 already means "refused, the command was
		// wrong" for a refused write, and this is the same kind of answer.
		let previous;
		if (args.get("since") === true || !args.has("since")) {
			previous = readPacket(root);
		} else {
			const sincePath = args.get("since");
			try {
				previous = JSON.parse(readFileSync(sincePath, "utf8"));
			} catch (error) {
				process.stderr.write(`--since ${sincePath}: cannot be read as a packet (${error?.code ?? error?.message ?? "unknown error"})\n`);
				return 2;
			}
		}
		const recordedRoot = previous?.machine_local?.workers_root ?? null;
		const recordedSessions = previous?.sessions?.length ?? 0;
		const rootChanged = recordedRoot !== null && recordedRoot !== workersRoot;
		// The session dimension is comparable only when this run can see the same
		// root the packet recorded. Otherwise it is unknown: diffing it anyway
		// reports every recorded artifact as removed, which is a claim about eight
		// other sessions' work made from a directory listing that never happened.
		const rootUnread = rootState === "missing" || rootState === "unreadable";
		const sessionsComparable = !rootChanged && (!rootUnread || recordedSessions === 0);
		// A partial root is comparable session by session, but the unreadable ones are
		// not: excluding them by name is what keeps "this process could not look" out
		// of the removed list. Only the ones the packet actually records pointers for
		// make the verdict incomplete -- an unreadable session the index never held
		// cannot make the comparison lie.
		const unreadableWithHistory = unreadableSessions.filter((name) =>
			(previous?.sessions ?? []).some((entry) => entry.session === name && (entry.artifacts?.length ?? 0) > 0),
		);
		const diff = diffOrientations(previous, packet, { includeSessions: sessionsComparable, unreadableSessions: unreadableWithHistory });
		if (!sessionsComparable) {
			process.stderr.write(
				`note: session dimension NOT compared (${rootChanged ? "the resolved root differs from the recorded one" : `the root is ${rootState}`})\n` +
					`  resolved ${workersRoot}\n` +
					(recordedRoot === null ? "" : `  recorded ${recordedRoot}\n`),
			);
		}
		if (diff.unchanged) {
			if (!sessionsComparable) {
				// The word `oriented` is the instruction to stop looking. It may only
				// be printed when every dimension in the content address was actually
				// compared, so a shell that could not read the session root says so
				// with a different word instead of borrowing the reader's permission.
				process.stdout.write("incomplete: no indexed document or plan item moved, but the session dimension was not read\n");
				if (diff.worktree_moved) {
					process.stdout.write(
						`  note: the worktree dirty set did move (${diff.worktree_counts.previous ?? "?"} -> ${diff.worktree_counts.current ?? "?"} entries). Sources changed, receipts did not.\n`,
					);
				}
				if (diff.actions_moved) process.stdout.write("  note: the plan's declared next-actions list moved.\n");
				return 3;
			}
			if (unreadableWithHistory.length > 0) {
				process.stdout.write("incomplete: no indexed document or plan item moved, but the session dimension was only partly compared\n");
				process.stdout.write(`  unreadable session workspace(s) the packet records pointers for: ${unreadableWithHistory.join(", ")}\n`);
				return 3;
			}
			process.stdout.write(`oriented: ${packet.orientation_id} (${diff.reason})\n`);
			if (diff.volatile_moved?.length) {
				process.stdout.write(
					`  note: ${diff.volatile_moved.length} declared-volatile artifact(s) moved. The address is unchanged on purpose:\n` +
						"  these are files their own session declared tool-regenerated, so a rewrite is not the world changing shape.\n",
				);
				for (const path of diff.volatile_moved) process.stdout.write(`    volatile ${path}\n`);
				if (args.has("strict")) return 4;
			}
			if (diff.worktree_moved) {
				process.stdout.write(
					`  note: no indexed artifact moved; the worktree dirty set did (${diff.worktree_counts.previous ?? "?"} -> ${diff.worktree_counts.current ?? "?"} entries). Sources changed, receipts did not.\n`,
				);
			}
			if (diff.actions_moved) process.stdout.write("  note: no indexed artifact moved; the plan's declared next-actions list did.\n");
			if (diff.excluded?.length) {
				process.stdout.write(
					`  note: ${diff.excluded.length} previously-indexed path(s) are no longer read by policy. The address is unchanged on purpose:\n` +
						"  an exclusion is the scanner changing what it reads, not the world losing a file.\n",
				);
				for (const path of diff.excluded) process.stdout.write(`    excluded ${path}\n`);
			}
			if (diff.machine_moved) process.stdout.write("  note: no indexed artifact moved; a machine-local field did.\n");
			return 0;
		}
		process.stdout.write(`drift: ${diff.reason}\n`);
		process.stdout.write(`  live:     ${packet.orientation_id}\n  recorded: ${previous?.orientation_id ?? "(none)"}\n`);
		for (const kind of ["changed", "added", "removed"]) {
			for (const path of diff[kind]) process.stdout.write(`  ${kind}  ${path}\n`);
		}
		for (const dimension of diff.dimensions_skipped ?? []) process.stdout.write(`  skipped  ${dimension} (unknown in this shell; not a drift report)\n`);
		for (const path of diff.volatile_moved ?? []) process.stdout.write(`  volatile ${path}  (declared tool-regenerated; named, not counted against the address)\n`);
		for (const path of diff.excluded ?? []) {
			process.stdout.write(`  excluded ${path}  (no longer read by policy; named, not counted as drift)\n`);
		}
		for (const path of diff.reclassified ?? []) {
			process.stdout.write(`  reclassified ${path}  (declared-volatile status changed; named, not counted on its own)\n`);
		}
		return 1;
	}

	if (args.has("json")) {
		process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${printBrief(packet)}\n`);
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
	// Nothing may borrow exit 1. It is the drift code, and the card tells a session
	// that exit 1 prints exactly the paths that moved -- so an uncaught exception
	// exiting 1 is a crash wearing a drift report's clothes, with a stack trace where
	// the path list belongs. A failure of the tool gets its own code, distinct from
	// the whole verdict vocabulary (0 oriented, 1 drift, 2 refused, 3 incomplete,
	// 4 declared-volatile moved).
	//
	// `process.exitCode`, not `process.exit()`. A write to a pipe is asynchronous and
	// process.exit() does not wait for it, so a document larger than one pipe buffer
	// was cut mid-string while the exit code still said 0: complete on a terminal,
	// unparseable through `| jq`, and nothing in the output said which one happened.
	// Setting the code lets stdout drain before the process ends, and it preserves the
	// codes above -- a tool that exited 2 for a refused write must still exit 2.
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`internal: the index failed, so this is not a report about the world\n${error?.stack ?? error}\n`);
		process.exitCode = 70;
	}
}
