import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../../i18n";
import type { DistQueueItem } from "../../lib/fleet";
import type { ParkSummary } from "../../lib/parks";
import { FleetPanel } from "./FleetPanel";

function fleetPark(name: string, overrides: Partial<ParkSummary> = {}): ParkSummary {
	return {
		name,
		created: "2026-09-20",
		status: "parked",
		state: "",
		blocked: [],
		next: [],
		wave: 1,
		tier: "",
		...overrides,
	};
}

vi.mock("../../hooks/useParks", () => ({
	useParksQuery: () => ({
		isPending: false,
		isError: false,
		data: [
			fleetPark("fleet-program", { wave: 0, next: ["ship"] }),
			fleetPark("fleet-app-a", { blocked: ["canonical root"] }),
			fleetPark("fleet-app-b", { next: ["trial"] }),
			fleetPark("other-thread", { blocked: ["x"] }),
		],
	}),
}));

function queueItem(overrides: Partial<DistQueueItem> & { id: string; status: DistQueueItem["status"] }): DistQueueItem {
	return { park: "fleet-app-a", caption: "clip", ...overrides };
}

vi.mock("../../hooks/useDistQueue", () => ({
	useDistQueue: () => ({
		isPending: false,
		isError: false,
		data: [
			queueItem({ id: "q1", status: "scheduled" }),
			queueItem({ id: "q2", status: "scheduled" }),
			queueItem({ id: "q3", status: "posted", park: "fleet-app-b" }),
			queueItem({ id: "q4", status: "linked", park: "fleet-app-b" }),
			queueItem({ id: "q5", status: "failed" }),
			queueItem({ id: "q6", status: "draft" }),
		],
	}),
}));

describe("FleetPanel", () => {
	afterEach(async () => {
		await appI18n.changeLanguage("en");
	});

	it("summarizes the whole board and ignores non-fleet threads", () => {
		render(<FleetPanel />);
		expect(screen.getByText("3 threads · 1 blocked · 2 ready")).toBeInTheDocument();
		expect(screen.queryByText("other-thread")).not.toBeInTheDocument();
	});

	it("shows the board queue counts per status under the totals", () => {
		render(<FleetPanel />);
		expect(screen.getByText("2 scheduled · 1 posted · 1 linked · 1 failed")).toBeInTheDocument();
	});
});
