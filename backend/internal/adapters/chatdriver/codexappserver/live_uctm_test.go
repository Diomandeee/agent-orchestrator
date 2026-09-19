package codexappserver

// Live proof that a /recall turn is tool-free, on the real host and the real
// grant. It is skipped unless AO_CODEX_LIVE=1 and the UCTM bridge environment is
// present, because it makes real model calls and writes a real delivery receipt.
//
//	AO_CODEX_LIVE=1 UCTM_STUDIO=1 \
//	UCTM_CEF_URL=... UCTM_CEF_TOKEN_PATH=... UCTM_CEF_GRANT_PATH=... \
//	UCTM_CEF_RECEIPTS_DIR=... go test ./internal/adapters/chatdriver/codexappserver/ -run Live -v

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// defaultLiveRecallQuery is the wording the checked-in grant was selected for.
// A longer paraphrase can rank a neighbouring family first, which the honesty
// boundary refuses rather than silently delivering a different family.
const defaultLiveRecallQuery = "Evidence Recovery adapter UCTM PACT pPACT"

func TestLiveUCTMRecallTurnIsToolFree(t *testing.T) {
	if os.Getenv("AO_CODEX_LIVE") != "1" {
		t.Skip("set AO_CODEX_LIVE=1 to run against a real codex app-server")
	}
	if !uctmStudioEnabled() {
		t.Skip("set UCTM_STUDIO=1 and the UCTM_CEF_* environment to run the live recall check")
	}
	for _, name := range []string{"UCTM_CEF_URL", "UCTM_CEF_GRANT_PATH", "UCTM_CEF_TOKEN_PATH", "UCTM_CEF_RECEIPTS_DIR"} {
		if os.Getenv(name) == "" {
			t.Skipf("%s is not set", name)
		}
	}
	bin := os.Getenv("AO_CODEX_BIN")
	if bin == "" {
		bin = "codex"
	}
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("codex binary %q not on PATH: %v", bin, err)
	}
	grantBytes, err := os.ReadFile(os.Getenv("UCTM_CEF_GRANT_PATH"))
	if err != nil {
		t.Fatalf("read grant: %v", err)
	}
	var grant uctmRecallGrant
	if err := json.Unmarshal(grantBytes, &grant); err != nil {
		t.Fatalf("decode grant: %v", err)
	}
	// The recall bridge compares the turn's workspace and model against the
	// grant, so the test must run as the granted subject rather than a temp dir.
	workspace := grant.WorkspacePath
	if _, err := os.Stat(workspace); err != nil {
		t.Skipf("granted workspace %q is unavailable: %v", workspace, err)
	}
	receipts := os.Getenv("UCTM_CEF_RECEIPTS_DIR")
	before := receiptNames(t, receipts)

	d := New(livePlugin{bin: bin}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	if _, err := d.Probe(ctx); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	conv, err := d.Start(ctx, ports.ChatStartConfig{
		SessionID:     "ao-live-uctm",
		WorkspacePath: workspace,
		Env:           envMap(),
		Permissions:   ports.PermissionModeDefault,
		SystemPrompt:  "You are in an automated recall check. Answer in one short sentence.",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	// Control: an ordinary turn can run a command. Without this the recall
	// assertion below would pass even if the host had lost its shell for an
	// unrelated reason.
	shellPrompt := "Use your shell tool to run `id -un` and reply with the stdout."
	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            shellPrompt,
		ClientMessageID: "live-uctm-control",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("control SendTurn: %v", err)
	}
	if command, _ := drainTurn(t, ctx, conv); !command {
		t.Fatalf("control turn ran no command; the host has no shell tool, so the recall assertion would be vacuous")
	}

	query := os.Getenv("UCTM_LIVE_RECALL_QUERY")
	if query == "" {
		query = defaultLiveRecallQuery
	}
	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "/recall " + query,
		ClientMessageID: "live-uctm-recall",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("recall SendTurn: %v", err)
	}
	command, text := drainTurn(t, ctx, conv)
	if command {
		t.Fatalf("recall turn executed a command; admitted evidence must not buy execution: %q", text)
	}

	// The recall turn removes the thread's environment, and that removal is
	// sticky. A later ordinary turn must have its shell back.
	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            shellPrompt,
		ClientMessageID: "live-uctm-restore",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("post-recall SendTurn: %v", err)
	}
	if command, _ := drainTurn(t, ctx, conv); !command {
		t.Fatalf("post-recall turn ran no command; the thread environment was not restored")
	}

	added := difference(receiptNames(t, receipts), before)
	if len(added) != 1 {
		t.Fatalf("recall produced %d new receipts (%v), want exactly one", len(added), added)
	}
	raw, err := os.ReadFile(filepath.Join(receipts, added[0]))
	if err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	var receipt uctmDeliveryReceipt
	if err := json.Unmarshal(raw, &receipt); err != nil {
		t.Fatalf("decode receipt: %v", err)
	}
	if receipt.Status != "accepted_by_codex_host" || receipt.FamilyID != grant.FamilyID ||
		receipt.SliceID == "" || len(receipt.Sources) == 0 {
		t.Fatalf("receipt does not prove delivery of the granted family: %s", raw)
	}
	for _, source := range receipt.Sources {
		if source.EvidenceID == "" || source.SourceOccurrenceID == "" || len(source.ContentSHA256) != 64 {
			t.Fatalf("receipt source is not an identity: %+v", source)
		}
	}
	t.Logf("receipt %s: family=%s slice=%s sources=%d", added[0], receipt.FamilyID, receipt.SliceID, len(receipt.Sources))
}

// drainTurn consumes one turn's events and reports whether any tool activity
// appeared in it, plus the settled assistant text.
func drainTurn(t *testing.T, ctx context.Context, conv ports.ChatConversation) (bool, string) {
	t.Helper()
	var (
		command  bool
		text     string
		deadline = time.After(6 * time.Minute)
	)
	for {
		select {
		case event, ok := <-conv.Events():
			if !ok {
				t.Fatal("conversation ended before the turn completed")
			}
			switch {
			case event.Kind == ports.ChatEventActivityStarted && event.ActivityKind == domain.ActivityKindCommand:
				command = true
			case event.Kind == ports.ChatEventActivityStarted && event.ActivityKind == domain.ActivityKindFileChange:
				command = true
			case event.Kind == ports.ChatEventCommandOutputDelta:
				command = true
			case event.Kind == ports.ChatEventMessageCompleted && event.Text != "":
				text = event.Text
			case event.Kind == ports.ChatEventError:
				t.Fatalf("provider error during turn: %s", event.Text)
			case event.Kind == ports.ChatEventTurnCompleted:
				return command, text
			}
		case <-ctx.Done():
			t.Fatal("turn did not complete before the test context expired")
		case <-deadline:
			t.Fatal("turn did not complete within six minutes")
		}
	}
}

func receiptNames(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read receipt directory: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	return names
}

func difference(after, before []string) []string {
	seen := make(map[string]struct{}, len(before))
	for _, name := range before {
		seen[name] = struct{}{}
	}
	added := make([]string, 0, len(after))
	for _, name := range after {
		if _, ok := seen[name]; !ok {
			added = append(added, name)
		}
	}
	return added
}
