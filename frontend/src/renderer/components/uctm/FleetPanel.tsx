import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useParksQuery } from "../../hooks/useParks";
import { FleetCard } from "./FleetCard";
import { FLEET_PROGRAM, isFleetPark, waveRank } from "../../lib/fleet";

/**
 * The Fleet Board: one card per cohort app plus the program and kit nodes,
 * grouped by wave so dependencies read top-down (kit and Wave 1 unblock the
 * rest). Read-only by construction — a fleet thread continues in the
 * terminal via `uctm resume <name>` with the full packet as its state.
 */
export function FleetPanel() {
	const { t } = useTranslation();
	const query = useParksQuery();
	const fleet = useMemo(
		() => (query.data ?? []).filter((park) => isFleetPark(park.name)),
		[query.data],
	);
	const program = fleet.filter((park) => park.name === FLEET_PROGRAM);
	const apps = fleet.filter((park) => park.name !== FLEET_PROGRAM);
	const waves = useMemo(() => {
		const groups = new Map<number, typeof apps>();
		for (const park of apps) {
			const wave = waveRank(park);
			if (!groups.has(wave)) groups.set(wave, []);
			groups.get(wave)?.push(park);
		}
		return [...groups.entries()].sort((a, b) => a[0] - b[0]);
	}, [apps]);

	if (query.isPending) {
		return (
			<section aria-label={t("uctm.fleet.title")} className="rounded-lg border border-border bg-card p-4">
				<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.fleet.title")}</h2>
				<p className="mt-2 text-control text-passive">{t("uctm.fleet.loading")}</p>
			</section>
		);
	}
	if (query.isError || !query.data) {
		return (
			<section aria-label={t("uctm.fleet.title")} className="rounded-lg border border-border bg-card p-4">
				<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.fleet.title")}</h2>
				<p role="alert" className="mt-2 text-control text-destructive">
					{query.error instanceof Error ? query.error.message : t("uctm.fleet.error")}
				</p>
			</section>
		);
	}
	if (fleet.length === 0) {
		return (
			<section aria-label={t("uctm.fleet.title")} className="rounded-lg border border-border bg-card p-4">
				<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.fleet.title")}</h2>
				<p className="mt-2 text-control text-passive">{t("uctm.fleet.empty")}</p>
			</section>
		);
	}
	const blockedCount = fleet.filter((park) => (park.blocked?.length ?? 0) > 0).length;
	return (
		<div className="flex flex-col gap-6">
			<p className="text-control text-muted-foreground">
				{t("uctm.fleet.summary", {
					total: fleet.length,
					blocked: blockedCount,
					ready: fleet.length - blockedCount,
				})}
			</p>
			{program.map((park) => (
				<section key={park.name} aria-label={t("uctm.fleet.section.program")}>
					<h2 className="mb-3 text-subtitle font-semibold text-foreground">
						{t("uctm.fleet.section.program")}
					</h2>
					<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
						<FleetCard park={park} />
					</div>
				</section>
			))}
			{waves.map(([wave, parks]) => (
				<section key={wave} aria-label={t("uctm.fleet.section.wave", { wave })}>
					<h2 className="mb-3 text-subtitle font-semibold text-foreground">
						{t("uctm.fleet.section.wave", { wave })}
					</h2>
					<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
						{parks.map((park) => (
							<FleetCard key={park.name} park={park} />
						))}
					</div>
				</section>
			))}
		</div>
	);
}
