//go:build linux && !android

package main

import (
	"strings"
	"testing"
)

// The exclusivity is the point: a tunnel selected by mark must not also claim
// everything arriving from the LAN, or a second tunnel never sees a packet.
func TestRuleSelector(t *testing.T) {
	tests := []struct {
		name  string
		tun   nativeRawTUN
		wants string
	}{
		{
			name: "lan interface when no mark is set",
			tun: nativeRawTUN{
				lanInterface: "br-lan",
				route:        rawRoute{table: "51820", priority: "10000"},
			},
			wants: "iif br-lan lookup 51820 priority 10000",
		},
		{
			name: "mark replaces the interface, not adds to it",
			tun: nativeRawTUN{
				lanInterface: "br-lan",
				route:        rawRoute{table: "51821", priority: "10001", fwmark: "0x100/0xff00"},
			},
			wants: "fwmark 0x100/0xff00 lookup 51821 priority 10001",
		},
	}

	for _, tc := range tests {
		got := strings.Join(tc.tun.ruleSelector(), " ")
		if got != tc.wants {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.wants)
		}
	}
}

// Rejected before anything is opened, so this runs unprivileged.
func TestCreateNativeRawTUNRejectsBadRouting(t *testing.T) {
	tests := []struct {
		name  string
		route rawRoute
	}{
		{"empty table", rawRoute{table: "", priority: "10000"}},
		{"table is not a number", rawRoute{table: "main", priority: "10000"}},
		{"priority is not a number", rawRoute{table: "51820", priority: "high"}},
		{"fwmark is not a mark", rawRoute{table: "51820", priority: "10000", fwmark: "0x100; reboot"}},
	}

	for _, tc := range tests {
		if _, err := createNativeRawTUN("qwdtt0", "br-lan", "10.0.0.2", 1300, tc.route); err == nil {
			t.Errorf("%s: accepted", tc.name)
		}
	}
}
