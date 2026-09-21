import { useTranslation } from "react-i18next";
import { useParksQuery } from "../../hooks/useParks";
import { ParkCard } from "./ParkCard";

/**
 * The Idea Garden: one card per parked idea. Read-only by construction —
 * there is no control here that revives, forks, or dispatches a thread. A
 * parked thread continues in the terminal via `uctm resume <name>`; the
 * garden shows where everything sleeps and what each one is blocked on.
 * An empty garden is stated, not drawn as an empty grid: an empty grid
 * reads as "loading", which is a different claim.
 */
export function GardenPanel() {
	const { t } = useTranslation();
	const query = useParksQuery();
	if (query.isPending) {
		return (
			<section aria-label={t("uctm.garden.title")} className="rounded-lg border border-border bg-card p-4">
				<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.garden.title")}</h2>
				<p className="mt-2 text-control text-passive">{t("uctm.garden.loading")}</p>
			</section>
		);
	}
	if (query.isError || !query.data) {
		return (
			<section aria-label={t("uctm.garden.title")} className="rounded-lg border border-border bg-card p-4">
				<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.garden.title")}</h2>
				<p role="alert" className="mt-2 text-control text-destructive">
					{query.error instanceof Error ? query.error.message : t("uctm.garden.error")}
				</p>
			</section>
		);
	}
	if (query.data.length === 0) {
		return (
			<section aria-label={t("uctm.garden.title")} className="rounded-lg border border-border bg-card p-4">
				<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.garden.title")}</h2>
				<p className="mt-2 text-control text-passive">{t("uctm.garden.empty")}</p>
			</section>
		);
	}
	const active = query.data.filter((park) => park.status === "active");
	const sleeping = query.data.filter((park) => park.status !== "active");
	return (
		<div className="flex flex-col gap-6">
			{active.length > 0 ? (
				<section aria-label={t("uctm.garden.section.active")}>
					<h2 className="mb-3 text-subtitle font-semibold text-foreground">
						{t("uctm.garden.section.active")}
					</h2>
					<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
						{active.map((park) => (
							<ParkCard key={park.name} park={park} />
						))}
					</div>
				</section>
			) : null}
			{sleeping.length > 0 ? (
				<section aria-label={t("uctm.garden.section.parked")}>
					<h2 className="mb-3 text-subtitle font-semibold text-foreground">
						{t("uctm.garden.section.parked")}
					</h2>
					<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
						{sleeping.map((park) => (
							<ParkCard key={park.name} park={park} />
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}
