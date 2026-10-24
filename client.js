/**
 * dsh-feiyu —— 浏览器半边（DSH 原生设置页）
 *
 * 和 dsh-purge / 官方 dsh-client-ui-* 同一套契约：
 *   · 本文件由 dsh-client-modules 通过 package.json 的 exports["./client"] +
 *     dsh.client 声明发现，用 window.__ModuleLoader__ 包装成客户端模块；
 *   · inject: ["slots"] —— 等 slots 服务就绪再 apply；
 *   · 只注册一个槽位 settings.section，于是「设置」左栏多出一行「大肥鱼」。
 *
 * 所有请求走同源 /dsh-feiyu/api/*，凭据由宿主会话自带，不需要任何 token。
 */
window.__ModuleLoader__.load({
	id: "dsh-feiyu",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;

		const name = "dsh-feiyu";
		const inject = ["slots"];

		// ── 接口层 ────────────────────────────────────────────────────────────
		const API = "/dsh-feiyu/api";

		async function api(path, init) {
			const r = await fetch(API + path, Object.assign({
				cache: "no-store",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
			}, init || {}));
			const text = await r.text();
			let data = {};
			try { data = text ? JSON.parse(text) : {}; } catch {
				throw new Error(r.status + " 非 JSON 响应：" + text.slice(0, 120));
			}
			if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
			return data;
		}

		const PLATFORMS = [
			["bilibili", "B站", "定时养鱼：看视频、写评论、@你"],
			["qq", "QQ", "常驻秒回 + 语音 + 说说", "restart"],
			["wechat", "微信", "替你回消息（工作模式，按联系人分开记）", "restart"],
			["douyin", "抖音", "定时刷视频 + 真发评论 + @人"],
		];

		// ── 少量工具 ──────────────────────────────────────────────────────────
		const section = (prev, patch) => {
			const next = Object.assign({}, prev || {});
			for (const k of Object.keys(patch)) next[k] = patch[k];
			return next;
		};
		const short = (s, n) => {
			const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
			return t.length > n ? t.slice(0, n) + "…" : t;
		};

		// ── 样式（用 DSH 主题变量，浅色/深色都跟着走）──────────────────────────
		const CSS = `
.fy-panel{display:flex;flex-direction:column;gap:14px;padding:2px 0 48px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}
.fy-hero{display:flex;align-items:center;gap:12px}
.fy-avatar{width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:22px;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 8%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent))}
.fy-h1{font-size:15px;font-weight:600;line-height:1.3}
.fy-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#8b95a5);margin-top:2px}
.fy-card{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));border-radius:12px;
  background:var(--dsw-alias-bg-l1,color-mix(in srgb,currentColor 3%,transparent));padding:14px 16px}
.fy-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.fy-card-title{font-size:13px;font-weight:600}
.fy-row{display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap}
.fy-label{min-width:96px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-input,input.fy-input,select.fy-input,textarea.fy-input{background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));color:inherit;border-radius:8px;
  padding:6px 9px;font:inherit;font-size:13px;min-width:0;outline:none}
input.fy-input:focus,select.fy-input:focus,textarea.fy-input:focus{border-color:var(--dsw-alias-brand-primary,#3b6cf6)}
input.fy-input{width:190px}
input.fy-w-md{width:248px}
input.fy-w-sm{width:84px}
select.fy-input{min-width:250px}
textarea.fy-input{width:100%;min-height:136px;resize:vertical;line-height:1.65;font-family:inherit}
.fy-btn{background:transparent;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 26%,transparent));
  color:var(--dsw-alias-label-secondary,#6b7480);border-radius:8px;
  padding:5px 12px;font:inherit;font-size:12.5px;font-weight:400;cursor:pointer;
  transition:background .15s,border-color .15s,color .15s}
.fy-btn:hover{background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-primary,inherit);border-color:color-mix(in srgb,currentColor 40%,transparent)}
.fy-btn:disabled{opacity:.55;cursor:default}
.fy-btn.primary{background:#3b6cf6;border-color:#3b6cf6;color:#fff;font-weight:600;box-shadow:0 1px 3px rgba(59,108,246,.28)}
.fy-btn.primary:hover{background:#2f5be0;color:#fff;border-color:#2f5be0}

.fy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:460px){.fy-grid{grid-template-columns:1fr}}
.fy-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 4%,transparent))}
.fy-sw-name{font-size:12.5px;font-weight:500}
.fy-sw-desc{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#98a2b3);margin-top:2px;line-height:1.4}
.fy-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border-radius:22px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 10%,transparent));transition:background .16s,border-color .16s}
.fy-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-label-tertiary,#9aa4b2);transition:left .16s,background .16s}
.fy-switch.on{background:var(--dsw-alias-brand-primary,#3b6cf6);border-color:var(--dsw-alias-brand-primary,#3b6cf6)}
.fy-switch.on i{left:18px;background:#fff}
.fy-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#98a2b3);line-height:1.65;margin-top:8px}
.fy-stats{display:flex;flex-wrap:wrap;gap:8px}
.fy-chip{font-size:12px;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent))}
.fy-chip b{font-weight:600}
.fy-chip.bad{color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:1px;background:#3fbf6f}
.fy-dot.off{background:#c9564d}
.fy-mem{max-height:232px;overflow:auto;margin-top:8px;font-size:12px;line-height:1.7}
.fy-report{max-height:260px;overflow:auto;margin-top:8px;font-size:12px;line-height:1.7;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));
  border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.fy-mem-item{padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent));
  color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-mem-item b{color:var(--dsw-alias-label-primary,inherit);font-weight:500;margin-right:6px}
.fy-tag{font-size:10.5px;padding:0 6px;border-radius:5px;margin-right:6px;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-tertiary,#98a2b3)}
.fy-notice{font-size:12px;line-height:1.5;padding:8px 12px;border-radius:8px;
  background:color-mix(in srgb,#3b6cf6 14%,transparent);color:var(--dsw-alias-label-primary,inherit)}
.fy-notice.err{background:color-mix(in srgb,#c9564d 16%,transparent)}
.fy-check{font-size:12px;line-height:1.8;margin-top:8px;max-height:200px;overflow:auto}
.fy-check span.ok{color:#3fbf6f}
.fy-check span.no{color:#c9564d}
`;

		function useStyles() {
			useEffect(() => {
				const id = "dsh-feiyu/client";
				if (document.getElementById(id)) return undefined;
				const tag = document.createElement("style");
				tag.id = id;
				tag.dataset.pluginCss = "dsh-feiyu/client";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => { try { tag.remove() } catch { /* ignore */ } };
			}, []);
		}

		// ── 原子组件 ──────────────────────────────────────────────────────────
		function Card(props) {
			return h("section", { className: "fy-card" },
				h("div", { className: "fy-card-head" },
					h("div", { className: "fy-card-title" }, props.title),
					props.extra || null),
				props.children,
				props.hint ? h("div", { className: "fy-hint" }, props.hint) : null);
		}

		function Row(props) {
			return h("div", { className: "fy-row" },
				props.label ? h("span", { className: "fy-label" }, props.label) : null,
				props.children);
		}

		function Switch(props) {
			return h("button", {
				type: "button",
				className: "fy-switch" + (props.on ? " on" : ""),
				role: "switch",
				"aria-checked": props.on ? "true" : "false",
				"aria-label": props.label || "",
				disabled: props.disabled,
				onClick: () => props.onChange(!props.on),
			}, h("i"));
		}

		// ── 主面板 ────────────────────────────────────────────────────────────
		function FeiyuSection() {
			useStyles();

			const [cfg, setCfg] = useState(null);
			const [draft, setDraft] = useState(null);
			const [voices, setVoices] = useState([]);
			const [cfgPath, setCfgPath] = useState("");
			const [persona, setPersona] = useState("");
			const [mem, setMem] = useState(null);
			const [status, setStatus] = useState(null);
			const [svc, setSvc] = useState(null);
			const [selftest, setSelftest] = useState(null);
			const [loading, setLoading] = useState(true);
			const [busy, setBusy] = useState("");
			const [error, setError] = useState("");
			const [notice, setNotice] = useState(null);
			const [report, setReport] = useState("");
			const timer = useRef(0);

			const flash = useCallback((msg, isErr) => {
				setNotice({ msg: msg, err: !!isErr });
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setNotice(null), 2600);
			}, []);

			const toDraft = (c) => {
				const n = (c.night && c.night.windows && c.night.windows[0]) || {};
				return {
					ownerQQ: (c.owner && c.owner.qq) || "",
					ownerMid: (c.owner && c.owner.mid) || "",
					ownerName: (c.owner && c.owner.name) || "",
					ownerWechat: (c.owner && c.owner.wechat) || "",
					nightStart: n.start || "20:00",
					nightEnd: n.end || "24:00",
					nightWakes: n.wakes || 1,
				shareDaily: (c.quota && c.quota.shareDaily) || 3,
				shareOn: !!(c.share && c.share.enabled),
				shareMinScore: (c.share && c.share.minScore) || 13,
				douyinCount: (c.douyin && c.douyin.maxPerRun) || 2,
				douyinAt: !!(c.douyin && c.douyin.atMention),
					voiceChance: (c.qq && c.qq.voice_chance) || 0,
					voicePath: (c.voice && c.voice.ref_audio_path) || "",
					wxRhythm: (c.wechat && c.wechat.rhythm) || "fast",
					wxMerge: (c.wechat && c.wechat.merge_window_sec) || 3,
					wxContext: (c.wechat && c.wechat.context_n) || 12,
					wxSkip: !(c.wechat && c.wechat.smart_skip === false),
				};
			};

			const load = useCallback(async () => {
				setLoading(true);
				setError("");
				try {
					const j = await api("/config");
					const c = j.config || {};
					setCfg(c);
					setDraft(toDraft(c));
					setVoices(j.voices || []);
					setCfgPath(j.configPath || "");
				} catch (e) {
					setError(String((e && e.message) || e));
					setLoading(false);
					return;
				}
				setLoading(false);
				api("/persona").then((r) => setPersona(r.text || "")).catch(() => {});
				api("/memory").then(setMem).catch(() => {});
				api("/status").then(setStatus).catch(() => {});
				api("/services").then((r) => setSvc(r.services || null)).catch(() => {});
			}, []);

			useEffect(() => { load(); }, [load]);

			const save = useCallback(async (patch, msg) => {
				try {
					await api("/config", { method: "POST", body: JSON.stringify(patch) });
					setCfg((prev) => {
						const next = Object.assign({}, prev || {});
						for (const k of Object.keys(patch)) next[k] = section(prev && prev[k], patch[k]);
						return next;
					});
					flash(msg || "已保存");
					return true;
				} catch (e) {
					flash("保存失败：" + ((e && e.message) || e), true);
					return false;
				}
			}, [flash]);

			const genReport = useCallback(async () => {
				setBusy("report");
				try {
					const r = await api("/report", { method: "POST", body: JSON.stringify({ days: 1 }) });
					if (r.ok) { setReport(r.markdown || ""); flash("日报已生成：" + (r.path || "")); }
					else flash((r.errors || []).join("；") || "生成失败", true);
				} catch (e) {
					flash("生成日报失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const startWatch = useCallback(async () => {
				setBusy("watch");
				try {
					const r = await api("/watch", { method: "POST", body: JSON.stringify({ duration: 10, max: 3 }) });
					flash(r.ok ? (r.note || "自主观看已开始") : (r.errors || []).join("；") || "启动失败", !r.ok);
				} catch (e) {
					flash("启动自主观看失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const restartService = useCallback(async (target, action) => {
				setBusy("svc:" + target);
				try {
					const r = await api("/services", { method: "POST", body: JSON.stringify({ target: target, action: action }) });
					setSvc(r.services || null);
					if (r.ok) flash(target === "wechat" ? "微信服务已就绪" : "QQ 服务已就绪");
					else flash((r.errors || []).join("；") || "服务启动失败", true);
				} catch (e) {
					flash("服务操作失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const togglePlatform = useCallback(async (key, on, needsRestart) => {
				const label = (PLATFORMS.find((p) => p[0] === key) || [key, key])[1];
				const next = Object.assign({}, (cfg && cfg.platforms) || {}, { [key]: on });
				const ok = await save({ platforms: next }, (on ? "已开启：" : "已关闭：") + label);
				if (!ok) return;
				setCfg((prev) => Object.assign({}, prev, { platforms: next }));
				if (needsRestart) await restartService(key, on ? "start" : "stop");
			}, [cfg, save, restartService]);

			const commitNight = useCallback(() => {
				const start = String(draft.nightStart || "").trim() || "20:00";
				const end = String(draft.nightEnd || "").trim() || "24:00";
				const wakes = Math.max(1, Math.min(5, Number(draft.nightWakes) || 1));
				save({ night: { windows: [{ start: start, end: end, wakes: wakes }] } },
					"作息已保存：" + start + " → " + end + "，醒 " + wakes + " 次");
			}, [draft, save]);

			const startNapcat = useCallback(async () => {
				setBusy("svc:napcat");
				try {
					const r = await api("/services", { method: "POST", body: JSON.stringify({ target: "napcat", action: "install" }) });
					flash(r.ok ? (r.note || "已请求启动 QQ 网关，请在 UAC 窗口点「是」") : (r.errors || []).join("；") || "启动失败", !r.ok);
					if (r.ok) setTimeout(load, 8000);
				} catch (e) {
					flash("启动 QQ 网关失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const runSelftest = useCallback(async () => {
				setBusy("selftest");
				setSelftest(null);
				try {
					const r = await api("/selftest", { method: "POST" });
					setSelftest(r);
					flash(r.ok ? "体检通过 ✓" : "体检有红项，看下面明细", !r.ok);
				} catch (e) {
					flash("体检失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const testVoice = useCallback(async () => {
				setBusy("voice");
				try {
					await api("/voice-test", { method: "POST", body: JSON.stringify({ name: draft.voicePath || "" }) });
					flash("合成完成，已发到你 QQ（看手机）");
				} catch (e) {
					flash("试听失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [draft, flash]);

			const savePersona = useCallback(async () => {
				setBusy("persona");
				try {
					await api("/persona", { method: "POST", body: JSON.stringify({ text: persona }) });
					flash("角色设定已保存，她下次醒来就照这个活");
				} catch (e) {
					flash("保存失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [persona, flash]);

			if (loading && !cfg) {
				return h("div", { className: "fy-panel" }, h("div", { className: "fy-hint" }, "读取大肥鱼配置…"));
			}

			if (error && !cfg) {
				return h("div", { className: "fy-panel" },
					h("div", { className: "fy-notice err" }, "载入失败：" + error),
					h("div", { className: "fy-hint" },
						"确认插件已在 DSH 里加载（宿主半边 dsh-feiyu 活着），然后点这里重试。"),
					h("div", { className: "fy-row" }, h("button", { className: "fy-btn primary", onClick: load }, "重试")));
			}

			const platforms = (cfg && cfg.platforms) || {};
			const schedulerOn = !!(status && status.scheduler && status.scheduler.ok);
			// 通道是否真的通：进程活着不等于能收发
			const napcatOk = !!(status && status.qqChannel && status.qqChannel.napcat && status.qqChannel.napcat.ok);
			const beat = (status && status.wxBeat) || null;
			const beatAge = beat && beat.ts ? Math.max(0, Math.round((Date.now() - Number(beat.ts)) / 1000)) : null;
			const beatFresh = beatAge !== null && beatAge <= 120;
			const napcatQr = (status && status.napcatQr) || null;   // 网关在等扫码登录
			const mood = (status && status.mood) || { value: 0, hunger: 0 };

			return h("div", { className: "fy-panel" },

				// 抬头
				h("div", { className: "fy-hero" },
					h("div", { className: "fy-avatar" }, "🐟"),
					h("div", null,
						h("div", { className: "fy-h1" }, "大肥鱼 · 私享版"),
						h("div", { className: "fy-sub" }, "她按作息自己醒：B站/抖音定时，QQ/微信随时回你"))),

				notice ? h("div", { className: "fy-notice" + (notice.err ? " err" : "") }, notice.msg) : null,

				// 运行状态
				h(Card, {
					title: "运行状态",
					extra: h("div", { className: "fy-row", style: { margin: 0 } },
						h("button", { className: "fy-btn", onClick: load, disabled: !!busy }, "刷新"),
						h("button", { className: "fy-btn", onClick: runSelftest, disabled: busy === "selftest" },
							busy === "selftest" ? "体检中…" : "跑一次体检")),
				},
					h("div", { className: "fy-stats" },
						h("div", { className: "fy-chip" },
							h("span", { className: "fy-dot" + (schedulerOn ? "" : " off") }),
							"生物钟 ", h("b", null, schedulerOn ? "运行中" : "停着")),
						h("div", { className: "fy-chip" }, "今日评论 ", h("b", null, (status && status.commentsToday) || 0), " 条"),
						h("div", { className: "fy-chip" }, "今日分享 ",
							h("b", null, (status && status.sharesToday) || 0), "/", (status && status.sharesMax) || 0),
						h("div", { className: "fy-chip" }, "情绪 ", h("b", null, mood.value), " · 饿 ", h("b", null, mood.hunger)),
						h("div", { className: "fy-chip" + ((status && status.dryRun) ? "" : " bad") },
							"干跑 ", h("b", null, (status && status.dryRun) ? "开（只演练）" : "关（真发）"))),
					// 通道健康：进程活着 ≠ 能收发。QQ 要看 NapCat 网关，微信要看心跳
					h("div", { className: "fy-stats", style: { marginTop: 10 } },
						h("div", { className: "fy-chip" + (napcatOk ? "" : " bad") },
							h("span", { className: "fy-dot" + (napcatOk ? "" : " off") }),
							"QQ 网关 ", h("b", null, napcatOk ? "在线" : "断开")),
						h("div", { className: "fy-chip" + (svc && svc.qq && svc.qq.running ? "" : " bad") },
							"QQ 进程 ", h("b", null, svc && svc.qq && svc.qq.running ? "在跑" : "没跑")),
						h("div", { className: "fy-chip" + (beatFresh ? "" : " bad") },
							"微信 ", h("b", null, beatAge === null ? "无心跳" : beatFresh ? beatAge + "s 前心跳 · " + (beat.state || "") : "心跳停了 " + beatAge + "s"))),
					h("div", { className: "fy-row", style: { marginTop: 8, marginBottom: 0 } },
						!napcatOk ? h("span", { className: "fy-hint", style: { marginTop: 0, flex: "1 1 260px" } },
							napcatQr
								? "📷 网关在等扫码登录：二维码 " + Math.max(1, Math.round(napcatQr.ageSec / 60)) + " 分钟前刚刷新，用手机 QQ 扫 D:\\NapCat\\cache\\qrcode.png。已开快速登录，正常只需要扫这一次。"
								: "⚠️ QQ 网关（NapCat）不通：服务在跑，但收不到也发不出任何 QQ 消息。点右边按钮，UAC 点一次「是」即可；网关随 DSH 启停。") : null,
						!napcatOk ? h("button", {
							className: "fy-btn primary",
							disabled: busy === "svc:napcat",
							onClick: startNapcat,
						}, busy === "svc:napcat" ? "授权中…" : (napcatQr ? "重新拉网关" : "安装并启动 QQ 网关")) : null,
						h("button", {
							className: "fy-btn",
							disabled: busy === "svc:all",
							onClick: () => restartService("all", "restart"),
						}, busy === "svc:all" ? "重启中…" : "重启 QQ / 微信")),
					selftest ? h("div", { className: "fy-check" },
						(selftest.items || []).map((it, i) => h("div", { key: i },
							h("span", { className: it.ok ? "ok" : "no" }, it.ok ? "✓ " : "✗ "),
							it.name,
							it.detail ? h("span", { className: "fy-tag", style: { marginLeft: 6 } }, short(it.detail, 60)) : null))) : null),

				// 平台开关
				h(Card, { title: "平台开关", hint: "B站/抖音 改完立即生效（生物钟每 60 秒读一次配置）；QQ/微信 会自动帮你重启对应服务。" },
					h("div", { className: "fy-grid" },
						PLATFORMS.map((p) => h("div", { className: "fy-sw", key: p[0] },
							h("span", null,
								h("span", { className: "fy-sw-name" }, p[1]),
								h("small", { className: "fy-sw-desc" }, p[2])),
							h(Switch, {
								on: platforms[p[0]] !== false,
								label: p[1],
								onChange: (v) => togglePlatform(p[0], v, p[3] === "restart"),
							}))))),

				// 主人
				h(Card, {
					title: "主人",
					hint: "QQ 号填上后，她能认出「这个人是我主人」；对网友保持距离、不泄隐私。",
				},
					h(Row, { label: "QQ 号" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerQQ, placeholder: "3082864371",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerQQ: e.target.value })),
							onBlur: () => save({ owner: { qq: draft.ownerQQ.trim() } }, "主人 QQ 已保存"),
						})),
					h(Row, { label: "称呼" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerName, placeholder: "她怎么叫你",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerName: e.target.value })),
							onBlur: () => save({ owner: { name: draft.ownerName.trim() } }, "称呼已保存"),
						})),
					h(Row, { label: "B站 mid" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerMid, placeholder: "B站数字 UID",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerMid: e.target.value })),
							onBlur: () => save({ owner: { mid: draft.ownerMid.trim() } }, "B站 mid 已保存"),
						})),
					h(Row, { label: "微信 wxid" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerWechat, placeholder: "（可选）",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerWechat: e.target.value })),
							onBlur: () => save({ owner: { wechat: draft.ownerWechat.trim() } }, "已保存"),
						}))),

				// 音色
				h(Card, {
					title: "音色",
					hint: voices.length
						? "音色来自 D:/GPT-SoVITS/models/<名字>/（.wav 参考音频 + .txt 参考文本）；换完重启 DSH 完全生效。"
						: "没扫到音色模型：把 GPT-SoVITS 音色放进 D:/GPT-SoVITS/models/<名字>/（含 .wav + .txt）。",
				},
					h(Row, { label: "当前音色" },
						h("select", {
							className: "fy-input",
							value: draft.voicePath,
							onChange: (e) => {
								const path = e.target.value;
								setDraft(Object.assign({}, draft, { voicePath: path }));
								const v = voices.find((x) => x.ref_audio_path === path);
								if (v) save({
									voice: { ref_audio_path: v.ref_audio_path, prompt_text: v.prompt_text || (cfg.voice && cfg.voice.prompt_text) || "" },
								}, "音色已切换为「" + v.name + "」");
							},
						},
							voices.length === 0 ? h("option", { value: "" }, "（没找到音色模型）") : null,
							voices.map((v) => h("option", { key: v.ref_audio_path, value: v.ref_audio_path },
								v.name + (v.has_prompt ? "" : "（缺参考文本）"))))),
					h(Row, { label: "语音概率" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 1, step: 0.05,
							value: draft.voiceChance,
							onChange: (e) => setDraft(Object.assign({}, draft, { voiceChance: e.target.value })),
							onBlur: () => save({ qq: { voice_chance: Math.max(0, Math.min(1, Number(draft.voiceChance) || 0)) } }, "语音概率已保存"),
						}),
						h("button", {
							className: "fy-btn", disabled: busy === "voice",
							onClick: testVoice,
						}, busy === "voice" ? "合成中…" : "试听（发到 QQ）")),
					h("div", { className: "fy-hint" }, "0~1，QQ/微信 每条回复走语音的概率（0.5 = 一半）。")),

				// 微信（UI 自动化，节奏与合并窗口直接决定像不像人、回得快不快）
				h(Card, {
					title: "微信",
					hint: "微信是 UI 自动化（不是协议）。节奏档 = 两条消息之间的最小间隔；合并窗口 = 等对方把话说完。改完点运行状态里的「重启 QQ / 微信」生效。",
				},
					h(Row, { label: "节奏档位" },
						h("select", {
							className: "fy-input",
							value: draft.wxRhythm,
							onChange: (e) => {
								const v = e.target.value;
								setDraft(Object.assign({}, draft, { wxRhythm: v }));
								save({ wechat: { rhythm: v } }, "微信节奏已切到 " + v + "（重启微信服务生效）");
							},
						},
						h("option", { value: "fast" }, "fast · 快（1.5 秒/条，推荐）"),
						h("option", { value: "off" }, "off · 秒回（最快，无节流，风控风险高）"),
						h("option", { value: "natural" }, "natural · 稳（4~7 秒/条）"),
							h("option", { value: "calm" }, "calm · 很慢（长时间挂机）"))),
					h(Row, { label: "合并窗口" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 1, max: 10, step: 0.5,
							value: draft.wxMerge,
							onChange: (e) => setDraft(Object.assign({}, draft, { wxMerge: e.target.value })),
							onBlur: () => save({ wechat: { merge_window_sec: Number(draft.wxMerge) || 3 } }, "合并窗口已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "对方说完几秒后才回；期间又发就继续等（最长 12 秒）")),
					h(Row, { label: "上下文条数" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 4, max: 30,
							value: draft.wxContext,
							onChange: (e) => setDraft(Object.assign({}, draft, { wxContext: e.target.value })),
							onBlur: () => save({ wechat: { context_n: Number(draft.wxContext) || 12 } }, "上下文条数已保存（下一条消息生效）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "往前带多少条对话来理解语境")),
					h(Row, { label: "自己判断该不该接" },
						h(Switch, {
							on: draft.wxSkip,
							label: "smart_skip",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { wxSkip: v }));
								save({ wechat: { smart_skip: v } }, v ? "以后她会先判断再决定回不回" : "以后每条都回");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "关掉就退回「每句都回」"))),

				// 作息与限额
				h(Card, {
					title: "作息与限额",
					hint: "窗口内随机挑时间醒（拟人，不整点）；B站和抖音共用这个窗口。",
				},
					h(Row, { label: "醒来窗口" },
						h("input", {
							className: "fy-input fy-w-sm", value: draft.nightStart, placeholder: "20:00",
							onChange: (e) => setDraft(Object.assign({}, draft, { nightStart: e.target.value })),
							onBlur: commitNight,
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "→"),
						h("input", {
							className: "fy-input fy-w-sm", value: draft.nightEnd, placeholder: "24:00",
							onChange: (e) => setDraft(Object.assign({}, draft, { nightEnd: e.target.value })),
							onBlur: commitNight,
						}),
						h("span", { className: "fy-label", style: { minWidth: "auto" } }, "次数"),
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 1, max: 5, value: draft.nightWakes,
							onChange: (e) => setDraft(Object.assign({}, draft, { nightWakes: e.target.value })),
							onBlur: commitNight,
						})),
					h(Row, { label: "每天分享上限" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 10, value: draft.shareDaily,
							onChange: (e) => setDraft(Object.assign({}, draft, { shareDaily: e.target.value })),
							onBlur: () => save({ quota: { shareDaily: Number(draft.shareDaily) || 0 } }, "分享上限已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "一天最多 @ 你几次")),
					h(Row, { label: "分享（@ 你）" },
						h(Switch, {
							on: draft.shareOn,
							label: "share",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { shareOn: v }));
								save({ share: { enabled: v } }, v ? "分享已开启" : "分享已关闭");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "最低 "),
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 20, value: draft.shareMinScore,
							onChange: (e) => setDraft(Object.assign({}, draft, { shareMinScore: e.target.value })),
							onBlur: () => save({ share: { minScore: Number(draft.shareMinScore) || 0 } }, "分享门槛已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, " 分才 @ 你")),
					h(Row, { label: "观看日报" },
						h("button", { className: "fy-btn", disabled: busy === "report", onClick: genReport },
							busy === "report" ? "生成中…" : "生成今日日报"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "聚合 B站/抖音 当天看过的，不调模型")),
					report ? h("pre", { className: "fy-report" }, report) : null,
					h(Row, { label: "自主观看（抖音）" },
						h("button", { className: "fy-btn", disabled: busy === "watch", onClick: startWatch },
							busy === "watch" ? "启动中…" : "开始看（10 分钟）"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "feed → 自主决策 → 记兴趣；默认只决策不真发评论")),
					h(Row, { label: "评论 @ 通知" },
						h(Switch, {
							on: draft.douyinAt,
							label: "douyinAt",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinAt: v }));
								save({ douyin: { atMention: v } }, v ? "已开启评论 @（风控风险高）" : "已关闭评论 @（推荐，防风控）");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "抖音评论带 @ 是风控主因，默认关")),
					h(Row, { label: "抖音每次条数" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 1, max: 5, value: draft.douyinCount,
							onChange: (e) => setDraft(Object.assign({}, draft, { douyinCount: e.target.value })),
							onBlur: () => save({ douyin: { maxPerRun: Number(draft.douyinCount) || 2 } }, "抖音条数已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "一轮刷几条就收手（防 shadowban）"))),

				// 角色设定
				h(Card, {
					title: "角色设定",
					extra: h("button", { className: "fy-btn primary", disabled: busy === "persona", onClick: savePersona },
						busy === "persona" ? "保存中…" : "保存角色设定"),
					hint: "这是她「自我迭代」的底稿：她每次醒来都读这份设定，你改她就照新的活。",
				},
					h("textarea", {
						className: "fy-input",
						value: persona,
						placeholder: "写下她是谁、怎么说话、在意什么……",
						onChange: (e) => setPersona(e.target.value),
					})),

				// 记忆库
				h(Card, {
					title: "记忆库",
					extra: h("div", { className: "fy-row", style: { margin: 0 } },
						h("span", { className: "fy-hint", style: { marginTop: 0 } },
							mem && mem.stats
								? "对话 " + mem.stats.episodes + " · 世界设定 " + mem.stats.lore + " · 主人事实 " + mem.stats.facts
								: "还没读到"),
						h("button", {
							className: "fy-btn",
							onClick: () => api("/memory").then(setMem).catch((e) => flash("读记忆失败：" + e.message, true)),
						}, "刷新")),
					hint: "最近的对话片段 —— 她记得的都在这里。",
				},
					h("div", { className: "fy-mem" },
						mem && (mem.recent || []).length
							? (mem.recent || []).slice().reverse().map((e, i) => h("div", { className: "fy-mem-item", key: i },
								h("b", null, e.role === "assistant" ? "她" : "对方"),
								h("span", { className: "fy-tag" }, String(e.chatId || "").split(":")[0] || e.platform || "?"),
								short(e.text, 96)))
							: h("div", { className: "fy-mem-item" }, "还没有记忆 —— 她醒过之后会开始记"))),

				// 页脚
				h("div", { className: "fy-hint", style: { paddingLeft: 2 } },
					"配置文件：", cfgPath || "~/.dsh/feiyu.config.json",
					"（面板改动即时写入，下次唤醒/重启生效）"));
		}

		// ── 客户端插件入口 ────────────────────────────────────────────────────
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-feiyu",
				order: 460,
				label: () => "大肥鱼",
			}, FeiyuSection));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
