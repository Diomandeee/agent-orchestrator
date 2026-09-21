import { useQuery } from "@tanstack/react-query";
import { apiErrorMessage, getApiBaseUrl } from "../lib/api-client";
import type { DistQueueItem } from "../lib/fleet";

async function fetchDistQueue(): Promise<DistQueueItem[]> {
	const response = await fetch(`${getApiBaseUrl()}/api/v1/dist/queue`);
	if (!response.ok) {
		let error: unknown;
		try {
			error = await response.json();
		} catch {
			error = undefined;
		}
		throw new Error(apiErrorMessage(error, "distribution queue was empty"));
	}
	const data: unknown = await response.json().catch(() => undefined);
	const items =
		Array.isArray(data) ? data : (data as { items?: unknown } | undefined)?.items;
	if (!Array.isArray(items)) throw new Error("distribution queue was empty");
	return items as DistQueueItem[];
}

/** Read-only distribution queue. No retry on refusal: a failed read is displayed, not repeated. */
export function useDistQueue() {
	return useQuery({
		queryKey: ["dist", "queue"],
		queryFn: fetchDistQueue,
		retry: false,
	});
}
