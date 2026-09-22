#!/usr/bin/env node
// UCTM intent scorecard -- measure the spine's own declared intentions against
// runtime records, and abstain rather than infer.
//
// Why this exists: the spine service publishes what it can derive and answers 204
// ("no facts") for everything else, because abstention is not emptiness. This
// scorecard holds itself to the same rule. Every intent prints a measured value
// with a status, or `UNKNOWN` plus the reason it could not be read. It never
// prints a zero it did not count.
//
// Usage:
//   node scripts/uctm-intent-scorecard.mjs            # text table
//   node scripts/uctm-intent-scorecard.mjs --json     # machine form
//   node scripts/uctm-intent-scorecard.mjs --deep     # adds the graph --stale scan
//
// Exit vocabulary (this tool's own, not uctm-orient's):
//   0  every measured intent is ok
//   1  at least one warn
//   2  at least one fail
//   3  nothing could be measured (every intent UNKNOWN)
//
// Non-claims: this reads local runtime records only. It cannot see another host,
// and a green line here is not a claim that any task succeeded -- only that the
// stated property holds in the records it could read.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// An AO worker shell rewrites $HOME to the harness home, so paths derived from
// it point at a directory that holds no records. getpwuid answers with the real
// estate home regardless, and --home overrides both. The resolved roots are
// printed in the output, because a path that cannot be read is never reported as
// an empty one.
function estateHome() {
	const flag = process.argv.indexOf("--home");
	if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
	if (process.env.UCTM_ESTATE_HOME) return process.env.UCTM_ESTATE_HOME;
	try {
		const pw = userInfo().homedir;
		if (pw && existsSync(pw)) return pw;
	} catch { /* fall through to $HOME below */ }
	return process.env.HOME || "";
}
const HOME = estateHome();
const DB = join(HOME, ".ao/uctm-studio/data/ao.db");
const ROLLOUTS = join(HOME, ".ao/uctm-studio/codex/sessions");
const PARKS = join(ROOT, "bridge/parks");
const MESSAGE_LOGS = join(HOME, ".openclaw/message-logs");

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const DEEP = args.includes("--deep");

const results = [];
function record(id, claim, status, measured, detail) {
	results.push({ id, claim, status, measured, detail });
}
function unknown(id, claim, reason) {
	record(id, claim, "unknown", null, reason);
}

function sqlite(sql) {
	if (!existsSync(DB)) throw new Error(`no database at ${DB}`);
	return execFileSync("sqlite3", [`file:${DB}?mode=ro`, sql], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000,
	}).trim();
}

function rolloutFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(dir);
	return out.sort();
}

// ---------------------------------------------------------------- transport
function transportIntent() {
	const claim = "Every recorded usage event is the single DeepSeek transport.";
	let rows;
	try {
		rows = sqlite("select model_id, count(*) from model_usage_events group by 1 order by 2 desc;")
			.split("\n").filter(Boolean).map((l) => l.split("|"));
	} catch (err) {
		return unknown("single_provider_deepseek", claim, `usage events unreadable: ${err.message}`);
	}
	if (!rows.length) return unknown("single_provider_deepseek", claim, "no usage events recorded");
	const total = rows.reduce((n, [, c]) => n + Number(c), 0);
	const deepseek = rows.filter(([m]) => /deepseek/i.test(m)).reduce((n, [, c]) => n + Number(c), 0);
	const others = rows.filter(([m]) => !/deepseek/i.test(m));
	const status = others.length === 0 ? "ok" : "fail";
	record("single_provider_deepseek", claim, status, `${deepseek}/${total} events`,
		others.length ? `non-DeepSeek models present: ${others.map(([m, c]) => `${m}(${c})`).join(", ")}`
			: "no second provider in the records");
}

// ------------------------------------------------------------ turn outcomes
function turnIntents() {
	const files = rolloutFiles(ROLLOUTS);
	const claim = "Turns started in Studio reach a completion state.";
	if (!files.length) return unknown("turns_reach_completion", claim, `no rollouts under ${ROLLOUTS}`);

	let started = 0, completed = 0, laundered = 0, unfinishedSessions = new Set();
	const maskedTurns = [];
	const codes = new Map();
	for (const f of files) {
		let s = 0, c = 0;
		let text;
		try { text = readFileSync(f, "utf8"); } catch { continue; }
		for (const raw of text.split("\n")) {
			if (!raw) continue;
			if (raw.includes('"task_started"')) s++;
			if (!raw.includes('"task_complete"')) continue;
			c++;
			let line;
			try { line = JSON.parse(raw); } catch { continue; }
			const payload = line.payload;
			if (!payload || !payload.error) continue;
			// A turn that carries an error but is emitted as task_complete reports a
			// completion shape for a failed turn. The spine's rule 5 says a failed read
			// is reported, not hidden; this is that rule measured on the runtime.
			laundered++;
			const msg = String(payload.error.message || "");
			const code = (msg.match(/"error":"([a-z_]+)"/) || [])[1]
				|| (msg.match(/unexpected status (\d{3})/) || [])[1]
				|| "unclassified";
			codes.set(code, (codes.get(code) || 0) + 1);
			if (payload.turn_id) maskedTurns.push({ turn: payload.turn_id, code });
		}
		started += s; completed += c;
		if (s > c) unfinishedSessions.add(f.split("/").pop().replace(".jsonl", ""));
	}
	const ratio = started ? completed / started : 0;
	const status = ratio >= 0.95 ? "ok" : ratio >= 0.85 ? "warn" : "fail";
	record("turns_reach_completion", claim, status, `${completed}/${started} turns`,
		`${started - completed} turn(s) never marked complete across ${unfinishedSessions.size} of ${files.length} session(s)`);

	return { unfinishedSessions, files, maskedTurns, codes };
}

// ------------------------------------------------------------------ failure
// The provider writes the failure in a completion shape; that record cannot be
// rewritten from here. What the estate controls is whether the failure is LEFT
// masked. So the intent is coverage, not the absence of failures: every masked
// turn must be answered by a resume packet naming it.
function maskedFailureIntent(maskedTurns, codes) {
	const claim = "A failed turn is reported, not left masked behind a completion shape.";
	const summary = codes && codes.size
		? [...codes.entries()].map(([k, v]) => `${k}(${v})`).join(", ")
		: "none";
	if (!maskedTurns || maskedTurns.length === 0) {
		record("failure_not_masked", claim, "ok", "0 masked failures",
			"no completion event carried an error in the records read");
		return;
	}
	let receipts = [];
	if (existsSync(PARKS)) {
		receipts = readdirSync(PARKS).filter((f) => f.endsWith(".json"))
			.map((f) => join(PARKS, f));
	}
	if (!receipts.length) {
		record("failure_not_masked", claim, "fail", `${maskedTurns.length} masked failure(s)`,
			`no resume packets exist under ${PARKS}; codes: ${summary}`);
		return;
	}
	const bodies = [];
	for (const p of receipts) {
		try { bodies.push(readFileSync(p, "utf8")); } catch { /* unreadable packet */ }
	}
	const covered = maskedTurns.filter((t) => bodies.some((b) => b.includes(t.turn)));
	const status = covered.length === maskedTurns.length ? "ok" : "fail";
	record("failure_not_masked", claim, status,
		`${covered.length}/${maskedTurns.length} masked failure(s) receipted`,
		`error codes: ${summary}; a resume packet names the session and turn it answers`);
}

// -------------------------------------------------------------- orientation
function orientationIntent(fileCount) {
	const claim = "Orientation is injected at spawn, not re-typed into task briefs.";
	const files = rolloutFiles(ROLLOUTS);
	if (!files.length) return unknown("orientation_not_re_derived", claim, "no rollouts to scan");
	let briefs = 0, total = 0;
	for (const f of files) {
		let text;
		try { text = readFileSync(f, "utf8"); } catch { continue; }
		for (const raw of text.split("\n")) {
			if (!raw.includes('"role":"user"')) continue;
			total++;
			if (/uctm-orient\.mjs|uctm-graph\.mjs/.test(raw)) briefs++;
		}
	}
	record("orientation_not_re_derived", claim, total && briefs / total > 0.2 ? "warn" : "ok",
		`${briefs}/${total} user briefs repeat an orient/graph command`,
		"the intent is zero: the orientation is a spawn-time fact");
}

// ------------------------------------------------------------------ handoff
// Two artifact types live in bridge/parks/, and only one of them is a handoff.
// A handoff declares `handoff_id` and is checked against
// docs/uctm/handoff-packet.schema.json. A park card is the Garden's card shape:
// the product reads name/created/status/state/blocked_on_mo/next/wave/tier in
// backend/internal/service/parks/service.go and has no notion of `objective`,
// `next_prompt` or `stop_condition` at all. Checking every *.json against the
// handoff schema therefore reported 56 invalid packets that were never packets,
// and reported them as failing a contract none of them claims -- the same error
// as reading a handoff as a card. Each file is now measured against what it says
// it is, and both populations stay counted, because dropping the cards out of the
// report would be its own silence.
function isHandoffPacket(body) {
	return typeof body?.handoff_id === "string" && body.handoff_id.length > 0;
}

// A card is read by backend/internal/service/parks/service.go, which skips a file
// that does not parse and falls back to the filename for an empty name -- so a
// parse failure is the only way a card is invisible in the Garden. That is the
// whole contract, and it is checked as written rather than tightened here.
function cardIntent(cards) {
	const claim = "Every parked idea is readable as a card by the product that lists it.";
	if (!cards.length) return unknown("park_cards_readable", claim, `no park cards under ${PARKS}`);
	const unreadable = [];
	for (const p of cards) {
		let body;
		try { body = JSON.parse(readFileSync(p, "utf8")); } catch { unreadable.push(p.slice(p.lastIndexOf("/") + 1)); continue; }
		if (!body || typeof body !== "object" || Array.isArray(body)) unreadable.push(p.slice(p.lastIndexOf("/") + 1));
	}
	record("park_cards_readable", claim, unreadable.length ? "warn" : "ok",
		`${cards.length - unreadable.length}/${cards.length} card(s) parse`,
		unreadable.length
			? `the product skips these silently, so they are absent from the Garden: ${unreadable.slice(0, 6).join(", ")}`
			: "cards are not handoff packets and are not checked against docs/uctm/handoff-packet.schema.json");
}

function handoffIntent(unfinishedSessions) {
	const claim = "Every session ends with a packet the next session can start from.";
	// The caller hands in a Set, which is iterable but has `size` rather than
	// `length` -- so the denominator is taken from a copy instead of from whichever
	// of the two the author happened to remember.
	const pending = [...unfinishedSessions];
	let files = [];
	if (existsSync(PARKS)) {
		files = readdirSync(PARKS).filter((f) => f.endsWith(".json")).map((f) => join(PARKS, f));
	}
	if (!files.length) return unknown("handoff_packet_coverage", claim, `no packets under ${PARKS}`);

	const packets = [], cards = [];
	for (const p of files) {
		let body = null;
		try { body = JSON.parse(readFileSync(p, "utf8")); } catch { /* an unreadable file is counted as a card, and reported there */ }
		if (isHandoffPacket(body)) packets.push(p); else cards.push(p);
	}

	let valid = 0, invalid = 0, covering = 0;
	const missing = new Map();
	const sessionIds = new Set();
	// Session ids are read from every file, handoff or card: a card can name the
	// session it parks, and coverage is about which sessions are named, not about
	// which artifact type did the naming.
	for (const p of files) {
		let body = "";
		try { body = readFileSync(p, "utf8"); } catch { continue; }
		for (const m of body.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
			sessionIds.add(m[0]);
		}
	}
	for (const p of packets) {
		try {
			execFileSync("python3", [join(ROOT, "bridge/validate_handoff.py"), p],
				{ stdio: "ignore", timeout: 20_000 });
			valid++;
		} catch (err) {
			invalid++;
			const out = String(err.stdout || "");
			for (const m of out.matchAll(/missing required key:\s*([\w.]+)/g)) {
				missing.set(m[1], (missing.get(m[1]) || 0) + 1);
			}
		}
	}
	let named = 0;
	for (const s of pending) {
		// rollout filenames end in the native session id; match on the tail.
		// One named session counts once: adding a match per id inside this loop let
		// a session named twice be counted twice, so the total could exceed the
		// number of sessions it claims to cover.
		const tail = s.split("-").slice(-1)[0];
		for (const id of sessionIds) if (id.endsWith(tail) || s.includes(id)) { named++; break; }
	}
	covering = named;
	const status = valid === 0 ? "fail" : invalid === 0 ? "ok" : "warn";
	const worst = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
		.map(([k, v]) => `${k}(${v})`).join(", ");
	record("handoff_packet_coverage", claim, status,
		`${valid} valid / ${invalid} invalid handoff packet(s), of ${files.length} file(s) under parks`,
		`${cards.length} park card(s) are not handoffs and are measured separately; ` +
		`${covering} of ${pending.length} unfinished session(s) named in a packet` +
		(worst ? `; most-missing keys: ${worst}` : ""));

	cardIntent(cards);
}

// ------------------------------------------------------------ voice intake
function intakeIntent() {
	const claim = "A voice note reaches the record as the words that were said.";
	if (!existsSync(MESSAGE_LOGS)) {
		return unknown("voice_intake_hygiene", claim, `no message logs at ${MESSAGE_LOGS} on this host`);
	}
	let blocks = 0, noisy = 0, wrapped = 0;
	const files = readdirSync(MESSAGE_LOGS).filter((f) => f.endsWith(".jsonl"));
	for (const name of files) {
		let text;
		try { text = readFileSync(join(MESSAGE_LOGS, name), "utf8"); } catch { continue; }
		for (const raw of text.split("\n")) {
			if (!raw.includes("Transcript:")) continue;
			blocks++;
			if (raw.includes("[message_id:")) noisy++;
			if (/transcript of the audio|here'?s a transcript|Here'?s a transcript/i.test(raw)) wrapped++;
		}
	}
	if (!blocks) return unknown("voice_intake_hygiene", claim, "no transcript blocks found");
	const dirty = (noisy + wrapped) / blocks;
	record("voice_intake_hygiene", claim, dirty > 0.5 ? "fail" : dirty > 0 ? "warn" : "ok",
		`${blocks} transcript block(s)`,
		`${noisy} carry inline metadata, ${wrapped} carry an agent wrapper as content`);
}

// -------------------------------------------------------- evidence staleness
function stalenessIntent() {
	const claim = "The evidence kernel's pointers still resolve to the same content.";
	if (!DEEP) return unknown("evidence_kernel_staleness", claim, "not requested; re-run with --deep");
	try {
		const out = execFileSync("node", [join(ROOT, "scripts/uctm-graph.mjs"), "--stale"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, cwd: ROOT });
		const stale = (out.match(/(\d+)\s+stale/i) || [])[1];
		record("evidence_kernel_staleness", claim, stale && stale !== "0" ? "warn" : "ok",
			`${stale ?? "no count"} stale`, out.trim().split("\n").slice(0, 2).join(" "));
	} catch (err) {
		unknown("evidence_kernel_staleness", claim, `scan failed: ${err.message.split("\n")[0]}`);
	}
}

function main() {
	transportIntent();
	const { unfinishedSessions = new Set(), maskedTurns = [], codes } = turnIntents() || {};
	maskedFailureIntent(maskedTurns, codes);
	orientationIntent();
	handoffIntent(unfinishedSessions);
	intakeIntent();
	stalenessIntent();

	if (AS_JSON) {
		console.log(JSON.stringify({
			schema: "uctm.intent-scorecard.v0",
			generated_at: new Date().toISOString(),
			root: ROOT,
			results,
		}, null, 2));
	} else {
		const w = Math.max(...results.map((r) => r.id.length));
		console.log("UCTM intent scorecard -- measured from local runtime records\n");
		for (const r of results) {
			const mark = { ok: "ok  ", warn: "warn", fail: "FAIL", unknown: "????" }[r.status];
			console.log(`  ${mark}  ${r.id.padEnd(w)}  ${r.measured ?? "unknown"}`);
			console.log(`        ${r.claim}`);
			console.log(`        ${r.detail}\n`);
		}
		const n = (s) => results.filter((r) => r.status === s).length;
		console.log(`  ${n("ok")} ok, ${n("warn")} warn, ${n("fail")} fail, ${n("unknown")} unknown`);
	}

	const n = (s) => results.filter((r) => r.status === s).length;
	if (n("fail")) process.exit(2);
	if (n("warn")) process.exit(1);
	if (n("ok") === 0) process.exit(3);
	process.exit(0);
}

main();
