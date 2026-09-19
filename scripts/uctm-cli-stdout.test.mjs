// The CLI's stdout must survive a pipe.
//
//   node --test scripts/*.test.mjs
//
// `--json` exists so that a machine can consume the packet, and a machine consumes
// it through a pipe. `process.exit()` does not wait for asynchronous writes, and on
// POSIX a write to a pipe is asynchronous while a write to a file or a terminal is
// not -- so the same command printed a complete document to a terminal and a
// document cut mid-string into `| jq`, with exit 0 either way.
//
// The first test below asserts nothing about any size. It runs one command twice,
// changing only what stdout *is* -- a pipe in one case, an open file in the other --
// and requires the bytes to match. A second test guards the guard: if the payload
// ever shrinks below one pipe buffer the first test still passes, and it would then
// be passing for a reason that has nothing to do with the defect it was written for.
//
// The suite could not see this before because every fixture it runs the real CLI
// against produces a few kilobytes, and the boundary is 64 KiB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PIPE_BUFFER = 65536;
const CLIS = ["uctm-orient.mjs", "uctm-graph.mjs"];

// How many piped runs the completeness arm repeats. The truncation is a race
// between the write draining and the process being killed, so a single run is not
// a reliable detector: measured against the pre-fix entry block, `graph --json`
// produced a complete document in 0 of 240 runs, but `uctm-orient.mjs` did so in
// 6 of 240 (2.5%) -- that run simply got scheduled long enough to flush. One green
// run therefore has a ~2.5% chance of being a false pass, which is the failure this
// arm exists to catch, so it repeats. Five runs put the chance near 1e-9.
const PIPE_RUNS = 5;

/**
 * Run a CLI twice with everything held constant except the type of stdout: `toFile`
 * redirects into an open file descriptor (a synchronous write), and omitting it
 * leaves stdout a pipe (an asynchronous one, which `process.exit` can abandon).
 * The timeout is not decoration -- a fix that keeps the event loop alive to flush
 * would hang instead of truncating, and a hang has to fail rather than stall.
 */
function capture(argv, { toFile } = {}) {
	const options = { cwd: REPO_ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 };
	if (toFile) {
		const fd = openSync(toFile, "w");
		try {
			const run = spawnSync(process.execPath, argv, { ...options, stdio: ["ignore", fd, "pipe"] });
			return { status: run.status, signal: run.signal, error: run.error ?? null, stdout: "", stderr: run.stderr ?? "" };
		} finally {
			closeSync(fd);
		}
	}
	const run = spawnSync(process.execPath, argv, options);
	return { status: run.status, signal: run.signal, error: run.error ?? null, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function tempFile() {
	const dir = mkdtempSync(join(tmpdir(), "uctm-stdout-"));
	return { path: join(dir, "out.json"), dir };
}

for (const cli of CLIS) {
	// The load-bearing claim, and the one truncation cannot satisfy: a document cut
	// mid-string does not parse, whatever the world is doing. This arm asserts
	// nothing about the size of anything, so a concurrent writer cannot make it fail
	// and cannot make it pass for the wrong reason.
	test(`${cli} --json survives a pipe as a complete JSON document`, (t) => {
		const sizes = [];
		for (let run = 1; run <= PIPE_RUNS; run += 1) {
			const piped = capture(["scripts/" + cli, "--json"]);
			assert.equal(piped.error, null, `piped run ${run} failed: ${piped.error?.message}`);
			assert.equal(piped.status, 0, `piped run ${run} exited ${piped.status}`);
			sizes.push(piped.stdout.length);
			// Named by run, because "the document was complete" and "one of five runs
			// dropped bytes" are different results and only the second one is the bug.
			assert.doesNotThrow(
				() => JSON.parse(piped.stdout),
				`piped stdout of run ${run} of ${PIPE_RUNS} is not a complete JSON document`,
			);
		}
		t.diagnostic(`piped payload sizes ${sizes.join(", ")}`);
		assert.ok(
			Math.min(...sizes) > PIPE_BUFFER,
			`the smallest piped payload was ${Math.min(...sizes)} bytes, under the ${PIPE_BUFFER}-byte buffer, so this arm cannot exercise the boundary it guards`,
		);
	});

	// The general claim: the destination must not change the bytes. Two things make a
	// naive byte comparison wrong here, and both are named rather than tolerated.
	//
	// `generated_at` is stamped per run, so two runs of the same command are *never*
	// byte-identical and the first version of this arm could not pass at all -- it
	// reported "another session wrote", which was false. The field is removed before
	// the comparison. What remains can still differ because the checkout is shared,
	// so the arm is retried; a length difference is the truncation signature and is
	// never retried away.
	test(`${cli} --json writes the same bytes to a pipe as to a file, at rest`, (t) => {
		const { path, dir } = tempFile();
		try {
			const normalized = (text) => {
				const doc = JSON.parse(text);
				delete doc.generated_at;
				return JSON.stringify(doc);
			};
			let equal = false;
			let last = null;
			for (let attempt = 0; attempt < 3 && !equal; attempt += 1) {
				const redirected = capture(["scripts/" + cli, "--json"], { toFile: path });
				const piped = capture(["scripts/" + cli, "--json"]);
				const written = readFileSync(path, "utf8");
				last = { file: written.length, pipe: piped.stdout.length };
				assert.equal(redirected.status, 0, `redirected run exited ${redirected.status}`);
				assert.equal(piped.status, 0, `piped run exited ${piped.status}`);
				assert.equal(
					piped.stdout.length,
					written.length,
					`through a pipe stdout is ${piped.stdout.length} bytes; the same command writing into a file produced ${written.length}` +
						". A destination is not allowed to change how much was written.",
				);
				equal = normalized(piped.stdout) === normalized(written);
			}
			if (equal) t.diagnostic(`identical modulo generated_at at ${last.file} bytes`);
			else
				t.diagnostic(
					`the checkout was written by another session during all three attempts (${JSON.stringify(last)}), ` +
						"so this arm cannot separate churn from loss here; the parse arm above is unaffected",
				);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("the payloads actually cross the pipe boundary, or the guard above is vacuous", (t) => {
	const { path, dir } = tempFile();
	try {
		const sizes = {};
		for (const cli of CLIS) {
			capture(["scripts/" + cli, "--json"], { toFile: path });
			sizes[cli] = readFileSync(path, "utf8").length;
		}
		t.diagnostic(JSON.stringify(sizes));
		for (const cli of CLIS) {
			assert.ok(
				sizes[cli] > PIPE_BUFFER,
				`${cli} --json is ${sizes[cli]} bytes, which no longer crosses the ${PIPE_BUFFER}-byte pipe buffer. ` +
					"The equality test above is still true and now proves nothing about the pipe; re-point it at a payload that does cross the boundary.",
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a payload under one pipe buffer is identical either way, so the comparison itself is sound", () => {
	// The control: this is the same measurement on output that never crosses the
	// boundary. If this arm ever fails, the defect is in the harness, not the CLI.
	const { path, dir } = tempFile();
	try {
		const argv = ["scripts/uctm-graph.mjs", "--impact", "scripts/uctm-orient.mjs", "--json"];
		const redirected = capture(argv, { toFile: path });
		const piped = capture(argv);
		const written = readFileSync(path, "utf8");
		assert.equal(redirected.status, 0);
		assert.equal(piped.status, 0);
		assert.ok(written.length < PIPE_BUFFER, `control payload is ${written.length} bytes and no longer small`);
		assert.equal(piped.stdout.length, written.length);
		assert.doesNotThrow(() => JSON.parse(piped.stdout));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the entry block still returns the tool's own exit codes", () => {
	// Switching the entry block away from `process.exit` must not cost it the exit
	// codes that are the whole verdict vocabulary. Both commands below are
	// checkout-independent, so this arm cannot fail because another session wrote
	// while it ran.
	const badSince = capture(["scripts/uctm-orient.mjs", "--check", "--since", join(tmpdir(), "uctm-no-such-packet.json")]);
	assert.equal(badSince.status, 2, `a --since path that cannot be read must be exit 2, got ${badSince.status}`);
	const unknownTarget = capture(["scripts/uctm-graph.mjs", "--impact", "no-such-node-in-this-graph-xyz"]);
	assert.equal(unknownTarget.status, 2, `an unresolvable --impact target must be exit 2, got ${unknownTarget.status}`);
	const ok = capture(["scripts/uctm-graph.mjs", "--impact", "scripts/uctm-orient.mjs", "--json"]);
	assert.equal(ok.status, 0, `a resolvable --impact target must be exit 0, got ${ok.status}`);
});
