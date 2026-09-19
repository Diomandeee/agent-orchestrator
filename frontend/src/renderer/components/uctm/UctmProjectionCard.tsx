import { useTranslation } from "react-i18next";
import {
	uctmPayloadText,
	uctmProjectionKindLabelKeys,
	uctmProvenanceRows,
	uctmStateSummary,
	type UctmProjectionKind,
	type UctmProjectionResult,
	type UctmTone,
} from "../../lib/uctm-projection";
import { cn } from "../../lib/utils";

// Tone classes are the only place a colour is chosen. A projection AO does not
// hold is never painted green, so the palette itself cannot imply a fact.
const toneClassName: Record<UctmTone, string> = {
	fresh: "bg-success/15 text-success",
	stale: "bg-warning/15 text-warning",
	disabled: "bg-raised text-passive",
	unknown: "bg-border/40 text-muted-foreground",
};

/**
 * Presentational only: it receives a projection and renders what that projection
 * says. Fetching lives in the panel so this component can be tested against a
 * fixture for every freshness state without a daemon.
 */
export function UctmProjectionCard({
	kind,
	projection,
}: {
	kind: UctmProjectionKind;
	projection: UctmProjectionResult;
}) {
	const { t } = useTranslation();
	const summary = uctmStateSummary(projection);
	const rows = uctmProvenanceRows(projection);
	return (
		<section
			aria-label={t(uctmProjectionKindLabelKeys[kind])}
			className="rounded-lg border border-border bg-card p-4"
			data-freshness={projection.freshness}
			data-kind={kind}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-subtitle font-semibold text-foreground">{t(uctmProjectionKindLabelKeys[kind])}</h2>
					<p className="mt-0.5 font-mono text-caption text-muted-foreground">{projection.reason}</p>
				</div>
				<span
					className={cn(
						"shrink-0 rounded-md px-2.5 py-1 text-caption font-semibold",
						toneClassName[summary.tone],
					)}
				>
					{t(summary.freshnessKey)}
				</span>
			</div>

			<p className="mt-3 text-control leading-row text-muted-foreground">
				{summary.reasonKey === null
					? t("uctm.reason.unrecognized", { code: summary.reasonCode })
					: t(summary.reasonKey)}
			</p>

			{rows.length > 0 ? (
				<dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
					{rows.map((row) => (
						<div key={row.key} className="contents">
							<dt className="text-caption text-passive">{t(row.labelKey)}</dt>
							<dd className="truncate font-mono text-caption text-foreground" title={row.value}>
								{row.value}
							</dd>
						</div>
					))}
				</dl>
			) : null}

			{summary.showsPayload ? (
				<details className="mt-4">
					{/* text-muted-foreground, not text-accent: the `text-accent` utility compiles to
					    var(--accent), which is a surface tint (near-white in the light theme), so it
					    would paint this affordance at ~1.05:1 on a card. The reveal control has to be
					    readable in both themes or the payload is effectively unreachable. */}
					<summary className="cursor-pointer text-caption font-medium text-muted-foreground hover:text-foreground">
						{t("uctm.payload.show")}
					</summary>
					<pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-caption text-foreground">
						{uctmPayloadText(projection.payload)}
					</pre>
				</details>
			) : (
				// Absence is stated, not left as an empty box: an empty box reads as
				// "the answer is nothing", which is a different claim.
				<p className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-caption text-passive">
					{t("uctm.payload.absent")}
				</p>
			)}
		</section>
	);
}
