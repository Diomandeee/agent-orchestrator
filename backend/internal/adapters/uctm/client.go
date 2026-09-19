// Package uctm adapts AO to a UCTM service over a loopback-only HTTP transport.
//
// The adapter is deliberately narrow. It reads; it never writes, proposes, or
// mutates UCTM state. It refuses to talk to a DNS name, follows no redirect, and
// rejects any response that is missing required provenance metadata — because a
// fact AO cannot provenance is not a UCTM fact, and displaying it anyway would
// turn a fabrication into an operator's dashboard.
package uctm

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// DefaultTimeout bounds one projection read when the caller configures none.
const DefaultTimeout = 5 * time.Second

// maxResponseBytes caps a projection body. The UCTM contract has no size
// negotiation, so an unbounded read would let a misbehaving peer exhaust the
// daemon's memory on a route the UI polls.
const maxResponseBytes = 8 << 20

// ErrorKind classifies a failed read without exposing transport internals to
// the API layer. The service maps these onto stable display reasons.
type ErrorKind string

const (
	// ErrorTransport means AO could not complete the exchange at all: refused
	// connection, timeout, TLS failure, oversized body.
	ErrorTransport ErrorKind = "transport"
	// ErrorStatus means UCTM answered with a non-success HTTP status.
	ErrorStatus ErrorKind = "status"
	// ErrorProtocol means UCTM answered, but the answer cannot be trusted:
	// wrong content type, unknown fields, missing provenance, hash mismatch.
	ErrorProtocol ErrorKind = "protocol"
)

// Error is the adapter's typed failure. It never carries the response body or
// the bearer token, so it is safe to log and to surface.
type Error struct {
	Kind       ErrorKind
	StatusCode int
	Message    string
	Err        error
}

// Error implements error.
func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("uctm read %s: %s: %v", e.Kind, e.Message, e.Err)
	}
	return fmt.Sprintf("uctm read %s: %s", e.Kind, e.Message)
}

// Unwrap exposes the underlying cause.
func (e *Error) Unwrap() error { return e.Err }

// Config is the adapter's resolved configuration. Token is secret: it is never
// logged, never returned in a DTO, and never written to a receipt.
type Config struct {
	BaseURL string
	Token   string
	Timeout time.Duration
}

// Client is a loopback-pinned UCTM read client.
type Client struct {
	baseURL *url.URL
	token   string
	http    *http.Client
}

// NewClient validates cfg and returns a client. A non-loopback host, a DNS
// name, an explicit redirect target, or a missing bearer token is an error at
// construction time rather than a surprise on the first read.
func NewClient(cfg Config) (*Client, error) {
	base, err := ValidateBaseURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.Token) == "" {
		return nil, fmt.Errorf("uctm transport: UCTM_API_TOKEN is required with UCTM_MODE=%s", "read_only")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		baseURL: base,
		token:   cfg.Token,
		http: &http.Client{
			Timeout: timeout,
			// A redirect is how a loopback-only promise is broken: the next hop
			// is chosen by the peer, not by AO. Refuse it instead of following.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
			Transport: &http.Transport{
				// nil disables proxy support entirely; the default
				// ProxyFromEnvironment would let HTTPS_PROXY route a loopback
				// read through a third party.
				Proxy: nil,
				DialContext: (&net.Dialer{
					Timeout:   timeout,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				ForceAttemptHTTP2:     true,
				MaxIdleConns:          4,
				MaxIdleConnsPerHost:   2,
				IdleConnTimeout:       30 * time.Second,
				TLSHandshakeTimeout:   timeout,
				ExpectContinueTimeout: time.Second,
			},
		},
	}, nil
}

// ValidateBaseURL enforces the v0 transport invariants and returns the parsed
// URL. It is exported so the daemon can fail the same way at wiring time that
// the client fails at construction time.
//
// Rejected: empty, relative, non-http(s), embedded credentials, a path, a query,
// a fragment, a missing port, a DNS name, and any address that is not loopback.
func ValidateBaseURL(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q is not a URL: %w", raw, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must be http or https", raw)
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must not carry credentials", raw)
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must not carry a path", raw)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must not carry a query or fragment", raw)
	}
	if parsed.Port() == "" {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must name an explicit port", raw)
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must use a loopback IP literal; DNS names are rejected in v0", raw)
	}
	if !ip.IsLoopback() {
		return nil, fmt.Errorf("uctm transport: UCTM_API_BASE_URL %q must be loopback", raw)
	}
	return &url.URL{Scheme: parsed.Scheme, Host: parsed.Host}, nil
}

// wireResponse is the frozen v0 projection envelope. The metadata block is
// embedded so the required fields sit at the top level of the response, exactly
// as the integration contract lists them.
type wireResponse struct {
	domain.UCTMWireMetadata
	Payload json.RawMessage `json:"payload"`
}

// Fetch performs one projection read. It returns NoFacts for an explicit
// abstention (204) and an error for everything else that is not a usable
// projection.
func (c *Client) Fetch(ctx context.Context, kind domain.UCTMProjectionKind) (domain.UCTMSourceResponse, error) {
	if !kind.Valid() {
		return domain.UCTMSourceResponse{}, fmt.Errorf("uctm read: unknown projection kind %q", kind)
	}
	target := *c.baseURL
	target.Path = kind.ServicePath()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorTransport, Message: "build request", Err: err}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorTransport, Message: "request failed", Err: err}
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
		return domain.UCTMSourceResponse{NoFacts: true}, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
		return domain.UCTMSourceResponse{}, &Error{
			Kind: ErrorStatus, StatusCode: resp.StatusCode,
			Message: fmt.Sprintf("unexpected status %d for %s", resp.StatusCode, kind.ServicePath()),
		}
	}
	if err := requireJSONContentType(resp.Header.Get("Content-Type")); err != nil {
		return domain.UCTMSourceResponse{}, err
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorTransport, Message: "read body", Err: err}
	}
	if len(body) > maxResponseBytes {
		return domain.UCTMSourceResponse{}, &Error{
			Kind:    ErrorTransport,
			Message: fmt.Sprintf("response exceeds %d bytes", maxResponseBytes),
		}
	}

	var wire wireResponse
	dec := json.NewDecoder(bytes.NewReader(body))
	// Unknown fields are refused at the boundary. A UCTM service that starts
	// sending a new field is a contract change a human must review; silently
	// dropping it would let a semantic change look like a no-op.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&wire); err != nil {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorProtocol, Message: "decode response envelope", Err: err}
	}
	if err := wire.UCTMWireMetadata.Validate(); err != nil {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorProtocol, Message: "validate response metadata", Err: err}
	}
	if len(wire.Payload) == 0 {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorProtocol, Message: "payload is required"}
	}

	payload, err := compactJSON(wire.Payload)
	if err != nil {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorProtocol, Message: "payload is not JSON", Err: err}
	}
	// `null` is valid JSON and a meaningless projection: it would store as a
	// fact whose content is "nothing", which is exactly the invented state this
	// path must never produce.
	if string(payload) == "null" {
		return domain.UCTMSourceResponse{}, &Error{Kind: ErrorProtocol, Message: "payload must not be null"}
	}
	if err := verifyContentHash(wire.UCTMWireMetadata.ContentHashOrETag, payload); err != nil {
		return domain.UCTMSourceResponse{}, err
	}

	return domain.UCTMSourceResponse{
		Metadata: wire.UCTMWireMetadata,
		Payload:  payload,
		MaxAge:   parseMaxAge(resp.Header.Get("Cache-Control")),
	}, nil
}

func requireJSONContentType(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return &Error{Kind: ErrorProtocol, Message: "Content-Type is required"}
	}
	mediaType, _, err := mime.ParseMediaType(raw)
	if err != nil {
		return &Error{Kind: ErrorProtocol, Message: "Content-Type is malformed", Err: err}
	}
	if mediaType != "application/json" {
		return &Error{Kind: ErrorProtocol, Message: fmt.Sprintf("Content-Type %q is not application/json", mediaType)}
	}
	return nil
}

// compactJSON returns the payload with insignificant whitespace removed so two
// spellings of the same document produce the same content address.
func compactJSON(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// verifyContentHash enforces the service's own content address when it claims
// one. A bare ETag is opaque and only recorded; a claimed sha256 that does not
// match the bytes is a provenance break and fails closed.
func verifyContentHash(claimed string, payload []byte) error {
	digest, ok := parseSHA256(claimed)
	if !ok {
		return nil
	}
	if !strings.EqualFold(digest, domain.ContentAddress(payload)) {
		return &Error{Kind: ErrorProtocol, Message: "content_hash_or_etag does not match the payload"}
	}
	return nil
}

// parseSHA256 recognises "sha256:<hex>" and a bare 64-character hex digest.
func parseSHA256(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(trimmed, "sha256:")
	if len(trimmed) != 64 {
		return "", false
	}
	if _, err := hex.DecodeString(trimmed); err != nil {
		return "", false
	}
	return trimmed, true
}

// parseMaxAge reads the max-age directive from a Cache-Control header. An
// absent, malformed, or repeated directive yields zero, which makes the caller
// apply its own default rather than trusting a value it cannot parse.
func parseMaxAge(header string) time.Duration {
	var found time.Duration
	for _, directive := range strings.Split(header, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(directive), "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "max-age") {
			continue
		}
		seconds, err := strconv.Atoi(strings.Trim(strings.TrimSpace(value), `"`))
		if err != nil || seconds < 0 {
			continue
		}
		if found != 0 {
			// Repeated directive: ambiguous, so take none of them.
			return 0
		}
		found = time.Duration(seconds) * time.Second
	}
	return found
}

// IsNotFound reports whether err is the adapter's "no such projection" style of
// protocol failure. Kept for callers that want to distinguish a peer answering
// 404 from a peer that is unreachable.
func IsNotFound(err error) bool {
	var typed *Error
	if errors.As(err, &typed) {
		return typed.Kind == ErrorStatus && typed.StatusCode == http.StatusNotFound
	}
	return false
}
