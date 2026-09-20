import { useTranslation } from "react-i18next";
import { uctmProjectionKindLabelKeys, uctmProjectionKinds } from "../../lib/uctm-projection";
import { UctmProjectionPanel } from "./UctmProjectionPanel";
import { CliSessionsPanel } from "./CliSessionsPanel";

/**
 * The project-scoped UCTM projection view.
 *
 * It is read-only by construction: every panel is a GET, and the page has no
 * control that proposes, approves, trains, merges, deploys, or sends. The banner
 * says so because a dashboard that looks authoritative is the failure this
 * surface exists to prevent — these are AO's cached copies of what a UCTM
 * service published, never UCTM truth.
 */
export function UctmView({ projectId }: { projectId: string }) {
	const { t } = useTranslation();
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
			<div className="border-b border-border bg-surface px-4.5 pt-5.5 pb-4">
				<div className="flex items-baseline gap-3">
					<h1 className="text-heading font-bold tracking-tight-xl text-foreground">{t("uctm.title")}</h1>
					<span className="text-md-sm text-passive">{t("uctm.subtitle")}</span>
				</div>
				<p className="mt-2 text-control leading-row text-muted-foreground">{t("uctm.readOnlyBanner")}</p>
			</div>
			<div className="grid grid-cols-1 gap-4 p-4.5 xl:grid-cols-2">
				{uctmProjectionKinds.map((kind) => (
					<UctmProjectionPanel key={kind} kind={kind} projectId={projectId} />
				))}
			</div>
			<CliSessionsPanel />
			<div className="px-4.5 pb-5 text-caption text-passive">
				{t("uctm.footer", { kinds: uctmProjectionKinds.length })}{" "}
				{uctmProjectionKinds.map((kind) => t(uctmProjectionKindLabelKeys[kind])).join(" · ")}
			</div>
		</div>
	);
}
