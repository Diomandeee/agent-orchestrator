package clichat

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SessionsDir resolves the UCTM CLI session store. UCTM_HOME wins; the
// default is ~/.uctm/sessions. Read-only by contract: nothing in this
// package writes under the directory.
func SessionsDir() string {
	if home := os.Getenv("UCTM_HOME"); home != "" {
		return filepath.Join(home, "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".uctm", "sessions")
}

// Summary is the list-view projection of one CLI session file.
type Summary struct {
	ID             string `json:"id"`
	Display        string `json:"display"`
	MessageCount   int    `json:"messageCount"`
	LastActivityNs string `json:"lastActivityNs"`
	TailDigest     string `json:"tailDigest"`
	ChainOK        bool   `json:"chainOk"`
	Project        string `json:"project"`
}

// TranscriptEvent is one chain event with its raw data preserved verbatim.
// Handles stay handles: data is never expanded.
type TranscriptEvent struct {
	Seq    uint64          `json:"seq"`
	Kind   string          `json:"kind"`
	TimeNs string          `json:"timeNs"`
	Data   json.RawMessage `json:"data"`
}

// Transcript is the capped, newest-first event view of one session.
type Transcript struct {
	ID       string            `json:"id"`
	ChainOK  bool              `json:"chainOk"`
	Total    int               `json:"total"`
	Events   []TranscriptEvent `json:"events"`
	CappedAt int               `json:"cappedAt"`
}

// MaxTranscriptEvents bounds transcript responses per the spec cap.
const MaxTranscriptEvents = 200

type rawEvent struct {
	Body json.RawMessage `json:"body"`
	SHA  string          `json:"sha256"`
}

type rawBody struct {
	Seq  uint64          `json:"seq"`
	Prev string          `json:"prev"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
	Time string          `json:"time_ns"`
}

func digestBody(raw json.RawMessage) string {
	sum := sha256.Sum256(bytes.TrimSpace(raw))
	return hex.EncodeToString(sum[:])
}

// parse verifies the hash chain structurally and cryptographically: every
// event must parse, link prev/seq, and its raw body bytes must hash to the
// recorded digest. The raw bytes are hashed, never a re-marshal, because key
// order is part of the digest. Anything else yields chainOK=false with
// whatever decoded cleanly up to the break.
func parse(content []byte) ([]TranscriptEvent, bool) {
	lines := bytes.Split(content, []byte("\n"))
	events := make([]TranscriptEvent, 0, len(lines))
	prev := "0000000000000000000000000000000000000000000000000000000000000000"
	var seq uint64
	for _, line := range lines {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var ev rawEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			return events, false
		}
		var body rawBody
		if err := json.Unmarshal(ev.Body, &body); err != nil {
			return events, false
		}
		if body.Seq != seq || body.Prev != prev || digestBody(ev.Body) != ev.SHA {
			return events, false
		}
		events = append(events, TranscriptEvent{Seq: body.Seq, Kind: body.Kind, TimeNs: body.Time, Data: body.Data})
		prev = ev.SHA
		seq++
	}
	return events, true
}

func userText(data json.RawMessage) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	var s string
	if raw, ok := m["user"]; ok && json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func summarize(id string, events []TranscriptEvent, chainOK bool, tail string) Summary {
	out := Summary{ID: id, Display: id, ChainOK: chainOK, TailDigest: tail}
	turns := 0
	for _, e := range events {
		switch e.Kind {
		case "session":
			var m map[string]json.RawMessage
			if json.Unmarshal(e.Data, &m) == nil {
				var project string
				if raw, ok := m["project"]; ok {
					_ = json.Unmarshal(raw, &project)
					out.Project = project
				}
			}
		case "completed", "failed":
			turns++
			if out.Display == id {
				if text := strings.TrimSpace(userText(e.Data)); text != "" {
					runes := []rune(text)
					if len(runes) > 80 {
						text = string(runes[:80]) + "…"
					}
					out.Display = text
				}
			}
		}
		if e.TimeNs > out.LastActivityNs {
			out.LastActivityNs = e.TimeNs
		}
	}
	out.MessageCount = turns
	return out
}

// tailDigest returns the recorded digest of the final event.
func tailDigest(content []byte) string {
	var last []byte
	for _, line := range bytes.Split(content, []byte("\n")) {
		if len(bytes.TrimSpace(line)) > 0 {
			last = line
		}
	}
	if len(last) == 0 {
		return ""
	}
	var ev rawEvent
	if err := json.Unmarshal(last, &ev); err != nil {
		return ""
	}
	return ev.SHA
}

// Service reads CLI session files. No method writes.
type Service struct {
	Dir string
}

// List returns one summary per *.jsonl file, sorted by id. Unreadable or
// broken files degrade to chain_ok=false entries, never errors that hide
// the rest of the store.
func (s Service) List() []Summary {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil
	}
	var out []Summary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".jsonl")
		content, err := os.ReadFile(filepath.Join(s.Dir, entry.Name()))
		if err != nil {
			out = append(out, Summary{ID: id, Display: id})
			continue
		}
		events, chainOK := parse(content)
		tail := ""
		if chainOK {
			tail = tailDigest(content)
		}
		out = append(out, summarize(id, events, chainOK, tail))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Transcript returns up to `limit` events newest-first (default cap when
// limit <= 0). Unknown ids and path tricks yield found=false; a broken chain
// yields chain_ok=false with whatever decoded, never a 500 for a file
// problem.
func (s Service) Transcript(id string, limit int) (Transcript, bool) {
	if id == "" || strings.ContainsAny(id, "/\\. ") {
		return Transcript{}, false
	}
	content, err := os.ReadFile(filepath.Join(s.Dir, id+".jsonl"))
	if err != nil {
		return Transcript{}, false
	}
	events, chainOK := parse(content)
	if limit <= 0 || limit > MaxTranscriptEvents {
		limit = MaxTranscriptEvents
	}
	out := Transcript{ID: id, ChainOK: chainOK, Total: len(events), CappedAt: limit}
	for i := len(events) - 1; i >= 0 && len(out.Events) < limit; i-- {
		out.Events = append(out.Events, events[i])
	}
	return out, true
}
