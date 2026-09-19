import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AO-F3 step 5 (no-telemetry verification). The UCTM surface may only ever read,
// so this suite drives the real api-client — not a stub — and asserts what
// leaves the process. The telemetry seam is mocked so the assertion is about
// what this surface emits, not about whether a DSN happens to be configured.
vi.mock("../../lib/telemetry", () => ({ captureRendererEvent: vi.fn() }));

import "../../i18n";
import { captureRendererEvent } from "../../lib/telemetry";
import { normalizeApiOperation, setApiBaseUrl } from "../../lib/api-client";
import { uctmProjectionKinds } from "../../lib/uctm-projection";
import { UctmProjectionPanel } from "./UctmProjectionPanel";

const EXPECTED_PATH: Record<string, string> = {
	status: "/api/v1/uctm/status",
	program: "/api/v1/uctm/program",
	lanes: "/api/v1/uctm/lanes",
	gates: "/api/v1/uctm/gates",
	receipts: "/api/v1/uctm/receipts",
	families: "/api/v1/uctm/families",
	adjudication_queue: "/api/v1/uctm/adjudication/queue",
	evaluations: "/api/v1/uctm/evaluations",
};

const PROJECT_ID = "scratch";

let requests: { method: string; url: string }[] = [];

function projectionBody() {
	return JSON.stringify({
		kind: "status",
		mode: "read_only",
		projectId: PROJECT_ID,
		freshness: "fresh",
		reason: "fresh_projection",
		payload: { product: "UCTM" },
	});
}

function stubFetch(status: number) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			requests.push({ method: input.method, url: input.url });
			return new Response(status === 200 ? projectionBody() : JSON.stringify({ code: "unavailable" }), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
}

function renderAllKinds() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			{uctmProjectionKinds.map((kind) => (
				<UctmProjectionPanel key={kind} kind={kind} projectId={PROJECT_ID} />
			))}
		</QueryClientProvider>,
	);
}

describe("UCTM surface is read-only and silent on success", () => {
	beforeEach(() => {
		requests = [];
		vi.mocked(captureRendererEvent).mockClear();
		// The daemon URL is only trusted once the app has resolved a port, so the
		// suite has to stand in for that handshake; without it the client refuses
		// before any request is built and the assertions below would pass vacuously.
		setApiBaseUrl(window.location.origin);
	});

	it("reads every kind exactly once, and only with GET, on the daemon's own origin", async () => {
		stubFetch(200);
		renderAllKinds();
		await waitFor(() => expect(requests).toHaveLength(uctmProjectionKinds.length));

		const origin = window.location.origin;
		for (const request of requests) {
			expect(request.method, `${request.url} must be a read`).toBe("GET");
			const url = new URL(request.url);
			expect(url.origin, `${request.url} must stay on the daemon origin`).toBe(origin);
			expect(url.searchParams.get("projectId")).toBe(PROJECT_ID);
		}
		expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual(
			Object.values(EXPECTED_PATH).sort(),
		);
	});

	it("emits no telemetry event when the reads succeed", async () => {
		stubFetch(200);
		renderAllKinds();
		await waitFor(() => expect(requests).toHaveLength(uctmProjectionKinds.length));
		expect(captureRendererEvent).not.toHaveBeenCalled();
	});

	it("reports a failure through the shared seam without carrying the project id", async () => {
		stubFetch(503);
		renderAllKinds();
		await waitFor(() => expect(captureRendererEvent).toHaveBeenCalled());

		for (const call of vi.mocked(captureRendererEvent).mock.calls) {
			expect(call[0]).toBe("ao.renderer.api_error");
			// The operation template is the only request detail that may travel; a
			// project id is user-chosen and must never appear in a captured payload.
			expect(JSON.stringify(call[1])).not.toContain(PROJECT_ID);
		}
	});

	it("normalizes every UCTM operation to a template that keeps ids out", () => {
		for (const path of Object.values(EXPECTED_PATH)) {
			expect(normalizeApiOperation("GET", path)).toBe(`GET ${path}`);
		}
	});
});
