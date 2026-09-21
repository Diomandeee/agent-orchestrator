import { expect, test } from "@playwright/test";

// UCTM-1. Unlike the fake-bridge renderer smokes, this spec deliberately reads a
// real daemon through the dev proxy when one is configured, because the project
// UCTM view is only meaningful if it renders what the API actually returns —
// including the states that carry no payload. It also has to pass with no UCTM
// daemon at all (CI), so it asserts the invariant that holds either way: every
// kind gets exactly one card, and a card is never painted with a state for a
// projection nobody produced.

const KINDS = [
	"status",
	"program",
	"lanes",
	"gates",
	"receipts",
	"families",
	"adjudication_queue",
	"evaluations",
];

test("project UCTM view states every kind and invents none @T0 @UCTM", async ({ page }) => {
	await page.goto("/#/projects/scratch/uctm");

	await expect(page.getByRole("heading", { name: "UCTM", exact: true })).toBeVisible();
	await expect(page.getByText(/never UCTM truth/)).toBeVisible();

	for (const kind of KINDS) {
		await expect(page.locator(`section[data-kind="${kind}"]`)).toHaveCount(1);
	}

	// Settle: no card may still be reading when the assertions below run.
	await expect(page.getByText("Reading the projection…")).toHaveCount(0);

	const cards = await page.locator("section[data-kind]").evaluateAll((nodes) =>
		nodes.map((node) => ({
			kind: node.getAttribute("data-kind"),
			freshness: node.getAttribute("data-freshness"),
			text: node.textContent ?? "",
		})),
	);
	expect(cards.map((card) => card.kind)).toEqual([...KINDS, "cli-sessions"]);

	// CLI threads render beside the projections: the section exists with or
	// without a daemon, and against a live daemon it lists real sessions.
	const cli = cards.find((card) => card.kind === "cli-sessions");
	expect(cli).toBeDefined();

	for (const card of cards.filter((c) => c.kind !== "cli-sessions")) {
		if (card.freshness === null) {
			// Nothing was read at all (no UCTM daemon behind the proxy). The view
			// must report the failure rather than paint a state for a fact that
			// nobody produced.
			expect(card.text).toContain("could not be read");
			continue;
		}
		// The daemon may only derive these four; there is deliberately no "healthy".
		expect(["disabled", "fresh", "stale", "unknown"]).toContain(card.freshness);
		expect(card.text).not.toContain("could not be read");
	}

	// A held projection shows its provenance; an absent one says so instead of
	// rendering an empty box that would read as "the answer is nothing".
	const held = cards.filter((card) => card.freshness === "fresh" || card.freshness === "stale");
	for (const card of held) {
		expect(card.text).toMatch(/Receipt reference|No payload is shown/);
	}
});
