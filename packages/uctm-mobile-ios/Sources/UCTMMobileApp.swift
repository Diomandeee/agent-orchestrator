import AVFoundation
import SwiftUI

@main
struct UCTMMobileApp: App {
    var body: some Scene { WindowGroup { RootView() } }
}

@MainActor
final class StudioState: ObservableObject {
    @Published var api: StudioAPI?
    @Published var projects: [StudioProject] = []
    @Published var sessions: [StudioSession] = []
    @Published var orchestrators: [StudioSession] = []
    @Published var error: String?
    @Published var loading = false
    @Published var selectedProjectId: String?

    init() {
        if let (connection, password) = ConnectionStorage.load() {
            api = StudioAPI(connection: connection, password: password)
        }
    }

    /// The board the user is looking at: every project, or the selected one.
    var visibleSessions: [StudioSession] {
        guard let selectedProjectId else { return sessions }
        return sessions.filter { $0.projectId == selectedProjectId }
    }

    var visibleProjects: [StudioProject] {
        guard let selectedProjectId else { return projects }
        return projects.filter { $0.id == selectedProjectId }
    }

    func projectName(_ id: String) -> String {
        projects.first { $0.id == id }?.name ?? id
    }

    func refresh() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            // Probe sessions first: one bad password causes one failure, not
            // several concurrent failures that can trigger the daemon lockout.
            let receivedSessions = try await api.sessions()
            async let receivedProjects = api.projects()
            async let receivedOrchestrators = api.orchestrators()
            sessions = receivedSessions
            projects = try await receivedProjects
            orchestrators = try await receivedOrchestrators
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func pair(_ connection: StudioConnection, password: String) async throws {
        let candidate = StudioAPI(connection: connection, password: password)
        let receivedSessions = try await candidate.sessions()
        let receivedProjects = try await candidate.projects()
        // Losing the orchestrator read must not fail pairing: the session board
        // is the app's floor, the orchestrator surface is additive.
        let receivedOrchestrators = (try? await candidate.orchestrators()) ?? []
        try ConnectionStorage.save(connection, password: password)
        api = candidate
        sessions = receivedSessions
        projects = receivedProjects
        orchestrators = receivedOrchestrators
        selectedProjectId = nil
        error = nil
    }

    func disconnect() {
        ConnectionStorage.clear()
        api = nil
        projects = []
        sessions = []
        orchestrators = []
        selectedProjectId = nil
        error = nil
    }
}

struct RootView: View {
    @StateObject private var state = StudioState()

    var body: some View {
        Group {
            if state.api == nil {
                NavigationStack { PairView(state: state) }
            } else {
                MainTabView(state: state)
            }
        }
        .tint(.cyan)
        .preferredColorScheme(.dark)
    }
}

// MARK: - Tabs

struct MainTabView: View {
    @ObservedObject var state: StudioState

    var body: some View {
        TabView {
            NavigationStack { AgentsView(state: state) }
                .tabItem { Label("Agents", systemImage: "square.stack.3d.up") }
            NavigationStack { OrchestratorView(state: state) }
                .tabItem { Label("Orchestrator", systemImage: "point.3.connected.trianglepath.dotted") }
            NavigationStack { SettingsView(state: state) }
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .task { await state.refresh() }
    }
}

// MARK: - Agents

struct AgentsView: View {
    @ObservedObject var state: StudioState
    @State private var archiveOpen = false

    private var sections: [BoardSection] { groupSessions(state.visibleSessions).sections }
    private var archived: [StudioSession] { groupSessions(state.visibleSessions).archived }

    var body: some View {
        List {
            if let error = state.error {
                Section { Text(error).foregroundStyle(.orange).font(.footnote) }
            }

            if !state.visibleSessions.isEmpty {
                Section {
                    FleetStats(counts: fleetCounts(state.visibleSessions))
                }
            }

            ForEach(sections) { section in
                Section {
                    ForEach(section.sessions) { session in
                        sessionLink(session)
                    }
                } header: {
                    HStack {
                        Circle().fill(zoneColor(section.zone)).frame(width: 8, height: 8)
                        Text(section.label)
                        Spacer()
                        Text("\(section.sessions.count)").foregroundStyle(.secondary)
                    }
                }
            }

            if !archived.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $archiveOpen) {
                        ForEach(archived) { session in
                            sessionLink(session)
                        }
                    } label: {
                        Text("Archive").foregroundStyle(.secondary)
                    }
                }
            }

            if state.visibleSessions.isEmpty && !state.loading {
                Section { Text("No sessions in Studio yet.").foregroundStyle(.secondary) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Agents")
        .refreshable { await state.refresh() }
        .toolbar { projectMenu }
    }

    private func sessionLink(_ session: StudioSession) -> some View {
        NavigationLink {
            ConversationView(api: state.api, session: session)
        } label: {
            SessionRow(session: session, projectName: state.projectName(session.projectId))
        }
    }

    private var projectMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("All projects") { state.selectedProjectId = nil }
                ForEach(state.projects) { project in
                    Button(project.name) { state.selectedProjectId = project.id }
                }
            } label: {
                Label("Project", systemImage: "line.3.horizontal.decrease.circle")
            }
        }
    }
}

struct SessionRow: View {
    let session: StudioSession
    let projectName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.title).lineLimit(2)
            HStack(spacing: 6) {
                Text(projectName)
                Text("·")
                Text(session.status ?? "unknown").foregroundStyle(statusColor(session.status))
                if let harness = session.harness, !harness.isEmpty {
                    Text("·")
                    Text(harness)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let branch = session.branch, !branch.isEmpty {
                Text(branch).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

struct FleetStats: View {
    let counts: (working: Int, needsYou: Int, mergeable: Int)

    var body: some View {
        HStack {
            stat(counts.working, "working", .cyan)
            Divider()
            stat(counts.needsYou, "need you", .orange)
            Divider()
            stat(counts.mergeable, "mergeable", .green)
        }
        .frame(maxWidth: .infinity)
    }

    private func stat(_ n: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(n)").font(.title3.bold()).foregroundStyle(color)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Orchestrator

struct OrchestratorView: View {
    @ObservedObject var state: StudioState

    var body: some View {
        List {
            if let error = state.error {
                Section { Text(error).foregroundStyle(.orange).font(.footnote) }
            }

            ForEach(state.visibleProjects) { project in
                let link = orchestratorLink(for: project.id, in: state.orchestrators)
                let workers = workersOf(state.visibleSessions, projectId: project.id, link: link)
                Section(project.name) {
                    OrchestratorCard(state: state, project: project, link: link, workers: workers)
                }
            }

            if state.visibleProjects.isEmpty && !state.loading {
                Section {
                    Text("No orchestrators yet. Start one in Studio, then refresh here.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Orchestrator")
        .refreshable { await state.refresh() }
    }
}

struct OrchestratorCard: View {
    @ObservedObject var state: StudioState
    let project: StudioProject
    let link: StudioSession?
    let workers: [StudioSession]

    private var orchestratorStateValue: OrchestratorState { orchestratorState(link) }
    private var counts: [AttentionLevel: Int] { zoneCounts(workers) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(stateColor).frame(width: 9, height: 9)
                Text(orchestratorStateValue.label).font(.subheadline.bold())
                Spacer()
                if let status = link?.status {
                    Text(status).font(.caption).foregroundStyle(statusColor(status))
                }
            }

            if let link {
                NavigationLink {
                    ConversationView(api: state.api, session: link)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(link.title)
                        Text("\(link.mode ?? "tui") · \(link.harness ?? "agent")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("No orchestrator session for this project yet. Start one from Studio to coordinate work here.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if !workers.isEmpty {
                Text("\(workers.count) worker\(workers.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ForEach(AttentionLevel.pillOrder, id: \.self) { level in
                        if let count = counts[level], count > 0 {
                            Text("\(count) \(level.label)")
                                .font(.caption2)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(attentionColor(level).opacity(0.2), in: Capsule())
                                .foregroundStyle(attentionColor(level))
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var stateColor: Color {
        switch orchestratorStateValue {
        case .missing: return .gray
        case .stopped: return .secondary
        case .running: return .green
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @ObservedObject var state: StudioState

    var body: some View {
        List {
            Section("Connection") {
                if let connection = state.api?.connection {
                    LabeledContent("Studio", value: "\(connection.host):\(connection.port)")
                    LabeledContent("Transport", value: connection.secure ? "Secure (Tailscale)" : "Local network")
                }
                Button("Refresh now") { Task { await state.refresh() } }
            }

            Section("Pairing") {
                Text("Open Connect Mobile in Studio on your Mac and scan its pairing code, or enter the address and password by hand. The password is kept in this iPhone's Keychain.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Disconnect and pair again", role: .destructive) { state.disconnect() }
            }

            Section("About") {
                Text("UCTM is a thin client. The Studio daemon, its models, and its evidence and governance gates stay on the Mac; this app drives sessions and reads their conversations.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
    }
}

// MARK: - Pairing

struct PairView: View {
    @ObservedObject var state: StudioState
    @State private var host = ""
    @State private var port = "3011"
    @State private var password = ""
    @State private var secure = false
    @State private var scanning = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Connect to UCTM Studio")
                        .font(.title2.bold())
                    Text("Open Connect Mobile in Studio on this Mac. Scan its pairing code, or enter its address and password below.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
            Section("Pairing") {
                Button("Scan Studio QR code", systemImage: "qrcode.viewfinder") { requestCamera() }
                TextField("Host (e.g. 192.168.1.20)", text: $host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                TextField("Port", text: $port).keyboardType(.numberPad)
                SecureField("Connection password", text: $password)
                Toggle("Secure Tailscale connection", isOn: $secure)
                Button(busy ? "Connecting…" : "Connect") {
                    Task { await connect() }
                }
                .disabled(busy)
            }
            Section {
                Text("On a trusted home LAN, Studio uses an authenticated but unencrypted connection. Use secure Tailscale pairing on other networks. The password stays in this iPhone's Keychain.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let message {
                Section { Text(message).foregroundStyle(.orange) }
            }
        }
        .navigationTitle("UCTM")
        .sheet(isPresented: $scanning) {
            NavigationStack {
                PairingScanner { code in
                    scanning = false
                    do {
                        let (connection, scannedPassword) = try PairingCode.parse(code)
                        host = connection.host
                        port = String(connection.port)
                        secure = connection.secure
                        if !scannedPassword.isEmpty { password = scannedPassword }
                        message = nil
                        if !password.isEmpty { Task { await connect() } }
                    } catch {
                        message = error.localizedDescription
                    }
                }
                .ignoresSafeArea()
                .toolbar { Button("Cancel") { scanning = false } }
            }
        }
    }

    private func requestCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: scanning = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { allowed in
                Task { @MainActor in
                    if allowed { scanning = true }
                    else { message = "Camera access is needed to scan. You can still enter the connection manually." }
                }
            }
        default: message = "Enable Camera access in iPhone Settings, or enter the connection manually."
        }
    }

    private func connect() async {
        busy = true
        defer { busy = false }
        do {
            guard let number = Int(port) else { throw StudioError.invalidAddress }
            let connection = try StudioConnection.validated(host: host, port: number, secure: secure)
            try await state.pair(connection, password: password)
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
}

// MARK: - Conversation

struct ConversationView: View {
    let api: StudioAPI?
    let session: StudioSession
    @State private var messages: [StudioMessage] = []
    @State private var draft = ""
    @State private var error: String?
    @State private var sending = false

    /// Chat sessions have a durable conversation controller. Terminal sessions
    /// do not — their conversation read returns a conflict — so they are driven
    /// by a single line into the terminal instead.
    private var isChat: Bool { session.mode == "chat" }

    var body: some View {
        VStack(spacing: 0) {
            if let error {
                Text(error).font(.footnote).foregroundStyle(.orange).padding(.horizontal).padding(.top, 8)
            }

            if isChat {
                transcript
            } else {
                terminalNote
            }

            if session.isTerminated == true {
                Text("This session has ended. Its record stays readable here.")
                    .font(.footnote).foregroundStyle(.secondary).padding()
            } else {
                composer
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } } }
        .task { await refresh() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(messages) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.role == "user" ? "You" : "Agent")
                                .font(.caption.bold()).foregroundStyle(.cyan)
                            Text(item.text).textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                        .id(item.id)
                    }
                    if messages.isEmpty {
                        Text("No messages yet.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .padding()
            }
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    private var terminalNote: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Terminal session").font(.headline)
                Text("This session runs in a terminal, so it has no chat transcript. Anything you send below is typed into its terminal, the same as in Studio.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let branch = session.branch, !branch.isEmpty {
                    Text(branch).font(.caption).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    private var composer: some View {
        HStack {
            TextField(isChat ? "Message this task" : "Send a line to the terminal", text: $draft, axis: .vertical)
                .lineLimit(1...5)
            Button("Send", systemImage: "arrow.up.circle.fill") { Task { await send() } }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || api == nil)
        }
        .padding()
        .background(.bar)
    }

    private func refresh() async {
        guard isChat, let api else { return }
        do {
            messages = try await api.messages(sessionID: session.id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let api else { return }
        sending = true
        defer { sending = false }
        do {
            if isChat {
                try await api.send(text: text, sessionID: session.id)
            } else {
                try await api.steer(text: text, sessionID: session.id)
            }
            draft = ""
            await refresh()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Colors

func zoneColor(_ zone: BoardZone) -> Color {
    switch zone {
    case .merge: return .green
    case .action: return .orange
    case .pending: return .gray
    case .working: return .cyan
    }
}

func attentionColor(_ level: AttentionLevel) -> Color {
    switch level {
    case .merge: return .green
    case .respond, .action: return .orange
    case .review: return .yellow
    case .pending: return .gray
    case .working: return .cyan
    case .done: return .secondary
    }
}

func statusColor(_ status: String?) -> Color {
    if isTerminalStatus(status) { return .gray }
    switch status {
    case "working": return .cyan
    case "needs_input": return .orange
    case "mergeable", "approved", "merged", "done": return .green
    case "ci_failed", "changes_requested": return .red
    default: return .secondary
    }
}
