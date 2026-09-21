import type { ParkSummary } from "./parks";

/** A fleet-board packet: the verbatim handoff state for one program item. */
export interface FleetPacket {
	name: string;
	display?: string;
	wave?: number;
	tier?: string;
	path?: string;
	status?: string;
	state?: string;
	blocked_on_mo?: string[];
	next?: string[];
	depends_on?: string[];
	unblocks?: string[];
	related?: string[];
	evidence?: string[];
	verify?: string[];
}

/** Distribution queue item: one scheduled social post for a fleet park. */
export type DistQueueStatus = "draft" | "scheduled" | "posted" | "linked" | "failed";

export interface DistQueueItem {
	id: string;
	park: string;
	caption: string;
	status: DistQueueStatus;
	scheduled_at?: string | null;
	views?: number | null;
	likes?: number | null;
	comments?: number | null;
}

export const FLEET_PREFIX = "fleet-";
export const FLEET_PROGRAM = "fleet-program";

/** Fleet parks only: program, kit, and one packet per cohort app. */
export function isFleetPark(name: string): boolean {
	return name === FLEET_PROGRAM || name.startsWith(FLEET_PREFIX);
}

/**
 * Resume hint is the only action this view offers. A fleet thread continues
 * in the terminal via `uctm resume <name>` — never from here, so the board
 * can neither fork nor duplicate a conversation. All state rides in the packet.
 */
export function fleetResumeCommand(name: string): string {
	return `uctm resume ${name}`;
}

/** Wave order for board sections; unknown waves sink to the end. */
export function waveRank(park: ParkSummary): number {
	return park.wave > 0 ? park.wave : 99;
}
