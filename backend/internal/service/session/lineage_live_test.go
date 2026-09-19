package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// TestLineageAgainstLiveDatabase runs the resolver over a real AO data
// directory and checks the invariants that must hold for *any* database, not
// for a particular fixture.
//
// It is opt-in: it reads the operator's live ao.db, which no CI job has. Set
// AO_LINEAGE_DATA_DIR to the directory containing ao.db to run it. The store is
// opened mode=ro, so the check cannot write — including migration state.
//
// The fixtures in lineage_test.go pin behaviour on shapes we chose. This pins
// behaviour on shapes we did not, which is the half a hand-written table can
// never cover.
func TestLineageAgainstLiveDatabase(t *testing.T) {
	dataDir := os.Getenv("AO_LINEAGE_DATA_DIR")
	if dataDir == "" {
		t.Skip("set AO_LINEAGE_DATA_DIR to the AO data directory (the one holding ao.db) to run the live check")
	}
	project := os.Getenv("AO_LINEAGE_PROJECT")

	ctx := context.Background()
	store, err := sqlite.OpenReadOnly(ctx, dataDir)
	if err != nil {
		t.Fatalf("open read-only store at %s: %v", dataDir, err)
	}
	defer func() { _ = store.Close() }()

	projects, err := store.ListProjects(ctx)
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	if project == "" {
		for _, record := range projects {
			if record.ID == "" {
				continue
			}
			checkOneProject(t, ctx, store, domain.ProjectID(record.ID))
		}
		return
	}
	checkOneProject(t, ctx, store, domain.ProjectID(project))
}

func checkOneProject(t *testing.T, ctx context.Context, store *sqlite.Store, project domain.ProjectID) {
	t.Helper()
	report, err := (&Service{store: store}).Lineage(ctx, project)
	if err != nil {
		t.Fatalf("lineage %s: %v", project, err)
	}

	byID := map[domain.SessionID]LineageNode{}
	order := make([]domain.SessionID, 0, len(report.Nodes))
	for _, node := range report.Nodes {
		if _, dup := byID[node.SessionID]; dup {
			t.Errorf("%s: session %s appears twice in Nodes", project, node.SessionID)
		}
		if node.SessionID == "" {
			t.Errorf("%s: a node carries no session id", project)
		}
		if node.ParentID == node.SessionID && node.ParentID != "" {
			t.Errorf("%s: session %s is its own parent", project, node.SessionID)
		}
		if node.Depth < 0 {
			t.Errorf("%s: session %s has negative depth %d", project, node.SessionID, node.Depth)
		}
		if node.Depth > len(report.Nodes) {
			t.Errorf("%s: session %s depth %d exceeds the node count", project, node.SessionID, node.Depth)
		}
		// nil marshals to null, and null reads as "not measured" where the report
		// did measure and found nothing. The desktop list view renders both.
		if node.Workspaces == nil {
			t.Errorf("%s: session %s serializes workspaces as null, want []", project, node.SessionID)
		}
		for _, workspace := range node.Workspaces {
			if workspace.Source != WorkspaceFromWorktreeRow && workspace.Source != WorkspaceFromSessionRecord {
				t.Errorf("%s: session %s workspace %s has source %q, which names no record", project, node.SessionID, workspace.Path, workspace.Source)
			}
		}
		if (node.ParentID == "") != (node.EdgeSource == "") {
			t.Errorf("%s: session %s has parent %q and edge source %q; an edge and its provenance must appear together",
				project, node.SessionID, node.ParentID, node.EdgeSource)
		}
		byID[node.SessionID] = node
		order = append(order, node.SessionID)
	}

	// A resolved edge must land inside the report. A parent that is not a node
	// would render as a subtree hanging off nothing.
	for _, node := range report.Nodes {
		if node.ParentID != "" && byID[node.ParentID].SessionID == "" {
			t.Errorf("%s: session %s points at parent %s, which is not in the report", project, node.SessionID, node.ParentID)
		}
	}

	// Children is the inverse of ParentID, exactly: no missing child, no extra.
	for id, node := range byID {
		want := make([]domain.SessionID, 0, len(byID))
		for otherID, other := range byID {
			if other.ParentID == id {
				want = append(want, otherID)
			}
		}
		sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
		if len(node.Children) != len(want) {
			t.Errorf("%s: session %s lists %d children, want %d (%v vs %v)", project, id, len(node.Children), len(want), node.Children, want)
			continue
		}
		for i := range want {
			if node.Children[i] != want[i] {
				t.Errorf("%s: session %s children[%d] = %s, want %s", project, id, i, node.Children[i], want[i])
			}
		}
	}

	// Roots must be every parentless node, once, in id order.
	wantRoots := make([]domain.SessionID, 0, len(report.Roots))
	for _, node := range report.Nodes {
		if node.ParentID == "" {
			wantRoots = append(wantRoots, node.SessionID)
		}
	}
	if len(wantRoots) != len(report.Roots) {
		t.Errorf("%s: Roots = %v, want %d parentless nodes %v", project, report.Roots, len(wantRoots), wantRoots)
	}
	for i := 0; i < len(report.Roots) && i < len(wantRoots); i++ {
		if report.Roots[i] != wantRoots[i] {
			t.Errorf("%s: Roots[%d] = %s, want %s", project, i, report.Roots[i], wantRoots[i])
		}
	}
	for i := 1; i < len(report.Roots); i++ {
		if report.Roots[i-1] >= report.Roots[i] {
			t.Errorf("%s: Roots is not sorted and unique at %d: %v", project, i, report.Roots)
			break
		}
	}

	// Every finding must carry the pointer it was read from, or it is an opinion.
	defects := 0
	for _, finding := range report.Findings {
		if finding.Code == "" || finding.Detail == "" || finding.Evidence == "" {
			t.Errorf("%s: finding %+v carries no pointer, so it is not evidence", project, finding)
		}
		switch finding.Severity {
		case SeverityDefect:
			defects++
		case SeverityAttention:
		default:
			t.Errorf("%s: finding %s has unknown severity %q", project, finding.Code, finding.Severity)
		}
	}

	// Counts are a summary of the same report, not a second opinion about it.
	if report.Counts.Orchestrators+report.Counts.Workers != len(report.Nodes) {
		t.Errorf("%s: counts %+v do not sum to %d nodes", project, report.Counts, len(report.Nodes))
	}
	if report.Counts.Findings != len(report.Findings) {
		t.Errorf("%s: counts.findings = %d, want %d", project, report.Counts.Findings, len(report.Findings))
	}
	if report.Counts.Defects != defects {
		t.Errorf("%s: counts.defects = %d, want %d", project, report.Counts.Defects, defects)
	}
	if report.Counts.Roots != len(report.Roots) {
		t.Errorf("%s: counts.roots = %d, want %d", project, report.Counts.Roots, len(report.Roots))
	}
	if report.Degraded != (defects > 0) {
		t.Errorf("%s: degraded = %v with %d defects", project, report.Degraded, defects)
	}

	// Every drawn edge is classified, and the classifier is the same one the
	// resolver labels nodes with. This is the invariant that survives a writer
	// landing: the sum must track the nodes, whichever kind they are.
	edges, inferred, declared := 0, 0, 0
	for _, node := range report.Nodes {
		if node.ParentID == "" {
			if node.EdgeSource != "" {
				t.Errorf("%s: %s has no parent but edgeSource %q", project, node.SessionID, node.EdgeSource)
			}
			continue
		}
		edges++
		switch node.EdgeSource {
		case EdgeWorkspace:
			inferred++
		case EdgeDeclared:
			declared++
		default:
			t.Errorf("%s: %s has parent %s but edgeSource %q, so the link is unattributed",
				project, node.SessionID, node.ParentID, node.EdgeSource)
		}
	}
	if report.Counts.InferredEdges != inferred || report.Counts.DeclaredEdges != declared {
		t.Errorf("%s: counts edges = inferred %d declared %d, but nodes say %d and %d",
			project, report.Counts.InferredEdges, report.Counts.DeclaredEdges, inferred, declared)
	}
	if report.Counts.InferredEdges+report.Counts.DeclaredEdges != edges {
		t.Errorf("%s: counts edges = %d, but %d nodes carry a parent",
			project, report.Counts.InferredEdges+report.Counts.DeclaredEdges, edges)
	}
	t.Logf("%s: %d nodes, %d parent links (%d inferred, %d declared), %d roots, %d findings",
		project, len(report.Nodes), edges, inferred, declared, len(report.Roots), len(report.Findings))

	rendered, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatalf("%s: marshal report: %v", project, err)
	}
	t.Logf("project %s\n%s\n%s", project, renderLineageTree(report), rendered)
}

// renderLineageTree is the human-readable half of the report: the shape a
// hierarchy view would draw, with findings attached where they were observed.
func renderLineageTree(report LineageReport) string {
	byID := map[domain.SessionID]LineageNode{}
	for _, node := range report.Nodes {
		byID[node.SessionID] = node
	}
	nested := map[domain.SessionID][]LineageFinding{}
	var unattached []LineageFinding
	for _, finding := range report.Findings {
		if finding.SessionID == "" {
			unattached = append(unattached, finding)
			continue
		}
		nested[finding.SessionID] = append(nested[finding.SessionID], finding)
	}

	var b strings.Builder
	var walk func(id domain.SessionID, depth int)
	walk = func(id domain.SessionID, depth int) {
		node := byID[id]
		label := node.DisplayName
		if label == "" {
			label = "-"
		}
		fmt.Fprintf(&b, "%s%s [%s/%s] %s ns=%s ord=%d\n",
			strings.Repeat("  ", depth), id, node.Kind, node.Harness, label, node.Namespace, node.Ordinal)
		for _, finding := range nested[id] {
			fmt.Fprintf(&b, "%s  ! %s (%s): %s\n", strings.Repeat("  ", depth), finding.Code, finding.Severity, finding.Detail)
		}
		for _, child := range node.Children {
			walk(child, depth+1)
		}
	}
	for _, root := range report.Roots {
		walk(root, 0)
	}
	for _, finding := range unattached {
		fmt.Fprintf(&b, "! %s (%s): %s\n", finding.Code, finding.Severity, finding.Detail)
	}
	return b.String()
}
