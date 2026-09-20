import { describe, expect, it } from "vitest";
import { cliChainState, renderEventData } from "./cli-sessions";

describe("cliChainState", () => {
	it("is verified only when the daemon checked the chain", () => {
		expect(cliChainState({ chainOk: true })).toBe("verified");
		expect(cliChainState({ chainOk: false })).toBe("unverified");
	});
});

describe("renderEventData", () => {
	it("renders secret handles verbatim without expansion", () => {
		const data = { credential: "keychain:DEEPSEEK_API_KEY", nested: { ref: "handle:abc" } };
		const out = renderEventData(data);
		expect(out).toContain("keychain:DEEPSEEK_API_KEY");
		expect(out).toContain("handle:abc");
		// Round-trips exactly: nothing added, nothing redacted.
		expect(JSON.parse(out)).toEqual(data);
	});
});
