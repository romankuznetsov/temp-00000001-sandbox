#!/bin/sh
# Exercises qwdtt.init away from a router. The init script is the piece that
# decides which tunnels may run together, and every way it can be wrong is
# quiet: a section that silently carries nothing, or two that flush each
# other's routing table. So the checks it makes are asserted here, against
# stubs for the procd and uci helpers, with the command lines printed instead
# of started.
#
# Run from the repository root: sh qwdtt/tests/init.sh
set -u

CFG_SECTIONS="main work late twin noserver waytoolongfortun off"

# section.option=value. The section name is the TUN device, so there is no
# tun_name here at all. main is the shipped shape: no mark, so it takes
# everything from the LAN. work is a valid second tunnel. The rest are each
# wrong in one way.
CFG='
main.enabled=1
main.peer_host=vpn1.example
main.peer_port=56003
main.password=p1
main.device_id=openwrt-main
main.hash=aaa bbb
work.enabled=1
work.peer_host=vpn2.example
work.password=p2
work.device_id=openwrt-work
work.hash=ccc
work.route_table=51821
work.rule_priority=9000
work.fwmark=0x100/0xff00
late.enabled=1
late.peer_host=vpn3.example
late.password=p3
late.hash=ddd
late.route_table=51822
late.rule_priority=11000
late.fwmark=0x200/0xff00
twin.enabled=1
twin.peer_host=vpn4.example
twin.password=p4
twin.hash=eee
twin.route_table=51821
twin.rule_priority=9001
twin.fwmark=0x300/0xff00
noserver.enabled=1
noserver.hash=ggg
noserver.route_table=51825
noserver.rule_priority=9003
noserver.fwmark=0x400/0xff00
waytoolongfortun.enabled=1
waytoolongfortun.peer_host=vpn7.example
waytoolongfortun.password=p7
waytoolongfortun.hash=iii
waytoolongfortun.route_table=51826
waytoolongfortun.rule_priority=9004
waytoolongfortun.fwmark=0x500/0xff00
off.enabled=0
off.peer_host=vpn6.example
off.hash=hhh
'

config_load() { :; }

config_get() {
	eval "$1=\"$(printf '%s\n' "$CFG" | sed -n "s/^$2\\.$3=//p")\""
	eval "[ -n \"\$$1\" ] || $1=\${4:-}"
}

config_get_bool() { config_get "$@"; }

config_foreach() {
	_fn=$1
	shift 2
	for _sec in $CFG_SECTIONS; do
		"$_fn" "$_sec" "$@"
	done
}

logger() {
	shift 2
	echo "refused: $*"
}

uci() { echo ""; }
mkdir() { :; }
ln() { :; }

procd_open_instance() { echo "started: $1"; }
procd_set_param() {
	[ "$1" = command ] || return 0
	shift
	echo "   $*"
}
procd_append_param() { procd_set_param "$@"; }
procd_close_instance() { :; }
procd_add_reload_trigger() { :; }

. ./qwdtt/files/qwdtt.init

# Replace the two that touch the router: there is no /sys and no /var/run here,
# and what the checks below are about is which devices get dropped and when.
drop_device() { echo "dropped: $1"; }
drop_orphans() { echo "swept orphans"; }

reset() {
	TABLES=
	PRIOS=
	IDS=
	CATCHALL=
	CATCHALL_PRIO=
}

got=$(start_service "" 2>&1)
want='started: main
   /var/run/qwdtt/qwdtt-main -mode rawtun -peer vpn1.example:56003 -vk aaa,bbb -password p1 -device-id openwrt-main -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name main -route-table 51820 -rule-priority 10000
started: work
   /var/run/qwdtt/qwdtt-work -mode rawtun -peer vpn2.example -vk ccc -password p2 -device-id openwrt-work -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name work -route-table 51821 -rule-priority 9000
   -route-fwmark 0x100/0xff00
refused: qwdtt.late: rule_priority 11000 must be below 10000, the priority of the section that has no fwmark
refused: qwdtt.twin: route_table 51821 is already taken by work
refused: qwdtt.noserver.peer_host is not set
refused: qwdtt.waytoolongfortun: the name is longer than 15 characters, which cannot be an interface name
dropped: off
swept orphans'

if [ "$got" != "$want" ]; then
	echo "start_service with every section:"
	echo "--- got"
	echo "$got"
	echo "--- want"
	echo "$want"
	exit 1
fi

# The same config minus the sections that collide, so the two that remain are
# the shape the documentation describes: one catch-all and one marked tunnel.
# The switched-off section has its device taken away rather than left holding
# the traffic routed into it.
CFG_SECTIONS="main work off"
reset
got=$(start_service "" 2>&1)
want='started: main
   /var/run/qwdtt/qwdtt-main -mode rawtun -peer vpn1.example:56003 -vk aaa,bbb -password p1 -device-id openwrt-main -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name main -route-table 51820 -rule-priority 10000
started: work
   /var/run/qwdtt/qwdtt-work -mode rawtun -peer vpn2.example -vk ccc -password p2 -device-id openwrt-work -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name work -route-table 51821 -rule-priority 9000
   -route-fwmark 0x100/0xff00
dropped: off
swept orphans'

if [ "$got" != "$want" ]; then
	echo "start_service with one catch-all and one marked tunnel:"
	echo "--- got"
	echo "$got"
	echo "--- want"
	echo "$want"
	exit 1
fi

# A named section starts that one and leaves the others alone, which is what
# /etc/init.d/qwdtt start <section> and the per-row buttons in LuCI rely on.
reset
got=$(start_service work 2>&1)
if [ "$(printf '%s\n' "$got" | grep -c '^started:')" != 1 ]; then
	echo "start_service work started the wrong number of instances:"
	echo "$got"
	exit 1
fi
# And it touches no device but its own: procd is being told about one instance,
# so the other sections' devices are not this call's to judge.
case $got in
*'dropped: '*|*'swept orphans'*)
	echo "start_service work removed a device:"; echo "$got"; exit 1 ;;
esac

# Of two catch-alls the first in the file runs and the second is refused,
# rather than both being refused: adding a broken section must not take down
# the tunnel that was already working, which is exactly what happened the first
# time this was tried on a router.
CFG_SECTIONS="main spare"
CFG="$CFG
spare.enabled=1
spare.peer_host=vpn5.example
spare.password=p5
spare.hash=fff
spare.route_table=51824
spare.rule_priority=9002
"
reset
got=$(start_service "" 2>&1)
case $got in
*'started: main'*) ;;
*) echo "the first catch-all did not start:"; echo "$got"; exit 1 ;;
esac
case $got in
*'refused: qwdtt.spare: main already takes everything from the LAN'*) ;;
*) echo "the second catch-all was not refused:"; echo "$got"; exit 1 ;;
esac

# A shared device_id makes the server treat two tunnels as one device and
# disconnect them in turn, which reads as a flapping link rather than as a
# configuration mistake. Both values are spelled out here because the default
# is derived from the hostname, which differs between machines.
CFG_SECTIONS="main clone"
CFG="$CFG
clone.enabled=1
clone.peer_host=vpn8.example
clone.password=p8
clone.hash=jjj
clone.device_id=openwrt-main
clone.route_table=51827
clone.rule_priority=9005
clone.fwmark=0x600/0xff00
"
reset
got=$(start_service "" 2>&1)
case $got in
*'refused: qwdtt.clone: device_id openwrt-main is already taken by main'*) ;;
*) echo "the duplicate device_id was not refused:"; echo "$got"; exit 1 ;;
esac

echo "qwdtt.init: ok"
