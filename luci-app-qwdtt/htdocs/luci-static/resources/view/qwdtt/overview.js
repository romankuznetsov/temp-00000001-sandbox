// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require dom';
'require poll';
'require form';

/* Services -> qWDTT: one row per tunnel over /etc/config/qwdtt, with its state
   and counters in the row, Stop, Restart and Edit beside them, and the
   tunnel's own log inside the editor.

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

/* Every read goes through rpcd's file object, never cgi-io. cgi-io matches the
   COMMAND LINE against the ACL, and an ACL can only name the script, so
   `qwdtt-luci runtime` came back as "Exec permission denied" while
   `qwdtt-luci` on its own would have been allowed. rpcd matches the program
   and passes the arguments through, which is why the same call works here and
   why fs.exec_direct must not be used anywhere in this page. */
function helper(args) {
	return fs.exec('/usr/bin/qwdtt-luci', args).then(function(res) {
		if (res.code !== 0)
			throw new Error(((res.stderr || '') + (res.stdout || '')).trim() ||
				_('exit %d').format(res.code));
		return res.stdout || '';
	});
}

/* ---- what a new tunnel gets ----------------------------------------------
   A section created with none of these inherits the same defaults as every
   other, and the init script then refuses it: one routing table cannot carry
   two tunnels. So the dialog fills them in, and the values are written to the
   config rather than derived at run time - what the tunnel uses is then the
   same thing the Routing tab shows.

   The unset value counts as its default, because that is what the init script
   would use. */
function usedValues(option, fallback) {
	var used = [];

	uci.sections('qwdtt', 'qwdtt', function(section) {
		var raw = uci.get('qwdtt', section['.name'], option);
		var value = parseInt(raw != null && raw !== '' ? raw : fallback, 10);
		if (!isNaN(value))
			used.push(value);
	});

	return used;
}

function freeTable() {
	var used = usedValues('route_table', 51820);

	for (var table = 51820; table < 52820; table++)
		if (used.indexOf(table) === -1)
			return table;

	return 51820;
}

/* Below every existing one: the tunnel without a mark matches everything from
   the LAN, so its rule has to be consulted last, and a new tunnel is the one
   that carries a mark. */
function freePriority() {
	var used = usedValues('rule_priority', 10000);

	if (!used.length)
		return 10000;

	return Math.max(1, Math.min.apply(null, used) - 1);
}

/* The section that takes everything arriving from the LAN, if it is not this
   one. Only one may, so this answers both "may this section go without a mark"
   and "which rule has to be consulted last". */
function catchall(section_id) {
	var owner = null;

	uci.sections('qwdtt', 'qwdtt', function(section) {
		var name = section['.name'];

		if (owner == null && name !== section_id &&
		    !uci.get('qwdtt', name, 'fwmark'))
			owner = name;
	});

	return owner;
}

/* Empty for the first tunnel, which takes everything from the LAN; a mark for
   every one after it, because only one tunnel may be the catch-all. Nothing
   carries the mark until a firewall rule sets it, which is the operator's to
   write - the Firewall mark field on the Routing tab says how. */
function freeMark() {
	var used = {};

	if (!catchall(null))
		return '';

	uci.sections('qwdtt', 'qwdtt', function(section) {
		var mark = uci.get('qwdtt', section['.name'], 'fwmark');
		if (mark)
			used[mark.split('/')[0].toLowerCase()] = true;
	});

	for (var n = 1; n < 256; n++) {
		var mark = '0x' + (n * 256).toString(16);
		if (!used[mark])
			return mark + '/0xff00';
	}

	return '';
}

/* The section that already claims this value, if it is not this one. Every
   section counts, enabled or not: the dialog above hands out values that are
   free across the whole file, and a spare tunnel that collides the moment it
   is enabled is a trap rather than a feature. */
function takenBy(section_id, option, fallback, value) {
	var owner = null;

	uci.sections('qwdtt', 'qwdtt', function(section) {
		var name = section['.name'];
		var raw = uci.get('qwdtt', name, option);

		if (owner == null && name !== section_id &&
		    String(raw != null && raw !== '' ? raw : fallback) === String(value))
			owner = name;
	});

	return owner;
}

/* ---- runtime state -------------------------------------------------------
   One call for the whole table: `qwdtt runtime` asks procd which instances it
   supervises, reads the packet counters off each tunnel device and works out
   how long each process has been up, and returns all of it as JSON keyed by
   section. Through the same helper as everything else, rather than calling the
   service ubus object from the browser, so the page needs no permission it did
   not already have. */
function runtimeState() {
	return helper([ 'runtime' ]).then(function(out) {
		try {
			return JSON.parse(out) || {};
		}
		catch (e) {
			return {};
		}
	}).catch(function() {
		return {};
	});
}

/* The Status cell, shaped like the one on Network -> Interfaces: L.itemlist
   lays out the label and value pairs and drops every pair whose value is null,
   which is how MAC disappears for a TUN - it has no link layer - and how the
   error line only shows when there is one. %t and %.2mB are LuCI's own
   formatters, so "5d 6h 37m 33s" and "156.13 MB" read the same here as there. */
function statusNode(st, enabled) {
	var items = [];

	/* On the tunnel being up, not on the client running: the client creates
	   its TUN only once the server has answered, and until then its uptime is
	   the process's rather than the tunnel's and every counter is a zero. */
	if (st.up) {
		items.push(_('Uptime'), '%t'.format(st.uptime));
		items.push(_('MAC'), st.mac || null);
		items.push(_('RX'), '%.2mB (%d %s)'.format(st.rx_bytes, st.rx, _('Pkts.')));
		items.push(_('TX'), '%.2mB (%d %s)'.format(st.tx_bytes, st.tx, _('Pkts.')));
		items.push(_('IPv4'), st.ipv4 || null);
	}
	else if (st.running) {
		items.push(null, E('em', _('connecting')));
	}
	/* Nothing is wrong with a tunnel that was never asked to run, so it says
	   why it is idle rather than reading as one that stopped on its own. The
	   flag is checked last: a section switched off but not yet applied is
	   still carrying traffic, and the counters above say so. */
	else if (!enabled) {
		items.push(_('Information'), _('Interface disabled'));
	}
	else {
		items.push(null, E('em', _('stopped')));
	}

	items.push(_('Error'), st.error || null);

	return L.itemlist(E('span'), items);
}

/* Only when something went wrong: a tunnel that started says so in its own row
   within the second, which is better confirmation than a notification the
   operator has to dismiss. What did not work has to be said, though - the
   helpers exit non-zero and explain themselves on stderr, and refusing to
   start a disabled tunnel is the case that reaches here most often. */
function report(label, res) {
	var out = ((res.stdout || '') + (res.stderr || '')).trim();

	if (res.code === 0)
		return;

	ui.addNotification(null, E('div', {}, [
		E('p', {}, _('%s failed (exit %d)').format(label, res.code)),
		out ? E('pre', {}, out) : ''
	]), 'error');
}

function act(verb, label, section_id) {
	ui.showModal(_('qWDTT'), [ E('p', { 'class': 'spinning' }, _('Running %s...').format(label)) ]);
	return fs.exec('/usr/bin/qwdtt-luci-act', [ verb, section_id ]).then(function(res) {
		ui.hideModal();
		report(label, res);
	}).catch(function(err) {
		ui.hideModal();
		ui.addNotification(null, E('p', {}, _('%s failed: %s').format(label, err)), 'error');
	});
}

return view.extend({
	/* Runtime state is loaded here as well as polled, so the first render
	   already knows which tunnels are running and can fill their counters and
	   disable the buttons that would have nothing to act on. */
	load: function() {
		return Promise.all([
			uci.load('qwdtt'),
			runtimeState()
		]);
	},

	handleAct: function(verb, label, section_id, ev) {
		return act(verb, label, section_id);
	},

	render: function(data) {
		var page = this;
		var m, s, o;

		/* Replaced wholesale by the poll, so read it through state() rather
		   than holding on to the object. */
		var runtime = (data && data[1]) || {};

		function state(section_id) {
			return runtime[section_id] || { running: false };
		}

		function running(section_id) {
			return !!state(section_id).running;
		}

		/* Config, not runtime: Stop leaves the flag alone, so a tunnel can be
		   enabled and not running, and switched off and still running until
		   the change is applied. */
		function enabled(section_id) {
			return uci.get('qwdtt', section_id, 'enabled') == '1';
		}

		/* The columns the poll touches, in the order they are shown. The one
		   with node() is rewritten in place rather than re-rendered, because
		   re-rendering the map would close an open editor and lose what is
		   typed in it. */
		var COLUMNS = [
			{
				key: 'state', title: _('Status'),
				node: function(section_id) {
					return statusNode(state(section_id), enabled(section_id));
				}
			},
			{
				key: 'enabled', title: _('Enabled'),
				config: function(section_id) {
					return enabled(section_id) ? _('yes') : _('no');
				}
			}
		];

		m = new form.Map('qwdtt', _('qWDTT'),
			_('One tunnel per section, all running at once. The name is the TUN device the tunnel creates. A second tunnel needs its own routing table and a firewall mark to say which traffic it carries: the tunnel without a mark takes everything arriving from the LAN.'));

		s = m.section(form.GridSection, 'qwdtt');
		s.addremove = true;
		/* Named sections all the same, and the name still has to be given -
		   handleAdd below asks for it in a dialog. This only suppresses the
		   bare text field the table would otherwise put in its footer, which
		   is how Network -> Interfaces does it too. */
		s.anonymous = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add tunnel...');

		/* ---- columns ------------------------------------------------------
		   modalonly = false keeps these out of the editor: cloneOptions skips
		   them when it builds the modal, so they show in the row only. */

		/* The name is the procd instance and the log tag, so it earns a column
		   of its own: nothing else in the row identifies which tunnel this is. */
		o = s.option(form.DummyValue, '_name', _('Tunnel'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			return section_id;
		};

		o = s.option(form.DummyValue, '_peer', _('Peer'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var host = uci.get('qwdtt', section_id, 'peer_host');
			var port = uci.get('qwdtt', section_id, 'peer_port');
			return host ? (port ? host + ':' + port : host) : '-';
		};

		/* cfgvalue, which is what a GridSection actually reads: it renders a
		   column that is not editable through textvalue, and that wants a
		   string. Overriding renderWidget instead is what produced LuCI's
		   "none" placeholder. Markup goes in as a string because dom.append
		   parses one; the poll then replaces the cell with the node itself,
		   found by the row and column attributes the way luci-app-ddns does. */
		COLUMNS.forEach(function(column) {
			var o = s.option(form.DummyValue, '_' + column.key, column.title);
			o.modalonly = false;

			if (column.config) {
				o.cfgvalue = column.config;
				return;
			}

			/* A node, not markup as a string: renderTextValue puts whatever
			   this returns straight into the cell, and the default textvalue
			   would run a string through %h - which is how the first render
			   came out as visible tags until the poll replaced it a second
			   later. rawhtml does not help, because the default textvalue
			   never looks at it. */
			o.textvalue = function(section_id) {
				return column.node(section_id);
			};
		});

		/* Shaped like Network -> Interfaces: the same two neutral buttons in
		   the same order, ahead of the Edit and Delete the parent supplies.
		   Those are taken as a list rather than by index, because how many
		   there are depends on whether the section is sortable. */
		s.renderRowActions = function(section_id) {
			var cell = this.super('renderRowActions', [ section_id, _('Edit') ]);
			var inherited = Array.prototype.slice.call(cell.lastChild.childNodes);

			dom.content(cell.lastChild, [
				E('button', {
					'class': 'cbi-button cbi-button-neutral reconnect',
					'title': _('Restart this tunnel'),
					'click': ui.createHandlerFn(page, 'handleAct', 'restart', _('Restart'), section_id)
				}, _('Restart')),
				E('button', {
					'id': 'qwdtt-stop-' + section_id,
					'class': 'cbi-button cbi-button-neutral down',
					'title': _('Stop this tunnel until it is started again or the router reboots'),
					'disabled': running(section_id) ? null : 'disabled',
					'click': ui.createHandlerFn(page, 'handleAct', 'stop', _('Stop'), section_id)
				}, _('Stop'))
			].concat(inherited));

			return cell;
		};

		/* Ask for the name in a dialog and go straight into the editor, the way
		   Network -> Interfaces does. The name is not cosmetic: it becomes the
		   procd instance and the syslog tag, and uci will not take anything
		   outside [A-Za-z0-9_], which is what the uciname datatype enforces. */
		s.handleAdd = function(ev) {
			var m2 = new form.Map('qwdtt');
			var s2 = m2.section(form.NamedSection, '_new_');
			var name;

			s2.render = function() {
				return Promise.all([ {}, this.renderUCISection('_new_') ])
					.then(this.renderContents.bind(this));
			};

			name = s2.option(form.Value, 'name', _('Name'));
			name.rmempty = false;
			name.datatype = 'uciname';
			name.placeholder = _('New tunnel name');
			name.description = _('Also the name of the TUN device this tunnel creates, so at most 15 characters. Keep the qwdtt prefix and the firewall zone covers it: the zone matches qwdtt+, and any other name has to be added to it by hand.');
			name.validate = function(section_id, value) {
				if (uci.get('qwdtt', value) != null)
					return _('That name is already taken');
				/* It becomes an interface name, and the kernel takes 15. */
				if (value.length > 15)
					return _('That name is too long for an interface');
				return true;
			};

			return m2.render().then(L.bind(function(nodes) {
				ui.showModal(_('Add tunnel'), [
					nodes,
					E('div', { 'class': 'right' }, [
						E('button', {
							'class': 'btn',
							'click': ui.hideModal
						}, _('Cancel')), ' ',
						E('button', {
							'class': 'cbi-button cbi-button-positive important',
							'click': ui.createHandlerFn(this, function() {
								var value = name.isValid('_new_') ? name.formvalue('_new_') : null;

								if (!value)
									return;

								return m.save(function() {
									var sid = uci.add('qwdtt', 'qwdtt', value);
									var mark = freeMark();

									uci.set('qwdtt', sid, 'route_table', String(freeTable()));
									uci.set('qwdtt', sid, 'rule_priority', String(freePriority()));
									if (mark)
										uci.set('qwdtt', sid, 'fwmark', mark);

									s.addedSection = sid;
									ui.hideModal();
									ui.showModal(null,
										E('p', { 'class': 'spinning' }, [ _('Loading data...') ]));
								}).then(L.bind(s.renderMoreOptionsModal, s, value));
							})
						}, _('Create tunnel'))
					])
				], 'cbi-modal');

				nodes.querySelector('[id="%s"] input[type="text"]'.format(name.cbid('_new_'))).focus();
			}, this));
		};

		s.modaltitle = function(section_id) {
			return _('qWDTT') + ' » ' + section_id;
		};

		s.addModalOptions = function(s2, section_id) {
			/* Declaration order is tab order. */
			s2.tab('general', _('General'));
			s2.tab('advanced', _('Advanced'));
			s2.tab('routing', _('Routing'));
			s2.tab('logs', _('Logs'));

			var o;

			o = s2.taboption('general', form.Flag, 'enabled', _('Enabled'),
				_('Start at boot and run now.'));
			o.rmempty = false;

			/* rawtun is the mode that creates the TUN interface named after
			   the section. The client used to pick it implicitly because a
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
			   The values that have to differ between tunnels. The init script
			   refuses to start a section that shares one with another, because
			   the two would otherwise flush each other's table and strand each
			   other's rule. The TUN device is not among them: it is the
			   section name, which uci has already made unique.

			   Its rules are repeated here so a collision is caught while it is
			   being typed. Without that the only sign is an Error line in the
			   row after Save & Apply, by which point the tunnel is already not
			   running. */

			o = s2.taboption('routing', form.Value, 'lan_interface', _('LAN interface'),
				_('LAN interface, for example: br-lan.'));

			o = s2.taboption('routing', form.Value, 'fwmark', _('Firewall mark'),
				_('Optional. Traffic carrying this mark is routed into this tunnel; set the mark yourself under Network -> Firewall, with target "mark", a source zone and destination "any". Value or value/mask, hex starting with 0x. Left empty, this tunnel takes everything arriving from the LAN, and only one tunnel may do that.'));
			o.placeholder = '0x100/0xff00';
			o.validate = function(section_id, value) {
				var lan = value ? null : catchall(section_id);
				return lan ? _('%s already takes everything arriving from the LAN, so this tunnel needs a mark').format(lan) : true;
			};

			o = s2.taboption('routing', form.Value, 'route_table', _('Routing table'),
				_('Table the default route into this tunnel is written to. Unique per tunnel.'));
			o.datatype = 'uinteger';
			o.placeholder = '51820';
			o.validate = function(section_id, value) {
				var table = value || '51820';
				var owner = takenBy(section_id, 'route_table', '51820', table);
				return owner ? _('Table %s is already used by %s').format(table, owner) : true;
			};

			o = s2.taboption('routing', form.Value, 'rule_priority', _('Rule priority'),
				_('Priority of the ip rule that selects the table above. Unique per tunnel, and lower than the priority of the tunnel without a mark, or that one answers first and this tunnel never sees a packet.'));
			o.datatype = 'uinteger';
			o.placeholder = '10000';
			o.validate = function(section_id, value) {
				var prio = value || '10000';
				var owner = takenBy(section_id, 'rule_priority', '10000', prio);
				if (owner)
					return _('Priority %s is already used by %s').format(prio, owner);

				/* Read from the editor rather than from uci: the mark may have
				   been typed a moment ago and not saved yet. */
				var mark = this.map.lookupOption('fwmark', section_id);
				var lan = catchall(section_id);
				if (!lan || !mark || !mark[0].formvalue(section_id))
					return true;

				var last = parseInt(uci.get('qwdtt', lan, 'rule_priority') || '10000', 10);
				if (parseInt(prio, 10) >= last)
					return _('Must be below %d, the priority of %s, which has no mark').format(last, lan);

				return true;
			};

			/* ---- advanced --------------------------------------------------
			   Every default here is the one the init script falls back to, so a
			   new tunnel opens showing what it will actually run with instead
			   of six empty fields. LuCI writes nothing for a field still equal
			   to its default, which is what keeps the section free of options
			   the init script would have supplied anyway. */

			o = s2.taboption('advanced', form.Value, 'workers', _('Workers'),
				_('Number of parallel sessions. Every tunnel runs its own, so two tunnels cost twice this.'));
			o.datatype = 'uinteger';
			o.default = '9';

			o = s2.taboption('advanced', form.Value, 'dns', _('DNS'),
				_('DNS resolver for VK: yandex, cloudflare or google, their doh- variants, or custom:IP and doh:URL.'));
			o.default = 'yandex';

			o = s2.taboption('advanced', form.Value, 'obfs', _('Obfuscation'),
				_('Obfuscation mode: audio or video.'));
			o.default = 'audio';

			o = s2.taboption('advanced', form.Value, 'captcha_mode', _('Captcha mode'),
				_('Captcha bypass mode: auto, wv or rjs.'));
			o.default = 'auto';

			o = s2.taboption('advanced', form.Value, 'vk_auth', _('VK auth'),
				_('VK authorization mode: account or anonymous.'));
			o.default = 'anonymous';

			o = s2.taboption('advanced', form.Value, 'vk_anon_path', _('VK anonymous path'),
				_('Anonymous VK TURN path: vkcalls or legacy.'));
			o.default = 'vkcalls';

			o = s2.taboption('advanced', form.Flag, 'no_dtls', _('Disable DTLS'),
				_('Direct mode: RTP-obfs AEAD over TURN without DTLS. The server has to be started with -listen-direct, or the tunnel will not come up.'));
			o.rmempty = false;

			o = s2.taboption('advanced', form.Flag, 'turn_tcp', _('TURN over TCP'),
				_('Reach the TURN relay over TCP instead of UDP. Works around UDP throttling on some networks, for example Rostelecom.'));
			o.rmempty = false;

			/* ---- logs ---------------------------------------------------------
			   Read on demand rather than polled: the editor is a modal, and a
			   poll started here would outlive it. */

			o = s2.taboption('logs', form.DummyValue, '_logview');
			o.render = function() {
				var box = E('textarea', {
					'style': 'font-family:monospace; font-size:12px; width:100%',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': 25
				}, [ _('Collecting data...') ]);

				function refresh() {
					return helper([ 'log', section_id ])
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

		/* One call for the whole table, once a second. The guard matters at
		   that rate: LuCI fires the next tick whether or not this one has
		   answered, and a router that takes longer than a second would
		   otherwise accumulate calls it can never catch up with.

		   An empty answer says the helper could not be run, not that the
		   tunnels stopped, so the cells are left alone rather than being
		   filled with zeroes. */
		var inflight = false;

		poll.add(function() {
			if (inflight)
				return;

			inflight = true;
			return runtimeState().then(function(fresh) {
				inflight = false;

				if (!Object.keys(fresh).length)
					return;

				runtime = fresh;

				/* By row and column attribute, not by an id of our own: the
				   cell is whatever the grid decided to build, and these two
				   attributes are on it either way. */
				document.querySelectorAll('.cbi-section-table-row[data-sid]')
					.forEach(function(row) {
						var name = row.getAttribute('data-sid');
						var stop = document.getElementById('qwdtt-stop-' + name);

						COLUMNS.forEach(function(column) {
							if (!column.node)
								return;
							var cell = row.querySelector('[data-name="_' + column.key + '"]');
							if (cell)
								dom.content(cell, column.node(name));
						});

						if (stop)
							stop.disabled = !running(name);
					});
			});
		}, 1);

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
