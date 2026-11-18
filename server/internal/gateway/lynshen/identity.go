package lynshen

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"request-monitor/internal/identity"
)

// sessionCookie is the cookie the gateway sets for the parent domain of its public origin
// (dashboard-session-authentication.spec.md DSA1), so a screen on a subdomain receives it.
const sessionCookie = "monoize_session"

// Verifier asks a LynShen gateway who a dashboard session belongs to (spec OS-SN2).
type Verifier struct {
	endpoint string
	client   *http.Client
}

// NewVerifier returns a verifier for the gateway whose HTTP API is at apiURL.
func NewVerifier(apiURL string) (*Verifier, error) {
	parsed, err := url.Parse(strings.TrimSpace(apiURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("lynshen: gateway.api_url must be an http or https URL")
	}
	parsed.RawQuery, parsed.Fragment = "", ""
	return &Verifier{
		endpoint: strings.TrimRight(parsed.String(), "/") + "/api/dashboard/auth/me",
		client: &http.Client{
			Timeout: 3 * time.Second,
			// The credential goes to the configured gateway and nowhere else: no proxy from the
			// environment, and no redirect is followed.
			Transport:     &http.Transport{Proxy: nil, MaxIdleConns: 4, IdleConnTimeout: time.Minute, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// wellFormed reports whether a value can be a session token. It keeps anything else out of the
// header that is sent to the gateway.
func wellFormed(value string) bool {
	if value == "" || len(value) > 512 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == '~', c == '+', c == '/', c == '=', c == '-':
		default:
			return false
		}
	}
	return true
}

// Credential is the session token of a request: the session cookie, or else a Bearer token.
func (v *Verifier) Credential(r *http.Request) string {
	if cookie, err := r.Cookie(sessionCookie); err == nil && wellFormed(cookie.Value) {
		return cookie.Value
	}
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		if token = strings.TrimSpace(token); wellFormed(token) {
			return token
		}
	}
	return ""
}

// Verify asks the gateway. Only a 200 answer that names a role makes a visitor more than a guest.
func (v *Verifier) Verify(ctx context.Context, credential string) (identity.Role, bool) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.endpoint, nil)
	if err != nil {
		return identity.Guest, false
	}
	request.Header.Set("Authorization", "Bearer "+credential)
	request.Header.Set("Accept", "application/json")
	response, err := v.client.Do(request)
	if err != nil {
		return identity.Guest, false
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		// The gateway answered: this is not a usable session.
		return identity.Guest, true
	default:
		return identity.Guest, false
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&body); err != nil {
		return identity.Guest, false
	}
	switch body.Role {
	case "admin", "super_admin":
		return identity.Admin, true
	case "":
		return identity.Guest, false
	default:
		return identity.User, true
	}
}
