package parks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ParksDir resolves the parked-idea store. UCTM_PARKS_DIR wins; the default
// is the UCTM Studio bridge parks directory. Read-only by contract: nothing
// in this package writes under the directory.
func ParksDir() string {
	if dir := os.Getenv("UCTM_PARKS_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Developer", "UCTM-Studio", "bridge", "parks")
}

// Summary is the card-view projection of one parked idea packet.
// Wave and Tier are additive fleet-board fields; garden packets omit them
// and read back as zero values.
type Summary struct {
	Name    string   `json:"name"`
	Created string   `json:"created"`
	Status  string   `json:"status"`
	State   string   `json:"state"`
	Blocked []string `json:"blocked"`
	Next    []string `json:"next"`
	Wave    int      `json:"wave"`
	Tier    string   `json:"tier"`
}

// statusOf normalizes the lifecycle state. Anything unrecognized sleeps.
func statusOf(raw string) string {
	if raw == "active" {
		return "active"
	}
	return "parked"
}

// rawPacket mirrors the handoff packet shape written by `uctm resume`
// helpers. Only card fields are projected; unknown fields are ignored.
type rawPacket struct {
	Name        string   `json:"name"`
	Created     string   `json:"created"`
	Status      string   `json:"status"`
	State       string   `json:"state"`
	BlockedOnMo []string `json:"blocked_on_mo"`
	BlockedOnMO []string `json:"blocked_on_MO"`
	Blocked     []string `json:"blocked"`
	Next        []string `json:"next"`
	Wave        int      `json:"wave"`
	Tier        string   `json:"tier"`
}

// Service reads parked packets. Dir is the parks directory.
type Service struct {
	Dir string
}

// stem validates a packet name: filename stem only, no traversal.
func stem(name string) (string, bool) {
	if name == "" || name != filepath.Base(name) {
		return "", false
	}
	if strings.ContainsAny(name, "./\\") {
		return "", false
	}
	return name, true
}

// List returns one summary per *.json packet, sorted by name.
func (s Service) List() []Summary {
	out := []Summary{}
	if s.Dir == "" {
		return out
	}
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		raw, err := os.ReadFile(filepath.Join(s.Dir, e.Name()))
		if err != nil {
			continue
		}
		var p rawPacket
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		blocked := append(append([]string{}, p.BlockedOnMo...), p.BlockedOnMO...)
		blocked = append(blocked, p.Blocked...)
		if p.Name == "" {
			p.Name = name
		}
		out = append(out, Summary{
			Name: p.Name, Created: p.Created, Status: statusOf(p.Status),
			State: p.State, Blocked: blocked, Next: p.Next,
			Wave: p.Wave, Tier: p.Tier,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Packet returns the raw packet bytes verbatim for one parked idea.
func (s Service) Packet(name string) (json.RawMessage, bool) {
	stemmed, ok := stem(name)
	if !ok || s.Dir == "" {
		return nil, false
	}
	raw, err := os.ReadFile(filepath.Join(s.Dir, stemmed+".json"))
	if err != nil {
		return nil, false
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, false
	}
	return json.RawMessage(raw), true
}
