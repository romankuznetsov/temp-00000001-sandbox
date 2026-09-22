package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
)

// A qWDTT tunnel's address, resolvers and MTU are not known until the server
// answers, so netifd cannot be given them when the interface is brought up. It
// is told afterwards, the way udhcpc tells it about a lease: the protocol
// handler starts this client, and this client runs the up-script once RAWCONF
// arrives. Shelling out rather than speaking ubus keeps the client free of a
// ubus dependency and puts the netifd calls where every other OpenWrt daemon
// protocol puts them.
const netifdUpScript = "/lib/netifd/qwdtt-up.sh"

const netifdErrorScript = "/lib/netifd/qwdtt-error.sh"

// Set when -netifd is given, because the workers that hit a fatal condition
// are several call frames away from the flag and have no other reason to know
// how the client was started.
var netifdManaged bool

// Refusals a reconnect cannot clear. Told to netifd, they appear against the
// interface on Network -> Interfaces; left in the log, they are a line the
// operator has to go looking for while the tunnel retries for ever.
//
// Matched on the message rather than plumbed through from where the server's
// DENIED reason is parsed, so that protocol.go stays free of netifd: it is
// shared with a build that has none.
var netifdErrors = []struct{ contains, code string }{
	{"the password is bound to another device", "QWDTT_DEVICE_MISMATCH"},
	{"the password has expired", "QWDTT_PASSWORD_EXPIRED"},
	{"wrong connection password", "QWDTT_WRONG_PASSWORD"},
	{"хеш мёртв", "QWDTT_HASH_DEAD"},
	{"FATAL_AUTH", "QWDTT_AUTH_FAILED"},
}

func netifdErrorCode(message string) string {
	for _, e := range netifdErrors {
		if strings.Contains(message, e.contains) {
			return e.code
		}
	}
	return ""
}

// Reported once. Every worker meets the same refusal, and netifd wants to know
// what is wrong with the interface, not how many streams noticed.
var netifdErrorOnce sync.Once

func notifyNetifdError(message string) {
	code := netifdErrorCode(message)
	if !netifdManaged || code == "" {
		return
	}
	netifdErrorOnce.Do(func() {
		if err := runNativeCommandEnv([]string{"ERROR=" + code}, netifdErrorScript); err != nil {
			log.Printf("[NETIFD] reporting %s: %v", code, err)
		}
	})
}

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
