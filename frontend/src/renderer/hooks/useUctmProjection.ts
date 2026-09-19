import { useQuery } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { UctmProjectionKind, UctmProjectionResult } from "../lib/uctm-projection";

/**
 * One read per kind. The kind is a closed set, so the path is resolved by an
 * explicit switch rather than built from the kind name: a dynamic path would
 * stop the generated schema from type-checking this call.
 *
 * The query is read-only in every sense. It never proposes, and it does not
 * retry a refusal: AO already derives stale/unknown from a failed attempt, so a
 * silent retry loop would only add load without changing what is displayed.
 */

function unpack(call: Promise<{ data?: unknown; error?: unknown }>): Promise<UctmProjectionResult> {
	return call.then(({ data, error }) => {
		if (error) throw new Error(apiErrorMessage(error));
		if (data === undefined || data === null) throw new Error("uctm projection response was empty");
		return data as UctmProjectionResult;
	});
}

export async function fetchUctmProjection(
	kind: UctmProjectionKind,
	projectId?: string,
): Promise<UctmProjectionResult> {
	const options = projectId ? { params: { query: { projectId } } } : {};
	switch (kind) {
		case "status":
			return unpack(apiClient.GET("/api/v1/uctm/status", options));
		case "program":
			return unpack(apiClient.GET("/api/v1/uctm/program", options));
		case "lanes":
			return unpack(apiClient.GET("/api/v1/uctm/lanes", options));
		case "gates":
			return unpack(apiClient.GET("/api/v1/uctm/gates", options));
		case "receipts":
			return unpack(apiClient.GET("/api/v1/uctm/receipts", options));
		case "families":
			return unpack(apiClient.GET("/api/v1/uctm/families", options));
		case "adjudication_queue":
			return unpack(apiClient.GET("/api/v1/uctm/adjudication/queue", options));
		case "evaluations":
			return unpack(apiClient.GET("/api/v1/uctm/evaluations", options));
	}
}

export function uctmProjectionQueryKey(kind: UctmProjectionKind, projectId: string) {
	return ["uctm-projection", kind, projectId] as const;
}

export function useUctmProjectionQuery(kind: UctmProjectionKind, projectId: string) {
	return useQuery({
		queryKey: uctmProjectionQueryKey(kind, projectId),
		queryFn: () => fetchUctmProjection(kind, projectId),
		retry: false,
		// The daemon derives freshness from its own projection window, so letting
		// react-query keep a longer stale time than that window would let the view
		// disagree with the daemon about the same projection.
		staleTime: 5_000,
	});
}
