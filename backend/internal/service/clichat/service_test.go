package clichat

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const zeroPrev = "0000000000000000000000000000000000000000000000000000000000000000"

func eventBody(seq int, prev, kind, data, timeNs string) string {
	return fmt.Sprintf(`{"seq":%d,"prev":%q,"kind":%q,"data":%s,"time_ns":%q}`, seq, prev, kind, data, timeNs)
}

func eventLine(seq int, prev, kind, data, timeNs string) (string, string) {
	body := eventBody(seq, prev, kind, data, timeNs)
	sum := sha256.Sum256([]byte(body))
	digest := hex.EncodeToString(sum[:])
	return fmt.Sprintf(`{"body":%s,"sha256":%q}`+"\n", body, digest), digest
}

func writeSession(t *testing.T, dir, id string, lines ...string) {
	t.Helper()
	content := strings.Join(lines, "")
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestListVerifiesRealChain(t *testing.T) {
	dir := t.TempDir()
	l0, _ := eventLine(0, zeroPrev, "session", `{"project":"/tmp/proj"}`, "100")
	l1, _ := eventLine(1, digestOf(l0), "completed", `{"user":"hello world","assistant":"hi"}`, "200")
	writeSession(t, dir, "s-1", l0, l1)

	got := Service{Dir: dir}.List()
	if len(got) != 1 {
		t.Fatalf("want 1 session, got %d", len(got))
	}
	s := got[0]
	if !s.ChainOK || s.MessageCount != 1 || s.Display != "hello world" || s.Project != "/tmp/proj" || s.LastActivityNs != "200" {
		t.Fatalf("bad summary: %+v", s)
	}
	if s.TailDigest == "" {
		t.Fatal("want tail digest")
	}
}

func digestOf(line string) string {
	var body struct {
		Raw string `json:"-"`
	}
	_ = body
	start := strings.Index(line, `"body":`) + len(`"body":`)
	// body runs to ,"sha256"
	end := strings.LastIndex(line, `,"sha256"`)
	sum := sha256.Sum256([]byte(line[start:end]))
	return hex.EncodeToString(sum[:])
}

func TestByteFlipShowsUnverified(t *testing.T) {
	dir := t.TempDir()
	l0, _ := eventLine(0, zeroPrev, "session", `{"project":"/tmp/proj"}`, "100")
	l1, _ := eventLine(1, digestOf(l0), "completed", `{"user":"hello","assistant":"hi"}`, "200")
	flipped := strings.Replace(l1, "hello", "hallo", 1)
	writeSession(t, dir, "s-bad", l0, flipped)

	got := Service{Dir: dir}.List()
	if len(got) != 1 || got[0].ChainOK {
		t.Fatalf("want unverified, got %+v", got)
	}
	if got[0].TailDigest != "" {
		t.Fatal("broken chain must not carry a tail digest")
	}
}

func TestTranscriptCapAndOrder(t *testing.T) {
	dir := t.TempDir()
	var lines []string
	prev := zeroPrev
	digests := []string{}
	l0, d0 := eventLine(0, zeroPrev, "session", `{"project":"/tmp/proj"}`, "100")
	lines = append(lines, l0)
	prev = d0
	_ = digests
	for i := 1; i <= 5; i++ {
		l, d := eventLine(i, prev, "completed", fmt.Sprintf(`{"user":"q%d","assistant":"a%d"}`, i, i), fmt.Sprintf("%d", 100+i))
		lines = append(lines, l)
		prev = d
	}
	writeSession(t, dir, "s-cap", lines...)

	tr, found := Service{Dir: dir}.Transcript("s-cap", 3)
	if !found || !tr.ChainOK || tr.Total != 6 || len(tr.Events) != 3 {
		t.Fatalf("bad transcript: %+v found=%v", tr, found)
	}
	if tr.Events[0].Seq != 5 || tr.Events[2].Seq != 3 {
		t.Fatal("want newest-first")
	}
	if _, found := (Service{Dir: dir}).Transcript("../escape", 3); found {
		t.Fatal("path traversal must not resolve")
	}
	if _, found := (Service{Dir: dir}).Transcript("missing", 3); found {
		t.Fatal("unknown id must not resolve")
	}
}
