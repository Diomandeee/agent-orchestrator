import type { components } from "../../api/schema";

export type ParkSummary = components["schemas"]["ControllersParkSummary"];
export type ParkPacket = components["schemas"]["ControllersParkPacketResponse"];

/**
 * Resume hint is the only action this view offers. A parked thread continues
 * in the terminal via `uctm resume <name>` — never from here, so the garden
 * can neither fork nor duplicate a conversation.
 */
export function parkResumeCommand(name: string): string {
	return `uctm resume ${name}`;
}
