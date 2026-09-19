package sessionmanager

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestReadUCTMContextCard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "card.md")
	if err := os.WriteFile(path, []byte("Source: synthetic user statement\n- A fact\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readUCTMContextCard(path)
	if err != nil || !strings.Contains(got, "A fact") {
		t.Fatalf("card = %q, %v", got, err)
	}
	if _, err := readUCTMContextCard("relative.md"); err == nil {
		t.Fatal("relative path accepted")
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readUCTMContextCard(path); err == nil {
		t.Fatal("world-readable card accepted")
	}
}

func TestReadUCTMContextCardRejectsOversizeAndSymlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "card.md")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 8193)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readUCTMContextCard(path); err == nil {
		t.Fatal("oversized card accepted")
	}
	if err := os.WriteFile(path, []byte("small"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readUCTMContextCard(link); err == nil {
		t.Fatal("symlink card accepted")
	}
}

func TestUCTMContextCardOnlyEntersStudioPrompt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "card.md")
	if err := os.WriteFile(path, []byte("Source: synthetic user statement\n- Likes focused tests"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UCTM_CONTEXT_CARD_PATH", path)
	st := newFakeStore()
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})
	t.Setenv("UCTM_STUDIO", "")
	plain, err := m.buildSystemPrompt(t.Context(), domain.KindWorker, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, "Likes focused tests") {
		t.Fatal("context leaked into ordinary AO prompt")
	}
	t.Setenv("UCTM_STUDIO", "1")
	studio, err := m.buildSystemPrompt(t.Context(), domain.KindWorker, "mer")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Permitted UCTM user context", "Likes focused tests", "not memory or a live evidence-recovery result"} {
		if !strings.Contains(studio, want) {
			t.Fatalf("Studio prompt missing %q", want)
		}
	}
}
