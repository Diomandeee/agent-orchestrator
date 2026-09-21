import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { appI18n } from "../../i18n";
import type { ParkSummary } from "../../lib/parks";
import { ParkCard } from "./ParkCard";

function park(overrides: Partial<ParkSummary> = {}): ParkSummary {
	return {
		name: "milkmen-connector",
		created: "2026-09-19",
		status: "parked",
		state: "21-tool server builds clean.",
		blocked: ["live creds", "stripe key"],
		next: ["deploy", "list"],
		wave: 0,
		tier: "",
		...overrides,
	};
}

describe("ParkCard", () => {
	afterEach(async () => {
		await appI18n.changeLanguage("en");
	});

	it("renders state, blocked count, and the terminal resume command", () => {
		render(<ParkCard park={park()} />);
		const card = screen.getByRole("region", { name: "milkmen-connector" });
		expect(card).toHaveAttribute("data-park", "milkmen-connector");
		expect(screen.getByText("21-tool server builds clean.")).toBeInTheDocument();
		expect(screen.getByText("2 blocked")).toBeInTheDocument();
		expect(screen.getByText("uctm resume milkmen-connector")).toBeInTheDocument();
	});

	it("shows next count instead of blocked when nothing blocks", () => {
		render(<ParkCard park={park({ blocked: [] })} />);
		expect(screen.getByText("2 next")).toBeInTheDocument();
		expect(screen.queryByText(/blocked/)).not.toBeInTheDocument();
	});

	it("badges active threads and sleeping ones differently", () => {
		const { rerender } = render(<ParkCard park={park({ status: "active" })} />);
		expect(screen.getByText("Active")).toBeInTheDocument();
		rerender(<ParkCard park={park({ status: "parked" })} />);
		expect(screen.getByText("Parked")).toBeInTheDocument();
	});

	it("lists what blocks the thread inline so the packet stays closed", () => {
		render(<ParkCard park={park()} />);
		expect(screen.getByText("live creds")).toBeInTheDocument();
		expect(screen.getByText("stripe key")).toBeInTheDocument();
	});

	it("lists next steps inline when nothing blocks", () => {
		render(<ParkCard park={park({ blocked: [] })} />);
		expect(screen.getByText("deploy")).toBeInTheDocument();
		expect(screen.getByText("list")).toBeInTheDocument();
	});

	it("caps the inline list with a more count", () => {
		render(<ParkCard park={park({ blocked: ["a", "b", "c", "d", "e"] })} />);
		expect(screen.getByText("a")).toBeInTheDocument();
		expect(screen.getByText("+2 more")).toBeInTheDocument();
		expect(screen.queryByText("e")).not.toBeInTheDocument();
	});

	it("offers the resume command on the clipboard", () => {
		render(<ParkCard park={park()} />);
		expect(
			screen.getByRole("button", { name: "Copy resume command" }),
		).toBeInTheDocument();
	});
});
