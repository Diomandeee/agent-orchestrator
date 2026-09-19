import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { appI18n } from "../../i18n";
import type { UctmProjectionResult } from "../../lib/uctm-projection";
import { UctmProjectionCard } from "./UctmProjectionCard";

function projection(overrides: Partial<UctmProjectionResult> = {}): UctmProjectionResult {
	return {
		kind: "status",
		mode: "read_only",
		projectId: "",
		freshness: "fresh",
		reason: "fresh_projection",
		...overrides,
	} as UctmProjectionResult;
}

describe("UctmProjectionCard", () => {
	afterEach(async () => {
		await appI18n.changeLanguage("en");
	});

	it("renders state before payload and marks a held projection fresh", () => {
		render(
			<UctmProjectionCard
				kind="status"
				projection={projection({
					payload: { product: "UCTM" },
					authorityCeiling: "interface_read_only",
					receiptRef: "uctm.spine.service.v0:receipt:sha256:ab",
				})}
			/>,
		);
		const card = screen.getByRole("region", { name: "Status" });
		expect(card).toHaveAttribute("data-freshness", "fresh");
		expect(screen.getByText("Fresh")).toBeInTheDocument();
		expect(screen.getByText("Authority claimed")).toBeInTheDocument();
		expect(screen.getByText("interface_read_only")).toBeInTheDocument();
		expect(screen.getByText("A projection is held and has not expired.")).toBeInTheDocument();
		expect(screen.getByText("Show the published payload")).toBeInTheDocument();
		expect(screen.queryByText(/No payload is shown/)).not.toBeInTheDocument();
	});

	it("states that nothing is held instead of showing an empty result", () => {
		render(
			<UctmProjectionCard
				kind="evaluations"
				projection={projection({ kind: "evaluations", freshness: "unknown", reason: "no_facts" })}
			/>,
		);
		const card = screen.getByRole("region", { name: "Evaluations" });
		expect(card).toHaveAttribute("data-freshness", "unknown");
		expect(screen.getByText("No facts")).toBeInTheDocument();
		expect(screen.getByText(/The service holds no facts for this kind/)).toBeInTheDocument();
		expect(screen.getByText(/No payload is shown/)).toBeInTheDocument();
		expect(screen.queryByText("Show the published payload")).not.toBeInTheDocument();
	});

	it("keeps a surviving projection readable while it is stale", () => {
		render(
			<UctmProjectionCard
				kind="status"
				projection={projection({ freshness: "stale", reason: "service_unavailable", payload: { sessions: 3 } })}
			/>,
		);
		expect(screen.getByText("Stale")).toBeInTheDocument();
		expect(screen.getByText(/did not answer/)).toBeInTheDocument();
		expect(screen.getByText("Show the published payload")).toBeInTheDocument();
	});

	it("shows a disabled integration without blaming the service", () => {
		render(
			<UctmProjectionCard
				kind="status"
				projection={projection({ freshness: "disabled", reason: "mode_off", payload: undefined })}
			/>,
		);
		expect(screen.getByText("Off")).toBeInTheDocument();
		expect(screen.getByText("The UCTM integration is off, so AO made no request.")).toBeInTheDocument();
		expect(screen.getByText(/No payload is shown/)).toBeInTheDocument();
	});

	it("prints an unrecognized reason code rather than inventing copy for it", () => {
		render(
			<UctmProjectionCard
				kind="gates"
				projection={projection({ kind: "gates", freshness: "unknown", reason: "some_future_code" })}
			/>,
		);
		expect(screen.getByText("Unrecognized state code: some_future_code")).toBeInTheDocument();
	});
});
