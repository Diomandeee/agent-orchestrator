package daemon

import (
	"log/slog"

	adaptersuctm "github.com/aoagents/agent-orchestrator/backend/internal/adapters/uctm"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	uctmsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/uctm"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// wireUCTMProjection builds the read-only UCTM projection service.
//
// The two failure directions are deliberately different:
//
//   - A malformed UCTM_MODE stops the daemon at config load. AO must never run
//     under an authority level nobody asked for.
//   - An unusable transport (non-loopback host, DNS name, missing token) does
//     NOT stop the daemon. It leaves the source unwired, logs at error level,
//     and keeps the configured mode visible so every read answers
//     `transport_not_configured`. A governance read path that cannot be proven
//     loopback must fail closed without taking the coding harness down with it.
func wireUCTMProjection(cfg config.UCTMConfig, store *sqlite.Store, log *slog.Logger) *uctmsvc.Service {
	opts := uctmsvc.Options{Mode: cfg.Mode}
	// Assign the store only when it exists. A typed nil *sqlite.Store boxed into
	// the service's interface is non-nil as an interface, so the service's own
	// nil check would pass and the first read would dereference it.
	if store != nil {
		opts.Store = store
	}
	if cfg.Mode.ReadsEnabled() {
		client, err := adaptersuctm.NewClient(adaptersuctm.Config{
			BaseURL: cfg.BaseURL,
			Token:   cfg.Token,
			Timeout: cfg.Timeout,
		})
		if err != nil {
			// The error is safe to log: the adapter never includes the bearer
			// token or a response body in its message.
			log.Error("uctm reads disabled: transport rejected; every uctm route will report transport_not_configured",
				"mode", string(cfg.Mode), "err", err)
		} else {
			opts.Source = client
		}
	}
	return uctmsvc.New(opts)
}
