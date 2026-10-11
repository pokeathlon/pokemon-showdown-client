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
		times: [[1000, "Quick"], [3000, "Normal"], [10000, "Strong"]],
		post: function (message) {
			if (!this.frame) {
				this.frame = $('<iframe title="Bot" style="display:none"></iframe>').attr('src', this.url + 'live.html').appendTo('body')[0];
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
				if (data.iterations && data.time > 250) {
					var speed = data.iterations / data.time * 1000;
					var previous = Storage.prefs('botspeed');
					Storage.prefs('botspeed', Math.round(previous ? previous * 0.7 + speed * 0.3 : speed));
					if (Bot.room) Bot.room.updateSpeed();
				}
				break;
			case 'battle':
				Bot.update('');
				if (Bot.popup) Bot.popup.close();
				break;
			case 'notice':
			case 'error':
				Bot.report(data.split('\n')[0]);
				break;
			case 'closed':
				Bot.name = '';
				Bot.report("The bot disconnected.");
				break;
			}
		},
		start: function (format, team, botTeam) {
			this.pending = {format: format, team: team};
			this.format = '';
			Storage.prefs('botformat', format);
			this.post({
				type: 'start', url: (Config.server.port === 443 || Config.server.https ? 'wss' : 'ws') + '://' + Config.server.host + ':' + Config.server.port + Config.sockjsprefix + '/websocket',
				owner: app.user.get('userid'), format: format, team: botTeam ? Storage.getPackedTeam(botTeam) : '', settings: this.settings(), ask: true
			});
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
			if (!this.overrides) this.overrides = $.extend(true, {}, Storage.prefs('botsettings') || {});
			return this.overrides;
		},
		time: function () {
			return this.settings().time || 3000;
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
		}
	};
	window.addEventListener('message', Bot.receive);

	var BotPopup = this.BotPopup = Popup.extend({
		type: 'semimodal',
		initialize: function () {
			Bot.popup = this;
			var format = app.rooms[''].curFormat;
			var time = Bot.time();
			var times = Bot.times.slice();
			if (!times.some(function (entry) { return entry[0] === time; })) times.push([time, "Custom"]);
			var buf = '<form class="battleform">';
			buf += '<p><label class="label">Format:</label>' + app.rooms[''].renderFormats(format) + '</p>';
			buf += '<p><label class="label">Your team:</label>' + app.rooms[''].renderTeams(format) + '</p>';
			buf += '<p><label class="label">Bot\'s team:</label>' + this.renderBotTeam(format) + '</p>';
			buf += '<p><label class="label">Strength:</label><select name="time" class="button">';
			for (var i = 0; i < times.length; i++) {
				buf += '<option value="' + times[i][0] + '"' + (times[i][0] === time ? ' selected' : '') + '>' + times[i][1] + ' (' + times[i][0] / 1000 + ' second' + (times[i][0] === 1000 ? '' : 's') + ' a turn)</option>';
			}
			buf += '</select></p>';
			buf += '<p class="status"></p>';
			buf += '<p class="buttonbar"><button type="submit" class="button"><strong>Battle!</strong></button> <button type="button" name="close" class="button">Cancel</button></p>';
			buf += '<p><button type="button" name="settings" class="button"><i class="fa fa-cog"></i> Bot settings</button></p>';
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
		renderBotTeam: function (format) {
			return app.rooms[''].renderTeams(format, Bot.botTeamIndex).replace('name="team"', 'name="botTeam"');
		},
		format: function (format, button) {
			var self = this;
			app.addPopup(FormatPopup, {format: format, sourceEl: button, selectType: 'challenge', onselect: function (format) {
				self.$('button[name=team]').replaceWith(app.rooms[''].renderTeams(format));
				Bot.botTeamIndex = -1;
				self.$('button[name=botTeam]').replaceWith(self.renderBotTeam(format));
			}});
		},
		team: function (team, button) {
			app.addPopup(TeamPopup, {team: team, format: this.$('button[name=format]').val(), sourceEl: button, folderToggleOn: true, folderNotExpanded: []});
		},
		botTeam: function (team, button) {
			this.team(team, button);
		},
		settings: function () {
			this.close();
			app.tryJoinRoom('botsettings');
		},
		submit: function (data) {
			var format = this.$('button[name=format]').val();
			var team = Storage.teams[this.$('button[name=team]').val()];
			var botTeam = Storage.teams[this.$('button[name=botTeam]').val()];
			if (!app.user.get('named')) return app.addPopup(LoginPopup);
			if (!window.BattleFormats[format].team && (!team || !botTeam)) return Bot.update("Pick a team for yourself and for the bot.");
			Bot.botTeamIndex = +this.$('button[name=botTeam]').val();
			if (+data.time !== Bot.time()) {
				Bot.settings().time = +data.time;
				Bot.save();
			}
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
			'input input[name=filter]': 'filter',
			'change input[name=changedOnly]': 'filter',
			'click label[data-explain]': 'explain'
		},
		initialize: function () {
			Bot.room = this;
			this.$el.addClass('ps-room-light').addClass('scrollable');
			this.curFormat = Storage.prefs('botformat') || app.rooms[''].curFormat || 'gen7ifrandombattle';
			this.data = null;
			this.open = {};
			this.zeros = {};
			this.query = '';
			this.changedOnly = false;
			this.wasFiltering = false;
			this.update();
		},
		destroy: function () {
			if (Bot.room === this) Bot.room = null;
			Room.prototype.destroy.apply(this, arguments);
		},
		update: function () {
			this.data = null;
			this.$el.html('<div class="pad"><h2>Bot settings</h2><p><em>Loading the bot...</em></p></div>');
			Bot.post({type: 'schema', format: this.curFormat});
		},
		load: function (data) {
			if (data.format !== this.curFormat) return;
			this.data = data;
			this.render();
		},
		renderFormat: function () {
			return '<button class="select formatselect" name="format" value="' + BattleLog.escapeHTML(this.curFormat) + '">' + BattleLog.escapeFormat(this.curFormat) + '</button>';
		},
		render: function () {
			var data = this.data;
			if (!this.filtering()) this.saveOpen();
			var buf = '<div class="pad"><h2>Bot settings <small data-saved style="color:#888;font-size:9pt;font-weight:normal"></small></h2>';
			if (data.error) {
				this.$el.html(buf + '<p>Format: ' + this.renderFormat() + '</p><p class="message-error">' + BattleLog.escapeHTML(data.error) + '</p></div>');
				return;
			}
			buf += '<p><small>How the bot you battle from <strong>Battle a bot</strong> plays. Changes apply from its next decision, also in a battle that has already started. Click a setting\'s name to see what it does.</small></p>';

			buf += '<h3>Strength</h3><p>';
			var time = this.value('time');
			for (var i = 0; i < Bot.times.length; i++) {
				var label = Bot.times[i][1] + ' (' + Bot.times[i][0] / 1000 + ' s)';
				buf += '<button class="button" name="preset" value="' + Bot.times[i][0] + '">' + (Bot.times[i][0] === time ? '<strong>' + label + '</strong>' : label) + '</button> ';
			}
			buf += '</p>';
			buf += this.renderTable([this.find('time')]);
			buf += '<p><small data-speed style="color:#888"></small></p>';
			var ponder = this.find('ponder');
			buf += '<p data-row="ponder" title="' + this.renderTitle(ponder) + '"><input type="checkbox" data-key="ponder" data-view="switch"' + (this.value('ponder') ? ' checked' : '') + ' /> ';
			buf += this.renderLabel(ponder, "Keep thinking during my turn") + ', for up to ' + this.renderNumber(ponder, 'width:56px') + ' seconds ' + this.renderReset(ponder) + '</p>';

			buf += '<h3 title="Each of these multiplies how much a part of the position counts when the bot scores the positions it looks ahead to. The middle is the tuned default.">What the bot cares about</h3>';
			buf += '<table style="border-spacing:0 2px;margin:4px 0">';
			var weights = this.basics().filter(function (setting) { return setting.key.indexOf('weights.') === 0; });
			for (var j = 0; j < weights.length; j++) {
				var weight = weights[j];
				buf += '<tr data-row="' + BattleLog.escapeHTML(weight.key) + '" title="' + this.renderTitle(weight) + '"><th style="text-align:right;font-weight:normal;padding-right:8px;width:min(230px,40vw)">' + this.renderLabel(weight) + '</th>';
				buf += '<td style="white-space:nowrap"><small>Less</small> <input type="range" data-key="' + BattleLog.escapeHTML(weight.key) + '" data-view="factor" min="-2" max="2" step="0.05" value="' + this.display(weight, 'factor') + '" style="width:140px;max-width:26vw;vertical-align:middle" /> <small>More</small> ';
				buf += '<small data-factor="' + BattleLog.escapeHTML(weight.key) + '" style="color:#888">' + this.factorText(weight) + '</small> ' + this.renderReset(weight) + '</td></tr>';
			}
			buf += '</table>';

			var gimmicks = this.basics().filter(function (setting) { return setting.key.indexOf('gimmicks.') === 0; });
			if (gimmicks.length) {
				buf += '<h3>Gimmicks <small style="font-weight:normal">in ' + BattleLog.escapeFormat(this.curFormat) + '</small></h3>';
				buf += this.renderBlocks(gimmicks);
			}

			buf += '<h3>Guessing your team</h3>';
			buf += this.renderTable([this.find('guess')]);

			buf += '<details data-open="advanced"' + (this.open.advanced ? ' open' : '') + ' style="margin-top:12px"><summary title="Every other setting, for fine-tuning how the bot searches, guesses your team and scores positions."><h3 style="display:inline">Advanced</h3> <small style="color:#888" data-gist="advanced"></small></summary>';
			buf += '<div data-advanced>';
			buf += '<p>Format: ' + this.renderFormat() + ' <small>(the conditions below, and the gimmicks above, depend on it)</small></p>';
			buf += '<p><input type="search" name="filter" class="textbox" placeholder="Filter settings" value="' + BattleLog.escapeHTML(this.query) + '" title="Show only settings whose name contains this." /> ';
			buf += '<label title="Show only settings changed from their defaults."><input type="checkbox" name="changedOnly"' + (this.changedOnly ? ' checked' : '') + ' /> Changed only</label> ';
			buf += '<button class="button" name="expandAll" title="Open every section and group.">Expand all</button> <button class="button" name="collapseAll" title="Close every section and group, back to one line each.">Collapse all</button></p>';
			for (var k = 0; k < data.sections.length; k++) {
				var section = data.sections[k];
				var groups = this.groups(section);
				if (!groups.length) continue;
				buf += '<details data-open="section:' + BattleLog.escapeHTML(section.section) + '"' + (this.open['section:' + section.section] ? ' open' : '') + '>';
				buf += '<summary title="' + BattleLog.escapeHTML(section.title) + '"><strong>' + BattleLog.escapeHTML(section.section) + '</strong> <small style="color:#888" data-gist="section:' + BattleLog.escapeHTML(section.section) + '"></small></summary>';
				if (section.section === 'Scoring') buf += '<p style="margin-left:16px"><small>Percentages are a share of what one healthy Pokémon is worth, after the multipliers in What the bot cares about.</small></p>';
				if (groups.length === 1) groups[0] = $.extend({}, groups[0], {single: true});
				for (var m = 0; m < groups.length; m++) {
					var group = groups[m];
					if (group.single) {
						buf += '<div style="margin-left:16px">' + this.renderGroup(group) + '</div>';
						continue;
					}
					buf += '<details data-open="group:' + BattleLog.escapeHTML(group.group) + '" style="margin:4px 0 4px 16px"' + (this.open['group:' + group.group] ? ' open' : '') + '>';
					buf += '<summary title="' + BattleLog.escapeHTML(group.title) + '">' + BattleLog.escapeHTML(group.group) + ' <small style="color:#888" data-gist="group:' + BattleLog.escapeHTML(group.group) + '"></small></summary>';
					buf += this.renderGroup(group) + '</details>';
				}
				buf += '</details>';
			}
			buf += '</div></details>';
			buf += '<p style="margin-top:16px"><button class="button" name="resetAll" title="Put every bot setting back to its default, in every format.">Reset everything</button></p>';
			buf += '</div>';
			this.$el.html(buf);
			this.updateGists();
			this.updateSpeed();
			this.applyView();
		},
		basics: function () {
			var all = [];
			for (var i = 0; i < this.data.schema.length; i++) {
				var group = this.data.schema[i];
				if (group.bot && group.bot !== 'mcts') continue;
				for (var j = 0; j < group.settings.length; j++) {
					if (group.settings[j].basic && !group.settings[j].hidden) all.push(group.settings[j]);
				}
			}
			return all;
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
		renderGroup: function (group) {
			var ranges = group.settings.filter(function (setting) { return setting.type === 'range'; });
			var hasSelect = group.settings.some(function (setting) { return setting.type === 'select'; });
			if (!group.kind && (hasSelect || ranges.length < 6)) return this.renderBlocks(group.settings);
			var buf = '<div style="columns:200px;column-gap:24px;margin:4px 0">';
			for (var i = 0; i < ranges.length; i++) {
				var setting = ranges[i];
				var zero = ranges.length > 12 && setting.default === 0;
				buf += '<div data-row="' + BattleLog.escapeHTML(setting.key) + '"' + (zero ? ' data-zero="' + BattleLog.escapeHTML(group.group) + '"' : '') + ' title="' + this.renderTitle(setting) + '" style="break-inside:avoid;padding:1px 0">';
				buf += this.renderNumber(setting, 'width:56px') + this.renderUnit(setting) + ' ' + this.renderLabel(setting) + ' ' + this.renderReset(setting) + '</div>';
			}
			buf += '</div>';
			if (ranges.length > 12) buf += '<p data-zeros="' + BattleLog.escapeHTML(group.group) + '"><button class="button" name="showZeros" value="' + BattleLog.escapeHTML(group.group) + '" title="Show the settings in this group that are at 0, where they don\'t count."></button></p>';
			return buf + this.renderBlocks(group.settings.filter(function (setting) { return setting.type !== 'range'; }));
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
					buf += '<div data-row="' + BattleLog.escapeHTML(settings[j].key) + '" title="' + this.renderTitle(settings[j]) + '" style="break-inside:avoid;padding:1px 0">';
					buf += this.renderSelect(settings[j], 'width:100px') + ' ' + this.renderLabel(settings[j]) + ' ' + this.renderReset(settings[j]) + '</div>';
				}
				buf += '</div>';
				i += run - 1;
			}
			if (rows.length) buf += this.renderTable(rows);
			return buf;
		},
		renderTable: function (settings) {
			var buf = '<table style="border-spacing:0 2px;margin:4px 0">';
			for (var i = 0; i < settings.length; i++) {
				var setting = settings[i];
				var key = BattleLog.escapeHTML(setting.key);
				buf += '<tr data-row="' + key + '" title="' + this.renderTitle(setting) + '"><th style="text-align:right;font-weight:normal;padding-right:8px;width:min(230px,40vw)">' + this.renderLabel(setting) + '</th><td style="white-space:nowrap">';
				if (setting.type === 'select') {
					buf += this.renderSelect(setting, 'max-width:48vw');
				} else if (setting.type === 'checkbox') {
					buf += '<input type="checkbox" data-key="' + key + '"' + (this.value(setting.key) ? ' checked' : '') + ' />';
				} else {
					buf += '<input type="range" data-key="' + key + '" data-view="' + this.view(setting) + '"' + this.renderRange(setting) + ' style="width:140px;max-width:24vw;vertical-align:middle" /> ' + this.renderNumber(setting, 'width:64px') + this.renderUnit(setting);
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
			return '<label data-explain="' + BattleLog.escapeHTML(setting.key) + '" style="cursor:help">' + (this.changed(setting) ? '<em>' + label + '</em>' : label) + '</label>';
		},
		renderTitle: function (setting) {
			return BattleLog.escapeHTML(setting.title + ' Default: ' + this.describe(setting, setting.default) + '.');
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
			if (view === 'percent') return '<small>%</small>';
			if (view === 'seconds') return ' <small>s</small>';
			return '';
		},
		renderReset: function (setting) {
			return '<button class="button" name="resetSetting" value="' + BattleLog.escapeHTML(setting.key) + '" title="Back to the default: ' + BattleLog.escapeHTML(this.describe(setting, setting.default)) + '" style="padding:0 4px;font-size:8pt' + (this.changed(setting) ? '' : ';display:none') + '"><i class="fa fa-undo"></i></button>';
		},
		find: function (key) {
			for (var i = 0; i < this.data.schema.length; i++) {
				for (var j = 0; j < this.data.schema[i].settings.length; j++) {
					if (this.data.schema[i].settings[j].key === key) return this.data.schema[i].settings[j];
				}
			}
			return null;
		},
		value: function (key) {
			var overrides = Bot.settings();
			var parts = key.split('.');
			var override = parts.length > 1 ? (overrides[parts[0]] || {})[parts[1]] : overrides[key];
			if (override !== undefined) return override;
			return parts.length > 1 ? this.data.defaults[parts[0]][parts[1]] : this.data.defaults[key];
		},
		changed: function (setting) {
			return JSON.stringify(this.value(setting.key)) !== JSON.stringify(setting.default);
		},
		describe: function (setting, value) {
			if (setting.type === 'select') return setting.options[value];
			if (setting.type === 'checkbox') return value ? 'on' : 'off';
			var view = this.view(setting);
			if (view === 'percent') return this.round(this.toView(setting, view, value)) + '% of a healthy Pokémon';
			if (view === 'seconds') return value / 1000 + ' seconds';
			return '' + value;
		},
		view: function (setting) {
			if (setting.key === 'time' || setting.key === 'ponder') return 'seconds';
			if (setting.per && this.unit(setting)) return 'percent';
			return 'raw';
		},
		unit: function (setting) {
			var healthy = this.value('weights.pokemon') * (this.value('alive') + this.value('hp'));
			if (!healthy) return 0;
			return 100 * this.value('weights.' + setting.per) / healthy;
		},
		round: function (value) {
			return Math.round(value * 10) / 10;
		},
		step: function (setting, view) {
			if (view === 'percent') return 0.1;
			if (view === 'seconds') return setting.key === 'time' ? 0.1 : 1;
			return setting.step;
		},
		toView: function (setting, view, raw) {
			if (view === 'seconds') return raw / 1000;
			if (view === 'percent') return this.round(raw * this.unit(setting));
			if (view === 'factor') {
				if (raw <= 0) return -2;
				var x = raw > setting.default ? 2 * Math.log(raw / setting.default) / Math.log(setting.max / setting.default) : Math.log(raw / setting.default) / Math.LN2;
				return Math.max(-2, Math.min(2, Math.round(x * 20) / 20));
			}
			return raw;
		},
		fromView: function (setting, view, shown) {
			var raw = shown;
			if (view === 'seconds') raw = Math.round(shown * 1000);
			if (view === 'percent') {
				if (this.toView(setting, view, setting.default) === this.round(shown)) return setting.default;
				raw = Math.round(shown / this.unit(setting) * 10000) / 10000;
			}
			if (view === 'factor') {
				if (Math.abs(shown) < 0.025) return setting.default;
				raw = shown <= -2 ? 0 : Math.round(setting.default * (shown > 0 ? Math.pow(setting.max / setting.default, shown / 2) : Math.pow(2, shown)) * 100) / 100;
			}
			return Math.max(setting.min, Math.min(setting.max, raw));
		},
		display: function (setting, view) {
			return this.toView(setting, view, this.value(setting.key));
		},
		factorText: function (setting) {
			var value = this.value(setting.key);
			if (value === setting.default) return 'tuned';
			if (!value) return 'ignored';
			return '×' + Math.round(value / setting.default * 100) / 100;
		},
		gist: function (settings, keys) {
			var self = this;
			var count = settings.filter(function (setting) { return self.changed(setting); }).length;
			var parts = [];
			for (var i = 0; i < (keys || []).length; i++) {
				var setting = this.find(keys[i]);
				if (setting && !setting.basic) parts.push(setting.label + ' ' + this.describe(setting, this.value(setting.key)));
			}
			if (count) parts.push(count + ' changed');
			return parts.join(' · ');
		},
		updateGists: function () {
			var self = this;
			this.$('[data-gist]').each(function () {
				var gist = $(this).attr('data-gist');
				var name = gist.slice(gist.indexOf(':') + 1);
				var settings = [];
				var keys = null;
				if (gist === 'advanced') {
					for (var i = 0; i < self.data.sections.length; i++) {
						self.groups(self.data.sections[i]).forEach(function (group) { settings = settings.concat(group.settings); });
					}
				} else if (gist.indexOf('section:') === 0) {
					var section = self.data.sections.filter(function (item) { return item.section === name; })[0];
					self.groups(section).forEach(function (group) { settings = settings.concat(group.settings); });
					keys = section.keys;
				} else {
					settings = self.data.schema.filter(function (group) { return group.group === name; })[0].settings.filter(function (setting) { return !setting.basic && !setting.hidden; });
				}
				$(this).text(self.gist(settings, keys));
			});
		},
		updateSpeed: function () {
			if (!this.data || this.data.error) return;
			var speed = Storage.prefs('botspeed');
			var time = this.value('time');
			this.$('[data-speed]').text(speed ? '≈ ' + (Math.round(speed * time / 1000 / 100) * 100).toLocaleString() + ' positions looked at per turn on this device' : 'Battle the bot once to see how many positions this lets it look at on this device.');
		},
		refresh: function (key) {
			var self = this;
			var keys = [key];
			if (key === 'alive' || key === 'hp' || key.indexOf('weights.') === 0) {
				this.$('input[data-view=percent]').each(function () { keys.push($(this).attr('data-key')); });
			}
			keys.forEach(function (key) {
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
				self.$('label[data-explain="' + key + '"]').each(function () {
					var text = BattleLog.escapeHTML($(this).text());
					$(this).html(self.changed(setting) ? '<em>' + text + '</em>' : text);
				});
				self.$('button[name=resetSetting][value="' + key + '"]').css('display', self.changed(setting) ? '' : 'none');
				self.$('[data-factor="' + key + '"]').text(self.factorText(setting));
			});
			if (key === 'time') {
				this.updateSpeed();
				this.$('button[name=preset]').each(function () {
					var text = $(this).text();
					$(this).html(+this.value === self.value('time') ? '<strong>' + BattleLog.escapeHTML(text) + '</strong>' : BattleLog.escapeHTML(text));
				});
			}
			this.updateGists();
		},
		filtering: function () {
			return !!(toID(this.query) || this.changedOnly);
		},
		applyView: function () {
			var self = this;
			var query = toID(this.query);
			var filtering = this.filtering();
			var zeros = {};
			var $advanced = this.$('[data-advanced]');
			$advanced.find('[data-row]').each(function () {
				var setting = self.find($(this).attr('data-row'));
				var zero = $(this).attr('data-zero');
				var hidden = zero && !filtering && !self.zeros[zero] && self.value(setting.key) === 0;
				if (hidden) zeros[zero] = (zeros[zero] || 0) + 1;
				var shown = (!query || toID(setting.label).indexOf(query) >= 0 || toID(setting.key).indexOf(query) >= 0) &&
					(!self.changedOnly || self.changed(setting)) && !hidden;
				this.style.display = shown ? '' : 'none';
			});
			$advanced.find('[data-zeros]').each(function () {
				var group = $(this).attr('data-zeros');
				var count = zeros[group] || 0;
				var rest = $(this).prev().children().filter(function () { return this.style.display !== 'none'; }).length;
				this.style.display = count ? '' : 'none';
				$(this).find('button').text('Show ' + count + (rest ? ' more' : '') + ' at 0');
			});
			$($advanced.find('details').get().reverse()).each(function () {
				var visible = $(this).find('[data-row]').filter(function () { return this.style.display !== 'none'; }).length;
				this.style.display = !filtering || visible ? '' : 'none';
				if (filtering) this.open = true;
				else if (self.wasFiltering) this.open = !!self.open[$(this).attr('data-open')];
			});
			this.wasFiltering = filtering;
		},
		filter: function () {
			if (!this.filtering()) this.saveOpen();
			this.query = this.$('input[name=filter]').val() || '';
			this.changedOnly = this.$('input[name=changedOnly]').is(':checked');
			this.applyView();
		},
		saveOpen: function () {
			var self = this;
			this.$('details[data-open]').each(function () {
				self.open[$(this).attr('data-open')] = this.open;
			});
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
			this.set(key, value);
		},
		explain: function (e) {
			e.preventDefault();
			e.stopImmediatePropagation();
			var setting = this.find($(e.currentTarget).attr('data-explain'));
			if (!setting) return;
			app.addPopup(Popup, {
				htmlMessage: '<strong>' + BattleLog.escapeHTML(setting.label) + '</strong><br />' + BattleLog.escapeHTML(setting.title) + '<br /><br /><small>Default: ' + BattleLog.escapeHTML(this.describe(setting, setting.default)) + '</small>',
				sourceEl: e.currentTarget,
				type: 'normal',
				maxWidth: 420
			});
		},
		preset: function (time) {
			this.set('time', +time);
		},
		resetSetting: function (key) {
			if (!this.data || !this.find(key)) return;
			this.set(key, undefined);
		},
		resetAll: function (value, button) {
			var self = this;
			if (!this.confirming) {
				this.confirming = true;
				$(button).text('Click again to reset everything');
				setTimeout(function () {
					self.confirming = false;
					$(button).text('Reset everything');
				}, 3000);
				return;
			}
			this.confirming = false;
			Bot.overrides = {};
			Bot.save(true);
			this.render();
		},
		expandAll: function () {
			this.setOpen(true);
		},
		collapseAll: function () {
			this.setOpen(false);
		},
		setOpen: function (open) {
			var self = this;
			this.$('[data-advanced] details[data-open]').each(function () {
				this.open = open;
				self.open[$(this).attr('data-open')] = open;
			});
		},
		showZeros: function (group) {
			this.zeros[group] = true;
			this.applyView();
		},
		format: function (format, button) {
			var self = this;
			app.addPopup(FormatPopup, {format: format, sourceEl: button, selectType: 'challenge', onselect: function (format) {
				self.saveOpen();
				self.curFormat = format;
				self.update();
			}});
		}
	});

	var sendDecision = BattleRoom.prototype.sendDecision;
	BattleRoom.prototype.sendDecision = function () {
		sendDecision.apply(this, arguments);
		if (Bot.frame) Bot.post({type: 'choosing', room: this.id, value: false});
	};

	var tryJoinRoom = App.prototype.tryJoinRoom;
	App.prototype.tryJoinRoom = function (id) {
		if (id === 'botsettings') return this.joinRoom(id, BotSettingsRoom);
		return tryJoinRoom.apply(this, arguments);
	};

	var initialize = MainMenuRoom.prototype.initialize;
	MainMenuRoom.prototype.initialize = function () {
		initialize.apply(this, arguments);
		this.$('button[name=search]').closest('p').after('<p><button class="button mainmenu1" name="botBattle"><strong>Battle a bot</strong></button></p>');
	};
	MainMenuRoom.prototype.botBattle = function () {
		app.addPopup(BotPopup);
	};

}).call(this, jQuery);
