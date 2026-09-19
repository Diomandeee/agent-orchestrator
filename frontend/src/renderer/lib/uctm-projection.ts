import type { components } from "../../api/schema";
import type { MessageKey } from "../i18n/messages";

/**
 * The UCTM projection view is deliberately state-first. A reader must be able to
 * tell "AO holds no UCTM fact" from "AO holds a UCTM fact that says nothing"
 * before they see a single payload field, because the second reading is the one
 * that turns a cache into an authority claim.
 *
 * Everything in this module is pure so the classification can be tested without
 * a daemon: the components only render what these functions decide.
 */
export type UctmProjectionResult = components["schemas"]["UCTMProjectionResponse"];

/** The v0 read set, in the order the view presents it. Closed: an unknown kind is a bug. */
export const uctmProjectionKinds = [
	"status",
	"program",
	"lanes",
	"gates",
	"receipts",
	"families",
	"adjudication_queue",
	"evaluations",
] as const;

export type UctmProjectionKind = (typeof uctmProjectionKinds)[number];

export const uctmProjectionKindLabelKeys: Record<UctmProjectionKind, MessageKey> = {
	status: "uctm.kind.status",
	program: "uctm.kind.program",
	lanes: "uctm.kind.lanes",
	gates: "uctm.kind.gates",
	receipts: "uctm.kind.receipts",
	families: "uctm.kind.families",
	adjudication_queue: "uctm.kind.adjudication_queue",
	evaluations: "uctm.kind.evaluations",
};

/**
 * Tone is derived from freshness alone, and there are exactly four outcomes.
 * There is no "healthy" tone on purpose: a green badge for a projection AO does
 * not hold would be the exact failure this surface exists to prevent.
 */
export type UctmTone = "disabled" | "fresh" | "stale" | "unknown";

/** Freshness copy is keyed by tone, so a new tone cannot ship without copy. */
const uctmToneLabelKeys: Record<UctmTone, MessageKey> = {
	fresh: "uctm.freshness.fresh",
	stale: "uctm.freshness.stale",
	disabled: "uctm.freshness.disabled",
	unknown: "uctm.freshness.unknown",
};

export function uctmTone(freshness: string): UctmTone {
	switch (freshness) {
		case "fresh":
			return "fresh";
		case "stale":
			return "stale";
		case "disabled":
			return "disabled";
		default:
			return "unknown";
	}
}

/**
 * Whether a payload may be rendered at all. AO omits the payload unless it holds
 * a projection, so an undefined payload is information, not a rendering gap.
 */
export function uctmShowsPayload(projection: UctmProjectionResult): boolean {
	return projection.payload !== undefined && projection.payload !== null;
}

/** Stable machine reasons the view has copy for. Anything else is shown verbatim. */
export const uctmKnownReasons = [
	"mode_off",
	"transport_not_configured",
	"service_unavailable",
	"service_rejected",
	"no_facts",
	"projection_expired",
	"fresh_projection",
	"projection_not_persisted",
	"no_projection",
] as const;

export type UctmKnownReason = (typeof uctmKnownReasons)[number];

/** One key per reason the daemon can send. A new reason needs a key or the raw code shows. */
const uctmReasonLabelKeys: Record<UctmKnownReason, MessageKey> = {
	mode_off: "uctm.reason.mode_off",
	transport_not_configured: "uctm.reason.transport_not_configured",
	service_unavailable: "uctm.reason.service_unavailable",
	service_rejected: "uctm.reason.service_rejected",
	no_facts: "uctm.reason.no_facts",
	projection_expired: "uctm.reason.projection_expired",
	fresh_projection: "uctm.reason.fresh_projection",
	projection_not_persisted: "uctm.reason.projection_not_persisted",
	no_projection: "uctm.reason.no_projection",
};

export function uctmReasonLabelKey(reason: string): MessageKey | null {
	return isKnownUctmReason(reason) ? uctmReasonLabelKeys[reason] : null;
}

export function isKnownUctmReason(reason: string): reason is UctmKnownReason {
	return (uctmKnownReasons as readonly string[]).includes(reason);
}

/**
 * The two facts a reader needs before the payload: how current the projection is
 * and whether AO is claiming anything with it. The authority ceiling is echoed
 * and never interpreted — AO's mode, not the ceiling, decides what AO does.
 */
export type UctmStateSummary = {
	tone: UctmTone;
	freshnessKey: MessageKey;
	reasonKey: MessageKey | null;
	reasonCode: string;
	showsPayload: boolean;
	/** True when the projection exists but its window has closed. */
	expired: boolean;
};

export function uctmStateSummary(projection: UctmProjectionResult): UctmStateSummary {
	const tone = uctmTone(projection.freshness);
	return {
		tone,
		freshnessKey: uctmToneLabelKeys[tone],
		reasonKey: uctmReasonLabelKey(projection.reason),
		reasonCode: projection.reason,
		showsPayload: uctmShowsPayload(projection),
		expired: projection.expiresAt !== null && projection.expiresAt !== undefined
			? Date.parse(projection.expiresAt) <= Date.now()
			: false,
	};
}

/**
 * Provenance rows, in the order a reader checks them. Fields AO did not receive
 * are omitted rather than rendered blank, so a missing value cannot be mistaken
 * for a value that arrived empty.
 */
export type UctmProvenanceRow = { key: string; labelKey: MessageKey; value: string };

const uctmProvenanceLabelKeys: Record<string, MessageKey> = {
	schemaVersion: "uctm.field.schemaVersion",
	freeze: "uctm.field.freeze",
	historical: "uctm.field.historical",
	authority: "uctm.field.authority",
	generatedAt: "uctm.field.generatedAt",
	observedAt: "uctm.field.observedAt",
	expiresAt: "uctm.field.expiresAt",
	contentHash: "uctm.field.contentHash",
	sourceHash: "uctm.field.sourceHash",
	receipt: "uctm.field.receipt",
};

function optional(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function uctmProvenanceRows(projection: UctmProjectionResult): UctmProvenanceRow[] {
	const rows: UctmProvenanceRow[] = [];
	const push = (key: keyof typeof uctmProvenanceLabelKeys, value: string | null) => {
		if (value !== null) rows.push({ key, labelKey: uctmProvenanceLabelKeys[key], value });
	};
	push("schemaVersion", optional(projection.schemaVersion));
	push("freeze", optional(projection.sourceCommitOrFreezeId));
	push("historical", optional(projection.historicalOrCurrent));
	push("authority", optional(projection.authorityCeiling));
	push("generatedAt", optional(projection.generatedAt));
	push("observedAt", optional(projection.observedAt));
	push("expiresAt", optional(projection.expiresAt));
	push("contentHash", optional(projection.contentHashOrEtag));
	push("sourceHash", optional(projection.sourceHash));
	push("receipt", optional(projection.receiptRef));
	return rows;
}

/**
 * Payload text for display. A payload that cannot be pretty-printed is shown
 * exactly as received rather than replaced with an error, because hiding it
 * would hide whichever field the reader is looking for.
 */
export function uctmPayloadText(payload: unknown): string {
	if (payload === undefined || payload === null) return "";
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}
