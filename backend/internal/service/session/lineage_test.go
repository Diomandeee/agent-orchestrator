package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func worktree(t *testing.T, root, namespace, role, session string) domain.SessionWorktreeRecord {
	t.Helper()
	dir := filepath.Join(root, "worktrees", namespace)
	if role != "" {
		dir = filepath.Join(dir, role)
	}
	dir = filepath.Join(dir, session)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	return domain.SessionWorktreeRecord{SessionID: domain.SessionID(session), WorktreePath: dir, Branch: "ao/" + session + "/root"}
}

func findingCodes(report LineageReport) map[string]int {
	codes := map[string]int{}
	for _, finding := range report.Findings {
		codes[finding.Code]++
	}
	return codes
}

func TestLineageBuildsWorkerEdgesFromWorktreePlacement(t *testing.T) {
	root := t.TempDir()
	st := newFakeStore()
	for _, id := range []domain.SessionID{"scratch-3", "scratch-5", "scratch-6"} {
		kind := domain.KindWorker
		if id == "scratch-3" {
			kind = domain.KindOrchestrator
		}
		st.sessions[id] = domain.SessionRecord{ID: id, ProjectID: "scratch", Kind: kind}
	}
	st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-3")}
	st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "scratch-5")}
	st.worktrees["scratch-6"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "scratch-6")}

	report, err := (&Service{store: st}).Lineage(context.Background(), "scratch")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if report.Degraded || len(report.Findings) != 0 {
		t.Fatalf("clean forest reported findings: %+v", report.Findings)
	}
	byID := map[domain.SessionID]LineageNode{}
	for _, node := range report.Nodes {
		byID[node.SessionID] = node
	}
	for _, worker := range []domain.SessionID{"scratch-5", "scratch-6"} {
		if byID[worker].ParentID != "scratch-3" || byID[worker].EdgeSource != EdgeWorkspace {
			t.Fatalf("%s parent = %q/%q, want scratch-3/workspace", worker, byID[worker].ParentID, byID[worker].EdgeSource)
		}
		if byID[worker].Depth != 1 {
			t.Fatalf("%s depth = %d, want 1", worker, byID[worker].Depth)
		}
	}
	if len(report.Roots) != 1 || report.Roots[0] != "scratch-3" {
		t.Fatalf("roots = %v, want [scratch-3]", report.Roots)
	}
	if len(byID["scratch-3"].Children) != 2 {
		t.Fatalf("root children = %v, want two workers", byID["scratch-3"].Children)
	}
	if report.Counts.Orchestrators != 1 || report.Counts.Workers != 2 || report.Counts.Roots != 1 {
		t.Fatalf("counts = %+v", report.Counts)
	}
	// Both edges here are folder-derived, and the summary has to say so: the
	// declared counter staying at zero is what keeps the inference visible.
	if report.Counts.InferredEdges != 2 || report.Counts.DeclaredEdges != 0 {
		t.Fatalf("counts edges = inferred %d declared %d, want 2 and 0",
			report.Counts.InferredEdges, report.Counts.DeclaredEdges)
	}
}

// The declared branch has no producer yet, so this table is the only coverage it
// gets: when a writer lands, the counter must already classify it correctly.
func TestEdgeCountsClassifiesBySource(t *testing.T) {
	nodes := []LineageNode{
		{SessionID: "scratch-3"},
		{SessionID: "scratch-5", ParentID: "scratch-3", EdgeSource: EdgeWorkspace},
		{SessionID: "scratch-6", ParentID: "scratch-3", EdgeSource: EdgeWorkspace},
		{SessionID: "scratch-7", ParentID: "scratch-3", EdgeSource: EdgeDeclared},
	}
	inferred, declared := edgeCounts(nodes)
	if inferred != 2 || declared != 1 {
		t.Fatalf("edgeCounts = %d inferred, %d declared; want 2 and 1", inferred, declared)
	}
	if inferred, declared := edgeCounts(nil); inferred != 0 || declared != 0 {
		t.Fatalf("edgeCounts(nil) = %d, %d; want zeroes", inferred, declared)
	}
	// A parent link with no source is a bug in the resolver, not an edge: it must
	// not be silently counted as either kind.
	inferred, declared = edgeCounts([]LineageNode{{SessionID: "scratch-8", ParentID: "scratch-3"}})
	if inferred != 0 || declared != 0 {
		t.Fatalf("unlabelled edge counted as %d inferred, %d declared; want zeroes", inferred, declared)
	}
}

func TestLineageReportsDegradedShapes(t *testing.T) {
	root := t.TempDir()
	gone := filepath.Join(root, "worktrees", "scratch", "workers", "scratch-reaped")

	tests := []struct {
		name       string
		build      func(st *fakeStore)
		wantCode   string
		wantSever  string
		wantEdges  bool
		wantDegrad bool
	}{
		{
			name: "worker with no orchestrator in its namespace",
			build: func(st *fakeStore) {
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "scratch-5")}
			},
			wantCode: FindingOrphanedWorker, wantSever: SeverityDefect, wantDegrad: true,
		},
		{
			name: "two orchestrators make every worker's parent a guess",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.sessions["scratch-4"] = domain.SessionRecord{ID: "scratch-4", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-3")}
				st.worktrees["scratch-4"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-4")}
				st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "scratch-5")}
			},
			wantCode: FindingAmbiguousParent, wantSever: SeverityAttention, wantEdges: false, wantDegrad: false,
		},
		{
			name: "orchestrator sitting under the workers directory",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "scratch-3")}
			},
			wantCode: FindingKindContradiction, wantSever: SeverityDefect, wantDegrad: true,
		},
		{
			name: "ordinal reused inside one namespace",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.sessions["dup-5"] = domain.SessionRecord{ID: "dup-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-3")}
				st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "scratch-5")}
				st.worktrees["dup-5"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "workers", "dup-5")}
			},
			wantCode: FindingDuplicateOrdinal, wantSever: SeverityAttention, wantEdges: true, wantDegrad: false,
		},
		{
			name: "live session whose worktree has been reaped",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-3")}
				st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{{SessionID: "scratch-5", WorktreePath: gone}}
			},
			wantCode: FindingWorktreeMissing, wantSever: SeverityDefect, wantEdges: true, wantDegrad: true,
		},
		{
			name: "live session with no worktree row at all",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-3")}
			},
			wantCode: FindingNoWorktreeRecord, wantSever: SeverityDefect, wantDegrad: true,
		},
		{
			name: "one session split across two namespaces",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator}
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{worktree(t, root, "scratch", "orchestrators", "scratch-3")}
				st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{
					worktree(t, root, "scratch", "workers", "scratch-5"),
					worktree(t, root, "other", "workers", "scratch-5"),
				}
			},
			wantCode: FindingNamespaceMismatch, wantSever: SeverityAttention, wantDegrad: false,
		},
		{
			name: "terminated session whose worktree is gone is not a finding",
			build: func(st *fakeStore) {
				st.sessions["scratch-3"] = domain.SessionRecord{ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator, IsTerminated: true}
				st.sessions["scratch-5"] = domain.SessionRecord{ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker, IsTerminated: true}
				st.worktrees["scratch-3"] = []domain.SessionWorktreeRecord{{SessionID: "scratch-3", WorktreePath: filepath.Join(root, "worktrees", "scratch", "orchestrators", "scratch-3")}}
				st.worktrees["scratch-5"] = []domain.SessionWorktreeRecord{{SessionID: "scratch-5", WorktreePath: filepath.Join(root, "worktrees", "scratch", "workers", "scratch-5")}}
			},
			wantCode: "", wantDegrad: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := newFakeStore()
			tt.build(st)
			report, err := (&Service{store: st}).Lineage(context.Background(), "scratch")
			if err != nil {
				t.Fatalf("Lineage: %v", err)
			}
			if report.Degraded != tt.wantDegrad {
				t.Fatalf("degraded = %v, want %v (findings %+v)", report.Degraded, tt.wantDegrad, report.Findings)
			}
			codes := findingCodes(report)
			if tt.wantCode == "" {
				if len(report.Findings) != 0 {
					t.Fatalf("expected no findings, got %+v", report.Findings)
				}
				return
			}
			if codes[tt.wantCode] == 0 {
				t.Fatalf("missing finding %s; got %+v", tt.wantCode, report.Findings)
			}
			for _, finding := range report.Findings {
				if finding.Code == tt.wantCode && finding.Severity != tt.wantSever {
					t.Fatalf("finding %s severity = %q, want %q", tt.wantCode, finding.Severity, tt.wantSever)
				}
				if finding.Detail == "" || finding.Evidence == "" {
					t.Fatalf("finding %+v carries no pointer, so it is not evidence", finding)
				}
			}
			if tt.wantEdges {
				edges := 0
				for _, node := range report.Nodes {
					if node.ParentID != "" {
						edges++
					}
				}
				if edges == 0 {
					t.Fatalf("expected at least one resolved edge")
				}
			}
		})
	}
}

func TestLineageRequiresAProject(t *testing.T) {
	if _, err := (&Service{store: newFakeStore()}).Lineage(context.Background(), ""); err == nil {
		t.Fatal("expected an error for an empty project id")
	}
}

// TestLineageReadsPlacementFromTheSessionRecord covers the shape a live daemon
// actually has: session_worktrees is empty (zero rows against a database with
// thirteen sessions), and the worktree path lives on the session row itself. A
// resolver that read only the table called every session a root.
func TestLineageReadsPlacementFromTheSessionRecord(t *testing.T) {
	root := t.TempDir()
	st := newFakeStore()
	orchestrator := worktree(t, root, "scratch", "orchestrators", "scratch-3")
	worker := worktree(t, root, "scratch", "workers", "scratch-5")
	st.sessions["scratch-3"] = domain.SessionRecord{
		ID: "scratch-3", ProjectID: "scratch", Kind: domain.KindOrchestrator,
		Metadata: domain.SessionMetadata{WorkspacePath: orchestrator.WorktreePath, Branch: orchestrator.Branch},
	}
	st.sessions["scratch-5"] = domain.SessionRecord{
		ID: "scratch-5", ProjectID: "scratch", Kind: domain.KindWorker,
		Metadata: domain.SessionMetadata{WorkspacePath: worker.WorktreePath, Branch: worker.Branch},
	}
	// No st.worktrees entries at all: the fallback is the only source here.

	report, err := (&Service{store: st}).Lineage(context.Background(), "scratch")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if report.Degraded || len(report.Findings) != 0 {
		t.Fatalf("placement on record was reported as a finding: %+v", report.Findings)
	}
	byID := map[domain.SessionID]LineageNode{}
	for _, node := range report.Nodes {
		if node.Workspaces == nil {
			t.Fatalf("session %s serializes workspaces as null; an unmeasured list is not an empty one", node.SessionID)
		}
		byID[node.SessionID] = node
	}
	if byID["scratch-5"].ParentID != "scratch-3" || byID["scratch-5"].EdgeSource != EdgeWorkspace {
		t.Fatalf("scratch-5 parent = %q/%q, want scratch-3/workspace", byID["scratch-5"].ParentID, byID["scratch-5"].EdgeSource)
	}
	if len(byID["scratch-5"].Children) != 0 {
		t.Fatalf("worker has children: %v", byID["scratch-5"].Children)
	}
	if len(byID["scratch-3"].Children) != 1 || byID["scratch-3"].Children[0] != "scratch-5" {
		t.Fatalf("root children = %v, want [scratch-5]", byID["scratch-3"].Children)
	}
	if got := byID["scratch-5"].Workspaces[0]; got.Source != WorkspaceFromSessionRecord || !got.PathPresent {
		t.Fatalf("scratch-5 workspace = %+v, want a present session_record placement", got)
	}
	if got := byID["scratch-3"].Workspaces[0]; got.Source != WorkspaceFromSessionRecord {
		t.Fatalf("scratch-3 workspace source = %q, want %q", got.Source, WorkspaceFromSessionRecord)
	}
}

func TestNodeDepthReportsACycleRatherThanLooping(t *testing.T) {
	nodes := map[domain.SessionID]*LineageNode{
		"a": {SessionID: "a", ParentID: "b"},
		"b": {SessionID: "b", ParentID: "a"},
		"c": {SessionID: "c", ParentID: "a"},
		"d": {SessionID: "d", ParentID: "missing"},
	}
	if got := nodeDepth("a", nodes); got != -1 {
		t.Fatalf("nodeDepth(a) = %d, want -1 for a cycle", got)
	}
	if got := nodeDepth("d", nodes); got != 0 {
		t.Fatalf("nodeDepth(d) = %d, want 0 for a chain ending off the map", got)
	}
}

func TestParseWorktreePlacement(t *testing.T) {
	tests := []struct {
		path      string
		namespace string
		role      string
		ok        bool
	}{
		{"/x/uctm-studio/data/worktrees/scratch/workers/scratch-5", "scratch", "worker", true},
		{"/x/uctm-studio/data/worktrees/scratch/orchestrators/scratch-3", "scratch", "orchestrator", true},
		{"/x/data/worktrees/uctm-proof/uctm-proof-1", "uctm-proof", "", true},
		{"/tmp/unrelated/path", "", "", false},
	}
	for _, tt := range tests {
		namespace, role, ok := parseWorktreePlacement(tt.path)
		if namespace != tt.namespace || role != tt.role || ok != tt.ok {
			t.Fatalf("parseWorktreePlacement(%q) = %q,%q,%v want %q,%q,%v", tt.path, namespace, role, ok, tt.namespace, tt.role, tt.ok)
		}
	}
}

func TestSessionOrdinal(t *testing.T) {
	for _, tt := range []struct {
		id   domain.SessionID
		want int
	}{
		{"scratch-5", 5}, {"scratch-11", 11}, {"mer-9", 9}, {"uctm-proof-1", 1}, {"named", 0}, {"trailing-", 0},
	} {
		if got := sessionOrdinal(tt.id); got != tt.want {
			t.Fatalf("sessionOrdinal(%q) = %d, want %d", tt.id, got, tt.want)
		}
	}
}
