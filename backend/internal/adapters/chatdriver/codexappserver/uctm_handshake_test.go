package codexappserver

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestUCTMInstalledHostHandshake qualifies local IPC only. It does not call a
// model, read the operator's Codex state, create a thread, or execute tools.
// Passing is not evidence of provider, tool, or UCTM context integration.
func TestUCTMInstalledHostHandshake(t *testing.T) {
	if os.Getenv("UCTM_HOST_HANDSHAKE") != "1" {
		t.Skip("set UCTM_HOST_HANDSHAKE=1 and AO_CODEX_BIN for local IPC qualification")
	}
	bin := os.Getenv("AO_CODEX_BIN")
	if bin == "" {
		t.Fatal("AO_CODEX_BIN must identify the binary being qualified")
	}
	resolved, err := exec.LookPath(bin)
	if err != nil {
		t.Fatal(err)
	}
	// The driver merges environment overlays. Override both home roots so the
	// probe cannot accidentally load the operator's configuration or auth file.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	d := New(livePlugin{bin: resolved}, nil)
	conv, err := d.connect(ctx, home, map[string]string{"CODEX_HOME": home, "HOME": home})
	if err != nil {
		t.Fatalf("isolated initialize: %v", err)
	}
	if err := conv.Close(); err != nil {
		t.Fatal(err)
	}
	t.Log("initialize/initialized passed; no thread or model call attempted")
}
