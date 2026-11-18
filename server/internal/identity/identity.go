// Package identity finds the role of a visitor from the gateway credential that arrives with the
// request (spec section 12). The role is decided here and nowhere else: nothing the page states
// about itself is read.
package identity

import (
	"context"
	"crypto/sha256"
	"net/http"
	"sync"
	"time"
)

// Role is who is looking.
type Role string

const (
	// Guest is the zero answer: a visitor that could not be identified.
	Guest Role = "guest"
	User  Role = "user"
	Admin Role = "admin"
)

const (
	// answerTTL is how long an answer of the gateway is kept (OS-B6.3).
	answerTTL = 60 * time.Second
	// failureTTL is how long "the gateway gave no answer" is kept, so that a gateway that is down
	// is not asked on every request.
	failureTTL = 5 * time.Second
	// askTimeout is how long the gateway may take (OS-B6.2).
	askTimeout = 3 * time.Second
	maxEntries = 10000
)

// Verifier knows the credentials of one gateway.
type Verifier interface {
	// Credential takes the gateway credential out of a request; "" when there is none.
	Credential(r *http.Request) string
	// Verify asks the gateway whose credential this is. answered is false when the gateway gave
	// no usable answer; the role is then Guest.
	Verify(ctx context.Context, credential string) (role Role, answered bool)
}

// Service identifies visitors and remembers the answers for a short time.
type Service struct {
	verifier Verifier
	now      func() time.Time

	mu       sync.Mutex
	cache    map[[sha256.Size]byte]entry
	inflight map[[sha256.Size]byte]*call
}

type entry struct {
	role    Role
	expires time.Time
}

type call struct {
	done chan struct{}
	role Role
}

// New returns a service that asks verifier. With a nil verifier every visitor is a guest.
func New(verifier Verifier) *Service {
	return &Service{verifier: verifier, now: time.Now, cache: map[[sha256.Size]byte]entry{}, inflight: map[[sha256.Size]byte]*call{}}
}

// Identify returns the role of the visitor who sent r. It never returns more than the gateway
// confirmed: every doubt is Guest.
func (s *Service) Identify(r *http.Request) Role {
	if s == nil || s.verifier == nil {
		return Guest
	}
	credential := s.verifier.Credential(r)
	if credential == "" {
		return Guest
	}
	// The cache is keyed by a hash, so no credential outlives its request in memory.
	key := sha256.Sum256([]byte(credential))

	s.mu.Lock()
	if e, ok := s.cache[key]; ok && s.now().Before(e.expires) {
		s.mu.Unlock()
		return e.role
	}
	if running, ok := s.inflight[key]; ok {
		s.mu.Unlock()
		<-running.done
		return running.role
	}
	c := &call{done: make(chan struct{}), role: Guest}
	s.inflight[key] = c
	s.mu.Unlock()

	// The question is shared by every request that waits for it, so it does not end when the
	// request that started it is cancelled.
	ctx, cancel := context.WithTimeout(context.Background(), askTimeout)
	role, answered := s.verifier.Verify(ctx, credential)
	cancel()
	if role != Admin && role != User {
		role = Guest
	}

	s.mu.Lock()
	ttl := answerTTL
	if !answered {
		role, ttl = Guest, failureTTL
	}
	if len(s.cache) >= maxEntries {
		now := s.now()
		for k, e := range s.cache {
			if !now.Before(e.expires) {
				delete(s.cache, k)
			}
		}
		if len(s.cache) >= maxEntries {
			s.cache = map[[sha256.Size]byte]entry{}
		}
	}
	s.cache[key] = entry{role: role, expires: s.now().Add(ttl)}
	delete(s.inflight, key)
	c.role = role
	s.mu.Unlock()
	close(c.done)
	return role
}
