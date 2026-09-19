package codexappserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func writeSyntheticUCTMGrant(t *testing.T, model, family string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "grant.json")
	grant := uctmRecallGrant{
		Schema: "uctm.recall-grant.v1", WorkspacePath: "/tmp/uctm-synthetic-workspace",
		ProviderModel: model, FamilyID: family, Purpose: "synthetic recall test",
		After: "2026-09-01", Before: "2026-09-18",
		ExpiresAt:        time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		MaxEvidenceChars: 1024, AllowHistorySearch: true, AllowModelEgress: true,
	}
	data, err := json.Marshal(grant)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeSyntheticUCTMToken(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cef-token")
	if err := os.WriteFile(path, []byte("synthetic-private-cef-token-with-32-chars\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUCTMReceiptWriterStoresOnlyPrivateIdentityManifest(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := uctmModelContext{
		RequestID: "00000000-0000-0000-0000-000000000001", FamilyID: "family-1", SliceID: "slice-1",
		Evidence: []uctmModelEvidence{{EvidenceID: "e1", SourceOccurrenceID: "occ-1", Role: "user",
			NativeTurnID: "00000000-0000-0000-0000-000000000002", ContentSHA256: strings.Repeat("a", 64),
			Excerpt: "SECRET SYNTHETIC EXCERPT"}},
	}
	if err := writeUCTMDeliveryReceipt(directory, "deepseek-flash", "thread-1", "turn-1", manifest); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, manifest.RequestID+".json"))
	if err != nil || strings.Contains(string(data), "SECRET SYNTHETIC EXCERPT") {
		t.Fatalf("receipt missing or leaked excerpt: err=%v data=%s", err, data)
	}
}

func TestUCTMRecallRequiresPrivateExactGrantBeforeAnySearch(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	t.Setenv("UCTM_CEF_URL", server.URL)
	t.Setenv("UCTM_CEF_TOKEN_PATH", writeSyntheticUCTMToken(t))
	t.Setenv("UCTM_CEF_GRANT_PATH", "")
	if _, err := resolveUCTMHistoricalContext(t.Context(), "/tmp/uctm-synthetic-workspace", "thread-1", "deepseek-flash", "/recall prior work"); err == nil {
		t.Fatal("missing grant accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("searched without a grant")
	}
	grant := writeSyntheticUCTMGrant(t, "deepseek-flash", "family-1")
	t.Setenv("UCTM_CEF_GRANT_PATH", grant)
	if _, err := resolveUCTMHistoricalContext(t.Context(), "/tmp/other", "thread-1", "deepseek-flash", "/recall prior work"); err == nil {
		t.Fatal("cross-workspace grant accepted")
	}
	if _, err := resolveUCTMHistoricalContext(t.Context(), "/tmp/uctm-synthetic-workspace", "thread-1", "gpt-6-astra", "/recall prior work"); err == nil {
		t.Fatal("cross-model grant accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("searched outside grant scope")
	}
}

func TestUCTMRecallSendsOnlyMatchingModelSafeFamily(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/context/resolve/model-safe" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-private-cef-token-with-32-chars" {
			t.Error("CEF bearer token missing")
		}
		var request struct {
			RequestID string `json:"request_id"`
			Query     string `json:"query"`
			Scope     struct {
				ExcludeSessionIDs []string `json:"exclude_session_ids"`
			} `json:"scope"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request.Query != "what did we build" || len(request.Scope.ExcludeSessionIDs) != 1 || request.Scope.ExcludeSessionIDs[0] != "thread-1" {
			t.Errorf("unexpected bounded request: %+v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(uctmModelContext{
			Kind: "cef_admitted_historical_context.v0", RequestID: request.RequestID,
			FamilyID: "family-1", SliceID: "signed-slice",
			Evidence: []uctmModelEvidence{{
				EvidenceID: "e1", SourceOccurrenceID: "occ-1", Role: "user", NativeTurnID: "00000000-0000-0000-0000-000000000001",
				ContentSHA256: strings.Repeat("a", 64), Excerpt: "We built a coding harness",
			}},
		})
	}))
	defer server.Close()
	t.Setenv("UCTM_CEF_URL", server.URL)
	t.Setenv("UCTM_CEF_TOKEN_PATH", writeSyntheticUCTMToken(t))
	t.Setenv("UCTM_CEF_GRANT_PATH", writeSyntheticUCTMGrant(t, "deepseek-flash", "family-1"))
	contextText, err := resolveUCTMHistoricalContext(t.Context(), "/tmp/uctm-synthetic-workspace", "thread-1", "deepseek-flash", "/recall what did we build")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contextText, "We built a coding harness") || !strings.Contains(contextText, "untrusted source data") {
		t.Fatalf("model-safe content missing: %q", contextText)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
	t.Setenv("UCTM_CEF_GRANT_PATH", writeSyntheticUCTMGrant(t, "deepseek-flash", "other-family"))
	if _, err := resolveUCTMHistoricalContext(t.Context(), "/tmp/uctm-synthetic-workspace", "thread-1", "deepseek-flash", "/recall what did we build"); err == nil {
		t.Fatal("wrong recovered family reached model")
	}
}

func TestUCTMRecallTurnDeliversOnlyAdmittedEvidenceAsSeparateText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			RequestID string `json:"request_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(uctmModelContext{
			Kind: "cef_admitted_historical_context.v0", RequestID: request.RequestID,
			FamilyID: "family-1", SliceID: "signed-slice",
			Evidence: []uctmModelEvidence{{
				EvidenceID: "e1", SourceOccurrenceID: "occ-1", Role: "user", NativeTurnID: "00000000-0000-0000-0000-000000000001",
				ContentSHA256: strings.Repeat("a", 64), Excerpt: "Synthetic historical requirement",
			}},
		})
	}))
	defer server.Close()
	t.Setenv("UCTM_STUDIO", "1")
	t.Setenv("UCTM_CEF_URL", server.URL)
	t.Setenv("UCTM_CEF_TOKEN_PATH", writeSyntheticUCTMToken(t))
	t.Setenv("UCTM_CEF_GRANT_PATH", writeSyntheticUCTMGrant(t, "gpt-test", "family-1"))
	receipts := t.TempDir()
	if err := os.Chmod(receipts, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UCTM_CEF_RECEIPTS_DIR", receipts)
	driver, provider := newTestDriver(t)
	conv, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/uctm-synthetic-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conv.Close() }()
	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "/recall What did we build?"}); err != nil {
		t.Fatal(err)
	}
	sent := provider.awaitFrame(func(f frame) bool { return f.Method == "turn/start" })
	var params struct {
		Input []struct {
			Text string `json:"text"`
		} `json:"input"`
	}
	if err := json.Unmarshal(sent.Params, &params); err != nil {
		t.Fatal(err)
	}
	if len(params.Input) != 2 || params.Input[0].Text != "What did we build?" ||
		!strings.Contains(params.Input[1].Text, "Synthetic historical requirement") ||
		!strings.Contains(params.Input[1].Text, "untrusted source data") {
		t.Fatalf("unexpected provider input shape: %+v", params.Input)
	}
	files, err := os.ReadDir(receipts)
	if err != nil || len(files) != 1 {
		t.Fatalf("expected one private delivery receipt: files=%v err=%v", files, err)
	}
	receiptBytes, err := os.ReadFile(filepath.Join(receipts, files[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var receipt uctmDeliveryReceipt
	if err := json.Unmarshal(receiptBytes, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "accepted_by_codex_host" || receipt.FamilyID != "family-1" ||
		len(receipt.Sources) != 1 || receipt.Sources[0].SourceOccurrenceID != "occ-1" ||
		strings.Contains(string(receiptBytes), "Synthetic historical requirement") {
		t.Fatalf("receipt is missing identity or contains source text: %s", receiptBytes)
	}
	if info, err := os.Stat(filepath.Join(receipts, files[0].Name())); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("receipt is not private: info=%v err=%v", info, err)
	}
}

func TestUCTMRecallTurnForcesToolFreeBoundary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			RequestID string `json:"request_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(uctmModelContext{
			Kind: "cef_admitted_historical_context.v0", RequestID: request.RequestID,
			FamilyID: "family-1", SliceID: "signed-slice",
			Evidence: []uctmModelEvidence{{
				EvidenceID: "e1", SourceOccurrenceID: "occ-1", Role: "user", NativeTurnID: "00000000-0000-0000-0000-000000000001",
				ContentSHA256: strings.Repeat("a", 64), Excerpt: "Synthetic historical requirement",
			}},
		})
	}))
	defer server.Close()
	t.Setenv("UCTM_STUDIO", "1")
	t.Setenv("UCTM_CEF_URL", server.URL)
	t.Setenv("UCTM_CEF_TOKEN_PATH", writeSyntheticUCTMToken(t))
	t.Setenv("UCTM_CEF_GRANT_PATH", writeSyntheticUCTMGrant(t, "gpt-test", "family-1"))
	receipts := t.TempDir()
	if err := os.Chmod(receipts, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UCTM_CEF_RECEIPTS_DIR", receipts)
	driver, provider := newTestDriver(t)
	conv, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/uctm-synthetic-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conv.Close() }()
	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text: "/recall What did we build?",
		Settings: ports.ChatTurnSettings{
			Approval: ports.PermissionModeAcceptEdits,
		},
	}); err != nil {
		t.Fatal(err)
	}
	sent := provider.awaitFrame(func(f frame) bool { return f.Method == "turn/start" })
	var params struct {
		ApprovalPolicy string `json:"approvalPolicy"`
		SandboxPolicy  struct {
			Type string `json:"type"`
		} `json:"sandboxPolicy"`
		Environments *[]turnEnvironment `json:"environments"`
	}
	if err := json.Unmarshal(sent.Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ApprovalPolicy != "never" {
		t.Fatalf("recall approvalPolicy = %q, want never: the turn must not be able to ask for approval", params.ApprovalPolicy)
	}
	if params.SandboxPolicy.Type != "readOnly" {
		t.Fatalf("recall sandboxPolicy.type = %q, want readOnly", params.SandboxPolicy.Type)
	}
	// The sandbox alone is not the boundary: read-only still runs commands. An
	// empty environment is what removes the shell tool from the turn.
	if params.Environments == nil || len(*params.Environments) != 0 {
		t.Fatalf("recall environments = %v, want an explicit empty selection", params.Environments)
	}
}

// An empty environment selection persists on the thread, so a recall turn that
// removed it must be followed by turns that put it back. A regression here is
// silent: the conversation keeps answering, just without any shell tool.
func TestUCTMTurnsRestoreThreadEnvironmentAfterRecall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			RequestID string `json:"request_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(uctmModelContext{
			Kind: "cef_admitted_historical_context.v0", RequestID: request.RequestID,
			FamilyID: "family-1", SliceID: "signed-slice",
			Evidence: []uctmModelEvidence{{
				EvidenceID: "e1", SourceOccurrenceID: "occ-1", Role: "user", NativeTurnID: "00000000-0000-0000-0000-000000000001",
				ContentSHA256: strings.Repeat("a", 64), Excerpt: "Synthetic historical requirement",
			}},
		})
	}))
	defer server.Close()
	t.Setenv("UCTM_STUDIO", "1")
	t.Setenv("UCTM_CEF_URL", server.URL)
	t.Setenv("UCTM_CEF_TOKEN_PATH", writeSyntheticUCTMToken(t))
	t.Setenv("UCTM_CEF_GRANT_PATH", writeSyntheticUCTMGrant(t, "gpt-test", "family-1"))
	receipts := t.TempDir()
	if err := os.Chmod(receipts, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UCTM_CEF_RECEIPTS_DIR", receipts)
	driver, provider := newTestDriver(t)
	provider.respondTo("thread/start", `{"thread":{"id":"thread-1","environments":[`+
		`{"environmentId":"local","cwd":"/tmp/uctm-synthetic-workspace"}]},"model":"gpt-test","cwd":"/tmp/uctm-synthetic-workspace"}`)
	conv, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/uctm-synthetic-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conv.Close() }()

	turnEnvironments := func(text string) ([]turnEnvironment, bool, bool) {
		t.Helper()
		sent := provider.awaitFrame(func(f frame) bool {
			if f.Method != "turn/start" {
				return false
			}
			var probe struct {
				Input []struct {
					Text string `json:"text"`
				} `json:"input"`
			}
			if err := json.Unmarshal(f.Params, &probe); err != nil || len(probe.Input) == 0 {
				return false
			}
			return probe.Input[0].Text == text
		})
		var params struct {
			ApprovalPolicy string             `json:"approvalPolicy"`
			Environments   *[]turnEnvironment `json:"environments"`
		}
		if err := json.Unmarshal(sent.Params, &params); err != nil {
			t.Fatal(err)
		}
		if params.Environments == nil {
			return nil, false, params.ApprovalPolicy == "never"
		}
		return *params.Environments, true, params.ApprovalPolicy == "never"
	}

	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "ordinary question"}); err != nil {
		t.Fatal(err)
	}
	env, present, _ := turnEnvironments("ordinary question")
	if !present || len(env) != 1 || env[0].EnvironmentID != "local" || env[0].Cwd != "/tmp/uctm-synthetic-workspace" {
		t.Fatalf("ordinary turn environments = %v present=%v, want the thread's environment", env, present)
	}

	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "/recall What did we build?"}); err != nil {
		t.Fatal(err)
	}
	env, present, toolFree := turnEnvironments("What did we build?")
	if !present || len(env) != 0 || !toolFree {
		t.Fatalf("recall turn environments = %v present=%v approvalNever=%v, want an empty selection", env, present, toolFree)
	}

	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "question after recall"}); err != nil {
		t.Fatal(err)
	}
	env, present, _ = turnEnvironments("question after recall")
	if !present || len(env) != 1 || env[0].EnvironmentID != "local" {
		t.Fatalf("post-recall turn environments = %v present=%v, want the thread's environment restored", env, present)
	}
}

func TestUCTMRecallNeverFollowsRedirectWithPrivateBearerOrQuery(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	t.Setenv("UCTM_CEF_URL", source.URL)
	t.Setenv("UCTM_CEF_TOKEN_PATH", writeSyntheticUCTMToken(t))
	t.Setenv("UCTM_CEF_GRANT_PATH", writeSyntheticUCTMGrant(t, "deepseek-flash", "family-1"))
	if _, err := resolveUCTMHistoricalContext(t.Context(), "/tmp/uctm-synthetic-workspace", "thread-1", "deepseek-flash", "/recall protected query"); err == nil {
		t.Fatal("redirected CEF response was accepted")
	}
	if redirected.Load() != 0 {
		t.Fatal("private CEF request followed a redirect")
	}
}
