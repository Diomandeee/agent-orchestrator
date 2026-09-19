import { useTranslation } from "react-i18next";
import { useUctmProjectionQuery } from "../../hooks/useUctmProjection";
import { uctmProjectionKindLabelKeys, type UctmProjectionKind } from "../../lib/uctm-projection";
import { UctmProjectionCard } from "./UctmProjectionCard";

/**
 * One panel per kind. A failed read is shown as a failure of this view, not as a
 * UCTM state: when the daemon does not answer there is no projection to classify
 * and inventing one would put a machine reason on a fact nobody produced.
 */
export function UctmProjectionPanel({ kind, projectId }: { kind: UctmProjectionKind; projectId: string }) {
	const { t } = useTranslation();
	const query = useUctmProjectionQuery(kind, projectId);
	const label = t(uctmProjectionKindLabelKeys[kind]);
	if (query.isPending) {
		return (
			<section aria-label={label} className="rounded-lg border border-border bg-card p-4" data-kind={kind}>
				<h2 className="text-subtitle font-semibold text-foreground">{label}</h2>
				<p className="mt-2 text-control text-passive">{t("uctm.loading")}</p>
			</section>
		);
	}
	if (query.isError || !query.data) {
		return (
			<section aria-label={label} className="rounded-lg border border-border bg-card p-4" data-kind={kind}>
				<h2 className="text-subtitle font-semibold text-foreground">{label}</h2>
				<p role="alert" className="mt-2 text-control text-destructive">
					{query.error instanceof Error ? query.error.message : t("uctm.error")}
				</p>
			</section>
		);
	}
	return <UctmProjectionCard kind={kind} projection={query.data} />;
}
