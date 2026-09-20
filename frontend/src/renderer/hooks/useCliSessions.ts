import { useQuery } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { CliSessionSummary, CliTranscript } from "../lib/cli-sessions";

function unpackList(call: Promise<{ data?: unknown; error?: unknown }>): Promise<CliSessionSummary[]> {
	return call.then(({ data, error }) => {
		if (error) throw new Error(apiErrorMessage(error));
		if (!Array.isArray(data)) throw new Error("cli session list was empty");
		return data as CliSessionSummary[];
	});
}

function unpackTranscript(call: Promise<{ data?: unknown; error?: unknown }>): Promise<CliTranscript> {
	return call.then(({ data, error }) => {
		if (error) throw new Error(apiErrorMessage(error));
		if (data === undefined || data === null) throw new Error("cli transcript was empty");
		return data as CliTranscript;
	});
}

/** Read-only list. No retry on refusal: a failed read is displayed, not repeated. */
export function useCliSessionsQuery() {
	return useQuery({
		queryKey: ["uctm", "cli-sessions"],
		queryFn: () => unpackList(apiClient.GET("/api/v1/uctm/cli-sessions", {})),
		retry: false,
	});
}

/** Read-only capped transcript for one session. Disabled until selected. */
export function useCliTranscriptQuery(sessionId: string | null) {
	return useQuery({
		queryKey: ["uctm", "cli-sessions", sessionId, "transcript"],
		queryFn: () =>
			unpackTranscript(
				apiClient.GET("/api/v1/uctm/cli-sessions/{id}/transcript", {
					params: { path: { id: sessionId ?? "" } },
				}),
			),
		enabled: sessionId !== null,
		retry: false,
	});
}
