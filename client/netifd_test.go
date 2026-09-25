package main

import (
	"strings"
	"testing"
	"time"
)

// The server's RAWCONF separates resolvers with commas and the up-script
// iterates DNS as a word list, so this conversion is the whole contract
// between them.
func TestNetifdUpEnvDNS(t *testing.T) {
	tests := []struct {
		name string
		csv  string
		want string
	}{
		{"one resolver", "10.70.0.1", "DNS=10.70.0.1"},
		{"several", "10.70.0.1,1.1.1.1", "DNS=10.70.0.1 1.1.1.1"},
		{"spaces after the commas", "10.70.0.1, 1.1.1.1", "DNS=10.70.0.1 1.1.1.1"},
		{"a trailing comma adds no empty resolver", "10.70.0.1,", "DNS=10.70.0.1"},
		{"none at all", "", "DNS="},
	}

	for _, tc := range tests {
		got := netifdUpEnv("qwdtt0", "10.70.0.2", tc.csv, 1300)
		if !hasEnv(got, tc.want) {
			t.Errorf("%s: got %q, want %q in it", tc.name, got, tc.want)
		}
	}
}

func TestNetifdUpEnvCarriesTheDevice(t *testing.T) {
	got := netifdUpEnv("qwdtt0", "10.70.0.2", "10.70.0.1", 1300)

	for _, want := range []string{"DEVICE=qwdtt0", "IPADDR=10.70.0.2", "MTU=1300"} {
		if !hasEnv(got, want) {
			t.Errorf("got %q, want %q in it", got, want)
		}
	}
}

// The name alone, so a test for DNS= does not pass on DNS=10.70.0.1.
func hasEnv(env []string, want string) bool {
	name := want[:strings.Index(want, "=")+1]

	for _, entry := range env {
		if strings.HasPrefix(entry, name) {
			return entry == want
		}
	}
	return false
}

// The point is which refusal is reported, not that one is: an operator reading
// "Unknown error (FATAL_AUTH)" on the interface learns nothing they could act
// on, and the three password refusals need three different corrections.
func TestNetifdErrorCode(t *testing.T) {
	tests := []struct {
		message string
		want    string
	}{
		{"FATAL_AUTH: the password is bound to another device", "QWDTT_DEVICE_MISMATCH"},
		{"FATAL_AUTH: the password has expired", "QWDTT_PASSWORD_EXPIRED"},
		{"FATAL_AUTH: wrong connection password", "QWDTT_WRONG_PASSWORD"},
		{"FATAL_AUTH: access denied (banned)", "QWDTT_AUTH_FAILED"},
		{"хеш мёртв", "QWDTT_HASH_DEAD"},
		{"TURN Allocate: error 401", ""},
		{"", ""},
	}

	for _, tc := range tests {
		if got := netifdErrorCode(tc.message); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.message, got, tc.want)
		}
	}
}

// The watchdog restarts the tunnel, so the cases it must not fire on matter as
// much as the one it must. Each step is one tick of netifdTrafficTick.
func TestStallTracker(t *testing.T) {
	const tick = netifdTrafficTick

	// up, down after each tick; want is the stall reported at that tick.
	tests := []struct {
		name  string
		steps [][2]int64
		want  []time.Duration
	}{
		{
			"an idle tunnel never stalls",
			[][2]int64{{0, 0}, {0, 0}, {0, 0}},
			[]time.Duration{0, 0, 0},
		},
		{
			"traffic both ways never stalls",
			[][2]int64{{100, 50}, {200, 120}, {300, 200}},
			[]time.Duration{0, 0, 0},
		},
		{
			"a tunnel that has never delivered is left to come up",
			[][2]int64{{100, 0}, {200, 0}, {300, 0}},
			[]time.Duration{0, 0, 0},
		},
		{
			"one that delivered and stopped accumulates",
			[][2]int64{{100, 50}, {200, 50}, {300, 50}, {400, 50}},
			[]time.Duration{0, 0, tick, 2 * tick},
		},
		{
			"one byte back clears it",
			[][2]int64{{100, 50}, {200, 50}, {300, 50}, {400, 51}},
			[]time.Duration{0, 0, tick, 0},
		},
		{
			"the lan going quiet clears it, because that is idleness",
			[][2]int64{{100, 50}, {200, 50}, {300, 50}, {300, 50}, {400, 50}},
			[]time.Duration{0, 0, tick, 0, 0},
		},
	}

	for _, tc := range tests {
		var s stallTracker
		now := time.Unix(0, 0)
		for i, step := range tc.steps {
			now = now.Add(tick)
			if got := s.sample(step[0], step[1], now); got != tc.want[i] {
				t.Errorf("%s: tick %d got %v, want %v", tc.name, i, got, tc.want[i])
			}
		}
	}
}
