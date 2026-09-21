import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { GardenPanel } from "../components/uctm/GardenPanel";

export const Route = createFileRoute("/_shell/garden")({
	component: GardenRoute,
});

function GardenRoute() {
	const { t } = useTranslation();
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
			<div className="border-b border-border bg-surface px-4.5 pt-5.5 pb-4">
				<div className="flex items-baseline gap-3">
					<h1 className="text-heading font-bold tracking-tight-xl text-foreground">
						{t("uctm.garden.title")}
					</h1>
					<span className="text-md-sm text-passive">{t("uctm.garden.subtitle")}</span>
				</div>
				<p className="mt-2 text-control leading-row text-muted-foreground">
					{t("uctm.garden.readOnlyBanner")}
				</p>
			</div>
			<div className="p-4.5">
				<GardenPanel />
			</div>
			<div className="px-4.5 pb-5 text-caption text-passive">{t("uctm.garden.footer")}</div>
		</div>
	);
}
