package sessionmanager

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The orientation card is the spawn-time half of the UCTM orientation index: a
// session is handed the id it is oriented to, the command that re-checks it, and
// the instruction to stop reading once it matches. These tests pin the boundary,
// not the wording: the card is bounded and private, it enters only a Studio
// prompt, its absence injects nothing, and a card the operator pointed at but
// that cannot be read fails the spawn instead of silently disappearing.

func writeOrientationCardFile(t *testing.T, body string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "orientation.md")
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadUCTMOrientationCard(t *testing.T) {
	body := "## Orientation (UCTM Studio)\n\norientation_id sha256:abc\n"
	path := writeOrientationCardFile(t, body, 0o600)
	got, err := readUCTMOrientationCard(path)
	if err != nil || !strings.Contains(got, "orientation_id sha256:abc") {
		t.Fatalf("card = %q, %v", got, err)
	}
	// No path means "not configured", which is not an error and not a section.
	if empty, err := readUCTMOrientationCard(""); err != nil || empty != "" {
		t.Fatalf("unset path = %q, %v", empty, err)
	}
	if _, err := readUCTMOrientationCard("relative.md"); err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestReadPrivateCardBounds(t *testing.T) {
	// Both cards go through one bounded read, so both must reject the same inputs
	// in the same way. Splitting the read would let one card drift wider.
	cards := map[string]func(string) (string, error){
		"context":     readUCTMContextCard,
		"orientation": readUCTMOrientationCard,
	}
	for name, read := range cards {
		t.Run(name, func(t *testing.T) {
			if _, err := read(filepath.Join(t.TempDir(), "missing.md")); err == nil {
				t.Fatal("unreadable path accepted")
			}
			if _, err := read(writeOrientationCardFile(t, strings.Repeat("x", 8193), 0o600)); err == nil {
				t.Fatal("oversized card accepted")
			}
			if _, err := read(writeOrientationCardFile(t, "body", 0o644)); err == nil {
				t.Fatal("world-readable card accepted")
			}
			target := writeOrientationCardFile(t, "body", 0o600)
			link := filepath.Join(t.TempDir(), "link")
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			if _, err := read(link); err == nil {
				t.Fatal("symlinked card accepted")
			}
		})
	}
}

func TestOrientationCardOnlyEntersStudioPromptAfterTheContextCard(t *testing.T) {
	orientation := writeOrientationCardFile(t, "## Orientation (UCTM Studio)\n\norientation_id sha256:feed\n", 0o600)
	context := writeOrientationCardFile(t, "Source: synthetic user statement\n- Likes focused tests\n", 0o600)
	t.Setenv("UCTM_CONTEXT_CARD_PATH", context)
	t.Setenv("UCTM_ORIENTATION_CARD_PATH", orientation)

	st := newFakeStore()
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})

	t.Setenv("UCTM_STUDIO", "")
	plain, err := m.buildSystemPrompt(t.Context(), domain.KindWorker, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, "orientation_id sha256:feed") {
		t.Fatal("orientation card leaked into an ordinary AO prompt")
	}

	t.Setenv("UCTM_STUDIO", "1")
	studio, err := m.buildSystemPrompt(t.Context(), domain.KindWorker, "mer")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"## Orientation (UCTM Studio)", "orientation_id sha256:feed"} {
		if !strings.Contains(studio, want) {
			t.Fatalf("Studio prompt missing %q", want)
		}
	}
	// The orientation card is a re-orientation protocol, so it reads after the
	// facts it re-orients against rather than before them.
	if strings.Index(studio, "## Permitted UCTM user context") > strings.Index(studio, "## Orientation (UCTM Studio)") {
		t.Fatal("orientation card is injected before the context card")
	}
	if strings.Count(studio, "## Orientation (UCTM Studio)") != 1 {
		t.Fatal("orientation card injected more than once")
	}
}

func TestOrientationCardAbsenceInjectsNothing(t *testing.T) {
	t.Setenv("UCTM_STUDIO", "1")
	t.Setenv("UCTM_CONTEXT_CARD_PATH", "")
	t.Setenv("UCTM_ORIENTATION_CARD_PATH", "")
	st := newFakeStore()
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})
	prompt, err := m.buildSystemPrompt(t.Context(), domain.KindWorker, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(prompt, "## Orientation") {
		t.Fatal("an unconfigured orientation card produced a section")
	}
}

func TestOrientationCardFailsClosed(t *testing.T) {
	// A configured-but-unreadable card is an error, because a spawn that silently
	// omits orientation looks identical to a spawn in an oriented world.
	t.Setenv("UCTM_STUDIO", "1")
	t.Setenv("UCTM_CONTEXT_CARD_PATH", "")
	t.Setenv("UCTM_ORIENTATION_CARD_PATH", filepath.Join(t.TempDir(), "absent.md"))
	st := newFakeStore()
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})
	if prompt, err := m.buildSystemPrompt(t.Context(), domain.KindWorker, "mer"); err == nil {
		t.Fatalf("unreadable orientation card did not fail the spawn; prompt = %q", prompt)
	}
}

// TestConfiguredOrientationCardIsReadable is the cross-language half of the
// contract: the card the Node emitter writes must be a card this reader accepts.
// It skips unless a card is actually configured, so `go test` stays hermetic while
// the real artifact can still be checked end to end:
//
//	UCTM_ORIENTATION_CARD_PATH=~/.ao/uctm-studio/orientation.md \
//	  go test ./internal/session_manager/ -run TestConfiguredOrientationCardIsReadable -count=1
func TestConfiguredOrientationCardIsReadable(t *testing.T) {
	path := os.Getenv("UCTM_ORIENTATION_CARD_PATH")
	if path == "" {
		t.Skip("no orientation card configured; set UCTM_ORIENTATION_CARD_PATH to check the real artifact")
	}
	card, err := readUCTMOrientationCard(path)
	if err != nil {
		t.Fatalf("the emitted card is not one the daemon accepts: %v", err)
	}
	if !strings.HasPrefix(card, "## Orientation (UCTM Studio)") {
		t.Fatalf("card does not start with its own heading: %q", card[:min(len(card), 60)])
	}
	if !strings.Contains(card, "orientation_id") {
		t.Fatal("card carries no comparand, so a session cannot tell whether it is still oriented")
	}
	if len(card) > 8192 {
		t.Fatalf("card is %d bytes", len(card))
	}
}
