import XCTest
@testable import UCTMMobile

/// These tests pin the phone's session presentation to the rules desktop Studio
/// and the AO app already use. A session must read the same way in all three, so
/// the mapping is asserted directly rather than through a rendered view.
final class SessionBoardTests: XCTestCase {

    // MARK: - Fixtures

    private func put(_ object: inout [String: Any], _ key: String, _ value: Any?) {
        if let value { object[key] = value }
    }

    /// Builds a session through the real decode path, so a wire-shape change
    /// fails these tests rather than silently producing an empty model.
    private func makeSession(
        id: String = "scratch-1",
        projectId: String = "scratch",
        issueId: String? = nil,
        issueTitle: String? = nil,
        userPrompt: String? = nil,
        summary: String? = nil,
        attentionLevel: String? = nil,
        kind: String? = "worker",
        harness: String? = "codex",
        displayName: String? = nil,
        mode: String? = "chat",
        status: String? = "working",
        isTerminated: Bool? = false,
        isPinned: Bool? = false,
        branch: String? = nil,
        lastActivityAt: String? = "2026-09-18T12:00:00Z",
        prs: [[String: Any]] = []
    ) throws -> StudioSession {
        var object: [String: Any] = ["id": id, "projectId": projectId, "prs": prs]
        put(&object, "issueId", issueId)
        put(&object, "issueTitle", issueTitle)
        put(&object, "userPrompt", userPrompt)
        put(&object, "summary", summary)
        put(&object, "attentionLevel", attentionLevel)
        put(&object, "kind", kind)
        put(&object, "harness", harness)
        put(&object, "displayName", displayName)
        put(&object, "mode", mode)
        put(&object, "status", status)
        put(&object, "isTerminated", isTerminated)
        put(&object, "isPinned", isPinned)
        put(&object, "branch", branch)
        if let lastActivityAt {
            object["activity"] = ["state": "active", "lastActivityAt": lastActivityAt]
            object["updatedAt"] = lastActivityAt
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(StudioSession.self, from: data)
    }

    // MARK: - Attention

    func testAttentionBucketsMatchDesktopVocabulary() throws {
        XCTAssertEqual(attentionOf(try makeSession(status: "needs_input")), .respond)
        XCTAssertEqual(attentionOf(try makeSession(status: "ci_failed")), .review)
        XCTAssertEqual(attentionOf(try makeSession(status: "changes_requested")), .review)
        XCTAssertEqual(attentionOf(try makeSession(status: "mergeable")), .merge)
        XCTAssertEqual(attentionOf(try makeSession(status: "approved")), .merge)
        XCTAssertEqual(attentionOf(try makeSession(status: "pr_open")), .pending)
        XCTAssertEqual(attentionOf(try makeSession(status: "review_pending")), .pending)
        XCTAssertEqual(attentionOf(try makeSession(status: "working")), .working)
        XCTAssertEqual(attentionOf(try makeSession(status: "idle")), .working)
        XCTAssertEqual(attentionOf(try makeSession(status: "terminated")), .done)
    }

    /// The AO app defers to a server-computed level when one is present. This
    /// daemon never sends one today, so the port has to be checked against a
    /// fixture or the deference is untested and the two apps agree only while
    /// the server keeps not sending it.
    func testServerAttentionLevelWinsOverRecomputation() throws {
        let session = try makeSession(attentionLevel: "merge", status: "working")
        XCTAssertEqual(attentionOf(session), .merge)
        XCTAssertEqual(boardZoneOf(session), .merge)
    }

    func testActionIsARealAttentionLevelAndFoldsIntoTheActionZone() throws {
        // "action" is reachable only through the server field, never from the
        // recomputation — which is why a six-case port would mis-file it.
        let session = try makeSession(attentionLevel: "action", status: "working")
        XCTAssertEqual(attentionOf(session), .action)
        XCTAssertEqual(attentionOf(session), AttentionLevel(rawValue: "action"))
        XCTAssertEqual(boardZoneOf(session), .action)
        XCTAssertTrue(AttentionLevel.allCases.contains(.action))
    }

    func testUnrecognisedServerAttentionLevelRecomputesInsteadOfLeaking() throws {
        // The AO app blind-casts, so it would propagate "nonsense". A typed
        // enum cannot, and quietly treating it as absent is the safer read.
        let session = try makeSession(attentionLevel: "nonsense", status: "needs_input")
        XCTAssertEqual(attentionOf(session), .respond)
    }

    func testMergedSessionIsDoneEvenWhileItsRuntimeIsAlive() throws {
        let session = try makeSession(status: "merged", isTerminated: false)
        XCTAssertEqual(attentionOf(session), .done)
        XCTAssertFalse(isArchived(session))
    }

    func testErroredFilesAsDoneToStayInStepWithDesktop() throws {
        // Desktop checks terminal status before `respond`, so `errored` lands in
        // `done`. Kept deliberately: diverging here would make the phone and the
        // desktop board disagree about the same session.
        XCTAssertEqual(attentionOf(try makeSession(status: "errored")), .done)
    }

    func testPRFactsDriveAttentionWhenStatusIsQuiet() throws {
        let failingCI = try makeSession(status: "working", prs: [["number": 12, "ci": "failing"]])
        XCTAssertEqual(attentionOf(failingCI), .review)
        let mergeable = try makeSession(status: "working", prs: [["number": 12, "mergeability": "mergeable"]])
        XCTAssertEqual(attentionOf(mergeable), .merge)
        let changesRequested = try makeSession(status: "working", prs: [["number": 12, "review": "changes_requested"]])
        XCTAssertEqual(attentionOf(changesRequested), .review)
    }

    func testBoardZoneFoldsSixBucketsIntoFourColumns() throws {
        XCTAssertEqual(boardZoneOf(try makeSession(status: "mergeable")), .merge)
        XCTAssertEqual(boardZoneOf(try makeSession(status: "pr_open")), .pending)
        XCTAssertEqual(boardZoneOf(try makeSession(status: "needs_input")), .action)
        XCTAssertEqual(boardZoneOf(try makeSession(status: "ci_failed")), .action)
        XCTAssertEqual(boardZoneOf(try makeSession(status: "working")), .working)
        XCTAssertEqual(boardZoneOf(try makeSession(status: "merged", isTerminated: false)), .working)
    }

    // MARK: - Titles

    func testTitleFallsBackThroughDisplayNameThenIssueIdThenId() throws {
        XCTAssertEqual((try makeSession(displayName: "Named by hand")).title, "Named by hand")
        XCTAssertEqual((try makeSession(issueId: "Fix the listener")).title, "Fix the listener")
        XCTAssertEqual((try makeSession()).title, "scratch-1")
    }

    /// The AO app walks five candidates before the id. The three middle rungs
    /// are null on every session today, so a two-rung port passes every test
    /// written against live data — these fixtures are the only way to pin them.
    func testTitleChainCoversEveryRungThePhoneWalks() throws {
        XCTAssertEqual((try makeSession(issueTitle: "From the tracker")).title, "From the tracker")
        XCTAssertEqual((try makeSession(userPrompt: "Fix the listener")).title, "Fix the listener")
        XCTAssertEqual((try makeSession(summary: "Listener repaired")).title, "Listener repaired")
        // Order matters: an earlier rung beats a later one.
        XCTAssertEqual((try makeSession(issueId: "issue-id", issueTitle: "issue-title")).title, "issue-id")
        XCTAssertEqual(
            (try makeSession(issueTitle: "issue-title", userPrompt: "user-prompt", summary: "summary")).title,
            "issue-title"
        )
    }

    func testBlankDisplayNameDoesNotWin() throws {
        let session = try makeSession(issueId: "Real title", displayName: "   ")
        XCTAssertEqual(session.title, "Real title")
    }

    // MARK: - Archive

    func testArchiveRuleIsDeadRuntimeNotFinishedOutcome() throws {
        XCTAssertTrue(isArchived(try makeSession(status: "terminated", isTerminated: true)))
        XCTAssertTrue(isArchived(try makeSession(status: "working", isTerminated: true)))
        XCTAssertFalse(isArchived(try makeSession(status: "merged", isTerminated: false)))
        XCTAssertFalse(isArchived(try makeSession(status: "working", isTerminated: nil)))
    }

    // MARK: - Grouping and ordering

    func testGroupSessionsDropsEmptyZonesAndLeadsWithAction() throws {
        let sessions = [
            try makeSession(id: "w", status: "working"),
            try makeSession(id: "a", status: "needs_input"),
        ]
        let grouped = groupSessions(sessions)
        XCTAssertEqual(grouped.sections.map(\.zone), [.action, .working])
        XCTAssertEqual(grouped.sections.first?.sessions.map(\.id), ["a"])
    }

    func testOrderingIsOldestFirstOutsideWorkingAndNewestFirstInsideIt() throws {
        let sessions = [
            try makeSession(id: "action-new", status: "needs_input", lastActivityAt: "2026-09-18T12:00:03Z"),
            try makeSession(id: "action-old", status: "needs_input", lastActivityAt: "2026-09-18T12:00:01Z"),
            try makeSession(id: "work-old", status: "working", lastActivityAt: "2026-09-18T12:00:01Z"),
            try makeSession(id: "work-new", status: "working", lastActivityAt: "2026-09-18T12:00:05Z"),
        ]
        let grouped = groupSessions(sessions)
        XCTAssertEqual(grouped.sections.first(where: { $0.zone == .action })?.sessions.map(\.id), ["action-old", "action-new"])
        XCTAssertEqual(grouped.sections.first(where: { $0.zone == .working })?.sessions.map(\.id), ["work-new", "work-old"])
    }

    func testPinnedSessionsSortAboveUnpinnedOnes() throws {
        let sessions = [
            try makeSession(id: "new", status: "needs_input", lastActivityAt: "2026-09-18T12:00:09Z"),
            try makeSession(id: "pinned", status: "needs_input", isPinned: true, lastActivityAt: "2026-09-18T12:00:01Z"),
        ]
        let grouped = groupSessions(sessions)
        XCTAssertEqual(grouped.sections.first?.sessions.map(\.id), ["pinned", "new"])
    }

    func testArchivedSessionsLeaveTheBoardAndSortNewestFirst() throws {
        let sessions = [
            try makeSession(id: "live", status: "working"),
            try makeSession(id: "dead-old", status: "terminated", isTerminated: true, lastActivityAt: "2026-09-18T12:00:01Z"),
            try makeSession(id: "dead-new", status: "terminated", isTerminated: true, lastActivityAt: "2026-09-18T12:00:09Z"),
        ]
        let grouped = groupSessions(sessions)
        XCTAssertEqual(grouped.sections.flatMap(\.sessions).map(\.id), ["live"])
        XCTAssertEqual(grouped.archived.map(\.id), ["dead-new", "dead-old"])
    }

    // MARK: - Orchestrator

    func testOrchestratorStateTreatsAMissingFlagAsRunning() throws {
        XCTAssertEqual(orchestratorState(nil), .missing)
        XCTAssertEqual(orchestratorState(try makeSession(kind: "orchestrator", isTerminated: true)), .stopped)
        XCTAssertEqual(orchestratorState(try makeSession(kind: "orchestrator", isTerminated: false)), .running)
        // A build that omits the flag must not read a live orchestrator as dead.
        XCTAssertEqual(orchestratorState(try makeSession(kind: "orchestrator", isTerminated: nil)), .running)
    }

    func testOrchestratorLinkPrefersARunningSessionOverARetiredOne() throws {
        let retired = try makeSession(
            id: "orchestrator-old", kind: "orchestrator", isTerminated: true, lastActivityAt: "2026-09-18T12:00:09Z")
        let live = try makeSession(
            id: "orchestrator-live", kind: "orchestrator", isTerminated: false, lastActivityAt: "2026-09-18T12:00:01Z")
        let otherProject = try makeSession(id: "other", projectId: "other", kind: "orchestrator", isTerminated: false)
        let link = orchestratorLink(for: "scratch", in: [retired, live, otherProject])
        XCTAssertEqual(link?.id, "orchestrator-live")
        XCTAssertNil(orchestratorLink(for: "absent", in: [retired, live]))
    }

    func testWorkersExcludeTheOrchestratorAndOtherProjects() throws {
        let link = try makeSession(id: "orchestrator-live", kind: "orchestrator")
        let sessions = [
            link,
            try makeSession(id: "worker-a"),
            try makeSession(id: "worker-b"),
            try makeSession(id: "elsewhere", projectId: "other"),
        ]
        let workers = workersOf(sessions, projectId: "scratch", link: link)
        XCTAssertEqual(workers.map(\.id), ["worker-a", "worker-b"])
    }

    // MARK: - Counts

    func testZoneCountsUseTheSixBucketTaxonomy() throws {
        let counts = zoneCounts([
            try makeSession(id: "a", status: "needs_input"),
            try makeSession(id: "b", status: "ci_failed"),
            try makeSession(id: "c", status: "working"),
            try makeSession(id: "d", status: "working"),
        ])
        XCTAssertEqual(counts[.respond], 1)
        XCTAssertEqual(counts[.review], 1)
        XCTAssertEqual(counts[.working], 2)
        XCTAssertNil(counts[.merge])
    }

    func testFleetCountsDriveTheAgentsSummaryStrip() throws {
        let counts = fleetCounts([
            try makeSession(id: "a", status: "working"),
            try makeSession(id: "b", status: "needs_input"),
            try makeSession(id: "c", status: "ci_failed"),
            try makeSession(id: "d", status: "mergeable"),
            try makeSession(id: "e", status: "merged"),
        ])
        XCTAssertEqual(counts.working, 1)
        XCTAssertEqual(counts.needsYou, 2)
        XCTAssertEqual(counts.mergeable, 1)
    }

    /// The phone counts `action` under "need you" alongside `respond`, so a
    /// port that only knew six levels would undercount the strip.
    func testFleetCountsTreatServerActionAsNeedingYou() throws {
        let counts = fleetCounts([
            try makeSession(id: "a", attentionLevel: "action", status: "working"),
            try makeSession(id: "b", status: "needs_input"),
        ])
        XCTAssertEqual(counts.needsYou, 2)
        XCTAssertEqual(counts.working, 0)
    }
}
