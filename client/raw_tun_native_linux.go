//go:build linux && !android

package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

var (
	interfaceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.:-]+$`)
	routeNumberPattern   = regexp.MustCompile(`^[0-9]+$`)
	// Value or value/mask, decimal or hex, which is what `ip rule` accepts.
	fwmarkPattern = regexp.MustCompile(`^(0[xX][0-9a-fA-F]+|[0-9]+)(/(0[xX][0-9a-fA-F]+|[0-9]+))?$`)
)

type nativeRawTUN struct {
	file         *os.File
	name         string
	lanInterface string
	route        rawRoute
}

func createNativeRawTUN(name, lanInterface, address string, mtu int, route rawRoute) (*nativeRawTUN, error) {
	if name == "" {
		name = "qwdtt0"
	}
	if lanInterface == "" {
		lanInterface = "br-lan"
	}
	if !validInterfaceName(name) || !validInterfaceName(lanInterface) {
		return nil, fmt.Errorf("invalid interface name")
	}
	if !routeNumberPattern.MatchString(route.table) {
		return nil, fmt.Errorf("invalid route table %q", route.table)
	}
	if !routeNumberPattern.MatchString(route.priority) {
		return nil, fmt.Errorf("invalid rule priority %q", route.priority)
	}
	if route.fwmark != "" && !fwmarkPattern.MatchString(route.fwmark) {
		return nil, fmt.Errorf("invalid fwmark %q", route.fwmark)
	}
	ip := net.ParseIP(address).To4()
	if ip == nil {
		return nil, fmt.Errorf("invalid raw IPv4 address %q", address)
	}
	if mtu < 576 || mtu > 9000 {
		return nil, fmt.Errorf("invalid MTU %d", mtu)
	}

	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/net/tun: %w", err)
	}
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("create ifreq: %w", err)
	}
	ifr.SetUint16(unix.IFF_TUN | unix.IFF_NO_PI)
	if err := unix.IoctlIfreq(fd, unix.TUNSETIFF, ifr); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("TUNSETIFF: %w", err)
	}
	if err := unix.SetNonblock(fd, false); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("set blocking TUN: %w", err)
	}

	t := &nativeRawTUN{
		file:         os.NewFile(uintptr(fd), "/dev/net/tun"),
		name:         name,
		lanInterface: lanInterface,
		route:        route,
	}
	if err := t.configure(address, mtu); err != nil {
		t.file.Close()
		return nil, err
	}
	return t, nil
}

func validInterfaceName(name string) bool {
	return len(name) > 0 && len(name) < unix.IFNAMSIZ && interfaceNamePattern.MatchString(name)
}

func (t *nativeRawTUN) configure(address string, mtu int) error {
	commands := [][]string{
		{"ip", "addr", "replace", address + "/16", "dev", t.name},
		{"ip", "link", "set", "dev", t.name, "mtu", strconv.Itoa(mtu), "up"},
	}
	for _, command := range commands {
		if err := runNativeCommand(command...); err != nil {
			return err
		}
	}
	_ = runNativeCommand("ip", "route", "flush", "table", t.route.table)
	if err := runNativeCommand("ip", "route", "replace", "default", "dev", t.name, "table", t.route.table); err != nil {
		return err
	}
	rule := t.ruleSelector()
	_ = runNativeCommand(append([]string{"ip", "rule", "del"}, rule...)...)
	if err := runNativeCommand(append([]string{"ip", "rule", "add"}, rule...)...); err != nil {
		return err
	}
	if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1\n"), 0644); err != nil {
		return fmt.Errorf("enable IPv4 forwarding: %w", err)
	}
	return nil
}

// Which traffic this tunnel takes. With a mark configured the LAN rule is not
// added as well: both rules would sit at the same priority, and a second
// tunnel would then never see a packet, because the first one's iif rule
// already matches everything arriving from the LAN.
func (t *nativeRawTUN) ruleSelector() []string {
	if t.route.fwmark != "" {
		return []string{"fwmark", t.route.fwmark, "lookup", t.route.table, "priority", t.route.priority}
	}
	return []string{"iif", t.lanInterface, "lookup", t.route.table, "priority", t.route.priority}
}

func (t *nativeRawTUN) cleanup() {
	_ = t.file.Close()
	rule := t.ruleSelector()
	_ = runNativeCommand(append([]string{"ip", "rule", "del"}, rule...)...)
	_ = runNativeCommand("ip", "route", "flush", "table", t.route.table)
	_ = runNativeCommand("ip", "link", "del", t.name)
}

func runNativeCommand(args ...string) error {
	cmd := exec.Command(args[0], args[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s: %s", strings.Join(args, " "), message)
	}
	return nil
}
