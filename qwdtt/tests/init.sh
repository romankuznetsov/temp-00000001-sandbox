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

CFG_SECTIONS="main work late twin noserver off"

# section.option=value. main is the shipped shape: no mark, so it takes
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
work.tun_name=qwdtt1
work.route_table=51821
work.rule_priority=9000
work.fwmark=0x100/0xff00
late.enabled=1
late.peer_host=vpn3.example
late.password=p3
late.hash=ddd
late.tun_name=qwdtt2
late.route_table=51822
late.rule_priority=11000
late.fwmark=0x200/0xff00
twin.enabled=1
twin.peer_host=vpn4.example
twin.password=p4
twin.hash=eee
twin.tun_name=qwdtt1
twin.route_table=51823
twin.rule_priority=9001
twin.fwmark=0x300/0xff00
noserver.enabled=1
noserver.hash=ggg
noserver.tun_name=qwdtt4
noserver.route_table=51825
noserver.rule_priority=9003
noserver.fwmark=0x400/0xff00
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

reset() {
	TUNS=
	TABLES=
	PRIOS=
	CATCHALL=
	CATCHALL_PRIO=
}

got=$(start_service "" 2>&1)
want='started: main
   /var/run/qwdtt/qwdtt-main -mode rawtun -peer vpn1.example:56003 -vk aaa,bbb -password p1 -device-id openwrt-main -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name qwdtt0 -route-table 51820 -rule-priority 10000
started: work
   /var/run/qwdtt/qwdtt-work -mode rawtun -peer vpn2.example -vk ccc -password p2 -device-id openwrt-work -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name qwdtt1 -route-table 51821 -rule-priority 9000
   -route-fwmark 0x100/0xff00
refused: qwdtt.late: rule_priority 11000 must be below 10000, the priority of the section that has no fwmark
refused: qwdtt.twin: tun_name qwdtt1 is already taken by work
refused: qwdtt.noserver.peer_host is not set'

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
CFG_SECTIONS="main work off"
reset
got=$(start_service "" 2>&1)
want='started: main
   /var/run/qwdtt/qwdtt-main -mode rawtun -peer vpn1.example:56003 -vk aaa,bbb -password p1 -device-id openwrt-main -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name qwdtt0 -route-table 51820 -rule-priority 10000
started: work
   /var/run/qwdtt/qwdtt-work -mode rawtun -peer vpn2.example -vk ccc -password p2 -device-id openwrt-work -n 9 -go-dns yandex -obfs audio -captcha-mode auto -vk-auth anonymous -vk-anon-path vkcalls -tun-name qwdtt1 -route-table 51821 -rule-priority 9000
   -route-fwmark 0x100/0xff00'

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
got=$(start_service work 2>&1 | grep -c '^started:')
if [ "$got" != 1 ]; then
	echo "start_service work started $got instances, expected 1"
	exit 1
fi

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
spare.tun_name=qwdtt3
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

echo "qwdtt.init: ok"
