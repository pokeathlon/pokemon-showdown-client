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
				if (data.analysis && Storage.prefs('botanalysis') !== false) {
					if (!Bot.analyses[data.room]) Bot.analyses[data.room] = [];
					Bot.analyses[data.room].push(data);
				}
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
		},
		renderAnalysis: function (data) {
			var analysis = data.analysis;
			var tree = analysis.tree;
			var iterations = analysis.iterations || 1;
			var count = function (n) { return Math.round(n).toLocaleString('en-US'); };
			var percent = function (n, total) { return (total ? Math.round(100 * n / total) : 0) + '%'; };
			var byVisits = function (a, b) { return b.n - a.n; };
			var options = analysis.options.slice().sort(byVisits);
			var foe = analysis.foe.slice().sort(byVisits);
			var total = 0;
			var foeTotal = 0;
			var entropy = 0;
			var chosen = data.choice;
			for (var i = 0; i < options.length; i++) total += options[i].n;
			for (var j = 0; j < foe.length; j++) foeTotal += foe[j].n;
			for (var k = 0; k < options.length; k++) {
				if (options[k].n) entropy -= options[k].n / total * Math.log(options[k].n / total);
				if (options[k].choice === data.choice) chosen = options[k].label;
			}
			var turns = (tree.turns / iterations).toFixed(1);
			var played = (tree.playoutTurns / iterations).toFixed(1);
			var scoreTitle = "Average result of the battles the search played out after this choice: 1 is a win, 0 a loss, 0.5 a tie. A battle stopped at the turn cap counts as the bot's share of the HP left on both sides.";

			var buf = '<div class="infobox"><details><summary title="What the bot\'s search did before choosing this turn. Click for depth, breadth and how it rated each choice.">';
			buf += '<strong>Bot, turn ' + data.turn + ':</strong> ' + BattleLog.escapeHTML(chosen) + ' &middot; ' + count(analysis.iterations) + ' iterations in ' + (analysis.time / 1000).toFixed(1) + ' s &middot; ' + played + ' turns played out on average</summary>';
			buf += '<p title="An iteration follows the search tree, choosing for both sides, until it reaches a position the tree hasn\'t seen before, then plays the rest of the battle out. Turns are full turns; decisions also count switch-ins after a faint or a pivot move.">';
			buf += '<strong>Depth:</strong> each iteration followed the tree ' + turns + ' turns ahead on average (' + (tree.plies / iterations).toFixed(1) + ' decisions, at most ' + tree.deepest + ' turns), then played ' + played + ' more turns ' + (analysis.playout === 'random' ? 'with random choices' : 'with each side using its most damaging move') + '. ';
			buf += (tree.capped ? count(tree.capped) + ' (' + percent(tree.capped, iterations) + ') stopped at the ' + analysis.cap + '-turn cap and the rest reached the end of the battle.' : 'Every one reached the end of the battle before the ' + analysis.cap + '-turn cap.') + '</p>';
			if (tree.cheap) {
				var shifts = [];
				for (var key in tree.correction) {
					var entry = tree.correction[key];
					if (entry.n) shifts.push(Math.abs(entry.sum / entry.n));
				}
				var shift = shifts.length ? shifts.reduce(function (a, b) { return a + b; }) / shifts.length : 0;
				buf += '<p title="The fast model plays turns with numbers measured from the exact sim. Some playouts are also played exactly from the same position, and the average difference for each choice corrects the fast results.">';
				buf += '<strong>Playouts:</strong> ' + count(tree.cheap) + ' in the fast model and ' + count(tree.exact) + ' in the exact sim; the exact ones differed from the fast ones by ' + shift.toFixed(3) + ' on average.</p>';
			}
			var levels = [];
			for (var m = 0; m < tree.levels.length; m++) levels.push((m + 1) + ': ' + count(tree.levels[m]));
			buf += '<p title="The search keeps one tree per guess of your hidden information (your unrevealed Pok&eacute;mon, moves, items and spreads). Each position is one combination of both sides\' choices from the one before it. Few positions far ahead means the search only looked deep along its main lines.">';
			buf += '<strong>Breadth:</strong> ' + count(tree.nodes) + ' positions in ' + analysis.guesses + ' trees, one per guess of your team. Positions by decisions ahead: ' + levels.join(' &middot; ') + '. ';
			buf += '<span title="The number of equally tried choices that would spread the iterations as evenly as they were actually spread (e to the power of the entropy of the shares). Close to the number of choices means the search could hardly tell them apart; close to 1 means it settled on one.">Its ' + options.length + ' choices got iterations like ' + Math.exp(entropy).toFixed(1) + ' equally tried ones.</span></p>';
			buf += '<table style="border-collapse:collapse;margin:4px 0"><tr><th style="text-align:left;padding-right:12px">Its choice</th><th style="padding-right:12px" title="Share of the iterations that started with this choice. The bot plays the most tried choice.">Tried</th><th title="' + scoreTitle + '">Score</th></tr>';
			for (var n = 0; n < options.length; n++) {
				var option = options[n];
				var label = BattleLog.escapeHTML(option.label);
				buf += '<tr><td style="padding-right:12px">' + (option.choice === data.choice ? '<strong>' + label + '</strong>' : label) + '</td>';
				buf += '<td style="text-align:right;padding-right:12px" title="' + count(option.n) + ' iterations">' + percent(option.n, total) + '</td>';
				buf += '<td style="text-align:right" title="' + scoreTitle + '">' + (option.n ? (option.w / option.n).toFixed(3) : '-') + '</td></tr>';
			}
			buf += '</table>';
			if (foe.length) {
				var expected = [];
				for (var q = 0; q < foe.length; q++) {
					expected.push('<span title="' + count(foe[q].n) + ' iterations">' + BattleLog.escapeHTML(foe[q].label) + ' ' + percent(foe[q].n, foeTotal) + '</span>');
				}
				buf += '<p title="The search chooses for you too, picking what looks best for you in each line, so these shares are how often it expected each of your choices. Switches to Pok&eacute;mon you haven\'t shown yet are grouped together."><strong>What it expected from you:</strong> ' + expected.join(', ') + '</p>';
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
			'change input[name=analysis]': 'toggleAnalysis',
			'click label[data-explain]': 'explain'
		},
		initialize: function () {
			Bot.room = this;
			this.$el.addClass('ps-room-light').addClass('scrollable');
			this.curFormat = Storage.prefs('botformat') || app.rooms[''].curFormat || 'gen7ifrandombattle';
			this.data = null;
			this.open = {};
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
			buf += '<p title="After each turn plays out, add a line to the battle log with how many iterations the bot\'s search ran, how many turns ahead and how widely it looked, how it rated each of its choices and what it expected from you. It only appears once the turn is over, so it never gives away the bot\'s choice."><label><input type="checkbox" name="analysis"' + (Storage.prefs('botanalysis') !== false ? ' checked' : '') + ' /> Show what the bot\'s search did after each turn</label></p>';

			buf += '<details data-open="advanced"' + (this.open.advanced ? ' open' : '') + ' style="margin-top:12px"><summary title="Every other setting, for fine-tuning how the bot searches and guesses your team."><h3 style="display:inline">Advanced</h3> <small style="color:#888" data-gist="advanced"></small></summary>';
			buf += '<div data-advanced>';
			buf += '<p><input type="search" name="filter" class="textbox" placeholder="Filter settings" value="' + BattleLog.escapeHTML(this.query) + '" title="Show only settings whose name contains this." /> ';
			buf += '<label title="Show only settings changed from their defaults."><input type="checkbox" name="changedOnly"' + (this.changedOnly ? ' checked' : '') + ' /> Changed only</label> ';
			buf += '<button class="button" name="expandAll" title="Open every section and group.">Expand all</button> <button class="button" name="collapseAll" title="Close every section and group, back to one line each.">Collapse all</button></p>';
			for (var k = 0; k < data.sections.length; k++) {
				var section = data.sections[k];
				var groups = this.groups(section);
				if (!groups.length) continue;
				buf += '<details data-open="section:' + BattleLog.escapeHTML(section.section) + '"' + (this.open['section:' + section.section] ? ' open' : '') + '>';
				buf += '<summary title="' + BattleLog.escapeHTML(section.title) + '"><strong>' + BattleLog.escapeHTML(section.section) + '</strong> <small style="color:#888" data-gist="section:' + BattleLog.escapeHTML(section.section) + '"></small></summary>';
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
			return this.renderBlocks(group.settings);
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
			if (view === 'seconds') return value / 1000 + ' seconds';
			return '' + value;
		},
		view: function (setting) {
			if (setting.key === 'time' || setting.key === 'ponder') return 'seconds';
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
				self.$('label[data-explain="' + key + '"]').each(function () {
					var text = BattleLog.escapeHTML($(this).text());
					$(this).html(self.changed(setting) ? '<em>' + text + '</em>' : text);
				});
				self.$('button[name=resetSetting][value="' + key + '"]').css('display', self.changed(setting) ? '' : 'none');
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
			var $advanced = this.$('[data-advanced]');
			$advanced.find('[data-row]').each(function () {
				var setting = self.find($(this).attr('data-row'));
				var shown = (!query || toID(setting.label).indexOf(query) >= 0 || toID(setting.key).indexOf(query) >= 0) &&
					(!self.changedOnly || self.changed(setting));
				this.style.display = shown ? '' : 'none';
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
		toggleAnalysis: function (e) {
			Storage.prefs('botanalysis', $(e.currentTarget).is(':checked') ? null : false);
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
		format: function (format, button) {
			var self = this;
			app.addPopup(FormatPopup, {format: format, sourceEl: button, selectType: 'challenge', onselect: function (format) {
				self.saveOpen();
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
