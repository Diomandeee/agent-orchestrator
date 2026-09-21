import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../../i18n";
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

describe("FleetPanel", () => {
	afterEach(async () => {
		await appI18n.changeLanguage("en");
	});

	it("summarizes the whole board and ignores non-fleet threads", () => {
		render(<FleetPanel />);
		expect(screen.getByText("3 threads · 1 blocked · 2 ready")).toBeInTheDocument();
		expect(screen.queryByText("other-thread")).not.toBeInTheDocument();
	});
});
