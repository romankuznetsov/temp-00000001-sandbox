package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// A qWDTT tunnel's address, resolvers and MTU are not known until the server
// answers, so netifd cannot be given them when the interface is brought up. It
// is told afterwards, the way udhcpc tells it about a lease: the protocol
// handler starts this client, and this client runs the up-script once RAWCONF
// arrives. Shelling out rather than speaking ubus keeps the client free of a
// ubus dependency and puts the netifd calls where every other OpenWrt daemon
// protocol puts them.
const netifdUpScript = "/lib/netifd/qwdtt-up.sh"

func notifyNetifd(device, address, dnsCSV string, mtu int) error {
	if os.Getenv("INTERFACE") == "" {
		return fmt.Errorf("INTERFACE is unset: -netifd only works under the qwdtt protocol handler")
	}
	return runNativeCommandEnv(netifdUpEnv(device, address, dnsCSV, mtu), netifdUpScript)
}

// The up-script iterates DNS unquoted, so the separator has to be whitespace.
// Splitting rather than replacing drops the empty fields a trailing comma would
// otherwise turn into an empty resolver.
func netifdUpEnv(device, address, dnsCSV string, mtu int) []string {
	servers := strings.FieldsFunc(dnsCSV, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t'
	})
	return []string{
		"DEVICE=" + device,
		"IPADDR=" + address,
		"DNS=" + strings.Join(servers, " "),
		"MTU=" + strconv.Itoa(mtu),
	}
}
