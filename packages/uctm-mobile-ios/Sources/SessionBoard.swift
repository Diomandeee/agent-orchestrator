// Session presentation rules shared with desktop Studio and the AO phone app.
//
// Ported from the AO app's `lib/sessionStatus.ts`, `lib/agentsView.ts` and
// `lib/orchestratorView.ts` so one session reads the same way in both apps:
// the same attention buckets, the same four board zones, the same archive rule,
// and the same title fallback chain. Deliberately pure Foundation — no SwiftUI,
// no URLSession — so the mapping stays unit-testable.

import Foundation

/// The daemon's terminal session statuses (`domain/status.go`).
private let terminalStatuses: Set<String> = ["killed", "terminated", "done", "cleanup", "errored", "merged"]

/// The attention taxonomy, matching the AO app's `AttentionLevel` exactly.
/// The Agents board folds these into four zones; the Orchestrator tab's pills
/// keep the six the phone renders.
enum AttentionLevel: String, CaseIterable {
    case merge, action, respond, review, pending, working, done

    /// Pill order, matching the AO orchestrator card's `ZONE_ORDER`. It is
    /// deliberately six of the seven cases: the phone counts `.action` in the
    /// zone totals but does not give it a pill, and the port keeps that.
    static let pillOrder: [AttentionLevel] = [.merge, .respond, .review, .pending, .working, .done]

    var label: String {
        switch self {
        case .merge: return "merge"
        case .action: return "action"
        case .respond: return "respond"
        case .review: return "review"
        case .pending: return "pending"
        case .working: return "working"
        case .done: return "done"
        }
    }
}

/// The four board columns, named as desktop names them.
enum BoardZone: String, CaseIterable {
    case action, merge, working, pending

    /// Mobile's action-first section order.
    static let displayOrder: [BoardZone] = [.action, .merge, .working, .pending]

    var label: String {
        switch self {
        case .merge: return "Ready to merge"
        case .action: return "Needs you"
        case .pending: return "In review"
        case .working: return "Working"
        }
    }
}

/// Where a project's orchestrator is in its lifecycle. The daemon sends no
/// single state field, so a session is only "stopped" when explicitly flagged —
/// a build that omits `isTerminated` must not read every live orchestrator dead.
enum OrchestratorState {
    case missing, stopped, running

    var label: String {
        switch self {
        case .missing: return "Not started"
        case .stopped: return "Stopped"
        case .running: return "Running"
        }
    }
}

func isTerminalStatus(_ status: String?) -> Bool {
    guard let status, !status.isEmpty else { return false }
    return terminalStatuses.contains(status)
}

/// Which attention bucket a session is in.
///
/// Precedence matches the AO app: a server-computed level wins, and only a
/// session without one is recomputed from `status` and `prs`. One deliberate
/// difference — the AO app blind-casts whatever string it is handed and would
/// propagate an unknown value, while this returns a typed enum and so treats an
/// unrecognised value as absent and recomputes. Treating garbage as `working`
/// is not more faithful, it is just quieter.
///
/// Terminal statuses win first in the recomputation (desktop's rule), so
/// `errored` files as `done` rather than `respond` — kept deliberately, because
/// diverging here would make the phone disagree with the desktop board about
/// the same session.
func attentionOf(_ session: StudioSession) -> AttentionLevel {
    if let raw = session.attentionLevel, let level = AttentionLevel(rawValue: raw) { return level }
    let pr = session.prs?.first
    if session.status == "merged" || session.status == "done" || isTerminalStatus(session.status) { return .done }
    if pr?.mergeability == "mergeable" || session.status == "mergeable" || session.status == "approved" { return .merge }
    if session.status == "needs_input" || session.status == "stuck" || session.status == "errored" { return .respond }
    if pr?.ci == "failing" || pr?.review == "changes_requested"
        || session.status == "ci_failed" || session.status == "changes_requested" { return .review }
    if session.status == "pr_open" || session.status == "review_pending" { return .pending }
    return .working
}

/// Title fallback chain, matching the AO app rung for rung:
/// `displayName ?? issueId ?? issueTitle ?? userPrompt ?? summary ?? id`.
///
/// The middle three are null on every session the phone has today, so only the
/// first two rungs and the id actually fire — but they are walked here anyway,
/// because a port that lists fewer rungs agrees with the phone only for as long
/// as the phone keeps those three null.
///
/// Candidates are checked after trimming, so a displayName of `" "` does not
/// win and render a nameless card.
func sessionTitle(_ session: StudioSession) -> String {
    let candidates = [session.displayName, session.issueId, session.issueTitle, session.userPrompt, session.summary]
    for candidate in candidates {
        if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty { return trimmed }
    }
    let id = session.id.trimmingCharacters(in: .whitespacesAndNewlines)
    return id.isEmpty ? session.id : id
}

/// Desktop's archive rule: a dead *runtime*, not a finished outcome. A session
/// that merged while its agent is still alive belongs on the board, not here.
func isArchived(_ session: StudioSession) -> Bool {
    session.isTerminated == true || session.status == "terminated"
}

/// Which column a session belongs in.
func boardZoneOf(_ session: StudioSession) -> BoardZone {
    switch attentionOf(session) {
    case .merge: return .merge
    case .pending: return .pending
    case .respond, .review, .action: return .action
    case .working, .done: return .working
    }
}

/// One rendered board section.
struct BoardSection: Identifiable {
    let zone: BoardZone
    let sessions: [StudioSession]

    var id: String { zone.rawValue }
    var label: String { zone.label }
}

private func activityKey(_ session: StudioSession) -> String { session.lastActivityAt ?? "" }

/// Pinned first, then activity. Working is newest-first; the rest oldest-first,
/// so the thing that has been waiting longest surfaces at the top.
private func precedesInZone(_ zone: BoardZone, _ a: StudioSession, _ b: StudioSession) -> Bool {
    let pinnedA = a.isPinned == true
    let pinnedB = b.isPinned == true
    if pinnedA != pinnedB { return pinnedA }
    let left = activityKey(a)
    let right = activityKey(b)
    return zone == .working ? right < left : left < right
}

/// The board split into its four sections, plus the archive.
///
/// Empty zones are dropped rather than rendered as empty headers — on a phone a
/// run of empty section titles is most of the screen.
func groupSessions(_ sessions: [StudioSession]) -> (sections: [BoardSection], archived: [StudioSession]) {
    var live: [StudioSession] = []
    var archived: [StudioSession] = []
    for session in sessions {
        if isArchived(session) { archived.append(session) } else { live.append(session) }
    }

    var byZone: [BoardZone: [StudioSession]] = [:]
    for session in live { byZone[boardZoneOf(session), default: []].append(session) }

    let sections = BoardZone.displayOrder.compactMap { zone -> BoardSection? in
        guard var bucket = byZone[zone], !bucket.isEmpty else { return nil }
        bucket.sort { precedesInZone(zone, $0, $1) }
        return BoardSection(zone: zone, sessions: bucket)
    }

    archived.sort { a, b in
        let pinnedA = a.isPinned == true
        let pinnedB = b.isPinned == true
        if pinnedA != pinnedB { return pinnedA }
        return activityKey(b) < activityKey(a)
    }
    return (sections, archived)
}

/// Worker sessions bucketed by attention zone, for the orchestrator card pills.
func zoneCounts(_ sessions: [StudioSession]) -> [AttentionLevel: Int] {
    var counts: [AttentionLevel: Int] = [:]
    for session in sessions { counts[attentionOf(session), default: 0] += 1 }
    return counts
}

func orchestratorState(_ link: StudioSession?) -> OrchestratorState {
    guard let link, !link.id.isEmpty else { return .missing }
    if link.isTerminated == true { return .stopped }
    return .running
}

/// The one live orchestrator for a project. The daemon can hold more than one
/// record for a project (restarts leave retired sessions behind), so prefer a
/// running one over a stopped one before falling back to the newest.
func orchestratorLink(for projectId: String, in orchestrators: [StudioSession]) -> StudioSession? {
    let forProject = orchestrators.filter { $0.projectId == projectId }
    if let running = forProject.first(where: { orchestratorState($0) == .running }) { return running }
    return forProject.max { activityKey($0) < activityKey($1) }
}

/// The project's worker sessions.
///
/// The daemon has no parent/orchestrator column, so sessions relate to an
/// orchestrator only by sharing a project — which is why the card says
/// "workers", not "its workers".
func workersOf(_ sessions: [StudioSession], projectId: String, link: StudioSession?) -> [StudioSession] {
    sessions.filter { $0.projectId == projectId && $0.id != link?.id }
}

/// Counts for the Agents-tab summary strip.
func fleetCounts(_ sessions: [StudioSession]) -> (working: Int, needsYou: Int, mergeable: Int) {
    var working = 0
    var needsYou = 0
    var mergeable = 0
    for session in sessions {
        switch attentionOf(session) {
        case .working: working += 1
        case .respond, .review, .action: needsYou += 1
        case .merge: mergeable += 1
        case .pending, .done: break
        }
    }
    return (working, needsYou, mergeable)
}
