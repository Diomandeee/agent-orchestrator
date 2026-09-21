import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParkPacketQuery } from "../../hooks/useParks";
import { parkResumeCommand, type ParkSummary } from "../../lib/parks";
import { cn } from "../../lib/utils";
import { ResumeCommand } from "./ResumeCommand";

/**
 * Presentational only: it receives a parked-idea summary and renders what
 * that packet says. Fetching lives in the panel so this card can be tested
 * against a fixture without a daemon.
 */
export function ParkCard({ park }: { park: ParkSummary }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	return (
		<section
			aria-label={park.name}
			className="rounded-lg border border-border bg-card p-4"
			data-park={park.name}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-subtitle font-semibold text-foreground">{park.name}</h2>
					{park.created ? (
						<p className="mt-0.5 font-mono text-caption text-muted-foreground">{park.created}</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span
						className={cn(
							"rounded-md px-2.5 py-1 text-caption font-semibold",
							park.status === "active"
								? "bg-success/15 text-success"
								: "bg-raised text-passive",
						)}
					>
						{t(park.status === "active" ? "uctm.garden.status.active" : "uctm.garden.status.parked")}
					</span>
					<span
						className={cn(
							"rounded-md px-2.5 py-1 text-caption font-semibold",
							(park.blocked?.length ?? 0) > 0
								? "bg-warning/15 text-warning"
								: "bg-success/15 text-success",
						)}
					>
						{(park.blocked?.length ?? 0) > 0
							? t("uctm.garden.blocked", { count: park.blocked.length })
							: t("uctm.garden.next", { count: park.next?.length ?? 0 })}
					</span>
				</div>
			</div>

			{park.state ? (
				<p className="mt-3 text-control leading-row text-muted-foreground">{park.state}</p>
			) : null}

			{(park.blocked?.length ?? 0) > 0 ? (
				<ul className="mt-3 flex flex-col gap-1.5">
					{park.blocked?.slice(0, 3).map((item) => (
						<li key={item} className="flex gap-2 text-control text-foreground">
							<span aria-hidden className="font-bold text-warning">
								!
							</span>
							<span>{item}</span>
						</li>
					))}
					{(park.blocked?.length ?? 0) > 3 ? (
						<li className="text-caption text-passive">
							{t("uctm.garden.more", { count: (park.blocked?.length ?? 0) - 3 })}
						</li>
					) : null}
				</ul>
			) : (park.next?.length ?? 0) > 0 ? (
				<ul className="mt-3 flex flex-col gap-1.5">
					{park.next?.slice(0, 3).map((item) => (
						<li key={item} className="flex gap-2 text-control text-foreground">
							<span aria-hidden className="text-passive">
								{"\u25CB"}
							</span>
							<span>{item}</span>
						</li>
					))}
					{(park.next?.length ?? 0) > 3 ? (
						<li className="text-caption text-passive">
							{t("uctm.garden.more", { count: (park.next?.length ?? 0) - 3 })}
						</li>
					) : null}
				</ul>
			) : null}

			<ResumeCommand
				command={parkResumeCommand(park.name)}
				label={t("uctm.garden.resume")}
				copyLabel={t("uctm.garden.copy")}
				copiedLabel={t("uctm.garden.copied")}
			/>

			<details
				className="mt-4"
				onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}
			>
				<summary className="cursor-pointer text-caption font-medium text-muted-foreground hover:text-foreground">
					{t("uctm.garden.packet.show")}
				</summary>
				{expanded ? <ParkPacketView name={park.name} /> : null}
			</details>
		</section>
	);
}

function ParkPacketView({ name }: { name: string }) {
	const { t } = useTranslation();
	const query = useParkPacketQuery(name);
	if (query.isPending) {
		return <p className="mt-2 text-control text-passive">{t("uctm.garden.loading")}</p>;
	}
	if (query.isError || !query.data) {
		return (
			<p role="alert" className="mt-2 text-control text-destructive">
				{query.error instanceof Error ? query.error.message : t("uctm.garden.packet.absent")}
			</p>
		);
	}
	return (
		<pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-caption text-foreground">
			{JSON.stringify(query.data.packet, null, 2)}
		</pre>
	);
}
