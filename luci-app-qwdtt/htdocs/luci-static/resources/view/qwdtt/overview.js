// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require rpc';
'require dom';
'require poll';
'require form';

/* Services -> qWDTT: one row per tunnel over /etc/config/qwdtt, with Stop,
   Restart and Edit on each, and Status and Logs inside the editor.

   The list is a form.GridSection, so the editor is LuCI's own modal and the
   Save & Apply footer is the framework's. What needs code is the hash list:
   the client accepts a full VK call link and reduces it to a hash itself
   (ParseHashes over the -vk flag), so storing a link would work -- but it
   would leave a link in the config and make the count in Status misleading.
   Links are therefore reduced here, on save.

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

/* ---- the hash list, its importer, and the checker ------------------------
   Hashes are an ordinary DynamicList: one field per hash with the standard add
   and remove controls, so a single one can be corrected or dropped in place.

   What a list widget is bad at is the realistic bulk case, several VK call
   links at once, so Import opens a textarea that takes them in one paste and
   validates per line. It writes nothing to UCI itself -- it sets the widget's
   value, so an import is an unsaved change like any other and the page footer
   applies it. That also means Reset discards an import, which would not be
   true if the importer touched the config directly. */

/* The saved list. Only a fallback: once the widget exists its staged value is
   the truth, because it includes edits the user has not saved yet. */
function savedHashes(section_id) {
	var v = uci.get('qwdtt', section_id, 'hash');
	if (Array.isArray(v))
		return v;
	return v ? [ String(v) ] : [];
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
		E('div', { 'class': 'right qwdtt-modalbtns' }, [
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

/* HASH_CHECK|<n>|<hash>|<status>|<message> is what the client prints. Falls
   back to the raw output if that format ever changes, rather than showing an
   empty box. */
function formatHashCheck(raw) {
	var rows = [];
	String(raw == null ? '' : raw).split('\n').forEach(function(line) {
		if (line.indexOf('HASH_CHECK|') !== 0)
			return;
		var f = line.split('|');
		if (f.length < 4)
			return;
		rows.push(f[1] + '. ' + f[2] + '  ' + f[3] + (f[4] ? '  ' + f[4] : ''));
	});
	return rows.length ? rows.join('\n') : String(raw == null ? '' : raw).trim();
}

function openHashCheck(section_id) {
	var out = E('pre', { 'style': 'white-space:pre-wrap; margin:0' }, [
		_('Asking VK about each configured hash. This uses the network and can take several seconds per hash.')
	]);

	ui.showModal(_('Check hashes'), [
		out,
		E('div', { 'class': 'right qwdtt-modalbtns' }, [
			E('button', {
				'class': 'btn',
				'click': ui.createHandlerFn(this, function() { ui.hideModal(); })
			}, [ _('Close') ])
		])
	]);

	/* Checks the SAVED config, since it shells out to the client -- staged
	   edits are not visible to it until Save and apply.

	   fs.exec for the same reason as the action buttons: this helper exits 3
	   when the client is missing and 4 when the section is unknown or has no
	   hashes, and all of those explain themselves on stderr, which cgi-io
	   would discard. */
	fs.exec('/usr/bin/qwdtt-luci', [ 'check-hashes', section_id ]).then(function(res) {
		if (res.code !== 0) {
			out.textContent = ((res.stderr || '') + (res.stdout || '')).trim() ||
				_('Check failed (exit %d)').format(res.code);
			return;
		}
		out.textContent = formatHashCheck(res.stdout) || _('No output.');
	}).catch(function(err) {
		out.textContent = _('Check failed:') + ' ' + err;
	});
}

/* ---- running state -------------------------------------------------------
   procd is asked rather than the control script: it is the only thing that can
   tell two tunnels apart, since every client process has the same name. */
var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

/* fs.exec, not fs.exec_direct. exec_direct goes through cgi-io, which sends the
   child's stderr to /dev/null and never looks at its exit status -- so every
   diagnostic the helpers write to stderr, and every non-zero exit, arrived here
   as a cheerful "Done." for work that had failed. fs.exec goes through rpcd's
   file object instead and returns code, stdout and stderr, which is why the ACL
   grants ubus file exec. The status and log reads keep using exec_direct: they
   want a stream of text and have no error semantics to lose. */
function report(label, res) {
	var out = ((res.stdout || '') + (res.stderr || '')).trim();

	if (res.code !== 0) {
		ui.addNotification(null, E('div', {}, [
			E('p', {}, _('%s failed (exit %d)').format(label, res.code)),
			out ? E('pre', {}, out) : ''
		]), 'error');
		return;
	}
	ui.addNotification(null, E('pre', {}, out || _('Done.')), 'info');
}

function act(verb, label, section_id) {
	var args = section_id ? [ verb, section_id ] : [ verb ];

	ui.showModal(_('qWDTT'), [ E('p', { 'class': 'spinning' }, _('Running %s...').format(label)) ]);
	return fs.exec('/usr/bin/qwdtt-luci-act', args).then(function(res) {
		ui.hideModal();
		report(label, res);
	}).catch(function(err) {
		ui.hideModal();
		ui.addNotification(null, E('p', {}, _('%s failed: %s').format(label, err)), 'error');
	});
}

return view.extend({
	load: function() {
		return uci.load('qwdtt');
	},

	handleAct: function(verb, label, section_id, ev) {
		return act(verb, label, section_id);
	},

	render: function() {
		var view = this;
		var m, s, o;

		m = new form.Map('qwdtt', _('qWDTT'),
			_('One section per tunnel, all running at once. A second tunnel needs its own TUN device and routing table, and a firewall mark to say which traffic it carries: the tunnel without a mark takes everything arriving from the LAN.'));

		s = m.section(form.GridSection, 'qwdtt');
		s.addremove = true;
		s.anonymous = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add tunnel');

		/* ---- columns ------------------------------------------------------
		   modalonly = false keeps these out of the editor: cloneOptions skips
		   them when it builds the modal, so they show in the row only. */

		o = s.option(form.DummyValue, '_peer', _('Peer'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var host = uci.get('qwdtt', section_id, 'peer_host');
			var port = uci.get('qwdtt', section_id, 'peer_port');
			return host ? (port ? host + ':' + port : host) : '-';
		};

		o = s.option(form.DummyValue, '_carries', _('Carries'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var mark = uci.get('qwdtt', section_id, 'fwmark');
			return mark ? _('marked %s').format(mark) : _('everything from the LAN');
		};

		/* Rewritten in place by the poll below rather than re-rendered: a
		   re-render would close an open editor and lose what is typed in it. */
		o = s.option(form.DummyValue, '_state', _('Status'));
		o.modalonly = false;
		o.renderWidget = function(section_id) {
			return E('span', { 'id': 'qwdtt-state-' + section_id }, [ '-' ]);
		};

		s.renderRowActions = function(section_id) {
			var cell = this.super('renderRowActions', [ section_id, _('Edit') ]);

			dom.content(cell.lastChild, [
				E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'title': _('Stop this tunnel and stop it starting at boot'),
					'click': ui.createHandlerFn(view, 'handleAct', 'stop', _('Stop'), section_id)
				}, [ _('Stop') ]),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'title': _('Restart this tunnel without changing boot behaviour'),
					'click': ui.createHandlerFn(view, 'handleAct', 'restart', _('Restart'), section_id)
				}, [ _('Restart') ]),
				' ',
				cell.lastChild.childNodes[0],
				cell.lastChild.childNodes[1],
				cell.lastChild.childNodes[2]
			]);

			return cell;
		};

		s.modaltitle = function(section_id) {
			return _('qWDTT') + ' » ' + section_id;
		};

		s.addModalOptions = function(s2, section_id) {
			s2.tab('general', _('General'));
			s2.tab('routing', _('Routing'));
			s2.tab('advanced', _('Advanced'));
			s2.tab('status', _('Status'));
			s2.tab('logs', _('Logs'));

			var o;

			o = s2.taboption('general', form.Flag, 'enabled', _('Enabled'),
				_('Start at boot and run now.'));
			o.rmempty = false;

			/* rawtun is the mode that creates the TUN interface named by
			   tun_name. The client used to pick it implicitly because a
			   -config file was passed; the init script states it now, so this
			   must not be blank. */
			/* Only rawtun is offered. The client also has vpn and socks modes,
			   but this package cannot configure either: the init script passes
			   neither -listen nor -socks, and there is no UCI option for them.
			   Choosing one started a daemon listening on localhost that the
			   router never used, with no TUN device -- which the status tab
			   reports as "interface: down", reading as a broken tunnel rather
			   than an unusable setting. */
			o = s2.taboption('general', form.ListValue, 'mode', _('Mode'),
				_('rawtun creates the TUN interface this router uses. The client has other modes, which this package does not configure.'));
			o.value('rawtun', 'rawtun');
			o.default = 'rawtun';
			o.rmempty = false;

			o = s2.taboption('general', form.Value, 'peer_host', _('Peer host'),
				_('Server hostname or IP address.'));
			o.rmempty = false;

			o = s2.taboption('general', form.Value, 'peer_port', _('Peer port'),
				_('UDP port of the server RAW listener, usually 56003.'));
			o.datatype = 'port';
			o.rmempty = false;

			o = s2.taboption('general', form.Value, 'password', _('Password'),
				_('Connection password, as set on the server.'));
			o.password = true;
			o.rmempty = false;

			o = s2.taboption('general', form.Value, 'device_id', _('Device ID'),
				_('Identifies this client to the peer. It must be unique: two tunnels sharing one are the same device to the server, and each disconnects the other.'));
			o.rmempty = false;

			o = s2.taboption('general', form.DynamicList, 'hash', _('Hashes'),
				_('One field per hash, %d characters each. A VK call link may be pasted into a field and is reduced to its hash when saved. Import takes several at once; Check asks VK whether each saved hash still resolves. At least one is required -- the client selects a hash modulo the list length, so an empty list cannot work.').format(HASH_LEN));

			/* The description has always said one hash is required, but until
			   now only the Import modal enforced it and the list itself would
			   save empty -- a config the client cannot start from, since it
			   selects a hash modulo the list length. DynamicList passes
			   `optional: this.optional || this.rmempty` to its widget, so
			   clearing rmempty is what routes an empty list through LuCI's own
			   "non-empty value" rejection rather than a check of our own. */
			o.rmempty = false;

			/* Judged per field. A link passes because it reduces to a valid
			   hash, which is what the client would do with it anyway. */
			o.validate = function(section_id, value) {
				if (value == null || value === '')
					return true;
				return hashProblem(normalizeVKJoinHash(value)) || true;
			};

			/* Normalise on the way to UCI so a pasted link is stored as the
			   hash it denotes and duplicates collapse. Without this the config
			   would keep the link, and the count in Status would overstate the
			   list. */
			o.write = function(section_id, formvalue) {
				var list = Array.isArray(formvalue) ? formvalue
				         : (formvalue ? [ formvalue ] : []);
				return form.DynamicList.prototype.write.call(this, section_id,
					parseHashes(list));
			};

			/* The stock widget with two buttons under it. Delegating to the
			   parent keeps the standard add and remove controls instead of
			   reimplementing them, and the buttons go in a wrapper rather than
			   inside the dynlist node, whose children are its items. Wrapping
			   is safe for getUIElement, which resolves the widget by element
			   id. */
			o.renderWidget = function(section_id, option_index, cfgvalue) {
				var self = this;
				var node = form.DynamicList.prototype.renderWidget.apply(this, arguments);

				/* Staged, not saved: an import must start from what the user
				   is looking at, including edits not yet written. */
				function staged() {
					var el = self.getUIElement(section_id);
					var v = el ? el.getValue() : null;
					if (Array.isArray(v))
						return v.filter(function(x) { return x != null && x !== ''; });
					return savedHashes(section_id);
				}

				return E('div', { 'class': 'qwdtt-hashlist' }, [
					node,
					E('div', { 'class': 'qwdtt-hashbtns' }, [
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
						}, [ _('Import') ]),
						' ',
						E('button', {
							'class': 'cbi-button cbi-button-neutral',
							'title': _('Contacts VK. Uses the saved config, so staged edits are not included.'),
							'click': ui.createHandlerFn(this, function() {
								openHashCheck(section_id);
							})
						}, [ _('Check') ])
					])
				]);
			};

			/* ---- routing --------------------------------------------------
			   The three values that have to differ between tunnels. The init
			   script refuses to start a section that shares any of them with
			   another, because the two would otherwise flush each other's
			   table and strand each other's rule. */

			o = s2.taboption('routing', form.Value, 'tun_name', _('TUN device'),
				_('Interface the client creates, for example: qwdtt0. Unique per tunnel.'));
			o.placeholder = 'qwdtt0';

			o = s2.taboption('routing', form.Value, 'lan_interface', _('LAN interface'),
				_('LAN interface, for example: br-lan.'));

			o = s2.taboption('routing', form.Value, 'fwmark', _('Firewall mark'),
				_('Optional. Traffic carrying this mark is routed into this tunnel; set the mark yourself under Network -> Firewall, with target "mark", a source zone and destination "any". Value or value/mask, hex starting with 0x. Left empty, this tunnel takes everything arriving from the LAN, and only one tunnel may do that.'));
			o.placeholder = '0x100/0xff00';

			o = s2.taboption('routing', form.Value, 'route_table', _('Routing table'),
				_('Table the default route into this tunnel is written to. Unique per tunnel.'));
			o.datatype = 'uinteger';
			o.placeholder = '51820';

			o = s2.taboption('routing', form.Value, 'rule_priority', _('Rule priority'),
				_('Priority of the ip rule that selects the table above. Unique per tunnel, and lower than the priority of the tunnel without a mark, or that one answers first and this tunnel never sees a packet.'));
			o.datatype = 'uinteger';
			o.placeholder = '10000';

			/* ---- advanced -------------------------------------------------- */

			o = s2.taboption('advanced', form.Value, 'workers', _('Workers'),
				_('Number of parallel sessions. Every tunnel runs its own, so two tunnels cost twice this.'));
			o.datatype = 'uinteger';

			o = s2.taboption('advanced', form.Value, 'dns', _('DNS'),
				_('DNS resolver for VK: yandex, cloudflare or google, their doh- variants, or custom:IP and doh:URL.'));

			o = s2.taboption('advanced', form.Value, 'obfs', _('Obfuscation'),
				_('Obfuscation mode: audio or video.'));

			o = s2.taboption('advanced', form.Value, 'captcha_mode', _('Captcha mode'),
				_('Captcha bypass mode: auto, wv or rjs.'));

			o = s2.taboption('advanced', form.Value, 'vk_auth', _('VK auth'),
				_('VK authorization mode: account or anonymous.'));

			o = s2.taboption('advanced', form.Value, 'vk_anon_path', _('VK anonymous path'),
				_('Anonymous VK TURN path: vkcalls or legacy.'));

			o = s2.taboption('advanced', form.Flag, 'no_dtls', _('Disable DTLS'),
				_('Direct mode: RTP-obfs AEAD over TURN without DTLS. The server has to be started with -listen-direct, or the tunnel will not come up.'));
			o.rmempty = false;

			o = s2.taboption('advanced', form.Flag, 'turn_tcp', _('TURN over TCP'),
				_('Reach the TURN relay over TCP instead of UDP. Works around UDP throttling on some networks, for example Rostelecom.'));
			o.rmempty = false;

			/* ---- status and logs --------------------------------------------
			   Read on demand rather than polled: the editor is a modal, and a
			   poll started here would outlive it. */

			o = s2.taboption('status', form.DummyValue, '_statusview');
			o.render = function() {
				var box = E('pre', { 'style': 'margin:0; white-space:pre-wrap' },
					[ _('Collecting data...') ]);

				function refresh() {
					return fs.exec_direct('/usr/bin/qwdtt-luci', [ 'status', section_id ])
						.then(function(out) {
							box.textContent = (out || '').trim() || _('No status.');
						}).catch(function(err) {
							box.textContent = _('Unable to read status:') + ' ' + err;
						});
				}

				refresh();
				return E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'qwdtt-modalbtns' }, [
						E('button', {
							'class': 'cbi-button cbi-button-neutral',
							'click': ui.createHandlerFn(this, refresh)
						}, [ _('Refresh') ])
					]),
					box
				]);
			};

			o = s2.taboption('logs', form.DummyValue, '_logview');
			o.render = function() {
				var box = E('textarea', {
					'style': 'font-family:monospace; font-size:12px; width:100%',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': 25
				}, [ _('Collecting data...') ]);

				function refresh() {
					return fs.exec_direct('/usr/bin/qwdtt-luci', [ 'log', section_id ])
						.then(function(data) {
							var text = (data || '').trim() || _('Log is empty');
							box.value = text;
							box.scrollTop = box.scrollHeight;
						}).catch(function(err) {
							box.value = _('Unable to read the log:') + ' ' + err;
						});
				}

				refresh();
				return E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-section-descr' },
						_('The last 400 lines the system log holds for this tunnel, newest last.')),
					E('div', { 'class': 'qwdtt-modalbtns' }, [
						E('button', {
							'class': 'cbi-button cbi-button-neutral',
							'click': ui.createHandlerFn(this, refresh)
						}, [ _('Refresh') ])
					]),
					box
				]);
			};
		};

		/* ---- the service as a whole ---------------------------------------
		   Deliberately not per section: without a section name these leave
		   every enabled flag alone, so a tunnel switched off on purpose is not
		   brought back by a Start here. */
		function serviceButton(label, verb, style, title) {
			return E('button', {
				'class': 'cbi-button ' + style,
				'title': title,
				'click': ui.createHandlerFn(view, 'handleAct', verb, label, null)
			}, [ label ]);
		}

		var serviceBar = E('div', { 'class': 'cbi-section' }, [
			E('h4', {}, [ _('Service') ]),
			E('div', { 'class': 'cbi-section-descr' },
				_('Acts on every tunnel at once, leaving the enabled flags as they are.')),
			E('div', { 'style': 'display:flex; gap:.5em; flex-wrap:wrap' }, [
				serviceButton(_('Start'), 'start', 'cbi-button-apply',
					_('Start every tunnel that is enabled')),
				serviceButton(_('Stop'), 'stop', 'cbi-button-reset',
					_('Stop every tunnel until the next boot or Start')),
				serviceButton(_('Restart'), 'restart', 'cbi-button-action',
					_('Restart every enabled tunnel'))
			])
		]);

		/* One call for the whole table: procd returns every instance of the
		   service, keyed by section name. */
		poll.add(function() {
			return callServiceList('qwdtt').then(function(res) {
				var instances = (res && res.qwdtt && res.qwdtt.instances) || {};

				uci.sections('qwdtt', 'qwdtt', function(section) {
					var node = document.getElementById('qwdtt-state-' + section['.name']);
					if (!node)
						return;

					var inst = instances[section['.name']];
					if (inst && inst.running)
						node.textContent = _('running');
					else if (uci.get('qwdtt', section['.name'], 'enabled') == '1')
						node.textContent = _('stopped');
					else
						node.textContent = _('disabled');
				});
			}).catch(function() {
				/* procd unreachable says nothing about the tunnels, so the
				   column is left as it was rather than claiming they stopped. */
			});
		}, 10);

		return m.render().then(function(mapEl) {
			return E([], [
				E('style', { 'type': 'text/css' }, [
					/* A committed entry in a dynlist is a span plus a hidden
					   input; only the trailing add-item is a real text input.
					   Both have to be named here, and an earlier attempt at
					   `input[type=text]` alone got it wrong twice over: the
					   saved hashes stayed proportional, because they are
					   spans, while the one input picked up a min-width and
					   became visibly wider than every row above it.

					   So the width goes on the container rather than the
					   field. The theme makes .cbi-dynlist an inline-flex
					   column capped at 400px, which means items and the
					   add-item field already stretch to it and are equal by
					   construction -- a min-width on the input simply pushed
					   past that cap. Sizing the container in ch, with
					   monospace set on it so ch is the width of a hash
					   character, fits 43 of them plus the item's 2em delete
					   gutter without wrapping. */
					'.qwdtt-hashlist .cbi-dynlist {' +
					' font-family: monospace; max-width: none; width: 50ch; }' +
					'.qwdtt-hashlist .cbi-dynlist > .add-item > input {' +
					' font-family: inherit; }' +
					'.qwdtt-hashbtns { margin-top: .5em;' +
					' display: flex; gap: .5em; }' +
					/* The modal button rows need the same gap above them as
					   the Import/Check row. It cannot reuse .qwdtt-hashbtns,
					   whose display:flex would override the right-alignment
					   that .right provides, so this carries the margin
					   alone. */
					'.qwdtt-modalbtns { margin-top: .5em; }'
				]),
				serviceBar,
				mapEl
			]);
		});
	}

	/* handleSave, handleSaveApply and handleReset are deliberately NOT
	   overridden, and that absence is the whole reason this page carries LuCI's
	   standard Save & Apply / Save / Reset footer instead of a button of its
	   own: the framework renders the footer only when those handlers exist, and
	   the inherited ones already do the right thing here.

	   Applying fires the procd reload trigger the init script registers, so the
	   client takes new settings without a manual restart. Save alone stages
	   them into the unsaved-changes counter, as on any other config page. */
});
