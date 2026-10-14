(function ($) {

	var Bot = this.Bot = {
		url: Config.botURL || 'https://bot.pokeathlon.com/',
		frame: null,
		loaded: false,
		queue: [],
		name: '',
		format: '',
		pending: null,
		popup: null,
		room: null,
		overrides: null,
		botTeamIndex: -1,
		analyses: {},
		battles: {},
		frameThreads: 0,
		post: function (message) {
			if (!this.frame) {
				this.frameThreads = Storage.prefs('botthreads') || 0;
				this.frame = $('<iframe title="Bot" style="display:none"></iframe>').attr('src', this.url + 'live.html' + (this.frameThreads ? '?threads=' + this.frameThreads : '')).appendTo('body')[0];
			}
			if (!this.loaded) return this.queue.push(message);
			this.frame.contentWindow.postMessage(message, new URL(this.url, location.href).origin);
		},
		receive: function (e) {
			if (!Bot.frame || e.source !== Bot.frame.contentWindow || !e.data || !e.data.bot) return;
			var data = e.data.data;
			switch (e.data.type) {
			case 'loaded':
				Bot.loaded = true;
				while (Bot.queue.length) Bot.post(Bot.queue.shift());
				break;
			case 'ready':
				Bot.format = data.format;
				if (data.name) Bot.name = data.name;
				Bot.challenge();
				break;
			case 'name':
				Bot.name = data;
				Bot.challenge();
				break;
			case 'schema':
				if (Bot.room) Bot.room.load(data);
				break;
			case 'thinking':
				Bot.post({type: 'choosing', room: data.room, value: Bot.choosing(data.room)});
				break;
			case 'decided':
				if (data.analysis && Storage.prefs('botanalysis') !== false) {
					if (!Bot.analyses[data.room]) Bot.analyses[data.room] = [];
					Bot.analyses[data.room].push(data);
				}
				if (data.iterations && data.time > 250) {
					var speed = data.iterations / data.time * 1000;
					var previous = Storage.prefs('botspeed');
					Storage.prefs('botspeed', Math.round(previous ? previous * 0.7 + speed * 0.3 : speed));
					var tree = data.analysis && data.analysis.tree;
					if (tree) Bot.shape({turns: tree.turns / data.iterations, horizon: tree.playoutTurns / data.iterations}, 0.3);
					if (Bot.room) Bot.room.updateSpeed();
				}
				break;
			case 'bench':
				if (data.speed) Storage.prefs('botspeed', Math.round(data.speed));
				if (data.search) Bot.shape(data.search, 1);
				var known = Bot.device();
				if (data.device) Storage.prefs('botdevice', Math.round(data.device));
				if (Bot.room) Bot.room.measuring = false;
				if (Bot.room && data.device && Math.round(data.device) !== known) Bot.post({type: 'schema', format: Bot.room.curFormat, speed: Bot.device()});
				if (Bot.room) Bot.room.updateSpeed();
				break;
			case 'battle':
				Bot.battles[data.room] = true;
				Bot.update('');
				if (Bot.popup) Bot.popup.close();
				break;
			case 'notice':
			case 'error':
				Bot.report(data.split('\n')[0]);
				break;
			case 'end':
				delete Bot.battles[data.room];
				Bot.reload();
				break;
			case 'closed':
				Bot.battles = {};
				Bot.name = '';
				Bot.report("The bot disconnected.");
				break;
			}
		},
		start: function (format, team, botTeam) {
			var self = this;
			this.pending = {format: format, team: team};
			this.format = '';
			Storage.prefs('botformat', format);
			app.once('response:pokeathlete', function (key) {
				if (!key) return self.report("This server doesn't allow bots.");
				self.post({
					type: 'start', url: (Config.server.port === 443 || Config.server.https ? 'wss' : 'ws') + '://' + Config.server.host + ':' + Config.server.port + Config.sockjsprefix + '/websocket',
					owner: app.user.get('userid'), key: key, format: format, team: botTeam ? Storage.getPackedTeam(botTeam) : '', settings: self.settings(), speed: self.device(), ask: true
				});
			});
			app.send('/cmd pokeathlete');
			this.update(this.loaded ? "Starting the bot..." : "Loading the bot (this can take a while the first time)...");
		},
		challenge: function () {
			var pending = this.pending;
			if (!pending || !this.name || this.format !== pending.format) return;
			this.pending = null;
			this.update("Challenging " + this.name + "...");
			var name = this.name;
			app.sendTeam(pending.team, function () {
				app.send('/challenge ' + name + ', ' + pending.format);
			});
		},
		settings: function () {
			if (!this.overrides) {
				this.overrides = $.extend(true, {}, Storage.prefs('botsettings') || {});
				delete this.overrides.ponder;
				delete this.overrides.foeExploration;
				delete this.overrides.infer;
				delete this.overrides.evStep;
				delete this.overrides.particles;
			}
			return this.overrides;
		},
		reload: function () {
			if (!this.frame || (Storage.prefs('botthreads') || 0) === this.frameThreads || !$.isEmptyObject(this.battles)) return;
			$(this.frame).remove();
			this.frame = null;
			this.loaded = false;
			this.name = '';
			this.format = '';
			if (this.room) this.room.update();
		},
		shape: function (search, weight) {
			var previous = Storage.prefs('botsearch');
			Storage.prefs('botsearch', previous && weight < 1 ? {turns: previous.turns * (1 - weight) + search.turns * weight, horizon: previous.horizon * (1 - weight) + search.horizon * weight} : search);
		},
		device: function () {
			return +Storage.prefs('botdevice') || 0;
		},
		save: function (fromRoom) {
			var self = this;
			clearTimeout(this.timer);
			this.timer = setTimeout(function () {
				var settings = self.settings();
				Storage.prefs('botsettings', $.isEmptyObject(settings) ? null : settings);
				if (self.frame) self.post({type: 'config', settings: settings});
				if (self.room) self.room.saved();
			}, 150);
			if (!fromRoom && this.room && this.room.data) this.room.render();
		},
		choosing: function (id) {
			var room = app.rooms[id];
			return !!(room && room.request && !room.request.wait && !(room.choice && room.choice.waiting) && !room.battleEnded);
		},
		update: function (status) {
			if (this.popup) this.popup.$('.status').text(status);
		},
		report: function (message) {
			if (this.popup) return this.update(message);
			app.addPopupMessage("Bot: " + message);
		},
		renderAnalysis: function (data) {
			var analysis = data.analysis;
			var tree = analysis.tree;
			var iterations = analysis.iterations || 1;
			var count = function (n) { return Math.round(n).toLocaleString('en-US'); };
			var percent = function (n, total) { return (total ? Math.round(100 * n / total) : 0) + '%'; };
			var byVisits = function (a, b) { return b.n - a.n; };
			var row = function (label, value) {
				return '<tr><th style="text-align:left;font-weight:normal;padding-right:12px">' + label + '</th><td>' + value + '</td></tr>';
			};
			var options = analysis.options.slice().sort(byVisits);
			var foe = analysis.foe.slice().sort(byVisits);
			var total = 0;
			var foeTotal = 0;
			var chosen = null;
			for (var i = 0; i < options.length; i++) total += options[i].n;
			for (var j = 0; j < foe.length; j++) foeTotal += foe[j].n;
			for (var k = 0; k < options.length; k++) {
				if (options[k].choice === data.choice) chosen = options[k];
			}
			var score = function (option) { return option.n ? (option.w / option.n).toFixed(3) : '-'; };

			var buf = '<div class="infobox"><details><summary>';
			buf += '<strong>Bot, turn ' + data.turn + ':</strong> ' + BattleLog.escapeHTML(chosen ? chosen.label : data.choice) + ' &middot; ' + count(analysis.iterations) + ' routes &middot; ' + (analysis.time / 1000).toFixed(1) + ' s</summary>';
			buf += '<table style="border-collapse:collapse;margin:4px 0">';
			buf += row('Branching depth', (tree.turns / iterations).toFixed(1) + ' turns (' + (tree.plies / iterations).toFixed(1) + ' decisions, max ' + tree.deepest + ' turns)');
			buf += row('Look-ahead', (tree.playoutTurns / iterations).toFixed(1) + ' turns');
			buf += row('Simulated turns', count(tree.playoutTurns));
			buf += row('At turn cap', percent(tree.capped, iterations) + ' (cap ' + analysis.cap + ')');
			buf += '</table>';
			if (chosen) {
				buf += '<details style="margin:4px 0"><summary><strong>Choices:</strong> ' + BattleLog.escapeHTML(chosen.label) + ' &middot; tried ' + percent(chosen.n, total) + ' &middot; score ' + score(chosen) + '</summary>';
				buf += '<table style="border-collapse:collapse;margin:4px 0"><tr><th style="text-align:left;padding-right:12px">Bot</th><th style="text-align:left;padding-right:12px">Tried</th><th>Score</th></tr>';
				for (var n = 0; n < options.length; n++) {
					var option = options[n];
					var label = BattleLog.escapeHTML(option.label);
					buf += '<tr><td style="padding-right:12px">' + (option === chosen ? '<strong>' + label + '</strong>' : label) + '</td>';
					buf += '<td style="padding-right:12px;white-space:nowrap"><span style="display:inline-block;height:8px;width:' + Math.max(1, Math.round(80 * option.n / (total || 1))) + 'px;background:currentColor;opacity:.45;vertical-align:middle"></span> ' + percent(option.n, total) + '</td>';
					buf += '<td style="text-align:right">' + score(option) + '</td></tr>';
				}
				buf += '</table></details>';
			}
			if (foe.length) {
				var expected = [];
				for (var q = 0; q < foe.length; q++) {
					expected.push(BattleLog.escapeHTML(foe[q].label) + ' ' + percent(foe[q].n, foeTotal));
				}
				buf += '<p><strong>Expected from you:</strong> ' + expected.join(' &middot; ') + '</p>';
			}
			if (analysis.line && analysis.line.length) {
				var first = analysis.line[0];
				buf += '<details style="margin:4px 0"><summary><strong>Route:</strong> turn ' + first.turn + ' &middot; you: ' + BattleLog.escapeHTML(first.foe || '-') + ' &middot; bot: ' + BattleLog.escapeHTML(first.me || '-') + '</summary>';
				buf += '<table style="border-collapse:collapse;margin:4px 0"><tr><th style="text-align:left;padding-right:12px">Turn</th><th style="text-align:left;padding-right:12px">You</th><th style="text-align:left">Bot</th></tr>';
				for (var r = 0; r < analysis.line.length; r++) {
					var step = analysis.line[r];
					buf += '<tr><td style="padding-right:12px">' + step.turn + '</td><td style="padding-right:12px">' + BattleLog.escapeHTML(step.foe || '-') + '</td><td>' + BattleLog.escapeHTML(step.me || '-') + '</td></tr>';
				}
				buf += '</table></details>';
			}
			buf += '</details></div>';
			return buf;
		}
	};
	window.addEventListener('message', Bot.receive);

	var BotPopup = this.BotPopup = Popup.extend({
		type: 'semimodal',
		initialize: function () {
			Bot.popup = this;
			var format = app.rooms[''].curFormat;
			var buf = '<form class="battleform">';
			buf += '<p><label class="label">Format:</label>' + app.rooms[''].renderFormats(format) + '</p>';
			var team = app.rooms[''].renderTeams(format);
			buf += '<p><label class="label">Your team:</label>' + team + '</p>';
			buf += '<p><label class="label">Bot\'s team:</label>' + this.renderBotTeam(format, $(team).val()) + '</p>';
			buf += '<p class="status"></p>';
			buf += '<p class="buttonbar" style="margin-top:12px"><button type="submit" class="button"><strong>Battle!</strong></button> <button type="button" name="settings" class="button"><i class="fa fa-cog"></i> Bot settings</button> <button type="button" name="close" class="button">Cancel</button></p>';
			buf += '</form>';
			this.$el.html(buf);
		},
		remove: function () {
			if (Bot.popup === this) {
				Bot.popup = null;
				Bot.pending = null;
			}
			Popup.prototype.remove.apply(this, arguments);
		},
		renderBotTeam: function (format, team) {
			var teamIndex = Bot.botTeamIndex;
			var teams = Storage.teams || [];
			if (teamIndex < 0 && teams[team]) {
				for (var i = 0; i < teams.length; i++) {
					if (i !== +team && teams[i].format === teams[team].format && teams[i].capacity === 6) {
						teamIndex = i;
						break;
					}
				}
			}
			return app.rooms[''].renderTeams(format, teamIndex).replace('name="team"', 'name="botTeam"');
		},
		format: function (format, button) {
			var self = this;
			app.addPopup(FormatPopup, {format: format, sourceEl: button, selectType: 'challenge', onselect: function (format) {
				self.$('button[name=team]').replaceWith(app.rooms[''].renderTeams(format));
				Bot.botTeamIndex = -1;
				self.$('button[name=botTeam]').replaceWith(self.renderBotTeam(format, self.$('button[name=team]').val()));
			}});
		},
		team: function (team, button) {
			app.addPopup(TeamPopup, {team: team, format: this.$('button[name=format]').val(), sourceEl: button, folderToggleOn: true, folderNotExpanded: []});
		},
		botTeam: function (team, button) {
			this.team(team, button);
		},
		settings: function () {
			Storage.prefs('botformat', this.$('button[name=format]').val());
			this.close();
			if (Bot.room) {
				Bot.room.curFormat = Storage.prefs('botformat');
				Bot.room.update();
			}
			app.tryJoinRoom('botsettings');
		},
		submit: function () {
			var format = this.$('button[name=format]').val();
			var team = Storage.teams[this.$('button[name=team]').val()];
			var botTeam = Storage.teams[this.$('button[name=botTeam]').val()];
			if (!app.user.get('named')) return app.addPopup(LoginPopup);
			if (!window.BattleFormats[format].team && (!team || !botTeam)) return Bot.update("Pick a team for yourself and for the bot.");
			Bot.botTeamIndex = +this.$('button[name=botTeam]').val();
			if (botTeam && botTeam.teamid && !botTeam.loaded) {
				return app.loadTeam(botTeam, function () {
					Bot.start(format, team, botTeam);
				});
			}
			Bot.start(format, team, botTeam);
		}
	});

	var BotSettingsRoom = this.BotSettingsRoom = Room.extend({
		type: 'botsettings',
		title: 'Bot settings',
		events: {
			'input input': 'change',
			'change input, select': 'change',
			'change input[name=analysis]': 'toggleAnalysis'
		},
		initialize: function () {
			Bot.room = this;
			this.$el.addClass('ps-room-light').addClass('scrollable');
			this.curFormat = Storage.prefs('botformat') || app.rooms[''].curFormat || 'gen7ifrandombattle';
			this.data = null;
			this.update();
		},
		destroy: function () {
			if (Bot.room === this) Bot.room = null;
			Room.prototype.destroy.apply(this, arguments);
		},
		update: function () {
			this.data = null;
			this.$el.html('<div class="pad"><h2>Bot settings</h2><p><em>Loading the bot...</em></p></div>');
			Bot.post({type: 'schema', format: this.curFormat, speed: Bot.device()});
		},
		load: function (data) {
			if (data.format !== this.curFormat) return;
			var fresh = !this.data;
			if (!fresh && JSON.stringify(data) === JSON.stringify(this.data)) return;
			this.data = data;
			this.benched = this.costs();
			this.render();
			if (fresh && $.isEmptyObject(Bot.battles)) this.measure(true);
		},
		renderFormat: function () {
			return '<button class="select formatselect" name="format" value="' + BattleLog.escapeHTML(this.curFormat) + '">' + BattleLog.escapeFormat(this.curFormat) + '</button>';
		},
		render: function () {
			var data = this.data;
			var buf = '<div class="pad"><h2>Bot settings <small data-saved style="color:#888;font-size:9pt;font-weight:normal"></small></h2>';
			if (data.error) {
				this.$el.html(buf + '<p>Format: ' + this.renderFormat() + '</p><p class="message-error">' + BattleLog.escapeHTML(data.error) + '</p></div>');
				return;
			}

			buf += '<p><label><input type="checkbox" name="analysis"' + (Storage.prefs('botanalysis') !== false ? ' checked' : '') + ' /> Show what the bot\'s search did after each turn</label></p>';
			buf += '<h3>Strength</h3>';
			buf += '<div style="margin-left:16px">' + this.renderTable([this.find('time'), this.find('threads')]);
			if (this.value('threads') !== data.threads) buf += '<p><small style="color:#888">Threads after your battle: ' + this.value('threads') + '</small></p>';
			buf += '</div>';

			for (var k = 0; k < data.sections.length; k++) {
				var groups = this.groups(data.sections[k]);
				for (var m = 0; m < groups.length; m++) {
					buf += '<h3>' + BattleLog.escapeHTML(groups.length === 1 ? data.sections[k].section : groups[m].group) + '</h3><div style="margin-left:16px">' + this.renderBlocks(groups[m].settings) + '</div>';
				}
			}
			buf += '<div style="margin-left:16px;margin-top:16px"><table data-speed style="border-spacing:0 2px;margin:4px 0;width:100%;table-layout:fixed;color:#888"></table></div>';
			buf += '<p style="margin-top:16px"><button class="button" name="resetAll">Reset to defaults</button></p>';
			buf += '</div>';
			this.$el.html(buf);
			this.updateSpeed();
		},
		groups: function (section) {
			var groups = [];
			for (var i = 0; i < this.data.schema.length; i++) {
				var group = this.data.schema[i];
				if (section.groups.indexOf(group.group) < 0 || (group.bot && group.bot !== 'mcts')) continue;
				var settings = group.settings.filter(function (setting) { return !setting.basic && !setting.hidden; });
				if (settings.length) groups.push($.extend({}, group, {settings: settings}));
			}
			return groups;
		},
		renderBlocks: function (settings) {
			var buf = '';
			var rows = [];
			for (var i = 0; i < settings.length; i++) {
				var run = 1;
				while (settings[i].type === 'select' && i + run < settings.length && settings[i + run].type === 'select' &&
					JSON.stringify(settings[i + run].options) === JSON.stringify(settings[i].options)) run++;
				if (run < 2) {
					rows.push(settings[i]);
					continue;
				}
				if (rows.length) buf += this.renderTable(rows);
				rows = [];
				buf += '<div style="columns:250px;column-gap:24px;margin:4px 0">';
				for (var j = i; j < i + run; j++) {
					buf += '<div data-row="' + BattleLog.escapeHTML(settings[j].key) + '" style="break-inside:avoid;padding:1px 0">';
					buf += this.renderSelect(settings[j], 'width:100px') + ' ' + this.renderLabel(settings[j]) + ' ' + this.renderReset(settings[j]) + '</div>';
				}
				buf += '</div>';
				i += run - 1;
			}
			if (rows.length) buf += this.renderTable(rows);
			return buf;
		},
		renderTable: function (settings) {
			var buf = '<table style="border-spacing:0 2px;margin:4px 0;width:100%;table-layout:fixed">';
			for (var i = 0; i < settings.length; i++) {
				var setting = settings[i];
				var key = BattleLog.escapeHTML(setting.key);
				buf += '<tr data-row="' + key + '"><th style="text-align:right;font-weight:normal;padding-right:8px;width:min(230px,30vw)">' + this.renderLabel(setting) + '</th><td style="white-space:nowrap">';
				if (setting.type === 'select') {
					buf += this.renderSelect(setting, 'max-width:48vw');
				} else if (setting.type === 'checkbox') {
					buf += '<input type="checkbox" data-key="' + key + '"' + (this.value(setting.key) ? ' checked' : '') + ' />';
				} else {
					buf += '<input type="range" data-key="' + key + '" data-view="' + this.view(setting) + '"' + this.renderRange(setting) + ' style="width:140px;max-width:30vw;vertical-align:middle" /> ' + this.renderNumber(setting, 'width:64px') + this.renderUnit(setting);
				}
				buf += ' ' + this.renderReset(setting) + '</td></tr>';
			}
			return buf + '</table>';
		},
		renderSelect: function (setting, style) {
			var value = '' + this.value(setting.key);
			var buf = '<select class="button" data-key="' + BattleLog.escapeHTML(setting.key) + '" style="' + style + '">';
			for (var option in setting.options) {
				buf += '<option value="' + BattleLog.escapeHTML(option) + '"' + (option === value ? ' selected' : '') + '>' + BattleLog.escapeHTML(setting.options[option]) + '</option>';
			}
			return buf + '</select>';
		},
		renderLabel: function (setting, text) {
			var label = BattleLog.escapeHTML(text || setting.label);
			return '<label data-label="' + BattleLog.escapeHTML(setting.key) + '">' + (this.changed(setting) ? '<em>' + label + '</em>' : label) + '</label>';
		},
		renderRange: function (setting) {
			var view = this.view(setting);
			var min = this.toView(setting, view, setting.min);
			var max = this.toView(setting, view, setting.max);
			return ' min="' + Math.min(min, max) + '" max="' + Math.max(min, max) + '" step="' + this.step(setting, view) + '" value="' + this.display(setting, view) + '"';
		},
		renderNumber: function (setting, style) {
			return '<input type="number" class="textbox" data-key="' + BattleLog.escapeHTML(setting.key) + '" data-view="' + this.view(setting) + '"' + this.renderRange(setting) + ' style="' + style + '" />';
		},
		renderUnit: function (setting) {
			var view = this.view(setting);
			if (view === 'seconds') return ' <small>s</small>';
			return '';
		},
		renderReset: function (setting) {
			return '<button class="button" name="resetSetting" value="' + BattleLog.escapeHTML(setting.key) + '" style="padding:0 4px;font-size:8pt' + (this.changed(setting) ? '' : ';display:none') + '"><i class="fa fa-undo"></i></button>';
		},
		find: function (key) {
			if (key === 'threads') {
				return {key: 'threads', label: 'Power usage (Threads)', type: 'range', min: 1, max: this.data.available, step: 1, default: this.data.available};
			}
			for (var i = 0; i < this.data.schema.length; i++) {
				for (var j = 0; j < this.data.schema[i].settings.length; j++) {
					if (this.data.schema[i].settings[j].key === key) return this.data.schema[i].settings[j];
				}
			}
			return null;
		},
		value: function (key) {
			if (key === 'threads') return Storage.prefs('botthreads') || this.data.available;
			var overrides = Bot.settings();
			var parts = key.split('.');
			var override = parts.length > 1 ? (overrides[parts[0]] || {})[parts[1]] : overrides[key];
			if (override !== undefined) return override;
			return parts.length > 1 ? this.data.defaults[parts[0]][parts[1]] : this.data.defaults[key];
		},
		changed: function (setting) {
			return JSON.stringify(this.value(setting.key)) !== JSON.stringify(setting.default);
		},
		view: function (setting) {
			if (setting.key === 'time') return 'seconds';
			return 'raw';
		},
		step: function (setting, view) {
			if (view === 'seconds') return setting.key === 'time' ? 0.1 : 1;
			return setting.step;
		},
		toView: function (setting, view, raw) {
			if (view === 'seconds') return raw / 1000;
			return raw;
		},
		fromView: function (setting, view, shown) {
			var raw = shown;
			if (view === 'seconds') raw = Math.round(shown * 1000);
			return Math.max(setting.min, Math.min(setting.max, raw));
		},
		display: function (setting, view) {
			return this.toView(setting, view, this.value(setting.key));
		},
		updateSpeed: function () {
			if (!this.data || this.data.error) return;
			var speed = Storage.prefs('botspeed');
			var search = Storage.prefs('botsearch');
			var guesses = this.value('determinizations');
			var rows = [['Speed', this.measuring ? 'Measuring...' : 'Not measured']];
			if (!this.measuring && speed && search) {
				rows = [['Routes per guess', '~' + (Math.round(speed * this.value('time') / 1000 / guesses / 10) * 10).toLocaleString()], ['Branching depth', search.turns.toFixed(1) + ' turns'], ['Look-ahead', search.horizon.toFixed(1) + ' turns'], ['Simulated turns', '~' + (Math.round(speed * this.value('time') / 1000 * search.horizon / 1000) * 1000).toLocaleString()]];
			}
			this.$('[data-speed]').html(rows.map(function (row) {
				return '<tr><th style="text-align:right;font-weight:normal;padding-right:8px;width:min(230px,30vw)">' + row[0] + '</th><td>' + row[1] + '</td></tr>';
			}).join(''));
		},
		costs: function () {
			var settings = $.extend({}, Bot.settings());
			delete settings.time;
			return JSON.stringify(settings);
		},
		refresh: function (key) {
			var self = this;
			[key].forEach(function (key) {
				var setting = self.find(key);
				if (!setting) return;
				self.$('input[data-key="' + key + '"], select[data-key="' + key + '"]').each(function () {
					if (this === document.activeElement) return;
					var view = $(this).attr('data-view');
					if (view === 'switch') this.checked = !!self.value(key);
					else if (this.type === 'checkbox') this.checked = !!self.value(key);
					else if (view) $(this).val(self.display(setting, view));
					else $(this).val('' + self.value(key));
				});
				self.$('label[data-label="' + key + '"]').each(function () {
					var text = BattleLog.escapeHTML($(this).text());
					$(this).html(self.changed(setting) ? '<em>' + text + '</em>' : text);
				});
				self.$('button[name=resetSetting][value="' + key + '"]').css('display', self.changed(setting) ? '' : 'none');
			});
			if (key === 'time') this.updateSpeed();
		},
		set: function (key, value) {
			var overrides = Bot.settings();
			var parts = key.split('.');
			var target = overrides;
			if (parts.length > 1) target = overrides[parts[0]] || (overrides[parts[0]] = {});
			var last = parts[parts.length - 1];
			if (value === undefined || JSON.stringify(value) === JSON.stringify(this.find(key).default)) {
				delete target[last];
				if (parts.length > 1 && $.isEmptyObject(target)) delete overrides[parts[0]];
			} else {
				target[last] = value;
			}
			Bot.save(true);
			this.refresh(key);
		},
		saved: function () {
			var $saved = this.$('[data-saved]').text('Saved');
			clearTimeout(this.savedTimer);
			this.savedTimer = setTimeout(function () {
				$saved.text('');
			}, 1500);
			if (this.costs() === this.benched || !$.isEmptyObject(Bot.battles)) return;
			var self = this;
			this.measuring = true;
			this.updateSpeed();
			clearTimeout(this.benchTimer);
			this.benchTimer = setTimeout(function () {
				self.measure(false);
			}, 600);
		},
		measure: function (full) {
			this.measuring = true;
			this.updateSpeed();
			this.benched = this.costs();
			Bot.post({type: 'bench', format: this.curFormat, settings: Bot.settings(), speed: Bot.device(), reference: full});
		},
		change: function (e) {
			var $input = $(e.currentTarget);
			var key = $input.attr('data-key');
			var setting = key && this.data && this.find(key);
			if (!setting) return;
			var view = $input.attr('data-view');
			var value;
			if (view === 'switch') {
				value = $input.is(':checked') ? (this.value(key) || setting.default) : 0;
			} else if ($input.is('[type=checkbox]')) {
				value = $input.is(':checked');
			} else if (setting.type === 'select') {
				value = $input.val();
			} else {
				var shown = $input.val();
				if (shown === '' || isNaN(+shown)) return;
				value = this.fromView(setting, view || 'raw', +shown);
				if (e.type === 'input' && $input.is('[type=range]')) $input.siblings('input[type=number][data-key="' + key + '"]').val(shown);
			}
			if (key === 'threads') {
				if (e.type === 'change') this.setThreads(value);
				return;
			}
			this.set(key, value);
		},
		setThreads: function (threads) {
			threads = Math.min(Math.max(Math.round(threads) || 1, 1), this.data.available);
			var speed = Storage.prefs('botspeed');
			if (speed) Storage.prefs('botspeed', Math.round(speed * threads / (Storage.prefs('botthreads') || this.data.available)));
			Storage.prefs('botthreads', threads === this.data.available ? null : threads);
			Bot.reload();
			if (this.data) this.render();
		},
		toggleAnalysis: function (e) {
			Storage.prefs('botanalysis', $(e.currentTarget).is(':checked') ? null : false);
		},
		resetSetting: function (key) {
			if (!this.data || !this.find(key)) return;
			if (key === 'threads') return this.setThreads(this.data.available);
			this.set(key, undefined);
		},
		resetAll: function () {
			Bot.overrides = {};
			Bot.save(true);
			this.render();
		},
		format: function (format, button) {
			var self = this;
			app.addPopup(FormatPopup, {format: format, sourceEl: button, selectType: 'challenge', onselect: function (format) {
				self.curFormat = format;
				self.update();
			}});
		}
	});

	var add = BattleRoom.prototype.add;
	BattleRoom.prototype.add = function (data) {
		var pending = Bot.analyses[this.id];
		if (pending && pending.length && data && data.substr(0, 9) !== '|request|') {
			var lines = data.split('\n');
			for (var i = 0; i < lines.length; i++) {
				if (!/^\|(turn|win|tie)(\||$)/.test(lines[i])) continue;
				var raw = [];
				for (var j = 0; j < pending.length; j++) raw.push('|raw|' + Bot.renderAnalysis(pending[j]));
				Array.prototype.splice.apply(lines, [i, 0].concat(raw));
				Bot.analyses[this.id] = [];
				data = lines.join('\n');
				break;
			}
		}
		return add.apply(this, arguments.length > 1 ? [data].concat(Array.prototype.slice.call(arguments, 1)) : [data]);
	};

	var send = BattleRoom.prototype.send;
	BattleRoom.prototype.send = function (data) {
		send.apply(this, arguments);
		if (Bot.frame && /^\/(choose|guess|move|mv|attack|switch|sw|team)(\s|\||$)/i.test(data)) Bot.post({type: 'choosing', room: this.id, value: false});
	};

	var tryJoinRoom = App.prototype.tryJoinRoom;
	App.prototype.tryJoinRoom = function (id) {
		if (id === 'botsettings') return this.joinRoom(id, BotSettingsRoom);
		return tryJoinRoom.apply(this, arguments);
	};

	var initialize = MainMenuRoom.prototype.initialize;
	MainMenuRoom.prototype.initialize = function () {
		initialize.apply(this, arguments);
		this.$('button[name=search]').closest('p').after('<p><button class="button mainmenu1" name="botBattle" style="width:230px"><strong>Battle a bot</strong></button></p>');
	};
	MainMenuRoom.prototype.botBattle = function () {
		app.addPopup(BotPopup);
	};

}).call(this, jQuery);
