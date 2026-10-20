import { Config, PS, PSRoom, type PSConfig, type RoomID, type RoomOptions, type Team } from "./client-main";
import { PSPanelWrapper, PSRoomPanel } from "./panels";
import { FormatDropdown, MainMenuRoom } from "./panel-mainmenu";
import { TeamBox } from "./panel-teamdropdown";
import { BattleRoom } from "./panel-battle";
import { BattleLog } from "./battle-log";
import { toID } from "./battle-dex";
import type { Args } from "./battle-text-parser";

type BotSetting = {
	key: string, label: string, type: 'range' | 'select' | 'checkbox', default: any,
	min: number, max: number, step: number, options?: { [value: string]: string },
	basic?: boolean, hidden?: boolean, title?: string,
};
type BotGroup = { group: string, bot?: string, title?: string, settings: BotSetting[] };
type BotSection = { section: string, groups: string[], title?: string };
type BotSchema = {
	format: string, error?: string, threads: number, available: number,
	schema: BotGroup[], sections: BotSection[], defaults: { [key: string]: any },
};
type BotDecision = { room: RoomID, turn: number, choice: string, iterations: number, time: number, analysis?: any };

export const PSBot = new class {
	url = (Config as PSConfig & { botURL?: string }).botURL || 'https://bot.pokeathlon.com/';
	frame: HTMLIFrameElement | null = null;
	loaded = false;
	queue: any[] = [];
	name = '';
	format = '';
	pending: { format: string, team?: Team, sheets: boolean } | null = null;
	team = '';
	resuming = false;
	status = '';
	overrides: { [key: string]: any } | null = null;
	botTeam = '';
	analyses: { [roomid: string]: BotDecision[] } = {};
	battles: { [roomid: string]: true } = {};
	frameThreads = 0;
	saveTimer: ReturnType<typeof setTimeout> | null = null;
	pref(key: string) {
		return PS.prefs.storage[key];
	}
	setPref(key: string, value: any) {
		if (value === null || value === undefined) {
			delete PS.prefs.storage[key];
		} else {
			PS.prefs.storage[key] = value;
		}
		PS.prefs.save();
	}
	post(message: any) {
		if (!this.frame) {
			this.frameThreads = this.pref('botthreads') || 0;
			this.frame = document.createElement('iframe');
			this.frame.title = 'Bot';
			this.frame.style.display = 'none';
			this.frame.src = `${this.url}live.html${this.frameThreads ? `?threads=${this.frameThreads}` : ''}`;
			document.body.appendChild(this.frame);
		}
		if (!this.loaded) {
			this.queue.push(message);
			return;
		}
		this.frame.contentWindow!.postMessage(message, new URL(this.url, location.href).origin);
	}
	receive = (e: MessageEvent) => {
		if (!this.frame || e.source !== this.frame.contentWindow || !e.data?.bot) return;
		const data = e.data.data;
		switch (e.data.type) {
		case 'loaded':
			this.loaded = true;
			for (const message of this.queue.splice(0)) this.post(message);
			break;
		case 'ready':
			this.resuming = false;
			this.format = data.format;
			if (data.name) this.name = data.name;
			this.challenge();
			break;
		case 'name':
			this.name = data;
			this.challenge();
			break;
		case 'schema':
			(PS.rooms['bot'] as BotRoom | undefined)?.load(data);
			(PS.rooms['botsettings'] as BotRoom | undefined)?.load(data);
			break;
		case 'thinking':
			this.post({ type: 'choosing', room: data.room, value: this.choosing(data.room) });
			break;
		case 'decided':
			if (data.analysis && this.pref('botanalysis') !== false) (this.analyses[data.room] ||= []).push(data);
			if (data.iterations && data.time > 250) {
				const speed = data.iterations / data.time * 1000;
				const previous = this.pref('botspeed');
				this.setPref('botspeed', Math.round(previous ? previous * 0.7 + speed * 0.3 : speed));
				const tree = data.analysis?.tree;
				if (tree) this.shape({ turns: tree.turns / data.iterations, horizon: tree.playoutTurns / data.iterations }, 0.3);
				PS.rooms['botsettings']?.update(null);
			}
			break;
		case 'bench': {
			if (data.speed) this.setPref('botspeed', Math.round(data.speed));
			if (data.search) this.shape(data.search, 1);
			const known = this.device();
			if (data.device) this.setPref('botdevice', Math.round(data.device));
			const room = PS.rooms['botsettings'] as BotSettingsRoom | undefined;
			if (!room) break;
			room.measuring = false;
			if (data.device && Math.round(data.device) !== known) this.requestSchema(room.format);
			room.update(null);
			break;
		}
		case 'battle':
			this.battles[data.room] = true;
			this.remember(data.room, data.format);
			this.setStatus('');
			if (PS.rooms['bot']) PS.leave('bot' as RoomID);
			break;
		case 'notice': case 'error': {
			const message = `${data.message || data}`.split('\n')[0];
			const battleRoom = data.room && PS.rooms[data.room];
			if (battleRoom instanceof BattleRoom) {
				battleRoom.add(`|error|Bot: ${message}`);
			} else {
				this.report(message);
			}
			break;
		}
		case 'rename':
			if (this.battles[data.from]) this.battles[data.room] = this.battles[data.from];
			if (this.analyses[data.from]) this.analyses[data.room] = this.analyses[data.from];
			delete this.battles[data.from];
			delete this.analyses[data.from];
			this.forget(data.from, data.room);
			break;
		case 'end':
			delete this.battles[data.room];
			this.forget(data.room);
			this.reload();
			break;
		case 'closed':
			this.battles = {};
			this.name = '';
			this.report("The bot disconnected.");
			break;
		}
	};
	requestSchema(format: string) {
		this.post({ type: 'schema', format, speed: this.device() });
	}
	start(format: string, team: Team | undefined, botTeam: Team | undefined, sheets: boolean) {
		this.pending = { format, team, sheets };
		this.format = '';
		this.team = botTeam?.packedTeam || '';
		this.setPref('botformat', format);
		this.launch(format, this.team, '');
		this.setStatus(this.loaded ? "Starting the bot..." : "Loading the bot (this can take a while the first time)...");
	}
	launch(format: string, team: string, name: string) {
		void PS.mainmenu.makeQuery('pokeathlete').then(key => {
			if (!key) return this.report("This server doesn't allow bots.");
			const server = PS.server;
			const port = server.protocol === 'https' ? server.port : server.httpport || server.port;
			this.post({
				type: 'start', url: `${server.protocol === 'https' ? 'wss' : 'ws'}://${server.host}:${port}${server.prefix}/websocket`,
				owner: PS.user.userid, key, format, team, name, settings: this.settings(), speed: this.device(), ask: true,
			});
		});
	}
	resume(games: { [roomid: string]: string }) {
		if (!PS.user.named) return;
		const saved = this.pref('botbattles') || {};
		const kept: typeof saved = {};
		let waiting = null;
		for (const id in saved) {
			if (!games[id]) continue;
			kept[id] = saved[id];
			if (!this.battles[id]) waiting = saved[id];
		}
		this.setPref('botbattles', Object.keys(kept).length ? kept : null);
		if (!waiting || this.resuming) return;
		this.resuming = true;
		this.launch(waiting.format, waiting.team, waiting.name);
	}
	remember(id: string, format: string) {
		const saved = this.pref('botbattles') || {};
		saved[id] ||= { format, team: this.team, name: this.name };
		this.setPref('botbattles', saved);
	}
	forget(id: string, renamed?: string) {
		const saved = this.pref('botbattles') || {};
		if (renamed && saved[id]) saved[renamed] = saved[id];
		delete saved[id];
		this.setPref('botbattles', Object.keys(saved).length ? saved : null);
	}
	challenge() {
		const pending = this.pending;
		if (!pending || !this.name || this.format !== pending.format) return;
		this.pending = null;
		this.setStatus(`Challenging ${this.name}...`);
		PS.send(`/utm ${pending.team?.packedTeam || ''}`);
		PS.send(`/challenge ${this.name}, ${pending.format}${pending.sheets ? '@@@Show Team Sheets' : ''}`);
	}
	settings() {
		if (!this.overrides) {
			this.overrides = JSON.parse(JSON.stringify(this.pref('botsettings') || {}));
			for (const key of ['ponder', 'foeExploration', 'infer', 'evStep', 'particles', 'method', 'worlds']) {
				delete this.overrides![key];
			}
		}
		return this.overrides!;
	}
	set(setting: BotSetting, value: any) {
		const overrides = this.settings();
		const parts = setting.key.split('.');
		const target = parts.length > 1 ? (overrides[parts[0]] ||= {}) : overrides;
		const last = parts[parts.length - 1];
		if (value === undefined || JSON.stringify(value) === JSON.stringify(setting.default)) {
			delete target[last];
			if (parts.length > 1 && !Object.keys(target).length) delete overrides[parts[0]];
		} else {
			target[last] = value;
		}
		this.save();
	}
	save() {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			const settings = this.settings();
			this.setPref('botsettings', Object.keys(settings).length ? settings : null);
			if (this.frame) this.post({ type: 'config', settings });
			(PS.rooms['botsettings'] as BotSettingsRoom | undefined)?.saved();
		}, 150);
		PS.rooms['bot']?.update(null);
		PS.rooms['botsettings']?.update(null);
	}
	reload() {
		if (!this.frame || (this.pref('botthreads') || 0) === this.frameThreads || Object.keys(this.battles).length) return;
		this.frame.remove();
		this.frame = null;
		this.loaded = false;
		this.name = '';
		this.format = '';
		const room = PS.rooms['botsettings'] as BotSettingsRoom | undefined;
		room?.setFormat(room.format);
	}
	shape(search: { turns: number, horizon: number }, weight: number) {
		const previous = this.pref('botsearch');
		this.setPref('botsearch', previous && weight < 1 ? {
			turns: previous.turns * (1 - weight) + search.turns * weight,
			horizon: previous.horizon * (1 - weight) + search.horizon * weight,
		} : search);
	}
	device() {
		return +this.pref('botdevice') || 0;
	}
	choosing(id: RoomID) {
		const room = PS.rooms[id];
		return !!(room instanceof BattleRoom && room.request && room.request.requestType !== 'wait' &&
			!room.choices?.isDone() && !room.battle?.ended);
	}
	battle(format: string, teamKey: string, botTeamKey: string, sheets: boolean) {
		const team = PS.teams.byKey[teamKey];
		const botTeam = PS.teams.byKey[botTeamKey];
		if (!PS.user.named) {
			PS.join('login' as RoomID);
			return;
		}
		if (!window.BattleFormats[PS.teams.teambuilderFormat(format)]?.team && (!team || !botTeam)) {
			this.setStatus("Pick a team for yourself and for the bot.");
			return;
		}
		this.botTeam = botTeamKey;
		void Promise.all([PS.teams.loadTeam(team), PS.teams.loadTeam(botTeam)]).then(() => {
			this.start(format, team, botTeam, sheets);
		});
	}
	setStatus(status: string) {
		this.status = status;
		PS.rooms['bot']?.update(null);
	}
	report(message: string) {
		if (PS.rooms['bot']) return this.setStatus(message);
		PS.alert(`Bot: ${message}`);
	}
	renderAnalysis(data: BotDecision) {
		const analysis = data.analysis;
		const tree = analysis.tree;
		const iterations = analysis.iterations || 1;
		const count = (n: number) => Math.round(n).toLocaleString('en-US');
		const percent = (n: number, total: number) => `${total ? Math.round(100 * n / total) : 0}%`;
		const byVisits = (a: { n: number }, b: { n: number }) => b.n - a.n;
		const row = (label: string, value: string) =>
			`<tr><th style="text-align:left;font-weight:normal;padding-right:12px">${label}</th><td>${value}</td></tr>`;
		const options: { choice: string, label: string, n: number, w: number }[] = analysis.options.slice().sort(byVisits);
		const foe: { label: string, n: number }[] = analysis.foe.slice().sort(byVisits);
		const total = options.reduce((sum, option) => sum + option.n, 0);
		const foeTotal = foe.reduce((sum, option) => sum + option.n, 0);
		const chosen = options.find(option => option.choice === data.choice);
		const score = (option: { n: number, w: number }) => option.n ? (option.w / option.n).toFixed(3) : '-';

		let buf = '<div class="infobox"><details><summary>';
		buf += `<strong>Bot, turn ${data.turn}:</strong> ${BattleLog.escapeHTML(chosen ? chosen.label : data.choice)} &middot; `;
		buf += `${count(analysis.iterations)} routes &middot; ${(analysis.time / 1000).toFixed(1)} s</summary>`;
		buf += '<table style="border-collapse:collapse;margin:4px 0">';
		const turns = (tree.turns / iterations).toFixed(1);
		const plies = (tree.plies / iterations).toFixed(1);
		buf += row('Branching depth', `${turns} turns (${plies} decisions, max ${tree.deepest} turns)`);
		buf += row('Look-ahead', `${(tree.playoutTurns / iterations).toFixed(1)} turns`);
		buf += row('Simulated turns', count(tree.playoutTurns));
		buf += row('At turn cap', `${percent(tree.capped, iterations)} (cap ${analysis.cap})`);
		if (analysis.method === 'oos') buf += row('Method', 'Online outcome sampling');
		buf += '</table>';
		if (chosen) {
			const mixed = analysis.method === 'oos' && analysis.strategy;
			const priors = analysis.priors;
			buf += `<details style="margin:4px 0"><summary><strong>Choices:</strong> ${BattleLog.escapeHTML(chosen.label)} &middot; `;
			buf += `tried ${percent(chosen.n, total)} &middot; score ${score(chosen)}</summary>`;
			buf += '<table style="border-collapse:collapse;margin:4px 0"><tr><th style="text-align:left;padding-right:12px">Bot</th>';
			buf += '<th style="text-align:left;padding-right:12px">Tried</th><th>Score</th>';
			if (mixed) buf += '<th style="padding-left:12px">Chance</th>';
			if (priors) buf += '<th style="padding-left:12px">Prior</th>';
			buf += '</tr>';
			for (const option of options) {
				const label = BattleLog.escapeHTML(option.label);
				buf += `<tr><td style="padding-right:12px">${option === chosen ? `<strong>${label}</strong>` : label}</td>`;
				buf += `<td style="padding-right:12px;white-space:nowrap"><span style="display:inline-block;height:8px;width:${Math.max(1, Math.round(80 * option.n / (total || 1)))}px;background:currentColor;opacity:.45;vertical-align:middle"></span> ${percent(option.n, total)}</td>`;
				buf += `<td style="text-align:right">${score(option)}</td>`;
				if (mixed) buf += `<td style="text-align:right;padding-left:12px">${percent(mixed[option.choice] || 0, 1)}</td>`;
				if (priors) buf += `<td style="text-align:right;padding-left:12px">${percent(priors[option.choice] || 0, 1)}</td>`;
				buf += '</tr>';
			}
			buf += '</table></details>';
		}
		if (foe.length) {
			const expected = foe.map(option => `${BattleLog.escapeHTML(option.label)} ${percent(option.n, foeTotal)}`);
			buf += `<p><strong>Expected from you:</strong> ${expected.join(' &middot; ')}</p>`;
		}
		const line: { turn: number, foe?: string, me?: string }[] = analysis.line || [];
		if (line.length) {
			buf += `<details style="margin:4px 0"><summary><strong>Route:</strong> turn ${line[0].turn} &middot; `;
			buf += `you: ${BattleLog.escapeHTML(line[0].foe || '-')} &middot; bot: ${BattleLog.escapeHTML(line[0].me || '-')}</summary>`;
			buf += '<table style="border-collapse:collapse;margin:4px 0"><tr><th style="text-align:left;padding-right:12px">Turn</th>';
			buf += '<th style="text-align:left;padding-right:12px">You</th><th style="text-align:left">Bot</th></tr>';
			for (const step of line) {
				buf += `<tr><td style="padding-right:12px">${step.turn}</td><td style="padding-right:12px">${BattleLog.escapeHTML(step.foe || '-')}</td>`;
				buf += `<td>${BattleLog.escapeHTML(step.me || '-')}</td></tr>`;
			}
			buf += '</table></details>';
		}
		buf += '</details></div>';
		return buf;
	}
};

class BotRoom extends PSRoom {
	override readonly classType: string = 'bot';
	format = '';
	data: BotSchema | null = null;
	threads: number | null = null;
	load(data: BotSchema) {
		if (data.format !== this.format) return;
		this.data = data;
		this.update(null);
	}
}

class BotPopupRoom extends BotRoom {
	fromSettings = false;
	team = '';
	botTeam = '';
	sheets = !!PSBot.pref('botsheets');
	constructor(options: RoomOptions) {
		super(options);
		this.fromSettings = !!options.args?.fromSettings;
		const menuFormat = this.parentElem?.closest('form')?.querySelector<HTMLButtonElement>('button[name=format]')?.value;
		this.setFormat(toID(options.args?.format as string || menuFormat || PSBot.pref('botformat') || 'gen7ifrandombattle'));
	}
	setFormat(format: string) {
		this.format = format;
		this.data = null;
		const teamFormat = PS.teams.teambuilderFormat(format);
		const teams = PS.teams.list.filter(team => !team.isBox && team.format === teamFormat);
		this.team = teams[0]?.key || '';
		this.botTeam = PS.teams.byKey[PSBot.botTeam] ? PSBot.botTeam : (teams[1] || teams[0])?.key || '';
		if (!this.fromSettings) PSBot.requestSchema(format);
	}
	override destroy() {
		PSBot.pending = null;
		PSBot.status = '';
		super.destroy();
	}
}

class BotSettingsRoom extends BotRoom {
	override readonly classType: string = 'botsettings';
	measuring = false;
	benched = '';
	showSaved = false;
	savedTimer: ReturnType<typeof setTimeout> | null = null;
	benchTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(options: RoomOptions) {
		super(options);
		this.setFormat(PSBot.pref('botformat') || 'gen7ifrandombattle');
	}
	setFormat(format: string) {
		this.format = format;
		this.data = null;
		PSBot.requestSchema(format);
		this.update(null);
	}
	override load(data: BotSchema) {
		if (data.format !== this.format) return;
		const fresh = !this.data;
		if (!fresh && JSON.stringify(data) === JSON.stringify(this.data)) return;
		this.data = data;
		this.benched = this.costs();
		if (fresh && !data.error && !Object.keys(PSBot.battles).length) this.measure(true);
		this.update(null);
	}
	costs() {
		return JSON.stringify({ ...PSBot.settings(), time: undefined });
	}
	saved() {
		this.showSaved = true;
		if (this.savedTimer) clearTimeout(this.savedTimer);
		this.savedTimer = setTimeout(() => {
			this.showSaved = false;
			this.update(null);
		}, 1500);
		if (this.costs() !== this.benched && !Object.keys(PSBot.battles).length) {
			this.measuring = true;
			if (this.benchTimer) clearTimeout(this.benchTimer);
			this.benchTimer = setTimeout(() => this.measure(false), 600);
		}
		this.update(null);
	}
	measure(full: boolean) {
		this.measuring = true;
		this.benched = this.costs();
		PSBot.post({ type: 'bench', format: this.format, settings: PSBot.settings(), speed: PSBot.device(), reference: full });
		this.update(null);
	}
}

class BotControlsPanel<T extends BotRoom> extends PSRoomPanel<T> {
	find(key: string): BotSetting | null {
		const data = this.props.room.data;
		if (!data?.schema) return null;
		if (key === 'threads') {
			return {
				key: 'threads', label: 'Power usage (Threads)', type: 'range',
				min: 1, max: data.available, step: 1, default: data.available,
			};
		}
		for (const group of data.schema) {
			for (const setting of group.settings) {
				if (setting.key === key) return setting;
			}
		}
		return null;
	}
	value(key: string) {
		const data = this.props.room.data!;
		if (key === 'threads') return PSBot.pref('botthreads') || data.available;
		const overrides = PSBot.settings();
		const parts = key.split('.');
		const override = parts.length > 1 ? overrides[parts[0]]?.[parts[1]] : overrides[key];
		if (override !== undefined) return override;
		return parts.length > 1 ? data.defaults[parts[0]][parts[1]] : data.defaults[key];
	}
	changed(setting: BotSetting) {
		return JSON.stringify(this.value(setting.key)) !== JSON.stringify(setting.default);
	}
	toView(setting: BotSetting, raw: number) {
		return setting.key === 'time' ? raw / 1000 : raw;
	}
	fromView(setting: BotSetting, shown: number) {
		const raw = setting.key === 'time' ? Math.round(shown * 1000) : shown;
		return Math.max(setting.min, Math.min(setting.max, raw));
	}
	changeSetting = (e: Event) => {
		const input = e.currentTarget as HTMLInputElement;
		const setting = this.find(input.name);
		if (!setting) return;
		let value;
		if (input.type === 'checkbox') {
			value = input.checked;
		} else if (setting.type === 'select') {
			value = input.value;
		} else {
			if (input.value === '' || isNaN(+input.value)) return;
			value = this.fromView(setting, +input.value);
		}
		if (setting.key !== 'threads') {
			PSBot.set(setting, value);
		} else if (e.type === 'change') {
			this.setThreads(value as number);
		} else {
			this.props.room.threads = value as number;
			this.forceUpdate();
		}
	};
	resetSetting = (e: Event) => {
		const setting = this.find((e.currentTarget as HTMLButtonElement).value);
		if (!setting) return;
		if (setting.key === 'threads') {
			this.setThreads(setting.default);
		} else {
			PSBot.set(setting, undefined);
		}
	};
	setThreads(threads: number) {
		const available = this.props.room.data!.available;
		threads = Math.min(Math.max(Math.round(threads) || 1, 1), available);
		const speed = PSBot.pref('botspeed');
		if (speed) PSBot.setPref('botspeed', Math.round(speed * threads / (PSBot.pref('botthreads') || available)));
		PSBot.setPref('botthreads', threads === available ? null : threads);
		this.props.room.threads = null;
		PSBot.reload();
		PS.rooms['bot']?.update(null);
		PS.rooms['botsettings']?.update(null);
	}
	renderLabel(setting: BotSetting, text = setting.label) {
		return <label title={setting.title}>{this.changed(setting) ? <em>{text}</em> : text}</label>;
	}
	renderReset(setting: BotSetting) {
		if (!this.changed(setting)) return null;
		return <button type="button" class="button bot-reset" value={setting.key} onClick={this.resetSetting}>
			<i class="fa fa-undo" aria-hidden></i>
		</button>;
	}
	renderRange(setting: BotSetting, rangeStyle: string, numberWidth: number) {
		const value = this.toView(setting, setting.key === 'threads' && this.props.room.threads || this.value(setting.key));
		const step = setting.key === 'time' ? 0.1 : setting.step;
		const min = this.toView(setting, setting.min);
		const max = this.toView(setting, setting.max);
		return <>
			<input
				type="range" name={setting.key} min={min} max={max} step={step} value={value}
				style={`${rangeStyle};vertical-align:middle`} onInput={this.changeSetting} onChange={this.changeSetting}
			/> {}
			<input
				type="number" class="textbox" name={setting.key} min={min} max={max} step={step} value={value}
				style={`width:${numberWidth}px`} onChange={this.changeSetting}
			/>
			{setting.key === 'time' && <> <small>s</small></>}
		</>;
	}
	renderSelect(setting: BotSetting, style: string) {
		const value = `${this.value(setting.key)}`;
		return <select class="button" name={setting.key} style={style} onChange={this.changeSetting}>
			{Object.entries(setting.options || {}).map(([option, label]) => (
				<option value={option} selected={option === value}>{label}</option>
			))}
		</select>;
	}
	renderThreadsNote() {
		const threads = this.value('threads');
		if (threads === this.props.room.data!.threads) return null;
		return <p><small class="bot-note">Threads after your battle: {threads}</small></p>;
	}
}

class BotPanel extends BotControlsPanel<BotPopupRoom> {
	static readonly id = 'bot';
	static readonly routes = ['bot'];
	static readonly Model = BotPopupRoom;
	static readonly location = 'modal-popup';
	static readonly noURL = true;
	changeFormat = (e: Event) => {
		PSBot.botTeam = '';
		this.props.room.setFormat(toID((e.target as HTMLButtonElement).value));
		this.forceUpdate();
	};
	changeTeam = (e: Event) => {
		const button = e.currentTarget as HTMLButtonElement;
		if (button.name === 'botTeam') {
			this.props.room.botTeam = button.value;
		} else {
			this.props.room.team = button.value;
		}
		this.forceUpdate();
	};
	toggleAnalysis = (e: Event) => {
		PSBot.setPref('botanalysis', (e.currentTarget as HTMLInputElement).checked ? null : false);
		this.forceUpdate();
	};
	toggleSheets = (e: Event) => {
		this.props.room.sheets = (e.currentTarget as HTMLInputElement).checked;
	};
	openSettings = () => {
		const room = this.props.room;
		PSBot.setPref('botformat', room.format);
		this.close();
		(PS.rooms['botsettings'] as BotSettingsRoom | undefined)?.setFormat(room.format);
		PS.join('botsettings' as RoomID);
	};
	submit = (e: Event) => {
		e.preventDefault();
		const room = this.props.room;
		PSBot.setPref('botsheets', room.sheets || null);
		PSBot.battle(room.format, room.team, room.botTeam, room.sheets);
	};
	renderTeam(name: string, key: string, teamFormat: string) {
		if (window.BattleFormats?.[teamFormat]?.team) {
			return <button type="button" class="select teamselect preselected" name={name} value="random" disabled>
				<div class="team"><strong>Random team</strong></div>
			</button>;
		}
		return <button
			type="button" class="select teamselect" name={name} value={key}
			data-href="/teamdropdown" data-format={teamFormat} onChange={this.changeTeam}
		>
			<TeamBox team={PS.teams.byKey[key] || null} noLink />
		</button>;
	}
	renderStrength() {
		const data = this.props.room.data;
		if (!data) return <p><em>Loading the bot...</em></p>;
		if (data.error) return <p class="message-error">{data.error}</p>;
		return <>
			{[this.find('time')!, this.find('threads')!].map(setting => <p>
				<span class="label">{this.renderLabel(setting, `${setting.label}:`)}</span>
				{this.renderRange(setting, 'width:110px', 52)} {this.renderReset(setting)}
			</p>)}
			{this.renderThreadsNote()}
		</>;
	}
	override render() {
		const room = this.props.room;
		const teamFormat = PS.teams.teambuilderFormat(room.format);
		return <PSPanelWrapper room={room} width={380}><div class="pad"><form class="botform" onSubmit={this.submit}>
			<p><label class="label">
				Format:<br />
				<FormatDropdown selectType="challenge" format={room.format} onChange={this.changeFormat} />
			</label></p>
			<p><label class="label">Your team:<br />{this.renderTeam('team', room.team, teamFormat)}</label></p>
			<p><label class="label">Bot's team:<br />{this.renderTeam('botTeam', room.botTeam, teamFormat)}</label></p>
			{!room.fromSettings && this.renderStrength()}
			<p><label class="checkbox">
				<input type="checkbox" checked={PSBot.pref('botanalysis') !== false} onChange={this.toggleAnalysis} /> Show bot logs
			</label></p>
			<p><label
				class="checkbox"
				title="You and the bot see each other's Pokémon, moves, items, abilities and Tera Types from the start"
			>
				<input type="checkbox" checked={room.sheets} onChange={this.toggleSheets} /> Open team sheets
			</label></p>
			{!!PSBot.status && <p>{PSBot.status}</p>}
			<p class="buttonbar">
				<button type="submit" class="button"><strong>Battle!</strong></button> {}
				{!room.fromSettings && <><button type="button" class="button" onClick={this.openSettings}>
					<i class="fa fa-cog" aria-hidden></i> Bot settings
				</button> </>}
				<button type="button" name="closeRoom" class="button">Cancel</button>
			</p>
		</form></div></PSPanelWrapper>;
	}
}

class BotSettingsPanel extends BotControlsPanel<BotSettingsRoom> {
	static readonly id = 'botsettings';
	static readonly routes = ['botsettings'];
	static readonly Model = BotSettingsRoom;
	static readonly icon = <i class="fa fa-cog" aria-hidden></i>;
	static readonly title = 'Bot settings';
	changeFormat = (e: Event) => {
		this.props.room.setFormat(toID((e.target as HTMLButtonElement).value));
	};
	resetAll = () => {
		PSBot.overrides = {};
		PSBot.save();
	};
	openBattle = (e: Event) => {
		PS.join('bot' as RoomID, {
			args: { format: this.props.room.format, fromSettings: true },
			parentElem: e.currentTarget as HTMLElement,
		});
	};
	groups(section: BotSection) {
		const groups: BotGroup[] = [];
		for (const group of this.props.room.data!.schema) {
			if (!section.groups.includes(group.group) || (group.bot && group.bot !== 'mcts')) continue;
			const settings = group.settings.filter(setting => !setting.basic && !setting.hidden);
			if (settings.length) groups.push({ ...group, settings });
		}
		return groups;
	}
	renderTable(settings: BotSetting[]) {
		return <table class="bot-table">{settings.map(setting => <tr>
			<th>{this.renderLabel(setting)}</th>
			<td>
				{setting.type === 'select' ? (
					this.renderSelect(setting, 'max-width:48vw')
				) : setting.type === 'checkbox' ? (
					<input type="checkbox" name={setting.key} checked={!!this.value(setting.key)} onChange={this.changeSetting} />
				) : (
					this.renderRange(setting, 'width:140px;max-width:30vw', 64)
				)} {this.renderReset(setting)}
			</td>
		</tr>)}</table>;
	}
	renderBlocks(settings: BotSetting[]) {
		const blocks = [];
		let rows: BotSetting[] = [];
		for (let i = 0; i < settings.length; i++) {
			let run = 1;
			while (
				settings[i].type === 'select' && settings[i + run]?.type === 'select' &&
				JSON.stringify(settings[i + run].options) === JSON.stringify(settings[i].options)
			) run++;
			if (run < 2) {
				rows.push(settings[i]);
				continue;
			}
			if (rows.length) blocks.push(this.renderTable(rows));
			rows = [];
			blocks.push(<div class="bot-columns">{settings.slice(i, i + run).map(setting => <div>
				{this.renderSelect(setting, 'width:100px')} {this.renderLabel(setting)} {this.renderReset(setting)}
			</div>)}</div>);
			i += run - 1;
		}
		if (rows.length) blocks.push(this.renderTable(rows));
		return blocks;
	}
	renderSpeed() {
		const speed = PSBot.pref('botspeed');
		const search = PSBot.pref('botsearch');
		const time = this.value('time');
		const routes = Math.round(speed * time / 1000 / this.value('determinizations') / 10) * 10;
		let rows = [['Speed', this.props.room.measuring ? 'Measuring...' : 'Not measured']];
		if (!this.props.room.measuring && speed && search) {
			rows = [
				['Routes per guess', `~${routes.toLocaleString()}`],
				['Branching depth', `${search.turns.toFixed(1)} turns`],
				['Look-ahead', `${search.horizon.toFixed(1)} turns`],
				['Simulated turns', `~${(Math.round(speed * time / 1000 * search.horizon / 1000) * 1000).toLocaleString()}`],
			];
		}
		return <table class="bot-table bot-speed">
			{rows.map(([label, value]) => <tr><th>{label}</th><td>{value}</td></tr>)}
		</table>;
	}
	override render() {
		const room = this.props.room;
		const data = room.data;
		return <PSPanelWrapper room={room}><div class="pad botsettings">
			<h2>Bot settings {room.showSaved && <small>Saved</small>}</h2>
			<p>
				<label class="label">Format:</label> {}
				<FormatDropdown selectType="challenge" format={room.format} onChange={this.changeFormat} />
			</p>
			{!data ? (
				<p><em>Loading the bot...</em></p>
			) : data.error ? (
				<p class="message-error">{data.error}</p>
			) : <>
				<h3>Strength</h3>
				<div class="bot-group">
					{this.renderTable([this.find('time')!, this.find('threads')!])}
					{this.renderThreadsNote()}
				</div>
				{data.sections.map(section => {
					const groups = this.groups(section);
					return groups.map(group => <>
						<h3 title={group.title}>{groups.length === 1 ? section.section : group.group}</h3>
						<div class="bot-group">{this.renderBlocks(group.settings)}</div>
					</>);
				})}
				<div class="bot-group">{this.renderSpeed()}</div>
				<p>
					<button class="button" onClick={this.openBattle}><strong>Battle!</strong></button> {}
					<button class="button" onClick={this.resetAll}>Reset to defaults</button>
				</p>
			</>}
		</div></PSPanelWrapper>;
	}
}

BattleRoom.prototype.receiveBatch = (receiveBatch => function (this: BattleRoom, batch: Args[]) {
	const pending = PSBot.analyses[this.id];
	const index = pending?.length ? batch.findIndex(args => ['turn', 'win', 'tie'].includes(args[0])) : -1;
	if (index >= 0) {
		batch = [
			...batch.slice(0, index), ...pending.map(data => ['raw', PSBot.renderAnalysis(data)] as Args), ...batch.slice(index),
		];
		PSBot.analyses[this.id] = [];
	}
	receiveBatch.call(this, batch);
})(BattleRoom.prototype.receiveBatch);

BattleRoom.prototype.sendDirect = (sendDirect => function (this: BattleRoom, msg: string) {
	sendDirect.call(this, msg);
	if (PSBot.frame && /^\/(choose|team)(\s|$)/.test(msg)) PSBot.post({ type: 'choosing', room: this.id, value: false });
})(BattleRoom.prototype.sendDirect);

MainMenuRoom.prototype.receiveSearch = (receiveSearch => function (this: MainMenuRoom, dataBuf: string) {
	receiveSearch.call(this, dataBuf);
	if (this.search) PSBot.resume(this.search.games || {});
})(MainMenuRoom.prototype.receiveSearch);

window.addEventListener('message', PSBot.receive);

PS.addRoomType(BotPanel, BotSettingsPanel);
