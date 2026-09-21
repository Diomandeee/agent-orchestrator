import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../../i18n";
import type { DistQueueItem } from "../../lib/fleet";
import type { ParkSummary } from "../../lib/parks";
import { FleetCard } from "./FleetCard";

vi.mock("../../hooks/useParks", () => ({
	useParkPacketQuery: () => ({
		isPending: false,
		isError: false,
		data: { packet: { name: "fleet-app-firstdate", next: [], depends_on: [], related: [] } },
	}),
}));

const { queueState } = vi.hoisted(() => ({
	queueState: {
		items: [
			{
				id: "q1",
				park: "fleet-app-firstdate",
				caption: "Launch clip",
				status: "scheduled",
				scheduled_at: "2026-09-22T10:00:00Z",
			},
			{
				id: "q2",
				park: "fleet-app-firstdate",
				caption: "Teaser",
				status: "linked",
				scheduled_at: "2026-09-20T10:00:00Z",
				views: 12,
				likes: 3,
				comments: 1,
			},
			{
				id: "q3",
				park: "fleet-app-other",
				caption: "Other clip",
				status: "posted",
				scheduled_at: "2026-09-21T10:00:00Z",
			},
		] as DistQueueItem[],
	},
}));

vi.mock("../../hooks/useDistQueue", () => ({
	useDistQueue: () => ({ isPending: false, isError: false, data: queueState.items }),
}));

async function expandPacket() {
	fireEvent.click(screen.getByText("Show the tackle list"));
	const details = document.querySelector("details");
	expect(details).not.toBeNull();
	details!.open = true;
	fireEvent(details!, new Event("toggle", { bubbles: true }));
}

function fleetPark(overrides: Partial<ParkSummary> = {}): ParkSummary {
	return {
		name: "fleet-app-firstdate",
		created: "2026-09-20",
		status: "active",
		state: "Curated first date experiences in Miami.",
		blocked: [],
		next: ["trial", "push", "analytics"],
		wave: 1,
		tier: "TIER-1",
		...overrides,
	};
}

describe("FleetCard", () => {
	afterEach(async () => {
		await appI18n.changeLanguage("en");
	});

	it("renders tier, next count, and the terminal resume command", () => {
		render(<FleetCard park={fleetPark()} />);
		const card = screen.getByRole("region", { name: "fleet-app-firstdate" });
		expect(card).toHaveAttribute("data-fleet", "fleet-app-firstdate");
		expect(screen.getByText("TIER-1")).toBeInTheDocument();
		expect(screen.getByText("3 next")).toBeInTheDocument();
		expect(screen.getByText("uctm resume fleet-app-firstdate")).toBeInTheDocument();
	});

	it("shows blocked count when blockers exist", () => {
		render(<FleetCard park={fleetPark({ blocked: ["canonical root"] })} />);
		expect(screen.getByText("1 blocked")).toBeInTheDocument();
	});

	it("lists the tackle items inline instead of hiding them in the packet", () => {
		render(<FleetCard park={fleetPark()} />);
		expect(screen.getByText("trial")).toBeInTheDocument();
		expect(screen.getByText("push")).toBeInTheDocument();
		expect(screen.getByText("analytics")).toBeInTheDocument();
	});

	it("lists blockers inline with a more count past three", () => {
		render(<FleetCard park={fleetPark({ blocked: ["a", "b", "c", "d"] })} />);
		expect(screen.getByText("a")).toBeInTheDocument();
		expect(screen.getByText("+1 more")).toBeInTheDocument();
		expect(screen.queryByText("d")).not.toBeInTheDocument();
	});

	it("offers the resume command on the clipboard", () => {
		render(<FleetCard park={fleetPark()} />);
		expect(
			screen.getByRole("button", { name: "Copy resume command" }),
		).toBeInTheDocument();
	});

	it("lists this park's queue items inside the packet details", async () => {
		render(<FleetCard park={fleetPark()} />);
		await expandPacket();
		expect(await screen.findByText("Distribution queue")).toBeInTheDocument();
		expect(screen.getByText("Launch clip")).toBeInTheDocument();
		expect(screen.getByText("2026-09-22T10:00:00Z")).toBeInTheDocument();
		expect(screen.getByText("Scheduled")).toBeInTheDocument();
		expect(screen.queryByText("Other clip")).not.toBeInTheDocument();
	});

	it("shows linked stats for linked queue items", async () => {
		render(<FleetCard park={fleetPark()} />);
		await expandPacket();
		expect(await screen.findByText("Teaser")).toBeInTheDocument();
		expect(screen.getByText("Linked")).toBeInTheDocument();
		expect(screen.getByText("12 views · 3 likes · 1 comments")).toBeInTheDocument();
	});

	it("shows the queue empty state when the park has no items", async () => {
		const saved = queueState.items;
		queueState.items = [];
		try {
			render(<FleetCard park={fleetPark()} />);
			await expandPacket();
			expect(await screen.findByText("Nothing queued for this park yet.")).toBeInTheDocument();
		} finally {
			queueState.items = saved;
		}
	});
});
