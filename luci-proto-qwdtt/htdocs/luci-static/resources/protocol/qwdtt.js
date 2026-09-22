// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
'require form';
'require network';
'require uci';
'require ui';

/* The qWDTT protocol class. A tunnel is a section of /etc/config/network with
   option proto 'qwdtt', so it is created, edited, started and stopped from
   Network -> Interfaces with the standard controls, and this file only has to
   describe the fields the protocol handler reads.

   What needs code is the hash list: the client accepts a full VK call link and
   reduces it to a hash itself (ParseHashes over the -vk flag), so storing a
   link would work -- but it would leave a link in the config and make the count
   on the status page misleading. Links are therefore reduced here, on save.

   That reduction is a translation of ParseHashes and normalizeVKJoinHash from
   the client's client/group.go, which is why this file is GPL-3.0-or-later and
   cannot be relicensed by one contributor alone: group.go carries no SPDX
   header of its own, inherits its repository's GPL-3.0, and has more than one
   author. Keeping the two in step also matters behaviourally -- if the
   client's rule changes, this must follow. */

/* ---- hash handling -------------------------------------------------------
   Ports of normalizeVKJoinHash and ParseHashes from the client's group.go. */

function trimChars(s, chars) {
	var start = 0, end = s.length;
	while (start < end && chars.indexOf(s.charAt(start)) !== -1)
		start++;
	while (end > start && chars.indexOf(s.charAt(end - 1)) !== -1)
		end--;
	return s.slice(start, end);
}

function firstIndexOfAny(s, chars) {
	var best = -1;
	for (var i = 0; i < chars.length; i++) {
		var at = s.indexOf(chars.charAt(i));
		if (at !== -1 && (best === -1 || at < best))
			best = at;
	}
	return best;
}

/* A full VK join link reduces to its trailing token; the "j-" such links carry
   is PART of the hash and is deliberately not stripped. A URL that is not a
   join link is rejected outright, exactly as the client does. */
function normalizeVKJoinHash(input) {
	var s = trimChars(String(input == null ? '' : input).trim(), '<>"\'');
	if (!s)
		return '';

	var lower = s.toLowerCase();
	var marker = '/call/join/';
	var idx = lower.indexOf(marker);

	if (idx >= 0)
		s = s.slice(idx + marker.length);
	else if (lower.indexOf('http://') === 0 ||
	         lower.indexOf('https://') === 0)
		return '';

	var cut = firstIndexOfAny(s, '?#/');
	if (cut !== -1)
		s = s.slice(0, cut);

	return trimChars(s.trim(), '/');
}

/* The client splits on comma, semicolon, whitespace and newlines, then
   deduplicates. One pasted field may therefore expand into several hashes. */
function splitHashTokens(raw) {
	var seps = ',;\n\r\t ';
	var out = [], cur = '';
	for (var i = 0; i < raw.length; i++) {
		var ch = raw.charAt(i);
		if (seps.indexOf(ch) !== -1) {
			if (cur)
				out.push(cur);
			cur = '';
		}
		else {
			cur += ch;
		}
	}
	if (cur)
		out.push(cur);
	return out;
}

/* Every hash VK has issued so far is 43 characters from the base64url
   alphabet -- unpadded base64 of a 32-byte token. The CLIENT enforces nothing
   of the sort: it only refuses an empty list. So this is a check against
   typos and truncated pastes, not a mirror of a rule the daemon applies, and
   the field description says as much so a future format change is
   diagnosable rather than mysterious. */
var HASH_LEN = 43;
var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
             'abcdefghijklmnopqrstuvwxyz' + '0123456789-_';

/* null when the hash looks right, otherwise why not. */
function hashProblem(h) {
	if (!h)
		return _('not a VK call link or a hash');
	if (h.length !== HASH_LEN)
		return _('expected %d characters, got %d').format(HASH_LEN, h.length);
	for (var i = 0; i < h.length; i++)
		if (B64URL.indexOf(h.charAt(i)) === -1)
			return _('unexpected character "%s"').format(h.charAt(i));
	return null;
}

function parseHashes(entries) {
	var seen = {}, out = [];
	entries.forEach(function(entry) {
		splitHashTokens(String(entry == null ? '' : entry)).forEach(function(token) {
			var h = normalizeVKJoinHash(token);
			if (h && !seen[h]) {
				seen[h] = true;
				out.push(h);
			}
		});
	});
	return out;
}

/* Per-line so a bad paste names the line to fix rather than just failing. One
   line may still hold several hashes -- the client separates on commas and
   semicolons too -- so each token is judged on its own. */
function parseHashLines(text) {
	var seen = {}, hashes = [], errors = [];
	String(text == null ? '' : text).split('\n').forEach(function(raw, i) {
		var line = raw.trim();
		if (!line)
			return;
		splitHashTokens(line).forEach(function(token) {
			var h = normalizeVKJoinHash(token);
			var problem = hashProblem(h);
			if (problem) {
				errors.push(_('line %d: %s').format(i + 1, problem));
				return;
			}
			if (!seen[h]) {
				seen[h] = true;
				hashes.push(h);
			}
		});
	});
	return { hashes: hashes, errors: errors };
}

/* getCurrent() supplies the prefill and onImport() receives the parsed list.
   Both are passed in rather than read here so the modal works against the
   widget's staged value and never has to know where it lives. */
function openHashImport(getCurrent, onImport) {
	var area = E('textarea', {
		'rows': 12,
		'wrap': 'off',
		'style': 'width:100%; font-family:monospace; font-size:12px'
	}, [ getCurrent().join('\n') ]);

	var problems = E('div', {
		'class': 'alert-message warning',
		'style': 'display:none; white-space:pre-wrap'
	});

	function complain(text) {
		problems.textContent = text;
		problems.style.display = '';
	}

	function save() {
		var parsed = parseHashLines(area.value);
		if (parsed.errors.length)
			return complain(parsed.errors.join('\n'));
		/* Not merely an invalid setting: the client picks a hash with
		   Hashes[i % len(Hashes)], so an empty list divides by zero. */
		if (!parsed.hashes.length)
			return complain(_('At least one hash is required.'));

		ui.hideModal();
		onImport(parsed.hashes);
		ui.addNotification(null, E('p', {},
			_('%d hash(es) staged. Use Save & Apply to write them and reload the client.')
				.format(parsed.hashes.length)), 'info');
	}

	ui.showModal(_('Import hashes'), [
		E('p', {}, [
			_('One per line, and the box starts from the current list so existing entries are kept unless you remove them. A full VK call link may be pasted and is reduced to its hash; commas and semicolons separate too, and duplicates are dropped.')
		]),
		area,
		problems,
		E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn',
				'click': ui.createHandlerFn(this, function() { ui.hideModal(); })
			}, [ _('Dismiss') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button-positive',
				'click': ui.createHandlerFn(this, save)
			}, [ _('Save') ])
		])
	]);
	area.focus();
}

/* ---- routing -------------------------------------------------------------
   The tunnel needs a routing table of its own, and that is not a preference.
   The client reaches its VK TURN relays over the WAN, so a default route into
   the tunnel in the main table would send the tunnel's own transport through
   the tunnel; the protocol handler refuses to come up rather than take the
   router's WAN down that way.

   What decides which traffic enters the table is an ordinary `config rule`,
   and what stops traffic leaking to the WAN while the tunnel is down is an
   ordinary unreachable route in the same table. Neither is a qWDTT option --
   both are written here because every value they need is known here, and
   both are then editable on Network -> Routing like any other. */

var KILL_METRIC = '4096';

function tableOf(section_id) {
	return uci.get('network', section_id, 'ip4table') || '';
}

/* The lowest table nothing else has claimed. 51820 is where the client's own
   default sat, so a router with one tunnel keeps the number it already had. */
function freeTable() {
	var used = {};

	uci.sections('network', 'interface', function(section) {
		var table = section.ip4table;
		if (table)
			used[table] = true;
	});

	for (var table = 51820; table < 52820; table++)
		if (!used[String(table)])
			return String(table);

	return '51820';
}

/* Below every rule that exists, so a tunnel added second is consulted first.
   The one added first is usually the catch-all, and a rule that matches
   everything has to be asked last or the others never see a packet. */
function freePriority() {
	var lowest = null;

	uci.sections('network', 'rule', function(section) {
		var priority = parseInt(section.priority, 10);
		if (!isNaN(priority) && (lowest == null || priority < lowest))
			lowest = priority;
	});

	return String(lowest == null ? 10000 : Math.max(1, lowest - 1));
}

function addLanRouting(section_id, table) {
	var rule = section_id + '_rule';
	var kill = section_id + '_killswitch';

	if (uci.get('network', rule) == null)
		uci.add('network', 'rule', rule);
	uci.set('network', rule, 'in', 'lan');
	uci.set('network', rule, 'lookup', table);
	if (!uci.get('network', rule, 'priority'))
		uci.set('network', rule, 'priority', freePriority());

	/* Attached to loopback so that it outlives the tunnel: a route attached to
	   the tunnel itself would disappear exactly when it is needed. The metric
	   is beaten by the tunnel's own default, so it only decides what happens
	   once that one is gone. */
	if (uci.get('network', kill) == null)
		uci.add('network', 'route', kill);
	uci.set('network', kill, 'interface', 'loopback');
	uci.set('network', kill, 'target', '0.0.0.0/0');
	uci.set('network', kill, 'type', 'unreachable');
	uci.set('network', kill, 'table', table);
	uci.set('network', kill, 'metric', KILL_METRIC);
}

/* Only what is there. Removing a section that does not exist still marks the
   map as changed, which would show an unsaved change on every visit to a
   tunnel that never had these. */
function dropLanRouting(section_id) {
	[ '_rule', '_killswitch' ].forEach(function(suffix) {
		if (uci.get('network', section_id + suffix) != null)
			uci.remove('network', section_id + suffix);
	});
}

return network.registerProtocol('qwdtt', {
	getI18n: function() {
		return _('qWDTT');
	},

	getIfname: function() {
		return this._ubus('l3_device') || this.sid;
	},

	getOpkgPackage: function() {
		return 'qwdtt-client';
	},

	getIcon: function() {
		return L.resource('icons/tunnel%s.png').format(this.isUp() ? '' : '_disabled');
	},

	isFloating: function() {
		return true;
	},

	isVirtual: function() {
		return true;
	},

	getDevices: function() {
		return null;
	},

	containsDevice: function(ifname) {
		return (network.getIfnameOf(ifname) == this.getIfname());
	},

	renderFormOptions: function(s) {
		var o;

		/* The section name is the TUN device the client creates, so it has to
		   be a name the kernel takes. Nothing else in the editor says so, and
		   the protocol handler's refusal arrives only after Save & Apply. */
		if (s.section.length > 15)
			s.description = _('This interface name is longer than 15 characters, so the tunnel cannot come up: the name is also the TUN device, and the kernel takes 15.');

		o = s.taboption('general', form.Value, 'peer_host', _('Peer host'),
			_('Server hostname or IP address.'));
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'peer_port', _('Peer port'),
			_('UDP port of the server RAW listener, usually 56003.'));
		o.datatype = 'port';
		o.placeholder = '56003';

		o = s.taboption('general', form.Value, 'password', _('Password'),
			_('Connection password, as set on the server.'));
		o.password = true;
		o.rmempty = false;

		o = s.taboption('general', form.DynamicList, 'hash', _('Hashes'),
			_('One field per hash, %d characters each. A VK call link may be pasted into a field and is reduced to its hash when saved. Import takes several at once. At least one is required -- the client selects a hash modulo the list length, so an empty list cannot work.').format(HASH_LEN));

		/* DynamicList passes `optional: this.optional || this.rmempty` to its
		   widget, so clearing rmempty is what routes an empty list through
		   LuCI's own "non-empty value" rejection rather than a check of our
		   own. */
		o.rmempty = false;

		/* Judged per field. A link passes because it reduces to a valid hash,
		   which is what the client would do with it anyway. */
		o.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;
			return hashProblem(normalizeVKJoinHash(value)) || true;
		};

		/* Normalise on the way to UCI so a pasted link is stored as the hash
		   it denotes and duplicates collapse. */
		o.write = function(section_id, formvalue) {
			var list = Array.isArray(formvalue) ? formvalue
			         : (formvalue ? [ formvalue ] : []);
			return form.DynamicList.prototype.write.call(this, section_id,
				parseHashes(list));
		};

		/* The stock widget with a button under it. Delegating to the parent
		   keeps the standard add and remove controls instead of
		   reimplementing them, and the button goes in a wrapper rather than
		   inside the dynlist node, whose children are its items. Wrapping is
		   safe for getUIElement, which resolves the widget by element id. */
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			var self = this;
			var node = form.DynamicList.prototype.renderWidget.apply(this, arguments);

			/* Staged, not saved: an import must start from what the user is
			   looking at, including edits not yet written. */
			function staged() {
				var el = self.getUIElement(section_id);
				var v = el ? el.getValue() : null;
				if (Array.isArray(v))
					return v.filter(function(x) { return x != null && x !== ''; });
				var saved = uci.get('network', section_id, 'hash');
				return Array.isArray(saved) ? saved : (saved ? [ String(saved) ] : []);
			}

			return E('div', {}, [
				node,
				E('div', { 'style': 'margin-top:.5em' }, [
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'title': _('Paste several hashes or VK call links at once'),
						'click': ui.createHandlerFn(this, function() {
							openHashImport(staged, function(hashes) {
								var el = self.getUIElement(section_id);
								if (el)
									el.setValue(hashes);
							});
						})
					}, [ _('Import') ])
				])
			]);
		};

		o = s.taboption('general', form.Value, 'device_id', _('Device ID'),
			_('Identifies this tunnel to the server. Two tunnels that share one are a single device to it, and it disconnects them in turn. Left empty, the protocol handler derives it from the hostname and the interface name, which cannot collide.'));
		o.placeholder = 'openwrt-' + s.section;

		/* ---- routing ------------------------------------------------------ */

		o = s.taboption('general', form.Value, 'ip4table', _('Routing table'),
			_('Table the tunnel writes its address and default route into. Required: in the main table that default route would carry the client\'s own traffic to VK back into the tunnel, and the tunnel would never come up.'));
		o.datatype = 'uinteger';
		o.rmempty = false;
		o.default = freeTable();
		/* A field still equal to its default is not written, and this one has
		   no useful default to fall back on: the protocol handler refuses to
		   start without it. */
		o.forcewrite = true;

		o = s.taboption('general', form.Flag, '_lanroute',
			_('Route the LAN through this tunnel'),
			_('Writes two ordinary sections of /etc/config/network: a routing rule sending traffic from the lan interface to the table above, and an unreachable default route in that table so nothing escapes to the WAN while the tunnel is down. Edit either of them afterwards on Network -> Routing - to send one client or one destination instead of the whole LAN, narrow the rule there.'));
		o.rmempty = false;
		/* So that a table changed above is carried into the rule, which is
		   otherwise left pointing at the old one. */
		o.forcewrite = true;

		/* Not a uci option of its own: the two sections it writes are what it
		   reads back. */
		o.cfgvalue = function(section_id) {
			return uci.get('network', section_id + '_rule') != null
				? this.enabled : this.disabled;
		};

		o.write = function(section_id, value) {
			if (value != this.enabled)
				return dropLanRouting(section_id);

			addLanRouting(section_id,
				this.section.formvalue(section_id, 'ip4table') ||
				tableOf(section_id) || freeTable());
		};

		o.remove = function(section_id) {
			dropLanRouting(section_id);
		};

		/* ---- advanced ------------------------------------------------------
		   Every default here is the one the protocol handler falls back to, so
		   a new tunnel opens showing what it will actually run with instead of
		   a row of empty fields. LuCI writes nothing for a field still equal to
		   its default, which is what keeps the section free of options the
		   handler would have supplied anyway. */

		o = s.taboption('advanced', form.Value, 'workers', _('Workers'),
			_('Number of parallel sessions. Every tunnel runs its own, so two tunnels cost twice this.'));
		o.datatype = 'uinteger';
		o.default = '9';

		o = s.taboption('advanced', form.Value, 'go_dns', _('DNS for VK'),
			_('Resolver the client uses to reach VK, which is not the resolver the tunnel hands out: yandex, cloudflare or google, their doh- variants, or custom:IP and doh:URL.'));
		o.default = 'yandex';

		o = s.taboption('advanced', form.ListValue, 'obfs', _('Obfuscation'),
			_('What the tunnel is disguised as inside the VK call.'));
		o.value('audio', _('audio'));
		o.value('video', _('video'));
		o.default = 'audio';

		o = s.taboption('advanced', form.ListValue, 'captcha_mode', _('Captcha mode'),
			_('How a VK captcha is answered. auto tries the built-in solver and falls back.'));
		o.value('auto', 'auto');
		o.value('rjs', 'rjs');
		o.value('wv', 'wv');
		o.default = 'auto';

		o = s.taboption('advanced', form.ListValue, 'vk_auth', _('VK authorization'),
			_('anonymous joins the call without an account. account uses TURN credentials from a VK account, read from the file below.'));
		o.value('anonymous', _('anonymous'));
		o.value('account', _('account'));
		o.default = 'anonymous';

		o = s.taboption('advanced', form.ListValue, 'vk_anon_path', _('Anonymous path'),
			_('Which VK endpoint an anonymous join goes through.'));
		o.value('vkcalls', 'vkcalls');
		o.value('legacy', 'legacy');
		o.default = 'vkcalls';
		o.depends('vk_auth', 'anonymous');

		o = s.taboption('advanced', form.Value, 'vk_creds_file', _('VK credentials file'),
			_('File holding the TURN credentials of a VK account. Without it, account authorization has nothing to authorize with.'));
		o.placeholder = '/etc/qwdtt/vk-creds.json';
		o.depends('vk_auth', 'account');

		o = s.taboption('advanced', form.Flag, 'no_dtls', _('Disable DTLS'),
			_('Direct mode: RTP-obfs AEAD over TURN without DTLS. The server has to be started with -listen-direct, or the tunnel will not come up.'));

		o = s.taboption('advanced', form.Flag, 'turn_tcp', _('TURN over TCP'),
			_('Reach the TURN relay over TCP instead of UDP. Works around UDP throttling on some networks, for example Rostelecom.'));
	}
});
