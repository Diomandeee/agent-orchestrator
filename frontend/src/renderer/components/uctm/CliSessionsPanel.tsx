import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCliSessionsQuery, useCliTranscriptQuery } from "../../hooks/useCliSessions";
import { cliChainState, renderEventData } from "../../lib/cli-sessions";

/**
 * CLI threads beside the projections. Read-only by construction: list and
 * transcript are GETs, selection is local state, and there is no control
 * that sends, resumes, or revives anything. A thread continues in the
 * terminal (`uctm chat --session ID`), never from here.
 */
export function CliSessionsPanel() {
	const { t } = useTranslation();
	const [selected, setSelected] = useState<string | null>(null);
	const list = useCliSessionsQuery();
	const transcript = useCliTranscriptQuery(selected);

	return (
		<section
			aria-label={t("uctm.cli.title")}
			className="rounded-lg border border-border bg-card p-4"
			data-kind="cli-sessions"
		>
			<h2 className="text-subtitle font-semibold text-foreground">{t("uctm.cli.title")}</h2>
			{list.isPending && <p className="mt-2 text-control text-passive">{t("uctm.loading")}</p>}
			{list.isError && (
				<p role="alert" className="mt-2 text-control text-destructive">
					{list.error instanceof Error ? list.error.message : t("uctm.error")}
				</p>
			)}
			{list.data && list.data.length === 0 && (
				<p className="mt-2 text-control text-passive">{t("uctm.cli.empty")}</p>
			)}
			{list.data && list.data.length > 0 && (
				<ul className="mt-2 space-y-1">
					{list.data.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								onClick={() => setSelected(s.id === selected ? null : s.id)}
								className="flex w-full items-baseline gap-2 text-left text-control hover:underline"
								aria-pressed={s.id === selected}
							>
								<span className="font-medium text-foreground">{s.display || s.id}</span>
								<span className="text-passive">
									{s.messageCount} · {cliChainState(s) === "verified" ? null : t("uctm.cli.unverified")}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{selected && transcript.data && (
				<div className="mt-3 border-t border-border pt-3">
					<p className="text-caption text-passive">
						{transcript.data.total} · {t("uctm.cli.capped", { count: transcript.data.cappedAt })}
						{transcript.data.chainOk ? null : ` · ${t("uctm.cli.unverified")}`}
					</p>
					{transcript.data.events.map((e) => (
						<details key={e.seq} className="mt-2 text-control">
							<summary className="cursor-pointer text-foreground">
								#{e.seq} {e.kind}
							</summary>
							<pre className="mt-1 overflow-auto rounded bg-surface p-2 text-caption">
								{renderEventData(e.data)}
							</pre>
						</details>
					))}
				</div>
			)}
		</section>
	);
}
