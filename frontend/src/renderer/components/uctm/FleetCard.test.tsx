import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../../i18n";
import type { ParkSummary } from "../../lib/parks";
import { FleetCard } from "./FleetCard";

vi.mock("../../hooks/useParks", () => ({
	useParkPacketQuery: () => ({ isPending: false, isError: false, data: null }),
}));

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
});
