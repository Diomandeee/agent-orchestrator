package session

import (
	"context"
	"fmt"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Delegation lineage.
//
// AO spawns workers on behalf of an orchestrator, but the parent edge is never
// persisted: DelegateTask computes a coordinator, uses it to ask for a title, and
// returns only the worker id. The surviving evidence of the relationship is the
// worktree layout AO happens to choose -- <project>/orchestrators/<session> beside
// <project>/workers/<session>. This file makes that reconstruction explicit, names
// where each edge came from, and reports the ways the tree degrades: orphaned,
// ambiguous, contradicted, duplicated, missing.
//
// It is read-only and repairs nothing. A finding is a finding.
//
// Out of scope here, and deliberately: conversation-level collapse. Branch
// replay/compaction (conversation_branches.replay_cutoff_sequence,
// replay_truncated, replaced_turn_id) needs two Store methods that do not exist
// yet -- ListConversationBranches and ListTurnsBySession -- and a lineage that
// silently omitted them would be claiming the message layer was accounted for.

// LineageEdgeSource records where a parent edge came from, so a reader can weigh it.
type LineageEdgeSource string

const (
	// EdgeDeclared is a parent AO persisted explicitly. Nothing produces one today:
	// no store column, no spawn field, and no writer exists anywhere in the tree, so
	// this value is never emitted yet. The resolver already yields to a pre-set
	// ParentID (the `ParentID == ""` guard below), so a future writer only has to
	// persist the edge -- it does not have to change the tree walk.
	EdgeDeclared LineageEdgeSource = "declared"
	// EdgeWorkspace is derived from the AO worktree layout. It is an inference from
	// directory naming, not a recorded delegation.
	EdgeWorkspace LineageEdgeSource = "workspace"
)

// Finding codes. Each names a degraded shape rather than a broken one.
const (
	FindingOrphanedWorker    = "orphaned_worker"
	FindingAmbiguousParent   = "ambiguous_parent"
	FindingKindContradiction = "kind_path_contradiction"
	FindingDuplicateOrdinal  = "duplicate_ordinal"
	FindingNamespaceMismatch = "namespace_mismatch"
	FindingWorktreeMissing   = "worktree_missing"
	FindingNoWorktreeRecord  = "no_worktree_record"
	FindingCycle             = "parent_cycle"
)

// Finding severities. "defect" means the tree cannot be read correctly;
// "attention" means it can be read but the edge is a guess.
const (
	SeverityDefect    = "defect"
	SeverityAttention = "attention"
)

// LineageWorkspace is one worktree a session owns, reduced to what a hierarchy view
// needs. State is not exposed: SessionWorktreeRecord.State is never written by any
// live code path, so reporting it would be reporting a constant.
type LineageWorkspace struct {
	RepoName     string `json:"repoName,omitempty"`
	Branch       string `json:"branch,omitempty"`
	BaseRef      string `json:"baseRef,omitempty"`
	BaseSHA      string `json:"baseSha,omitempty"`
	Path         string `json:"path,omitempty"`
	PreservedRef string `json:"preservedRef,omitempty"`
	// Source names the record the placement was read from, so a reader can weigh
	// it the same way it weighs an edge source.
	Source LineageWorkspaceSource `json:"source"`
	// PathPresent is probed here, at read time, so a vanished worktree is visible
	// instead of being inferred from a row that still exists.
	PathPresent bool `json:"pathPresent"`
}

// LineageWorkspaceSource names which record a worktree placement came from.
type LineageWorkspaceSource string

const (
	// WorkspaceFromWorktreeRow is the per-repo session_worktrees row, the richer
	// source: one row per repo, with the base ref and SHA.
	WorkspaceFromWorktreeRow LineageWorkspaceSource = "worktree_row"
	// WorkspaceFromSessionRecord is the session row's own workspace_path. It is the
	// source a repo-less project actually has: measured against a live daemon with
	// thirteen sessions, session_worktrees held zero rows while every session row
	// carried its worktree path. A reader that trusted only the table reported
	// eleven roots and not one edge.
	WorkspaceFromSessionRecord LineageWorkspaceSource = "session_record"
)

// LineageNode is one unit of delegation.
type LineageNode struct {
	SessionID   domain.SessionID    `json:"sessionId"`
	DisplayName string              `json:"displayName,omitempty"`
	Kind        domain.SessionKind  `json:"kind"`
	Harness     domain.AgentHarness `json:"harness,omitempty"`
	Activity    string              `json:"activity,omitempty"`
	Terminated  bool                `json:"terminated"`
	ParentID    domain.SessionID    `json:"parentId,omitempty"`
	EdgeSource  LineageEdgeSource   `json:"edgeSource,omitempty"`
	Depth       int                 `json:"depth"`
	Children    []domain.SessionID  `json:"children"`
	Namespace   string              `json:"namespace,omitempty"`
	Role        string              `json:"role,omitempty"`
	Ordinal     int                 `json:"ordinal,omitempty"`
	Workspaces  []LineageWorkspace  `json:"workspaces"`
}

// LineageFinding names one degraded shape, with the pointer it was read from.
type LineageFinding struct {
	Code      string           `json:"code"`
	Severity  string           `json:"severity"`
	SessionID domain.SessionID `json:"sessionId,omitempty"`
	Namespace string           `json:"namespace,omitempty"`
	Detail    string           `json:"detail"`
	Evidence  string           `json:"evidence"`
}

// LineageCounts is the summary a list view renders without walking the tree.
type LineageCounts struct {
	Orchestrators int `json:"orchestrators"`
	Workers       int `json:"workers"`
	Roots         int `json:"roots"`
	Orphaned      int `json:"orphaned"`
	// InferredEdges counts parent links read out of the worktree layout, and
	// DeclaredEdges counts links read from a persisted parent. They are reported
	// together on purpose: until a writer exists the first number is the whole tree
	// and the second is zero, so a consumer comparing them sees the inference for
	// what it is instead of reading folder-derived structure as recorded delegation.
	InferredEdges int `json:"inferredEdges"`
	DeclaredEdges int `json:"declaredEdges"`
	Findings      int `json:"findings"`
	Defects       int `json:"defects"`
}

// LineageReport is the whole delegation forest for one project.
type LineageReport struct {
	ProjectID domain.ProjectID   `json:"projectId"`
	Roots     []domain.SessionID `json:"roots"`
	Nodes     []LineageNode      `json:"nodes"`
	Findings  []LineageFinding   `json:"findings"`
	// Degraded is true when at least one finding has severity defect.
	Degraded bool          `json:"degraded"`
	Counts   LineageCounts `json:"counts"`
}

// Lineage assembles the delegation forest for a project from the records AO already
// has. It performs one worktree read per session; the project's session count is the
// bound on that, and the read model is not cached because a stale hierarchy is worse
// than a slow one.
func (s *Service) Lineage(ctx context.Context, projectID domain.ProjectID) (LineageReport, error) {
	report := LineageReport{ProjectID: projectID}
	if projectID == "" {
		return report, fmt.Errorf("lineage requires a project id")
	}
	records, err := s.store.ListSessions(ctx, projectID)
	if err != nil {
		return report, fmt.Errorf("list sessions: %w", err)
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].ID < records[j].ID
		}
		return records[i].CreatedAt.Before(records[j].CreatedAt)
	})

	nodes := make(map[domain.SessionID]*LineageNode, len(records))
	namespace := make(map[domain.SessionID]string, len(records))
	role := make(map[domain.SessionID]string, len(records))
	var findings []LineageFinding

	for _, record := range records {
		node := &LineageNode{
			SessionID:   record.ID,
			DisplayName: record.DisplayName,
			Kind:        record.Kind,
			Harness:     record.Harness,
			Activity:    string(record.Activity.State),
			Terminated:  record.IsTerminated,
			Ordinal:     sessionOrdinal(record.ID),
			Workspaces:  []LineageWorkspace{},
			Children:    []domain.SessionID{},
		}
		rows, err := s.store.ListSessionWorktrees(ctx, record.ID)
		if err != nil {
			return report, fmt.Errorf("list worktrees for %s: %w", record.ID, err)
		}
		// The per-repo rows are the richer source, but they are not the only one,
		// and on a repo-less project the table is empty while the session row still
		// carries its worktree path. Fall back to that rather than reporting a
		// session whose placement is on record as unplaced.
		worktrees := rows
		fromSessionRecord := false
		if len(rows) == 0 && record.Metadata.WorkspacePath != "" {
			worktrees = []domain.SessionWorktreeRecord{{
				SessionID:    record.ID,
				RepoName:     domain.RootWorkspaceRepoName,
				Branch:       record.Metadata.Branch,
				BaseRef:      record.Metadata.DiffBaseRef,
				BaseSHA:      record.Metadata.DiffBaseSHA,
				WorktreePath: record.Metadata.WorkspacePath,
			}}
			fromSessionRecord = true
		}
		if len(worktrees) == 0 && !record.IsTerminated {
			findings = append(findings, LineageFinding{
				Code: FindingNoWorktreeRecord, Severity: SeverityDefect, SessionID: record.ID,
				Detail:   "a live session owns no worktree row, so its placement in the tree cannot be read",
				Evidence: "session_worktrees where session_id = " + string(record.ID),
			})
		}
		for _, worktree := range worktrees {
			present := pathExists(worktree.WorktreePath)
			source := WorkspaceFromWorktreeRow
			if fromSessionRecord {
				source = WorkspaceFromSessionRecord
			}
			node.Workspaces = append(node.Workspaces, LineageWorkspace{
				RepoName:     worktree.RepoName,
				Branch:       worktree.Branch,
				BaseRef:      worktree.BaseRef,
				BaseSHA:      worktree.BaseSHA,
				Path:         worktree.WorktreePath,
				PreservedRef: worktree.PreservedRef,
				Source:       source,
				PathPresent:  present,
			})
			if !present && !record.IsTerminated {
				findings = append(findings, LineageFinding{
					Code: FindingWorktreeMissing, Severity: SeverityDefect, SessionID: record.ID,
					Detail:   "a live session's worktree path is not on disk, so the work it delegated work into has moved or been reaped",
					Evidence: worktree.WorktreePath,
				})
			}
			ns, r, ok := parseWorktreePlacement(worktree.WorktreePath)
			if !ok {
				continue
			}
			if existing, seen := namespace[record.ID]; seen && existing != ns {
				findings = append(findings, LineageFinding{
					Code: FindingNamespaceMismatch, Severity: SeverityAttention, SessionID: record.ID,
					Detail:   fmt.Sprintf("session has worktrees in two namespaces (%s and %s), so it belongs to no single subtree", existing, ns),
					Evidence: worktree.WorktreePath,
				})
				continue
			}
			namespace[record.ID] = ns
			role[record.ID] = r
			node.Namespace, node.Role = ns, r
		}
		nodes[record.ID] = node
	}

	// Placement in a namespace is the grouping the tree is built from.
	byNamespace := make(map[string][]domain.SessionID)
	for id, ns := range namespace {
		byNamespace[ns] = append(byNamespace[ns], id)
	}
	namespaces := make([]string, 0, len(byNamespace))
	for ns := range byNamespace {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)

	for _, ns := range namespaces {
		var orchestrators, workers []domain.SessionID
		for _, id := range byNamespace[ns] {
			switch nodes[id].Kind {
			case domain.KindOrchestrator:
				orchestrators = append(orchestrators, id)
			default:
				workers = append(workers, id)
			}
			if nodes[id].Role != "" && !roleMatchesKind(nodes[id].Role, nodes[id].Kind) {
				findings = append(findings, LineageFinding{
					Code: FindingKindContradiction, Severity: SeverityDefect, SessionID: id,
					Namespace: ns,
					Detail: fmt.Sprintf("session is recorded as %s but its worktree sits under the %s directory",
						nodes[id].Kind, nodes[id].Role),
					Evidence: worktreeEvidence(nodes[id]),
				})
			}
		}
		sort.Slice(orchestrators, func(i, j int) bool {
			return nodes[orchestrators[i]].SessionID < nodes[orchestrators[j]].SessionID
		})
		sort.Slice(workers, func(i, j int) bool { return nodes[workers[i]].SessionID < nodes[workers[j]].SessionID })

		switch len(orchestrators) {
		case 1:
			parent := orchestrators[0]
			for _, worker := range workers {
				if nodes[worker].ParentID == "" && worker != parent {
					nodes[worker].ParentID = parent
					nodes[worker].EdgeSource = EdgeWorkspace
				}
			}
		case 0:
			for _, worker := range workers {
				findings = append(findings, LineageFinding{
					Code: FindingOrphanedWorker, Severity: SeverityDefect, SessionID: worker,
					Namespace: ns,
					Detail:    "namespace holds workers but no orchestrator, so the delegation this worker came from is not on record",
					Evidence:  worktreeEvidence(nodes[worker]),
				})
			}
		default:
			if len(workers) > 0 {
				findings = append(findings, LineageFinding{
					Code: FindingAmbiguousParent, Severity: SeverityAttention, Namespace: ns,
					Detail: fmt.Sprintf("namespace holds %d orchestrators and %d worker(s); the parent of each worker is not recorded, so no edge is drawn rather than guessing",
						len(orchestrators), len(workers)),
					Evidence: "namespace " + ns,
				})
			}
		}

		seen := map[int][]domain.SessionID{}
		for _, id := range byNamespace[ns] {
			if ordinal := nodes[id].Ordinal; ordinal > 0 {
				seen[ordinal] = append(seen[ordinal], id)
			}
		}
		for _, ordinal := range sortedKeys(seen) {
			ids := seen[ordinal]
			if len(ids) < 2 {
				continue
			}
			findings = append(findings, LineageFinding{
				Code: FindingDuplicateOrdinal, Severity: SeverityAttention, Namespace: ns,
				Detail:   fmt.Sprintf("namespace reuses ordinal %d across %s, so a worker number no longer identifies one session", ordinal, joinSessionIDs(ids)),
				Evidence: "session ids " + joinSessionIDs(ids),
			})
		}
	}

	// Depth, with a cycle guard: edges are inferred today and will be declared
	// tomorrow, and a declared edge is exactly the kind that can close a loop.
	for _, node := range nodes {
		node.Depth = nodeDepth(node.SessionID, nodes)
	}
	for _, node := range nodes {
		if node.Depth == -1 {
			findings = append(findings, LineageFinding{
				Code: FindingCycle, Severity: SeverityDefect, SessionID: node.SessionID,
				Detail:   "the parent chain returns to this session, so the subtree is not a tree",
				Evidence: "lineage parent edges",
			})
			node.Depth = 0
		}
	}

	ids := make([]domain.SessionID, 0, len(nodes))
	for id := range nodes {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	// Children are collected in a pass of their own. A node copied into the report
	// before its last child is appended would carry an empty Children list, and the
	// report copy is the only thing a caller ever sees.
	for _, id := range ids {
		node := nodes[id]
		node.SessionID = id
		if node.ParentID == "" || nodes[node.ParentID] == nil {
			continue
		}
		nodes[node.ParentID].Children = append(nodes[node.ParentID].Children, id)
	}
	for _, id := range ids {
		node := nodes[id]
		if node.ParentID == "" || nodes[node.ParentID] == nil {
			report.Roots = append(report.Roots, id)
		}
		report.Nodes = append(report.Nodes, *node)
	}

	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].Severity != findings[j].Severity {
			return findings[i].Severity == SeverityDefect
		}
		if findings[i].Code != findings[j].Code {
			return findings[i].Code < findings[j].Code
		}
		return findings[i].SessionID < findings[j].SessionID
	})
	report.Findings = findings
	if report.Findings == nil {
		report.Findings = []LineageFinding{}
	}
	for _, node := range report.Nodes {
		switch node.Kind {
		case domain.KindOrchestrator:
			report.Counts.Orchestrators++
		default:
			report.Counts.Workers++
		}
		if node.ParentID == "" {
			report.Counts.Orphaned++
		}
	}
	report.Counts.InferredEdges, report.Counts.DeclaredEdges = edgeCounts(report.Nodes)
	report.Counts.Roots = len(report.Roots)
	report.Counts.Findings = len(report.Findings)
	for _, finding := range report.Findings {
		if finding.Severity == SeverityDefect {
			report.Counts.Defects++
		}
	}
	report.Degraded = report.Counts.Defects > 0
	return report, nil
}

// edgeCounts splits the drawn parent edges by how they were read. It is a named
// function rather than an inline switch because the declared case has no producer
// yet: this is the only place the branch can be exercised until a writer lands.
func edgeCounts(nodes []LineageNode) (inferred, declared int) {
	for _, node := range nodes {
		switch node.EdgeSource {
		case EdgeDeclared:
			declared++
		case EdgeWorkspace:
			inferred++
		}
	}
	return inferred, declared
}

// parseWorktreePlacement reads the AO worktree layout out of a path. Two layouts
// exist in practice: <root>/worktrees/<namespace>/<role>/<session> and the older
// flat <root>/worktrees/<namespace>/<session>.
func parseWorktreePlacement(worktreePath string) (namespace, role string, ok bool) {
	clean := path.Clean(strings.ReplaceAll(worktreePath, "\\", "/"))
	const marker = "/worktrees/"
	index := strings.Index(clean, marker)
	if index < 0 {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(clean[index+len(marker):], "/"), "/")
	switch len(parts) {
	case 0, 1:
		return "", "", false
	case 2:
		return parts[0], "", true
	default:
		return parts[0], strings.TrimSuffix(parts[1], "s"), true
	}
}

func joinSessionIDs(ids []domain.SessionID) string {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, string(id))
	}
	return strings.Join(parts, ", ")
}

func roleMatchesKind(role string, kind domain.SessionKind) bool {
	return role == string(kind)
}

func worktreeEvidence(node *LineageNode) string {
	if len(node.Workspaces) == 0 {
		return "no worktree row"
	}
	return node.Workspaces[0].Path
}

func pathExists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// sessionOrdinal reads the trailing number of a generated session id (scratch-5 -> 5).
// A session named by a human returns 0, which is why 0 is not a valid ordinal.
func sessionOrdinal(id domain.SessionID) int {
	text := string(id)
	dash := strings.LastIndex(text, "-")
	if dash < 0 || dash == len(text)-1 {
		return 0
	}
	ordinal := 0
	for _, r := range text[dash+1:] {
		if r < '0' || r > '9' {
			return 0
		}
		ordinal = ordinal*10 + int(r-'0')
	}
	return ordinal
}

func sortedKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Ints(keys)
	return keys
}

// nodeDepth walks to the root. It returns -1 for a session whose parent chain
// revisits it, so the caller can report a cycle instead of hanging.
func nodeDepth(id domain.SessionID, nodes map[domain.SessionID]*LineageNode) int {
	seen := map[domain.SessionID]bool{}
	depth := 0
	for current := id; ; {
		if seen[current] {
			return -1
		}
		seen[current] = true
		node := nodes[current]
		if node == nil || node.ParentID == "" {
			return depth
		}
		if nodes[node.ParentID] == nil {
			return depth
		}
		current = node.ParentID
		depth++
	}
}
