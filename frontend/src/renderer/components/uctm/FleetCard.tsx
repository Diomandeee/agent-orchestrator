import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParkPacketQuery } from "../../hooks/useParks";
import { useDistQueue } from "../../hooks/useDistQueue";
import { cn } from "../../lib/utils";
import { fleetResumeCommand, type DistQueueItem, type FleetPacket } from "../../lib/fleet";
import type { ParkSummary } from "../../lib/parks";
import { ResumeCommand } from "./ResumeCommand";

/**
 * One fleet-board card: a cohort app (or program/kit node) with its tackle
 * list. Presentational only — state comes from the packet, actions are
 * resume hints. Fetching lives in the panel; packet detail loads on expand
 * so the board mounts with list data alone.
 */
export function FleetCard({ park }: { park: ParkSummary }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const blocked = park.blocked?.length ?? 0;
	return (
		<section
			aria-label={park.name}
			className="rounded-lg border border-border bg-card p-4"
			data-fleet={park.name}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-subtitle font-semibold text-foreground">{park.name}</h3>
					{park.tier ? (
						<p className="mt-0.5 font-mono text-caption text-muted-foreground">{park.tier}</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span
						className={cn(
							"rounded-md px-2.5 py-1 text-caption font-semibold",
							park.status === "active" ? "bg-success/15 text-success" : "bg-raised text-passive",
						)}
					>
						{t(park.status === "active" ? "uctm.fleet.status.active" : "uctm.fleet.status.parked")}
					</span>
					<span
						className={cn(
							"rounded-md px-2.5 py-1 text-caption font-semibold",
							blocked > 0 ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
						)}
					>
						{blocked > 0
							? t("uctm.fleet.blocked", { count: blocked })
							: t("uctm.fleet.next", { count: park.next?.length ?? 0 })}
					</span>
				</div>
			</div>

			{park.state ? (
				<p className="mt-3 text-control leading-row text-muted-foreground">{park.state}</p>
			) : null}

			{blocked > 0 && park.blocked ? (
				<ul className="mt-3 flex flex-col gap-1.5">
					{park.blocked.slice(0, 3).map((item) => (
						<li key={item} className="flex gap-2 text-control text-foreground">
							<span aria-hidden className="font-bold text-warning">
								!
							</span>
							<span>{item}</span>
						</li>
					))}
					{blocked > 3 ? (
						<li className="text-caption text-passive">
							{t("uctm.fleet.more", { count: blocked - 3 })}
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
							{t("uctm.fleet.more", { count: (park.next?.length ?? 0) - 3 })}
						</li>
					) : null}
				</ul>
			) : null}

			<ResumeCommand
				command={fleetResumeCommand(park.name)}
				label={t("uctm.fleet.resume")}
				copyLabel={t("uctm.fleet.copy")}
				copiedLabel={t("uctm.fleet.copied")}
			/>

			<details
				className="mt-4"
				onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}
			>
				<summary className="cursor-pointer text-caption font-medium text-muted-foreground hover:text-foreground">
					{t("uctm.fleet.packet.show")}
				</summary>
				{expanded ? <FleetPacketView name={park.name} /> : null}
			</details>
		</section>
	);
}

function FleetPacketView({ name }: { name: string }) {
	const { t } = useTranslation();
	const query = useParkPacketQuery(name);
	if (query.isPending) {
		return <p className="mt-2 text-control text-passive">{t("uctm.fleet.loading")}</p>;
	}
	if (query.isError || !query.data) {
		return (
			<p role="alert" className="mt-2 text-control text-destructive">
				{query.error instanceof Error ? query.error.message : t("uctm.fleet.packet.absent")}
			</p>
		);
	}
	const packet = query.data.packet as unknown as FleetPacket;
	return (
		<div className="mt-2 flex flex-col gap-3">
			<FleetQueueSection name={name} />
			{packet.next && packet.next.length > 0 ? (
				<ol className="flex flex-col gap-1.5">
					{packet.next.map((item) => (
						<li key={item} className="flex gap-2 text-control text-foreground">
							<span aria-hidden className="text-passive">{"\u25CB"}</span>
							<span>{item}</span>
						</li>
					))}
				</ol>
			) : null}
			{packet.depends_on && packet.depends_on.length > 0 ? (
				<p className="text-caption text-passive">
					{t("uctm.fleet.dependsOn")}{" "}
					{packet.depends_on.map((dep) => (
						<code
							key={dep}
							className="mr-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-caption text-foreground"
						>
							{dep}
						</code>
					))}
				</p>
			) : null}
			{packet.related && packet.related.length > 0 ? (
				<p className="text-caption text-passive">
					{t("uctm.fleet.related")}{" "}
					{packet.related.map((rel) => (
						<code
							key={rel}
							className="mr-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-caption text-foreground"
						>
							{rel}
						</code>
					))}
				</p>
			) : null}
		</div>
	);
}

/**
 * This park's distribution queue, read-only like the rest of the board.
 * Queued posts go out through the distribution lane, never from here.
 */
function FleetQueueSection({ name }: { name: string }) {
	const { t } = useTranslation();
	const query = useDistQueue();
	if (query.isPending) {
		return <p className="mt-2 text-control text-passive">{t("uctm.fleet.loading")}</p>;
	}
	if (query.isError || !query.data) {
		return (
			<p role="alert" className="mt-2 text-control text-destructive">
				{query.error instanceof Error ? query.error.message : t("uctm.fleet.error")}
			</p>
		);
	}
	const items = query.data.filter((item) => item.park === name);
	if (items.length === 0) {
		return <p className="mt-2 text-control text-passive">{t("uctm.fleet.queue.empty")}</p>;
	}
	return (
		<div className="mt-2 flex flex-col gap-1.5">
			<h4 className="text-caption font-semibold text-muted-foreground">
				{t("uctm.fleet.queue.title")}
			</h4>
			<ul className="flex flex-col gap-2">
				{items.map((item) => (
					<FleetQueueItem key={item.id} item={item} />
				))}
			</ul>
		</div>
	);
}

function distStatusKey(status: DistQueueItem["status"]): string {
	switch (status) {
		case "draft":
			return "uctm.fleet.status.draft";
		case "scheduled":
			return "uctm.fleet.status.scheduled";
		case "posted":
			return "uctm.fleet.status.posted";
		case "linked":
			return "uctm.fleet.status.linked";
		case "failed":
			return "uctm.fleet.status.failed";
	}
}

function FleetQueueItem({ item }: { item: DistQueueItem }) {
	const { t } = useTranslation();
	return (
		<li className="flex flex-col gap-1 rounded-md border border-border bg-background p-2">
			<div className="flex items-center justify-between gap-2">
				<span className="min-w-0 truncate text-control text-foreground">{item.caption}</span>
				<span
					className={cn(
						"shrink-0 rounded-md px-2 py-0.5 text-caption font-semibold",
						item.status === "linked" || item.status === "posted"
							? "bg-success/15 text-success"
							: item.status === "scheduled"
								? "bg-warning/15 text-warning"
								: item.status === "failed"
									? "bg-destructive/15 text-destructive"
									: "bg-raised text-passive",
					)}
				>
					{t(distStatusKey(item.status))}
				</span>
			</div>
			{item.scheduled_at ? (
				<p className="font-mono text-caption text-passive">{item.scheduled_at}</p>
			) : null}
			{item.status === "linked" ? (
				<p className="text-caption text-passive">
					{t("uctm.fleet.queue.stats", {
						views: item.views ?? 0,
						likes: item.likes ?? 0,
						comments: item.comments ?? 0,
					})}
				</p>
			) : null}
		</li>
	);
}
