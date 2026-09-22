package parks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePacket(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+".json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestListSummaries(t *testing.T) {
	dir := t.TempDir()
	writePacket(t, dir, "b-idea", `{"name":"b-idea","created":"2026-09-19","state":"spec written","blocked_on_mo":["creds"],"next":["deploy"]}`)
	writePacket(t, dir, "a-idea", `{"name":"a-idea","created":"2026-09-18","state":"parked"}`)
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := Service{Dir: dir}.List()
	if len(got) != 2 {
		t.Fatalf("List() = %d summaries, want 2 (txt + broken skipped)", len(got))
	}
	if got[0].Name != "a-idea" || got[1].Name != "b-idea" {
		t.Fatalf("List() not sorted: %+v", got)
	}
	if len(got[1].Blocked) != 1 || len(got[1].Next) != 1 {
		t.Fatalf("List() blocked/next not projected: %+v", got[1])
	}
	if got[0].Wave != 0 || got[0].Tier != "" {
		t.Fatalf("List() garden packet wave/tier = %d/%q, want zero values", got[0].Wave, got[0].Tier)
	}
}

func TestListProjectsFleetFields(t *testing.T) {
	dir := t.TempDir()
	writePacket(t, dir, "fleet-app-x", `{"name":"fleet-app-x","wave":2,"tier":"TIER-2","state":"s"}`)
	got := Service{Dir: dir}.List()
	if len(got) != 1 {
		t.Fatalf("List() = %d summaries, want 1", len(got))
	}
	if got[0].Wave != 2 || got[0].Tier != "TIER-2" {
		t.Fatalf("List() fleet wave/tier = %d/%q, want 2/TIER-2", got[0].Wave, got[0].Tier)
	}
}

func TestParksDirDoesNotFollowARewrittenHome(t *testing.T) {
	t.Setenv("UCTM_PARKS_DIR", "")
	t.Setenv("UCTM_ESTATE_HOME", "")
	harness := t.TempDir()
	t.Setenv("HOME", harness)

	got := ParksDir()
	if got == "" {
		t.Fatal("ParksDir returned no directory")
	}
	if rewritten := filepath.Join(harness, "Developer", "UCTM-Studio", "bridge", "parks"); got == rewritten {
		t.Fatalf("ParksDir followed a rewritten $HOME into the harness home: %q", got)
	}
	if !strings.HasSuffix(got, filepath.Join("bridge", "parks")) {
		t.Fatalf("ParksDir does not name a parks directory: %q", got)
	}
}

func TestParksDirPrefersTheNamedEstateHome(t *testing.T) {
	t.Setenv("UCTM_PARKS_DIR", "")
	estate := t.TempDir()
	t.Setenv("UCTM_ESTATE_HOME", estate)
	t.Setenv("HOME", t.TempDir())

	want := filepath.Join(estate, "Developer", "UCTM-Studio", "bridge", "parks")
	if got := ParksDir(); got != want {
		t.Fatalf("ParksDir = %q, want %q", got, want)
	}
}

func TestParksDirLetsAnExplicitDirOutrankEveryHome(t *testing.T) {
	explicit := t.TempDir()
	t.Setenv("UCTM_PARKS_DIR", explicit)
	t.Setenv("UCTM_ESTATE_HOME", t.TempDir())
	if got := ParksDir(); got != explicit {
		t.Fatalf("ParksDir = %q, want the explicit %q", got, explicit)
	}
}

func TestListMissingDir(t *testing.T) {
	missing := Service{Dir: filepath.Join(t.TempDir(), "nope")}.List()
	if len(missing) != 0 {
		t.Fatalf("List() on missing dir = %v, want empty", missing)
	}
	empty := Service{}.List()
	if len(empty) != 0 {
		t.Fatalf("List() with empty dir = %v, want empty", empty)
	}
}

func TestPacketVerbatimAndTraversal(t *testing.T) {
	dir := t.TempDir()
	body := `{"name":"x","created":"2026-09-19","state":"s"}`
	writePacket(t, dir, "x", body)

	svc := Service{Dir: dir}
	raw, ok := svc.Packet("x")
	if !ok || string(raw) != body {
		t.Fatalf("Packet(x) = %q, %v; want verbatim body", string(raw), ok)
	}
	for _, evil := range []string{"../x", "x/y", ".", "", "x.json"} {
		_, found := svc.Packet(evil)
		if found {
			t.Fatalf("Packet(%q) accepted, want rejection", evil)
		}
	}
	_, found := svc.Packet("missing")
	if found {
		t.Fatalf("Packet(missing) found, want 404")
	}
}
