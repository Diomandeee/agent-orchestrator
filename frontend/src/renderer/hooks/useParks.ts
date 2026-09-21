import { useQuery } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { ParkPacket, ParkSummary } from "../lib/parks";

function unpackList(call: Promise<{ data?: unknown; error?: unknown }>): Promise<ParkSummary[]> {
	return call.then(({ data, error }) => {
		if (error) throw new Error(apiErrorMessage(error));
		if (!Array.isArray(data)) throw new Error("park list was empty");
		return data as ParkSummary[];
	});
}

function unpackPacket(call: Promise<{ data?: unknown; error?: unknown }>): Promise<ParkPacket> {
	return call.then(({ data, error }) => {
		if (error) throw new Error(apiErrorMessage(error));
		if (data === undefined || data === null) throw new Error("park packet was empty");
		return data as ParkPacket;
	});
}

/** Read-only list. No retry on refusal: a failed read is displayed, not repeated. */
export function useParksQuery() {
	return useQuery({
		queryKey: ["uctm", "parks"],
		queryFn: () => unpackList(apiClient.GET("/api/v1/uctm/parks", {})),
		retry: false,
	});
}

/** Read-only handoff packet for one parked idea. Disabled until expanded. */
export function useParkPacketQuery(name: string | null) {
	return useQuery({
		queryKey: ["uctm", "parks", name, "packet"],
		queryFn: () =>
			unpackPacket(
				apiClient.GET("/api/v1/uctm/parks/{name}/packet", {
					params: { path: { name: name ?? "" } },
				}),
			),
		enabled: name !== null,
		retry: false,
	});
}
