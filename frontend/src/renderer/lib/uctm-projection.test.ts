import { describe, expect, it } from "vitest";
import type { UctmProjectionResult } from "./uctm-projection";
import {
	uctmPayloadText,
	uctmProjectionKinds,
	uctmProvenanceRows,
	uctmShowsPayload,
	uctmStateSummary,
	uctmTone,
} from "./uctm-projection";

function projection(overrides: Partial<UctmProjectionResult> = {}): UctmProjectionResult {
	return {
		kind: "status",
		mode: "read_only",
		projectId: "",
		freshness: "fresh",
		reason: "fresh_projection",
		...overrides,
	} as UctmProjectionResult;
}

describe("uctmTone", () => {
	it("maps every freshness value to exactly one tone", () => {
		expect(uctmTone("fresh")).toBe("fresh");
		expect(uctmTone("stale")).toBe("stale");
		expect(uctmTone("disabled")).toBe("disabled");
		expect(uctmTone("unknown")).toBe("unknown");
	});

	it("treats an unrecognized freshness as unknown rather than fresh", () => {
		expect(uctmTone("healthy")).toBe("unknown");
		expect(uctmTone("")).toBe("unknown");
	});
});

describe("uctmShowsPayload", () => {
	it("shows a payload only when AO actually holds one", () => {
		expect(uctmShowsPayload(projection({ payload: { sessions: { count: 3 } } }))).toBe(true);
		expect(uctmShowsPayload(projection({ payload: undefined }))).toBe(false);
		expect(uctmShowsPayload(projection({ payload: null }))).toBe(false);
	});

	it("does not invent a payload for a fresh projection that carries none", () => {
		const summary = uctmStateSummary(projection({ payload: undefined }));
		expect(summary.tone).toBe("fresh");
		expect(summary.showsPayload).toBe(false);
	});
});

describe("uctmStateSummary", () => {
	it("keeps the machine reason when it has no copy, instead of hiding it", () => {
		const summary = uctmStateSummary(projection({ freshness: "unknown", reason: "brand_new_code" }));
		expect(summary.reasonKey).toBeNull();
		expect(summary.reasonCode).toBe("brand_new_code");
	});

	it("maps every reason the daemon can send", () => {
		for (const reason of [
			"mode_off",
			"transport_not_configured",
			"service_unavailable",
			"service_rejected",
			"no_facts",
			"projection_expired",
			"fresh_projection",
			"projection_not_persisted",
			"no_projection",
		]) {
			expect(uctmStateSummary(projection({ reason })).reasonKey).toBe(`uctm.reason.${reason}`);
		}
	});

	it("marks a projection whose window has closed as expired", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const future = new Date(Date.now() + 60_000).toISOString();
		expect(uctmStateSummary(projection({ expiresAt: past })).expired).toBe(true);
		expect(uctmStateSummary(projection({ expiresAt: future })).expired).toBe(false);
		expect(uctmStateSummary(projection({ expiresAt: null })).expired).toBe(false);
	});
});

describe("uctmProvenanceRows", () => {
	it("omits fields AO did not receive rather than rendering them blank", () => {
		expect(uctmProvenanceRows(projection())).toHaveLength(0);
		expect(uctmProvenanceRows(projection({ receiptRef: "   ", sourceHash: "" }))).toHaveLength(0);
	});

	it("keeps the fields that carry provenance", () => {
		const rows = uctmProvenanceRows(
			projection({
				schemaVersion: "uctm.spine.service.v0",
				sourceCommitOrFreezeId: "dev-supervisor:abc",
				authorityCeiling: "interface_read_only",
				receiptRef: "uctm.spine.service.v0:receipt:sha256:ab",
				contentHashOrEtag: "sha256:ab",
				sourceHash: "ab",
			}),
		);
		expect(rows.map((row) => row.key)).toEqual([
			"schemaVersion",
			"freeze",
			"authority",
			"contentHash",
			"sourceHash",
			"receipt",
		]);
		expect(rows.every((row) => row.value.trim() !== "")).toBe(true);
	});
});

describe("uctmPayloadText", () => {
	it("pretty-prints a payload and tolerates nothing being there", () => {
		expect(uctmPayloadText({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(uctmPayloadText(undefined)).toBe("");
		expect(uctmPayloadText(null)).toBe("");
	});
});

describe("uctmProjectionKinds", () => {
	it("is the closed v0 read set in presentation order", () => {
		expect(uctmProjectionKinds).toEqual([
			"status",
			"program",
			"lanes",
			"gates",
			"receipts",
			"families",
			"adjudication_queue",
			"evaluations",
		]);
	});
});
