import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { FleetPanel } from "../components/uctm/FleetPanel";

export const Route = createFileRoute("/_shell/fleet")({
	component: FleetRoute,
});

function FleetRoute() {
	const { t } = useTranslation();
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
			<div className="border-b border-border bg-surface px-4.5 pt-5.5 pb-4">
				<div className="flex items-baseline gap-3">
					<h1 className="text-heading font-bold tracking-tight-xl text-foreground">
						{t("uctm.fleet.title")}
					</h1>
					<span className="text-md-sm text-passive">{t("uctm.fleet.subtitle")}</span>
				</div>
				<p className="mt-2 text-control leading-row text-muted-foreground">
					{t("uctm.fleet.readOnlyBanner")}
				</p>
			</div>
			<div className="p-4.5">
				<FleetPanel />
			</div>
			<div className="px-4.5 pb-5 text-caption text-passive">{t("uctm.fleet.footer")}</div>
		</div>
	);
}
