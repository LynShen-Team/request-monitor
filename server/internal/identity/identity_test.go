package identity

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fake struct {
	calls    atomic.Int64
	role     Role
	answered bool
	delay    time.Duration
}

func (f *fake) Credential(r *http.Request) string { return r.Header.Get("X-Test-Credential") }
func (f *fake) Verify(context.Context, string) (Role, bool) {
	f.calls.Add(1)
	time.Sleep(f.delay)
	return f.role, f.answered
}

func request(credential string) *http.Request {
	r := httptest.NewRequest("GET", "/api/identity", nil)
	if credential != "" {
		r.Header.Set("X-Test-Credential", credential)
	}
	return r
}

func TestGuestWithoutVerifierOrCredential(t *testing.T) {
	if New(nil).Identify(request("anything")) != Guest {
		t.Fatal("without a verifier a visitor is not a guest")
	}
	var none *Service
	if none.Identify(request("anything")) != Guest {
		t.Fatal("a nil service must answer guest")
	}
	f := &fake{role: Admin, answered: true}
	if New(f).Identify(request("")) != Guest || f.calls.Load() != 0 {
		t.Fatal("a request without a credential must be a guest and must not ask the gateway")
	}
}

func TestAnswersAreKeptForSixtySeconds(t *testing.T) {
	f := &fake{role: Admin, answered: true}
	s := New(f)
	now := time.Unix(1_800_000_000, 0)
	s.now = func() time.Time { return now }
	for i := 0; i < 5; i++ {
		if s.Identify(request("a")) != Admin {
			t.Fatal("not admin")
		}
	}
	if f.calls.Load() != 1 {
		t.Fatalf("the gateway was asked %d times within 60 s, want 1", f.calls.Load())
	}
	// Another credential is another question.
	s.Identify(request("b"))
	if f.calls.Load() != 2 {
		t.Fatal("a second credential was answered from the first one's cache entry")
	}
	// After 60 s the gateway is asked again, and a role it took away is gone.
	now = now.Add(61 * time.Second)
	f.role = User
	if s.Identify(request("a")) != User || f.calls.Load() != 3 {
		t.Fatalf("after 60 s: calls %d", f.calls.Load())
	}
}

func TestNoAnswerIsGuestAndIsAskedAgainSoon(t *testing.T) {
	// Whatever role comes with "no answer" is ignored.
	f := &fake{role: Admin, answered: false}
	s := New(f)
	now := time.Unix(1_800_000_000, 0)
	s.now = func() time.Time { return now }
	if s.Identify(request("a")) != Guest {
		t.Fatal("a gateway that gave no answer made a visitor more than a guest")
	}
	s.Identify(request("a"))
	if f.calls.Load() != 1 {
		t.Fatal("a failure must be kept for a few seconds")
	}
	now = now.Add(6 * time.Second)
	f.answered = true
	if s.Identify(request("a")) != Admin || f.calls.Load() != 2 {
		t.Fatal("after 5 s the gateway must be asked again")
	}
}

func TestUnknownRoleIsGuest(t *testing.T) {
	f := &fake{role: Role("root"), answered: true}
	if New(f).Identify(request("a")) != Guest {
		t.Fatal("a role the service does not know made a visitor more than a guest")
	}
}

func TestConcurrentRequestsShareOneQuestion(t *testing.T) {
	f := &fake{role: User, answered: true, delay: 50 * time.Millisecond}
	s := New(f)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.Identify(request("a")) != User {
				t.Error("not user")
			}
		}()
	}
	wg.Wait()
	if f.calls.Load() != 1 {
		t.Fatalf("20 simultaneous requests asked the gateway %d times, want 1", f.calls.Load())
	}
}
