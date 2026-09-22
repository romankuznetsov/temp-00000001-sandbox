// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
'require view';
'require dom';
'require poll';
'require rpc';
'require network';

/* Status -> qWDTT. Most of the table comes off the interface, because netifd
   owns it now and the counters it keeps are free. Two things are not free: the
   log, and where each tunnel's counters stood when it last came up - the TUN
   device outlives the interface on purpose, so its totals would otherwise be
   shown against an uptime that starts at the restart. */

var callLog = rpc.declare({
	object: 'luci.qwdtt',
	method: 'getLog',
	params: [ 'name' ],
	expect: { log: '' }
});

var callBaselines = rpc.declare({
	object: 'luci.qwdtt',
	method: 'getBaselines',
	expect: { '': {} }
});

function tunnels() {
	return Promise.all([ network.getNetworks(), callBaselines() ]).then(function(res) {
		var baselines = res[1] || {};

		return res[0].filter(function(net) {
			return net.getProtocol() == 'qwdtt';
		}).map(function(net) {
			net.qwdttBase = baselines[net.getName()] || null;
			return net;
		});
	});
}

/* Counted from the last time the interface came up. A device recreated since
   then counts from zero and so reads below the baseline, in which case the raw
   total is already the figure that is wanted. */
function since(now, base) {
	return (base != null && now >= base) ? now - base : now;
}

function peerOf(net) {
	var host = net._get('peer_host');
	var port = net._get('peer_port');

	if (!host)
		return '-';
	return port ? host + ':' + port : host;
}

/* Shaped like the Status cell on Network -> Interfaces: L.itemlist lays out the
   label and value pairs and drops every pair whose value is null, which is how
   the counters disappear for a tunnel that has not come up yet.

   Up means the tunnel is carrying traffic, not that the client is running: the
   client creates its device and reports an address only once the server has
   answered, so everything before that is "connecting". */
function stateOf(net) {
	var device = net.getL3Device() || net.getDevice();

	if (!net.isUp()) {
		return L.itemlist(E('span'), [
			null, E('em', net.isDynamic() || net.getUptime() > 0
				? _('connecting') : _('down'))
		]);
	}

	var base = net.qwdttBase || {};

	return L.itemlist(E('span'), [
		_('Uptime'), '%t'.format(net.getUptime()),
		_('IPv4'), (net.getIPAddrs() || [])[0] || null,
		_('RX'), device ? '%.2mB (%d %s)'.format(
			since(device.getRXBytes(), base.rx_bytes),
			since(device.getRXPackets(), base.rx_packets), _('Pkts.')) : null,
		_('TX'), device ? '%.2mB (%d %s)'.format(
			since(device.getTXBytes(), base.tx_bytes),
			since(device.getTXPackets(), base.tx_packets), _('Pkts.')) : null
	]);
}

function renderTable(nets) {
	var table = new L.ui.Table(
		[ _('Tunnel'), _('Peer'), _('Device'), _('Status') ],
		{ id: 'qwdtt-tunnels' },
		E('em', [ _('No qWDTT interfaces are configured.') ])
	);

	table.update(nets.map(function(net) {
		return [
			net.getName(),
			peerOf(net),
			net.getL3Device() ? net.getL3Device().getName() : net.getName(),
			stateOf(net)
		];
	}));

	return table.render();
}

return view.extend({
	/* network.getNetworks() reads the system feature probe synchronously and
	   throws if it has not resolved, which on a router with no wifi is where a
	   view that asks for networks first thing lands. Waiting for it here costs
	   one cached call and is what keeps this page working where the stock
	   Interfaces page does not. */
	load: function() {
		return L.probeSystemFeatures().then(tunnels);
	},

	/* Which tunnel's log is on screen. Empty is every tunnel, which is what
	   `logread -e qwdtt` gives on the command line. */
	selected: '',

	refreshLog: function() {
		var box = document.getElementById('qwdtt-log');

		if (!box)
			return Promise.resolve();

		return callLog(this.selected).then(function(text) {
			var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;

			box.value = (text || '').trim() || _('Log is empty');
			if (atBottom)
				box.scrollTop = box.scrollHeight;
		});
	},

	render: function(nets) {
		var page = this;
		var picker = E('select', {
			'class': 'cbi-input-select',
			'change': function(ev) {
				page.selected = ev.target.value;
				page.refreshLog();
			}
		}, [ E('option', { 'value': '' }, [ _('All tunnels') ]) ].concat(
			nets.map(function(net) {
				return E('option', { 'value': net.getName() }, [ net.getName() ]);
			})));

		var box = E('textarea', {
			'id': 'qwdtt-log',
			'style': 'font-family:monospace; font-size:12px; width:100%',
			'readonly': 'readonly',
			'wrap': 'off',
			'rows': 25
		}, [ _('Collecting data...') ]);

		poll.add(function() {
			return Promise.all([
				tunnels().then(function(fresh) {
					var into = document.getElementById('qwdtt-table');
					if (into)
						dom.content(into, renderTable(fresh));
				}),
				page.refreshLog()
			]);
		}, 5);

		return E([], [
			E('h2', [ _('qWDTT') ]),
			E('div', { 'id': 'qwdtt-table' }, [ renderTable(nets) ]),
			E('h3', [ _('Log') ]),
			E('div', { 'class': 'cbi-section-descr' },
				_('The last 400 lines the system log holds, newest last. netifd prefixes every line with the interface it came from, which is what one tunnel is picked out by.')),
			E('div', { 'style': 'margin-bottom:.5em' }, [ picker ]),
			box
		]);
	},

	handleReset: null,
	handleSaveApply: null,
	handleSave: null
});
