import { useEffect, useRef, useState } from "react";

async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the legacy path below.
	}
	try {
		if (typeof document === "undefined" || typeof document.execCommand !== "function") {
			return false;
		}
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "absolute";
		area.style.left = "-9999px";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * The terminal resume hint with a copy button. Read-only views cannot wake a
 * thread themselves; the kindest thing they can do is put the exact resume
 * command on the clipboard. Feedback appears only when the copy succeeded —
 * a "Copied" note after a failed copy would be a lie.
 */
export function ResumeCommand({
	command,
	label,
	copyLabel,
	copiedLabel,
}: {
	command: string;
	label: string;
	copyLabel: string;
	copiedLabel: string;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);
	return (
		<div className="mt-4 flex flex-wrap items-center gap-2 text-caption text-passive">
			<span>{label}</span>
			<code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-caption text-foreground">
				{command}
			</code>
			<button
				type="button"
				aria-label={copyLabel}
				onClick={async () => {
					if (await copyText(command)) {
						setCopied(true);
						if (timer.current !== null) window.clearTimeout(timer.current);
						timer.current = window.setTimeout(() => setCopied(false), 1500);
					}
				}}
				className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-raised px-2 py-1 font-medium text-muted-foreground transition-colors duration-200 hover:border-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<svg
					aria-hidden
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect width="14" height="14" x="8" y="8" rx="2" />
					<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
				</svg>
				{copied ? copiedLabel : copyLabel}
			</button>
		</div>
	);
}
