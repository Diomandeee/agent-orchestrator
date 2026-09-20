import type { components } from "../../api/schema";

export type CliSessionSummary = components["schemas"]["ControllersCLISessionSummary"];
export type CliTranscript = components["schemas"]["ControllersCLITranscriptResponse"];

/**
 * Chain state is the only classification this view makes. Verified means the
 * daemon checked every event's sequence, linkage, and digest; unverified
 * means anything else — including a daemon that could not read the file.
 * The view never distinguishes *why* inside unverified, because guessing
 * would turn a display into a diagnosis.
 */
export type CliChainState = "verified" | "unverified";

export function cliChainState(summary: Pick<CliSessionSummary, "chainOk">): CliChainState {
	return summary.chainOk ? "verified" : "unverified";
}

/**
 * Render event data verbatim. Handles stay handles: this function performs
 * no lookup, expansion, or redaction — the transcript shows exactly what the
 * daemon returned, pretty-printed for reading.
 */
export function renderEventData(data: unknown): string {
	return JSON.stringify(data, null, 2);
}
