#!/bin/sh
# Run by `qwdtt-client -netifd` once the server has answered with the tunnel's
# address, resolvers and MTU. netifd cannot be given them when the interface is
# brought up, because they arrive over the tunnel's own control connection -
# the same shape as a DHCP lease, and told to netifd the same way.

[ -n "$INTERFACE" ] && [ -n "$DEVICE" ] && [ -n "$IPADDR" ] || {
	echo "qwdtt-up: INTERFACE, DEVICE and IPADDR must be set" >&2
	exit 1
}

. /lib/functions.sh
. /lib/netifd/netifd-proto.sh

config_load network
config_get_bool defaultroute "$INTERFACE" defaultroute 1
config_get_bool peerdns "$INTERFACE" peerdns 1

[ -z "$MTU" ] || ip link set dev "$DEVICE" mtu "$MTU"

proto_init_update "$DEVICE" 1
# /16, not /32: the server hands every peer an address out of one 10.x.0.0/16
# and expects them to reach each other without going back through it.
proto_add_ipv4_address "$IPADDR" 16

if [ "$defaultroute" = 1 ]; then
	proto_add_ipv4_route 0.0.0.0 0
fi
if [ "$peerdns" = 1 ]; then
	for server in $DNS; do
		proto_add_dns_server "$server"
	done
fi

proto_send_update "$INTERFACE"
