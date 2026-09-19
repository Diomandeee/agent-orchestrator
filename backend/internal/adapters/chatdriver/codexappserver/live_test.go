package codexappserver

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

// TestLiveCodexAppServer drives a real `codex app-server`. It is skipped unless
// AO_CODEX_LIVE=1, because it needs a local Codex install, working auth, and it
// makes real model calls. Everything else in this package runs against pipes.
//
// Run it after changing the protocol layer:
//
//	AO_CODEX_LIVE=1 go test ./internal/adapters/chatdriver/codexappserver/ -run Live -v
func TestLiveCodexAppServer(t *testing.T) {
	if os.Getenv("AO_CODEX_LIVE") != "1" {
		t.Skip("set AO_CODEX_LIVE=1 to run against a real codex app-server")
	}

	bin := os.Getenv("AO_CODEX_BIN")
	if bin == "" {
		bin = "codex"
	}
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("codex binary %q not on PATH: %v", bin, err)
	}

	workspace := t.TempDir()
	seedGitWorkspace(t, workspace)

	d := New(livePlugin{bin: bin}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))

	caps, err := d.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) != 0 {
		t.Fatalf("missing production capabilities: %v", missing)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	conv, err := d.Start(ctx, ports.ChatStartConfig{
		SessionID:     "ao-live",
		WorkspacePath: workspace,
		Env:           envMap(),
		Permissions:   ports.PermissionModeDefault,
		SystemPrompt:  "You are in an automated test. Answer in one short sentence.",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	threadID := conv.ProviderConversationID()
	if threadID == "" {
		t.Fatal("no provider conversation id after Start")
	}
	t.Logf("thread %s", threadID)

	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "Reply with exactly the word: acknowledged",
		ClientMessageID: "live-1",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn: %v", err)
	}

	var (
		sawDelta bool
		state    domain.TurnState
	)
collect:
	for {
		select {
		case ev, ok := <-conv.Events():
			if !ok {
				t.Fatal("event stream closed before the turn completed")
			}
			switch ev.Kind {
			case ports.ChatEventMessageDelta:
				sawDelta = true
			case ports.ChatEventApprovalRequested:
				// This text-only fixture should never need an approval. Reject it
				// rather than granting unexpected authority during qualification.
				t.Errorf("unexpected approval request under default permissions: %s", ev.Summary)
				_ = conv.ResolveRequest(ctx, ev.RequestID, ports.ChatDecision{ID: "decline"})
			case ports.ChatEventTurnCompleted:
				state = ev.TurnState
				break collect
			case ports.ChatEventControllerState:
				if ev.ControllerState == ports.ChatControllerStopped {
					t.Fatalf("controller stopped before the turn completed: %v", ev.Err)
				}
			}
		case <-ctx.Done():
			t.Fatalf("timed out: %v", ctx.Err())
		}
	}

	if !sawDelta {
		t.Error("no streaming deltas observed")
	}
	if state != domain.TurnStateCompleted {
		t.Errorf("turn state = %q, want completed", state)
	}

	// Resume on a fresh process must recover the same thread — this is the
	// daemon-restart path.
	if err := conv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	resumed, err := d.Resume(ctx, ports.ChatResumeConfig{
		SessionID:              "ao-live",
		ProviderConversationID: threadID,
		WorkspacePath:          workspace,
		Env:                    envMap(),
		Permissions:            ports.PermissionModeDefault,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	defer func() { _ = resumed.Close() }()

	if got := resumed.ProviderConversationID(); got != threadID {
		t.Fatalf("resumed thread = %q, want %q", got, threadID)
	}
	t.Logf("resumed thread %s on a fresh app-server process", threadID)
}

// This opt-in leg uses a real Codex app-server and provider, but the CEF
// service must point to the all-synthetic fixture started by the e2e script.
// It does not search or export protected user history.
func TestLiveUCTMRecallSynthetic(t *testing.T) {
	if os.Getenv("AO_CODEX_LIVE") != "1" || os.Getenv("UCTM_RECALL_LIVE") != "1" {
		t.Skip("requires explicit synthetic live-model qualification")
	}
	day := os.Getenv("UCTM_RECALL_DAY")
	family := os.Getenv("UCTM_RECALL_FAMILY_ID")
	marker := os.Getenv("UCTM_RECALL_MARKER")
	if day == "" || family == "" || marker == "" || os.Getenv("UCTM_CEF_URL") == "" || os.Getenv("UCTM_CEF_TOKEN_PATH") == "" {
		t.Fatal("synthetic CEF fixture is not configured")
	}
	workspace := t.TempDir()
	seedGitWorkspace(t, workspace)
	grant := uctmRecallGrant{
		Schema: "uctm.recall-grant.v1", WorkspacePath: workspace,
		ProviderModel: "deepseek-flash", FamilyID: family,
		Purpose: "all-synthetic model delivery qualification",
		After:   day, Before: day,
		ExpiresAt:        time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		MaxEvidenceChars: 1800, AllowHistorySearch: true, AllowModelEgress: true,
	}
	data, err := json.Marshal(grant)
	if err != nil {
		t.Fatal(err)
	}
	grantPath := filepath.Join(t.TempDir(), "synthetic-grant.json")
	if err := os.WriteFile(grantPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UCTM_CEF_GRANT_PATH", grantPath)
	t.Setenv("UCTM_STUDIO", "1")
	receipts := t.TempDir()
	if err := os.Chmod(receipts, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UCTM_CEF_RECEIPTS_DIR", receipts)
	bin := os.Getenv("AO_CODEX_BIN")
	if bin == "" {
		t.Fatal("AO_CODEX_BIN is required for synthetic live-model qualification")
	}
	driver := New(livePlugin{bin: bin}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	conv, err := driver.Start(ctx, ports.ChatStartConfig{
		SessionID: "uctm-recall-synthetic", WorkspacePath: workspace,
		Env: envMap(), Model: "deepseek-flash", Permissions: ports.PermissionModeDefault,
		SystemPrompt: "This is an all-synthetic test. Do not use tools. Answer with only the exact marker in the admitted historical evidence; if none was delivered, answer NONE.",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()
	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "/recall pact.workflow.v1 synthetic decision gate",
		ClientMessageID: "synthetic-recall-1", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	var answer strings.Builder
	for {
		select {
		case event, ok := <-conv.Events():
			if !ok {
				t.Fatal("provider event stream closed")
			}
			switch event.Kind {
			case ports.ChatEventMessageDelta:
				answer.WriteString(event.Delta)
			case ports.ChatEventMessageCompleted:
				if event.Text != "" {
					answer.Reset()
					answer.WriteString(event.Text)
				}
			case ports.ChatEventApprovalRequested:
				_ = conv.ResolveRequest(ctx, event.RequestID, ports.ChatDecision{ID: "decline"})
				t.Fatalf("unexpected approval request: %s", event.Summary)
			case ports.ChatEventTurnCompleted:
				if event.TurnState != domain.TurnStateCompleted || !strings.Contains(answer.String(), marker) {
					t.Fatalf("synthetic marker not confirmed in completed provider answer: state=%q answer=%q", event.TurnState, answer.String())
				}
				files, err := os.ReadDir(receipts)
				if err != nil || len(files) != 1 {
					t.Fatalf("model delivery receipt missing: files=%v err=%v", files, err)
				}
				receiptBytes, err := os.ReadFile(filepath.Join(receipts, files[0].Name()))
				if err != nil {
					t.Fatal(err)
				}
				var receipt uctmDeliveryReceipt
				if err := json.Unmarshal(receiptBytes, &receipt); err != nil {
					t.Fatal(err)
				}
				if receipt.Status != "accepted_by_codex_host" || receipt.FamilyID != family ||
					len(receipt.Sources) == 0 || strings.Contains(string(receiptBytes), marker) {
					t.Fatalf("invalid model delivery receipt: %s", receiptBytes)
				}
				return
			case ports.ChatEventControllerState:
				if event.ControllerState == ports.ChatControllerStopped {
					t.Fatalf("controller stopped: %v", event.Err)
				}
			}
		case <-ctx.Done():
			t.Fatalf("synthetic live recall timed out: %v", ctx.Err())
		}
	}
}

// livePlugin stands in for AO's Codex agent plugin so this test exercises the
// driver rather than binary discovery.
type livePlugin struct{ bin string }

func (p livePlugin) ResolveBinary(context.Context) (string, error) { return p.bin, nil }
func (p livePlugin) AuthStatus(context.Context) (ports.AgentAuthStatus, error) {
	return ports.AgentAuthStatusAuthorized, nil
}

func envMap() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				out[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	return out
}

func seedGitWorkspace(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "."},
		{"-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "seed"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
}
