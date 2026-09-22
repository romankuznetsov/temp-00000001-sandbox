package main

import (
	"strings"
	"testing"
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
