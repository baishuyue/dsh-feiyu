#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抖音网页版(douyin.com)互动工具 —— 登录 / 刷feed / 发评论。

用 patchright（playwright 防检测分支）+ 本地 Chrome，仿 B站 whale 的 feed→看懂→发评论流程。
三个子命令：
  login   扫码登录 douyin.com，保存 cookie 到 --cookie 文件
  feed    加载 cookie，刷 feed，采集视频信息输出 JSON
  comment 加载 cookie，对某视频发评论（--dry 只打印）

安全铁律：评论默认 --dry（只打印不真发），确认后才真发。
"""
import re
import argparse
import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

# Windows 上 stdout 默认 GBK(cp936)，feed 结果里带 emoji 会 UnicodeEncodeError（DSH spawn 时必现：
# 宿主用 pipe 接 stdout，Python 按 locale 用 GBK 编码 → emoji 崩）。强制 UTF-8，根治。
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from patchright.async_api import async_playwright

# 关键：清掉 shell 注入的代理环境变量。patchright 的 Node 驱动会继承它们，
# 把 127.0.0.1 的 CDP/WebSocket 也走代理（58266/7897）→ 502。浏览器走系统代理，不受影响。
for _pk in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(_pk, None)

# 复用 social-auto-upload 的本地 Chrome 配置
LOCAL_CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
HOME = Path.home()
DEFAULT_COOKIE = str(HOME / ".feiyu-ai" / "douyin-cookies.json")

LOGIN_URL = "https://www.douyin.com/"
FEED_URL = "https://www.douyin.com/"

# CDP：连用户真实 Chrome（干净 profile + 调试端口），绕过抖音风控发评论
CDP_PORT = 9222
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
CDP_PROFILE = "D:/social-auto-upload/chrome-profile"


def log(msg):
    print(msg, flush=True)


async def _launch(playwright, headless: bool):
    launch_kwargs = {
        "headless": headless,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--lang=zh-CN",
            "--disable-infobars",
            "--no-sandbox",
            # 无头默认禁自动播放 → 打开视频页只是"看了一眼静态页"，永远不进观看历史。
            # 放开自动播放（静音），页面一打开视频就真播，手机端的浏览记录才会有她。
            "--autoplay-policy=no-user-gesture-required",
            "--mute-audio",
        ],
    }
    if LOCAL_CHROME_PATH and Path(LOCAL_CHROME_PATH).exists():
        launch_kwargs["executable_path"] = LOCAL_CHROME_PATH
    browser = await playwright.chromium.launch(**launch_kwargs)
    context = await browser.new_context(
        viewport={"width": 1280, "height": 900},
        locale="zh-CN",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    )
    # 抹掉 navigator.webdriver 痕迹
    await context.add_init_script(
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
    )
    return browser, context


def _has_session(cookies: list) -> bool:
    # 只有 sessionid / sessionid_ss 才是真正的登录态；ttwid 是匿名 cookie，不算登录
    return any(c.get("name") in ("sessionid", "sessionid_ss") and c.get("value") for c in cookies)


async def _save_cookies(context, cookie_file):
    cookies = await context.cookies()
    Path(cookie_file).parent.mkdir(parents=True, exist_ok=True)
    Path(cookie_file).write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
    return cookies


async def cmd_login(cookie_file: str) -> int:
    """扫码登录：打开可见 Chrome → douyin.com → 用户扫码 → 轮询登录 → 存 cookie。"""
    log("[login] 打开抖音网页版登录页（会弹出 Chrome 窗口）...")
    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=False)
        page = await context.new_page()
        await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
        log("[login] 请在 Chrome 窗口里点右上角「登录」并扫码（窗口里的二维码是活的，过期会自动刷新）")
        log("[login] 扫码后若手机提示「确认登录」，务必点确认")
        deadline = time.time() + 180  # 3 分钟
        last_state = ""
        while time.time() < deadline:
            cookies = await context.cookies()
            if _has_session(cookies):
                await _save_cookies(context, cookie_file)
                log(f"[login] ✅ 登录成功，cookie 已存到 {cookie_file}")
                await browser.close()
                return 0
            state = f"{len(cookies)} cookies, sessionid={'有' if _has_session(cookies) else '无'}"
            if state != last_state:
                log(f"[login] 等待登录中... {state}")
                last_state = state
            await asyncio.sleep(3)
        await browser.close()
        log("[login] ❌ 超时（3 分钟未完成扫码登录）")
        return 1


FEED_API_MARK = "/aweme/v2/web/module/feed/"


async def _collect_feed(page, scrolls: int, videos: dict):
    """下滑刷 feed，触发 feed API 加载更多视频（视频信息由响应拦截器采集）。"""
    for i in range(scrolls):
        await page.mouse.wheel(0, 3000)
        await asyncio.sleep(1.5)
        if i % 3 == 0:
            log(f"[feed] 已下滑 {i + 1}/{scrolls} 次，累计 {len(videos)} 个视频")


async def cmd_feed(cookie_file: str, scrolls: int, out_file: str, headed: bool) -> int:
    log("[feed] 加载 cookie 打开抖音...")
    videos = {}

    def parse_aweme(body: str):
        try:
            data = json.loads(body)
        except Exception:
            return
        for a in (data.get("aweme_list") or []):
            try:
                aweme_id = str(a.get("aweme_id", ""))
                if not aweme_id:
                    continue
                author = a.get("author") or {}
                stat = a.get("statistics") or {}
                videos[aweme_id] = {
                    "vid": aweme_id,
                    "desc": (a.get("desc") or "").strip(),
                    "author": author.get("nickname", ""),
                    "author_uid": str(author.get("uid", "")),
                    "comment_count": stat.get("comment_count", 0),
                    "digg_count": stat.get("digg_count", 0),
                }
            except Exception:
                continue

    async def on_response(resp):
        try:
            if FEED_API_MARK in resp.url and "json" in (resp.headers.get("content-type") or ""):
                parse_aweme(await resp.text())
        except Exception:
            pass

    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=not headed)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        page.on("response", on_response)
        await page.goto(FEED_URL, wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(5)
        await _collect_feed(page, scrolls, videos)
        await browser.close()
    log(f"[feed] 采集到 {len(videos)} 个视频")
    result = {"count": len(videos), "videos": list(videos.values())}
    if out_file == "-":
        print(json.dumps(result, ensure_ascii=False))
    else:
        Path(out_file).parent.mkdir(parents=True, exist_ok=True)
        Path(out_file).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"[feed] 已写入 {out_file}")
    return 0


def cmd_cdp_start():
    """启动带调试端口的真 Chrome（干净 profile），供 CDP 连接发评论。"""
    import subprocess
    chrome = LOCAL_CHROME_PATH
    if not Path(chrome).exists():
        log(f"✗ 找不到 Chrome：{chrome}")
        return 1
    Path(CDP_PROFILE).mkdir(parents=True, exist_ok=True)
    cmd = [
        chrome,
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={CDP_PROFILE}",
        "--no-first-run",
        "--no-default-browser-check",
        "https://www.douyin.com/",
    ]
    log(f"[cdp-start] 启动真 Chrome（调试端口 {CDP_PORT}，profile={CDP_PROFILE}）...")
    try:
        # Windows 用 DETACHED_PROCESS 分离，脚本退出后 Chrome 继续跑
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(cmd, creationflags=flags, close_fds=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    except Exception as e:
        log(f"✗ 启动失败：{e}")
        return 1
    log("[cdp-start] ✅ Chrome 已启动。请在窗口里登录抖音（扫码），登录后保持窗口开着。")
    log(f"[cdp-start] 之后发评论会通过 http://127.0.0.1:{CDP_PORT} 连这个真浏览器。")
    return 0


async def _cdp_connect(pw):
    """连接 CDP 真浏览器；失败返回 None。"""
    # 本地 CDP 连接必须绕过代理（代理会把 127.0.0.1 的 WebSocket 拦成 502）
    for k in ("NO_PROXY", "no_proxy"):
        os.environ[k] = "127.0.0.1,localhost"
    try:
        browser = await pw.chromium.connect_over_cdp(CDP_URL)
        return browser
    except Exception as e:
        log(f"[comment] CDP 连接失败（{str(e)[:80]}）—— 先跑 cdp-start 启动真浏览器")
        return None


async def _human_type(box, text):
    """拟人化输入：随机延迟，模拟真人打字节奏（降低自动化特征）。"""
    await box.type(text, delay=random.randint(20, 70))


async def _human_pause(lo=1.2, hi=3.0):
    """拟人化停顿：随机间隔，避免机械的固定节奏。"""
    await asyncio.sleep(random.uniform(lo, hi))


async def _click_at_user(page, at_user: str) -> bool:
    """精确点选 @ 下拉框里的用户项（semi-avatar 头像 + 昵称）。

    不能用 `text=昵称`：评论区里可能已有同名评论（比如之前发过的「@朴昌范 xxx」），
    `text=朴昌范` 会误点到评论而不是 @ 下拉框的用户项，导致真 @ 失效（不弹通知）。
    这里遍历 semi-avatar 头像，找「祖先容器文本以昵称开头且足够短」的用户项点选。
    """
    try:
        hit = await page.evaluate(
            """(name) => {
                const avatars = [...document.querySelectorAll('span.semi-avatar')];
                for (const av of avatars) {
                    let p = av;
                    for (let k = 0; k < 4 && p.parentElement; k++) p = p.parentElement;
                    const text = (p.innerText || '').trim().replace(/\\s+/g, ' ');
                    // 用户项文本 ≈ 昵称（可能带「关注」等），用 startsWith + 长度限制过滤掉评论卡片
                    if (text.startsWith(name) && text.length <= name.length + 12) {
                        p.click();
                        return text;
                    }
                }
                return null;
            }""",
            at_user,
        )
        return bool(hit)
    except Exception:
        return False


async def cmd_comment(cookie_file: str, vid: str, message: str, dry: bool, use_cdp: bool = False, at_user: str = "") -> int:
    # dry 不需要开浏览器（以前先连 CDP 再打 DRY 日志，CDP 没开就白失败一次）
    if dry:
        log(f"[comment][DRY] 本要发送：{'@' + at_user + ' ' if at_user else ''}{message} → {vid}")
        return 0
    log(f"[comment] 打开视频 https://www.douyin.com/video/{vid}")
    async with async_playwright() as pw:
        if use_cdp:
            browser = await _cdp_connect(pw)
            if browser is None:
                return 1
            # 用真浏览器现有的 context（保留登录态/真指纹）
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
        else:
            browser, context = await _launch(pw, headless=False)
            if Path(cookie_file).exists():
                await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
            page = await context.new_page()
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(5)
        # 先点开评论编辑框（抖音是 Draft.js 编辑器，占位符「留下你的精彩评论吧」点了才出现 contenteditable）
        # 2026-10-26 补：编辑框已经展开时不要再去点占位符 —— 会被 DraftEditor 挡住而超时
        if await page.locator('.public-DraftEditor-content[contenteditable="true"]').count() == 0:
            try:
                await page.locator('text=留下你的精彩评论吧').first.click(timeout=8000)
            except Exception:
                try:
                    await page.locator('.comment-title, text=全部评论').first.click(timeout=8000)
                except Exception:
                    log("✗ 找不到评论占位符（可能被风控或页面结构变了）")
                    if not use_cdp:
                        await browser.close()
                    return 1
        await asyncio.sleep(1)
        # Draft.js 输入框：public-DraftEditor-content
        box = page.locator('.public-DraftEditor-content[contenteditable="true"]').first
        try:
            await box.click(timeout=8000)
        except Exception:
            box = page.locator('[contenteditable="true"]').first
            await box.click(timeout=8000)

        # 输入评论。三种模式：
        # ① at_user 非空：真 @（输入 @ → 点选用户 → 输入正文，text_extra 由前端生成，会弹通知）
        # ② message 以 @ 开头（纯文本 @）：输入 @ → ESC 关下拉框 → 输入剩余，不弹通知
        # ③ 其他：纯文字直接输入
        if at_user:
            # 正常人类 @ 流程：输入 @ → 输入名字（Draft.js 自动匹配并选中，唯一命中则无需点选）
            # → 写评论。这样 text_extra 由前端自动带上被 @ 用户的 uid，才是真提及（会弹通知）。
            await _human_type(box, '@')
            await _human_pause(0.6, 1.2)
            await _human_type(box, at_user)   # 输入名字触发搜索/自动匹配
            await _human_pause(1.8, 2.6)      # 等自动选中
            # 兜底：名字不唯一时下拉框仍开着、不会自动选中，此时点选第一个匹配项
            try:
                await _click_at_user(page, at_user)
            except Exception:
                pass
            await _human_pause(0.6, 1.0)
            await _human_type(box, message)
        elif message.startswith('@'):
            await _human_type(box, '@')
            await _human_pause(1.0, 1.6)
            await page.keyboard.press('Escape')
            await _human_pause(0.4, 0.8)
            if len(message) > 1:
                await _human_type(box, message[1:])
        else:
            await _human_type(box, message)
        await asyncio.sleep(1)
        # 发布按钮：右侧容器的发送图标（SVG span，无文字）
        # 2026-10-26 修：原来用 `.last`，而最后一个 span 是 display:none 的隐藏节点（0x0），
        # 点击必然 8 秒超时（当天第二次评论就死在这）。现在只挑「可见 + 尺寸正常」的图标，
        # 取最右边那个当发送键；都点不到就回车发送。
        sent = False
        try:
            icons = page.locator('.commentInput-right-ct span:has(svg)')
            n = await icons.count()
            cands = []
            for i in range(n):
                el = icons.nth(i)
                try:
                    if not await el.is_visible():
                        continue
                    bb = await el.bounding_box()
                except Exception:
                    continue
                if bb and bb['width'] >= 8 and bb['height'] >= 8:
                    cands.append((bb['x'], i))
            cands.sort()
            if cands:
                await icons.nth(cands[-1][1]).click(timeout=8000)
                sent = True
                log(f"[comment] 用发送图标（可见、最右，共 {len(cands)} 个候选）")
        except Exception as e:
            log(f"[comment] 发送图标点击失败：{e.__class__.__name__}")
        if not sent:
            for sel in ['text="发布"', 'button:has-text("发布")']:
                try:
                    el = page.locator(sel).last
                    if await el.count() and await el.is_visible():
                        await el.click(timeout=5000)
                        sent = True
                        log(f"[comment] 用文字按钮 {sel}")
                        break
                except Exception:
                    pass
        if not sent:
            await box.press('Enter')
            log("[comment] 图标都点不到，改用回车发送")
        await asyncio.sleep(3)
        # 回读验证发送结果（输入框清空 = 发送成功；未清空 = 可能被风控拦下）
        try:
            after = await page.locator('.public-DraftEditor-content[contenteditable="true"]').first.inner_text()
            if (after or '').strip():
                log(f"[comment] ⚠️ 发送后输入框未清空（评论可能没发出去）：{after!r}")
            else:
                log(f"[comment] ✅ 已发送评论：{'@' + at_user + ' ' if at_user else ''}{message}")
        except Exception:
            log(f"[comment] ✅ 已发送评论：{'@' + at_user + ' ' if at_user else ''}{message}（输入框已收起）")
        if not use_cdp:
            await browser.close()
    return 0


COMMENT_API_MARK = "/aweme/v1/web/comment/list/"


async def cmd_reply(cookie_file: str, vid: str, cid: str, message: str, dry: bool, use_cdp: bool = False, at_user: str = "") -> int:
    """回复某条评论（点该评论的「回复」按钮 → 输入 → 发送，publish 自动带 reply_id）。"""
    # dry 不需要开浏览器（同 cmd_comment：以前先连 CDP 再打 DRY 日志，白失败一次）
    if dry:
        log(f"[reply][DRY] 本要回复 cid={cid}：{'@' + at_user + ' ' if at_user else ''}{message}")
        return 0
    log(f"[reply] 打开视频 https://www.douyin.com/video/{vid}")
    async with async_playwright() as pw:
        if use_cdp:
            browser = await _cdp_connect(pw)
            if browser is None:
                return 1
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
        else:
            browser, context = await _launch(pw, headless=False)
            if Path(cookie_file).exists():
                await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
            page = await context.new_page()
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(5)
        # 拦截评论列表 API，找 cid 的序号（第几条）
        cids = []

        async def on_resp(resp):
            try:
                if '/aweme/v1/web/comment/list/' in resp.url and 'json' in (resp.headers.get('content-type') or ''):
                    d = json.loads(await resp.text())
                    for c in (d.get('comments') or []):
                        cids.append(str(c.get('cid')))
            except Exception:
                pass

        # ⚠️ 监听必须在 goto **之前**挂上（10-25 修）：以前挂在 goto+sleep(5) 之后，
        # 评论接口早就在页面加载时回完了 → cids 永远空 → 每次都报"cid 不在当前列表"，一次都发不出去。
        page.on('response', on_resp)
        await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(5)
        for i in range(5):
            await page.mouse.wheel(0, 2000)
            await asyncio.sleep(1.5)
        page.remove_listener('response', on_resp)
        cid = str(cid)
        if cid not in cids:
            log(f"[reply] ✗ 评论 cid={cid} 不在当前列表（前 5 条：{cids[:5]}）")
            if not use_cdp:
                await browser.close()
            return 1
        idx = cids.index(cid)
        log(f"[reply] 目标评论是第 {idx + 1} 条")
        # 点第 idx 个「回复」按钮（优先在该评论条目内部找）
        clicked = False
        try:
            items = page.locator('div[data-e2e="comment-item"]')
            if await items.count() > idx:
                await items.nth(idx).locator('text=回复').first.click(timeout=5000)
                clicked = True
        except Exception:
            clicked = False
        if not clicked:
            try:
                await page.locator('text=回复').nth(idx).click(timeout=5000)
                clicked = True
            except Exception as e:
                log(f"[reply] ✗ 点回复按钮失败：{str(e)[:100]}")
                if not use_cdp:
                    await browser.close()
                return 1
        log(f"[reply] 已点第 {idx + 1} 个回复按钮")
        await asyncio.sleep(1.5)
        # 输入框
        box = page.locator('.public-DraftEditor-content[contenteditable="true"]').first
        try:
            await box.click(timeout=5000)
        except Exception:
            box = page.locator('[contenteditable="true"]').first
            await box.click(timeout=5000)
        # 输入（真 @ 或纯文本）
        if at_user:
            # 正常人类 @：输入 @ → 输入名字（Draft.js 自动匹配选中）→ 写评论
            await _human_type(box, '@')
            await _human_pause(0.6, 1.2)
            await _human_type(box, at_user)
            await _human_pause(1.8, 2.6)
            try:
                await _click_at_user(page, at_user)
            except Exception:
                pass
            await _human_pause(0.6, 1.0)
            await _human_type(box, message)
        else:
            await _human_type(box, message)
        await asyncio.sleep(1)
        # 发送前挂上"发布接口"监听 —— 唯一可信的成功信号（10-25：只看输入框空了会假成功，
        # 判定成功但页面/接口都没有这条回复的情况实测出现过）
        pub = {"ok": False, "info": ""}

        async def on_pub(resp):
            try:
                if "comment/publish" in resp.url:
                    d = json.loads(await resp.text())
                    sc = d.get("status_code")
                    cid_new = ((d.get("comment") or {}).get("cid")) or ""
                    pub["ok"] = sc == 0 and bool(cid_new)
                    pub["info"] = f"status_code={sc} 新cid={cid_new} msg={str(d.get('status_msg') or '')[:60]}"
            except Exception:
                pass

        page.on("response", on_pub)
        # 发送：回车优先（抖音评论框 Enter 直接发），不行再点右侧「发送」按钮
        try:
            await page.keyboard.press('Enter')
            await asyncio.sleep(3)
        except Exception:
            pass
        try:
            left = (await page.locator('.public-DraftEditor-content[contenteditable="true"]').first.inner_text() or '').strip()
        except Exception:
            left = ''
        if left and not pub["ok"]:
            for sel in ['.commentInput-right-ct span:has(svg)', 'span:has-text("发送")', 'text="评论"']:
                try:
                    await page.locator(sel).last.click(timeout=5000)
                    await asyncio.sleep(3)
                    break
                except Exception:
                    continue
        page.remove_listener("response", on_pub)
        if pub["ok"]:
            log(f"[reply] ✅ 已回复 cid={cid}：{'@' + at_user + ' ' if at_user else ''}{message}（{pub['info']}）")
        else:
            shot = str(Path.home() / 'AppData/Local/Temp' / f"reply-fail-{cid}.png")
            try:
                await page.screenshot(path=shot)
            except Exception:
                shot = '(截图失败)'
            log(f"[reply] ✗ 发布接口没确认成功：{pub['info'] or '（没抓到 comment/publish 响应）'} 截图 {shot}")
            if not use_cdp:
                await browser.close()
            return 1
        if not use_cdp:
            await browser.close()
    return 0


async def cmd_self_info(cookie_file: str, out_file: str = "-") -> int:
    """读当前登录账号自己的资料（昵称 + sec_uid + uid）。

    为什么要：cookie 登录的是"她"的号（顾思苡），而 douyin.owner 是主人（朴昌范）。
    运营/回复自己的作品评论区，扫的必须是**自己**的投稿 —— 以前 engage 用 owner.sec_uid
    扫成了主人的旅行视频（10-25 主人当场纠正）。
    """
    prof = {}

    async def on_resp(resp):
        try:
            if "user/profile" in resp.url and "json" in (resp.headers.get("content-type") or ""):
                d = json.loads(await resp.text())
                u = d.get("user") or {}
                if u.get("nickname"):
                    prof.update({
                        "nickname": u.get("nickname"),
                        "sec_uid": u.get("sec_uid"),
                        "uid": str(u.get("uid") or ""),
                        "unique_id": str(u.get("unique_id") or ""),
                        "signature": u.get("signature") or "",
                    })
        except Exception:
            pass

    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=True)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        page.on("response", on_resp)
        await page.goto("https://www.douyin.com/user/self", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(9)
        if not prof.get("sec_uid"):
            try:
                prof["nickname"] = (await page.locator("h1").first.inner_text(timeout=4000) or "").strip()
            except Exception:
                pass
        await browser.close()
    log(f"[self-info] {prof.get('nickname') or '?'} · {prof.get('sec_uid') or '(没读到 sec_uid)'}")
    result = {"ok": bool(prof.get("sec_uid")), **prof}
    if out_file == "-":
        print(json.dumps(result, ensure_ascii=False))
    else:
        Path(out_file).parent.mkdir(parents=True, exist_ok=True)
        Path(out_file).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if prof.get("sec_uid") else 1


async def cmd_comments(cookie_file: str, vid: str, out_file: str, headed: bool) -> int:
    """读某视频的热评（拦截评论列表 API），输出 JSON。"""
    log(f"[comments] 打开视频 https://www.douyin.com/video/{vid}")
    comments = []

    def parse_comments(body: str):
        try:
            data = json.loads(body)
        except Exception:
            return
        for c in (data.get("comments") or []):
            try:
                u = c.get("user") or {}
                # cid 必须带上（10-25）：否则 `reply --vid --cid` 无从下手 —— 读评论拿到文本却没有 id，
                # 只靠文本前缀定位（comment-reply --match）在纯表情评论上会歧义。
                comments.append({
                    "cid": str(c.get("cid") or ""),
                    "text": (c.get("text") or "").strip(),
                    "user": u.get("nickname", ""),
                    "user_sec_uid": u.get("sec_uid", ""),
                    "digg_count": c.get("digg_count", 0),
                    "reply_total": c.get("reply_comment_total", 0),
                    "create_time": c.get("create_time", 0),
                    "aweme_id": str(c.get("aweme_id") or vid),
                    "is_reply": False,
                    "parent_cid": "",
                    "reply_to_user": "",
                })
                # 10-26 修：一级评论里自带的子回复（reply_comment）也要收。
                # 以前只读 comments[]，于是"她回过一次之后对方又追问"的那句永远看不见 ——
                # 表现就是：同一个人只能被回一次（主人 10-26 截图实锤：他说"给我也分一碗"，她一直没搭理）。
                for rc in (c.get("reply_comment") or []):
                    try:
                        ru = rc.get("user") or {}
                        comments.append({
                            "cid": str(rc.get("cid") or ""),
                            "text": (rc.get("text") or "").strip(),
                            "user": ru.get("nickname", ""),
                            "user_sec_uid": ru.get("sec_uid", ""),
                            "digg_count": rc.get("digg_count", 0),
                            "reply_total": rc.get("reply_comment_total", 0),
                            "create_time": rc.get("create_time", 0),
                            "aweme_id": str(rc.get("aweme_id") or vid),
                            "is_reply": True,
                            "parent_cid": str(c.get("cid") or ""),
                            "reply_to_user": ((rc.get("reply_to_user") or {}).get("nickname") or u.get("nickname", "")),
                        })
                    except Exception:
                        continue
            except Exception:
                continue

    async def on_response(resp):
        try:
            if COMMENT_API_MARK in resp.url and "json" in (resp.headers.get("content-type") or ""):
                parse_comments(await resp.text())
        except Exception:
            pass

    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=not headed)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        page.on("response", on_response)
        await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(5)
        for _ in range(3):
            await page.mouse.wheel(0, 2000)
            await asyncio.sleep(1.5)
        await browser.close()
    # 接口会分页多次回调，同一个 cid 可能来两遍 —— 按 cid 去重（没有 cid 的按文本+作者去重）
    uniq, seen = [], set()
    for c in comments:
        k = c.get("cid") or (c.get("user", "") + "|" + c.get("text", "")[:40])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(c)
    comments = uniq
    log(f"[comments] 读到 {len(comments)} 条评论")
    result = {"vid": vid, "count": len(comments), "comments": comments}
    if out_file == "-":
        print(json.dumps(result, ensure_ascii=False))
    else:
        Path(out_file).parent.mkdir(parents=True, exist_ok=True)
        Path(out_file).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0



async def _open_dm_chat(page, sec_uid: str):
    """打开某用户的私信聊天窗：进主页 → 点「私信/发消息」→ 返回输入框 locator。
    加载慢/风控页会找不到按钮 —— 刷新一次重试再放弃（DSH 刚重启全员抢资源时高发）。"""
    for attempt in (1, 2):
        await page.goto(f"https://www.douyin.com/user/{sec_uid}", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(9 if attempt == 2 else 7)
        for label in ("私信", "发消息", "消息", "聊天"):
            try:
                await page.locator(f'button:has-text("{label}")').first.click(timeout=6000)
                await asyncio.sleep(5)
                return page.locator('.editor-kit-container[contenteditable="true"]').first
            except Exception:
                continue
        if attempt == 1:
            log("[dm] 主页没找到私信按钮，刷新重试一次…")
    raise RuntimeError("主页上没找到私信/发消息按钮")


async def _read_dm_messages(page):
    """读聊天面板消息。⚠️ 顺序有讲究：先读一遍默认视图（最新消息在底部、已渲染），
    再向上滚加载旧消息读第二遍合并 —— 以前先滚后读，虚拟列表把最新消息移出 DOM，
    主人的新回复永远读不到（10-24 实锤：鱼发了分享、主人回了话，dm-read 全看不见）。"""
    def _extract():
        return page.evaluate("""() => {
            const out = [];
            const list = document.querySelector('.messageMessageListlist')
                || document.querySelector('[class*="messageMessageList"]');
            if (!list) return out;
            const seen = new Set();
            for (const content of list.querySelectorAll('[data-e2e="msg-item-content"], [class*="MessageBoxContent"]')) {
                const imgEl = content.querySelector('img');
                const imgSrc = (imgEl && imgEl.clientWidth >= 60 && imgEl.clientHeight >= 60 && (imgEl.src || '').startsWith('http')) ? imgEl.src : '';
                let t = (content.innerText || '').trim();
                if (t.length > 400) t = t.slice(0, 400);
                if (!t && !imgSrc) continue;   // 纯图片消息：文字为空但带 img，交给视觉模型看
                // 剥掉日期/时间行（"09/07"、"2025/12/13"、"21分钟前"）——那是时间分隔不是消息
                const lines = t.split('\\n').filter((l) => {
                    const s = l.trim();
                    if (!s) return false;
                    if (/^\\d{1,2}\\/\\d{1,2}$/.test(s)) return false;
                    if (/^\\d{4}\\/\\d{1,2}\\/\\d{1,2}$/.test(s)) return false;
                    if (/^\\d+分钟前$/.test(s)) return false;
                    return true;
                });
                t = lines.join('\\n').trim();
                if (!t) continue;
                // 分享卡片：douyin 渲染成 "[分享视频]" 占位 —— 从卡片里把标题挖出来拼上，
                // 不然她永远不知道对方分享的是什么（10-25 实锤：主人回"这个看起来好好吃"，她看不懂）
                if (t.indexOf('[分享') >= 0) {
          const cardRoot = content.closest('[class*="messageBox"]') || content.parentElement || content;
          const card = cardRoot.querySelector('a[href*="/video/"], a[href*="/note/"], [class*="cardTitle"], [class*="shareCard"], [class*="share"] img');
          const extraTitle = card ? (card.innerText || '').trim().split('\\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 60) : '';
          const rawHref = card ? String(card.getAttribute('href') || '') : '';
          const href = rawHref ? (rawHref.indexOf('http') === 0 ? rawHref : 'https://www.douyin.com' + rawHref) : '';
          const tag = '[分享视频' + (extraTitle ? '：' + extraTitle : '') + (href ? ' ' + href : '') + ']';
          const b = t.indexOf('[分享');
          const e2 = t.indexOf(']', b);
          if (e2 > b) t = t.slice(0, b) + tag + t.slice(e2 + 1);
        }
                // 系统占位卡/游戏邀请卡没有对话价值
                if (/暂不支持该消息类型|邀请你一起|点击加入|接受邀请/.test(t)) continue;
                const key = t.slice(0, 50);
                if (seen.has(key)) continue;
                seen.add(key);
                const box = content.closest('[class*="messageBox"]') || content.parentElement;
                out.push({ dir: (box && box.querySelector('[class*="isFromMe"]')) ? 'out' : 'in', text: t, img: imgSrc });
            }
            return out;
        }""")

    # 第一遍：默认视图（最新在底部，别动）
    first = await _extract()
    # 第二遍：向上滚加载旧消息（合并去重，旧的在前）
    for _ in range(3):
        await page.mouse.wheel(0, -1500)
        await asyncio.sleep(1)
    second = await _extract()
    fresh_keys = {m["text"][:50] for m in first}
    merged, seen = [], set()
    for m in second + first:
        k = m["text"][:50]
        if k in seen:
            continue
        seen.add(k)
        m = dict(m)
        # 默认视图（没滚动前那一屏）里出现过的 → 说明是最近的消息。
        # 合并顺序是"旧的在前"，但虚拟列表偶尔会打乱，调用方不能靠位置判断新旧（10-25 实锤：
        # 末尾常常是早就回过的旧消息，导致新消息永远轮不到）。
        m["fresh"] = k in fresh_keys
        merged.append(m)
    return merged[-40:]


async def _find_share_target(page, friend: str):
    """在「分享给朋友」面板里找到好友那一行的「分享」按钮（找不到 → 先用面板搜索框搜一次）。"""
    async def scan():
        btns = page.locator('div:text-is("分享")')
        n = min(await btns.count(), 24)
        for i in range(n):
            b = btns.nth(i)
            for depth in (1, 2, 3):
                try:
                    row_text = await b.locator(f"xpath=ancestor::div[{depth}]").inner_text(timeout=800)
                except Exception:
                    continue
                if friend and friend in row_text and len(row_text) < 120:
                    return b
        return None

    target = await scan()
    if target is not None:
        return target
    # 兜底：面板顶部有搜索框，搜好友名再扫一遍
    try:
        box = page.locator('input[placeholder="搜索"], input[placeholder*="搜索"]').first
        await box.fill(friend, timeout=4000)
        await asyncio.sleep(2)
        target = await scan()
    except Exception:
        pass
    return target


async def cmd_share(cookie_file: str, vid: str, friend: str, dry: bool, use_cdp: bool = False, headless: bool = False) -> int:
    """原生分享视频卡片给好友：视频页 hover 分享图标 → 「分享给朋友」面板 → 点好友旁的「分享」。
    收到的是可点开的视频卡片（手机上和你手动分享的长一样），不是文字链接。"""
    log(f"[share] 把视频 {vid} 原生分享给「{friend}」…")
    async with async_playwright() as pw:
        if use_cdp:
            browser = await _cdp_connect(pw)
            if browser is None:
                return 1
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
        else:
            browser, context = await _launch(pw, headless=headless)
            if Path(cookie_file).exists():
                await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
            page = await context.new_page()
        try:
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(8)
            icon = page.locator('[data-e2e="video-share-icon-container"]').first
            try:
                box = await icon.bounding_box(timeout=8000)
            except Exception:
                box = None
            if not box:
                log("✗ 找不到分享图标（页面没加载完或结构变了）")
                return 1
            # hover 弹面板（真实鼠标移动，别用 locator.hover —— actionability 检查会超时）
            await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=8)
            await asyncio.sleep(3)
            target = await _find_share_target(page, friend)
            if target is None:
                log(f"✗ 「分享给朋友」面板里没找到「{friend}」")
                return 1
            if dry:
                log(f"[share][DRY] 面板已开、找到「{friend}」的分享按钮。本要把视频卡片分享给 TA")
                return 0
            await target.click()
            await asyncio.sleep(3)
            # 有的版本点完弹确认（发送/确定），有就直接发了
            for label in ("发送", "确定"):
                try:
                    await page.locator(f'button:has-text("{label}"), div:text-is("{label}")').first.click(timeout=2500)
                    await asyncio.sleep(2)
                    break
                except Exception:
                    continue
            log(f"[share] ✅ 已把视频卡片分享给「{friend}」")
            return 0
        finally:
            if not use_cdp:
                await browser.close()


async def cmd_dm_send(cookie_file: str, sec_uid: str, message: str, dry: bool, use_cdp: bool = False, name: str = "", headless: bool = False) -> int:
    """发私信：进主页→点私信→输入→回车发送。sec_uid 唯一锁定用户，不怕昵称重名。"""
    log(f"[dm] 打开「{name or sec_uid}」主页发私信…")
    async with async_playwright() as pw:
        if use_cdp:
            browser = await _cdp_connect(pw)
            if browser is None:
                return 1
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
        else:
            browser, context = await _launch(pw, headless=headless)
            if Path(cookie_file).exists():
                await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
            page = await context.new_page()
        try:
            box = await _open_dm_chat(page, sec_uid)
        except Exception as e:
            log(f"✗ 打不开「{name or sec_uid}」的私信窗：{str(e)[:120]}（主页结构/未互关/风控）")
            if not use_cdp:
                await browser.close()
            return 1
        if dry:
            log(f"[dm][DRY] 私信窗已打开、输入框已定位。本要发给「{name or sec_uid}」：{message}")
            if not use_cdp:
                await browser.close()
            return 0
        try:
            await box.click(timeout=8000)
        except Exception:
            box = page.locator('[class*="messageEditorinputArea"][contenteditable="true"]').first
            await box.click(timeout=8000)
        await _human_type(box, message)
        await asyncio.sleep(1)
        await page.keyboard.press("Enter")
        await asyncio.sleep(3)
        log(f"[dm] ✅ 已发送给「{name or sec_uid}」：{message}")
        if not use_cdp:
            await browser.close()
    return 0


async def cmd_dm_read(cookie_file: str, sec_uid: str, n: int, out: str, name: str = "", headless: bool = False) -> int:
    """读某会话最近 n 条消息（带方向 in/out）。"""
    log(f"[dm-read] 打开「{name or sec_uid}」的私信窗读最近 {n} 条…")
    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=headless)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        try:
            await _open_dm_chat(page, sec_uid)
        except Exception as e:
            log(f"✗ 打不开私信窗：{str(e)[:120]}")
            await browser.close()
            return 1
        msgs = await _read_dm_messages(page)
        await browser.close()
    result = json.dumps({"conversation": name or sec_uid, "messages": msgs}, ensure_ascii=False)
    if out == "-":
        print(result)
    else:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(result, encoding="utf-8")
    return 0


async def _dismiss_login_dialog(page):
    """模块级：点掉「是否保存登录信息」弹窗（多处共用）。"""
    try:
        btn = page.locator('button:has-text("取消")').first
        if await btn.is_visible(timeout=1500):
            await btn.click(timeout=2000)
    except Exception:
        pass


async def cmd_my_videos(cookie_file: str, sec_uid: str, out: str, headed: bool = False) -> int:
    """扫她自己的投稿列表（10-25 运营用）：打开主页 → 抓作品卡片（vid/描述/评论数），输出 JSON。"""
    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=not headed)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        videos = []
        try:
            await page.goto(f"https://www.douyin.com/user/{sec_uid}", wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(6)
            for _ in range(2):
                await page.mouse.wheel(0, 2500)
                await asyncio.sleep(2)
            items = page.locator('li[class*="video-item"], div[data-e2e="user-post-list"] li')
            n = await items.count()
            for i in range(min(n, 20)):
                try:
                    el = items.nth(i)
                    a = el.locator("a[href*='/video/']").first
                    href = await a.get_attribute("href", timeout=3000) or ""
                    vid_m = re.search(r"/video/(\d+)", href)
                    if not vid_m:
                        continue
                    txt = (await el.inner_text(timeout=3000) or "").replace("\n", " ").strip()
                    videos.append({"vid": vid_m.group(1), "desc": txt[:60]})
                except Exception:
                    continue
        except Exception as e:
            log(f"✗ 扫投稿失败：{str(e)[:120]}")
        finally:
            await browser.close()
    print(json.dumps({"sec_uid": sec_uid, "videos": videos}, ensure_ascii=False))
    return 0


async def cmd_comment_reply(cookie_file: str, vid: str, match_text: str, reply_text: str, dry: bool, headed: bool = False) -> int:
    """回复自己视频下的某条评论（10-25 运营用）：按评论文本前缀定位 → hover 点回复 → 输入 → 回车。
    风控提示：低频使用（一天几条），别批量。"""
    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=not headed)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        try:
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(6)
            await _dismiss_login_dialog(page)
            # 点开评论面板（有的页面默认收起）
            try:
                btn = page.locator('div[data-e2e="comment-icon"], [class*="comment"] [data-e2e="comment-icon"]').first
                if await btn.is_visible(timeout=3000):
                    await btn.click(timeout=3000)
                    await asyncio.sleep(2)
            except Exception:
                pass
            items = page.locator('div[data-e2e="comment-item"]')
            n = await items.count()
            if n == 0:
                # 滚动加载评论
                for _ in range(3):
                    await page.mouse.wheel(0, 1500)
                    await asyncio.sleep(1.5)
                n = await items.count()
            target = None
            key = match_text.strip()[:18]
            best_len = None
            for i in range(min(n, 40)):
                el = items.nth(i)
                try:
                    txt = (await el.inner_text(timeout=2500) or "").replace("\n", " ")
                except Exception:
                    continue
                if not key or key not in txt:
                    continue
                # 10-26：取「包含这句话的最内层条目」。子回复是嵌在父评论里的，父条目的 inner_text
                # 也命中；点父条目的「回复」会把回复挂到一级评论上（对方收不到通知），
                # 所以挑 inner_text 最短、也就是最具体的那一个 —— 它自己的「回复」按钮才对。
                if best_len is None or len(txt) < best_len:
                    target, best_len = el, len(txt)
            if target is None:
                log(f"✗ 没找到匹配的评论（关键词：{key}）")
                await browser.close()
                return 1
            if dry:
                log(f"【干跑 ✓】将对评论「{key}」回复：{reply_text}")
                await browser.close()
                return 0
            await target.hover(timeout=5000)
            await asyncio.sleep(1)
            btn = target.locator('div[data-e2e="comment-reply"], [class*="reply"]').first
            await btn.click(timeout=6000)
            await asyncio.sleep(1.5)
            editor = page.locator('.editor-kit-container[contenteditable="true"]').last
            await editor.click(timeout=6000)
            await editor.type(reply_text, delay=90)
            await page.keyboard.press("Enter")
            await asyncio.sleep(4)
            log(f"✓ 已回复评论「{key}」：{reply_text[:40]}")
        except Exception as e:
            log(f"✗ 回复评论失败：{str(e)[:150]}")
            try:
                await browser.close()
            except Exception:
                pass
            return 1
        await browser.close()
    return 0


async def cmd_frames(cookie_file: str, vid: str, out_dir: str, n: int, headed: bool = False) -> int:
    """截视频画面 n 帧（视觉理解采样，10-25 新增）：打开视频页等起播，JPEG 连拍，输出 JSON 路径。
    纯读操作：无头即可（autoplay 已放开，视频真播帧间才有差异）。
    打开时顺手点掉「是否保存登录信息」弹窗（不点会挡画面），优先按 <video> 元素区域截。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    frames = []

    async def dismiss_login_dialog(page):
        try:
            btn = page.locator('button:has-text("取消")').first
            if await btn.is_visible(timeout=1500):
                await btn.click(timeout=2000)
        except Exception:
            pass

    async def shot(page, f):
        try:   # 优先只截视频区域（信号密度高，视觉模型描述更准）
            el = page.locator("video").first
            box = await el.bounding_box(timeout=3000)
            if box and box.get("width", 0) > 100:
                f.write_bytes(await page.screenshot(type="jpeg", quality=70, clip=box))
                return
        except Exception:
            pass
        f.write_bytes(await page.screenshot(type="jpeg", quality=70, full_page=False))

    async with async_playwright() as pw:
        browser, context = await _launch(pw, headless=not headed)
        if Path(cookie_file).exists():
            await context.add_cookies(json.loads(Path(cookie_file).read_text(encoding="utf-8")))
        page = await context.new_page()
        try:
            await page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(4)
            await dismiss_login_dialog(page)
            try:
                await page.wait_for_selector("video", timeout=15000)   # 等真播放器出来（404 页没有 video）
            except Exception:
                log(f"[frames] ⚠ 页面没有 video 元素（视频可能已删除/404），回退整页截帧")
            await asyncio.sleep(2)   # 等起播
            for i in range(max(1, min(n, 6))):
                f = out / f"frame-{i}.jpg"
                await shot(page, f)
                if f.exists() and f.stat().st_size > 0:
                    frames.append(str(f))
                await asyncio.sleep(2.5)   # 间隔连拍：视频在播，帧间有内容差异
        except Exception as e:
            log(f"✗ 截帧失败：{str(e)[:150]}")
        finally:
            await browser.close()
    if not frames:
        print(json.dumps({"vid": vid, "frames": [], "error": "no frames"}, ensure_ascii=False))
        return 1
    print(json.dumps({"vid": vid, "frames": frames}, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser(description="抖音网页版互动工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="扫码登录")
    p_login.add_argument("--cookie", default=DEFAULT_COOKIE)

    p_cdp = sub.add_parser("cdp-start", help="启动带调试端口的真 Chrome（供 CDP 发评论）")

    p_feed = sub.add_parser("feed", help="刷 feed 采集视频")
    p_feed.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_feed.add_argument("--scrolls", type=int, default=8)
    p_feed.add_argument("--out", default="-")
    p_feed.add_argument("--headed", action="store_true", help="有头模式（反爬更稳）")

    p_comment = sub.add_parser("comment", help="发评论")
    p_comment.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_comment.add_argument("--vid", required=True)
    p_comment.add_argument("--message", required=True)
    p_comment.add_argument("--at", default="", help="要真 @ 的用户昵称（输入 @ 后点选该用户，形成真实提及、会弹通知）；空则纯文本/不 @")
    p_comment.add_argument("--dry", action="store_true", default=True, help="只打印不真发（默认开）")
    p_comment.add_argument("--go", dest="dry", action="store_false", help="真发")
    p_comment.add_argument("--cdp", action="store_true", help="用 CDP 真浏览器发（绕过风控）")

    p_comments = sub.add_parser("comments", help="读评论")
    p_comments.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_comments.add_argument("--vid", required=True)
    p_comments.add_argument("--out", default="-")
    p_comments.add_argument("--headed", action="store_true")

    p_share = sub.add_parser("share", help="原生分享视频卡片给好友（hover 分享面板，不是文字链接）")
    p_share.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_share.add_argument("--vid", required=True)
    p_share.add_argument("--friend", required=True, help="好友昵称（面板里按名字找）")
    p_share.add_argument("--dry", action="store_true", default=True)
    p_share.add_argument("--go", dest="dry", action="store_false")
    p_share.add_argument("--cdp", action="store_true")
    p_share.add_argument("--headless", action="store_true")

    p_dm = sub.add_parser("dm-send", help="发私信（分享视频给好友）")
    p_dm.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_dm.add_argument("--sec-uid", required=True, help="好友 sec_uid（唯一）")
    p_dm.add_argument("--name", default="", help="好友昵称（仅日志显示）")
    p_dm.add_argument("--message", required=True)
    p_dm.add_argument("--dry", action="store_true", default=True)
    p_dm.add_argument("--go", dest="dry", action="store_false")
    p_dm.add_argument("--cdp", action="store_true")
    p_dm.add_argument("--headless", action="store_true", help="无头后台（静默）")

    p_dmread = sub.add_parser("dm-read", help="读某会话最近消息（带方向）")
    p_dmread.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_dmread.add_argument("--sec-uid", required=True, help="好友 sec_uid（唯一）")
    p_dmread.add_argument("--name", default="", help="好友昵称（仅日志显示）")
    p_dmread.add_argument("--n", type=int, default=20)
    p_dmread.add_argument("--headless", action="store_true", help="无头后台（静默）")
    p_dmread.add_argument("--out", default="-")

    p_myvids = sub.add_parser("my-videos", help="扫自己的投稿列表（运营用）")
    p_myvids.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_myvids.add_argument("--sec-uid", required=True)
    p_myvids.add_argument("--out", default="-")
    p_myvids.add_argument("--headed", action="store_true")

    p_creply = sub.add_parser("comment-reply", help="回复自己视频下的某条评论（按评论文本定位）")
    p_creply.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_creply.add_argument("--vid", required=True)
    p_creply.add_argument("--match", required=True, help="目标评论文本前缀（定位用）")
    p_creply.add_argument("--text", required=True, help="回复内容")
    p_creply.add_argument("--dry", action="store_true", default=True)
    p_creply.add_argument("--go", dest="dry", action="store_false")
    p_creply.add_argument("--headed", action="store_true")

    p_self = sub.add_parser("self-info", help="读当前登录账号自己的资料（昵称/sec_uid）")
    p_self.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_self.add_argument("--out", default="-")

    p_frames = sub.add_parser("frames", help="截视频画面 N 帧（视觉理解采样）")
    p_frames.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_frames.add_argument("--vid", required=True)
    p_frames.add_argument("--out", required=True, help="帧图输出目录")
    p_frames.add_argument("--n", type=int, default=3, help="帧数（1~6）")
    p_frames.add_argument("--headed", action="store_true")

    p_dmlist = sub.add_parser("dm-list", help="读私信会话列表")
    p_dmlist.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_dmlist.add_argument("--out", default="-")

    p_reply = sub.add_parser("reply", help="回复评论")
    p_reply.add_argument("--cookie", default=DEFAULT_COOKIE)
    p_reply.add_argument("--vid", required=True)
    p_reply.add_argument("--cid", required=True, help="被回复评论的 cid")
    p_reply.add_argument("--message", required=True)
    p_reply.add_argument("--at", default="", help="要真 @ 的用户昵称")
    p_reply.add_argument("--dry", action="store_true", default=True, help="只打印不真发（默认开）")
    p_reply.add_argument("--go", dest="dry", action="store_false", help="真发")
    p_reply.add_argument("--cdp", action="store_true", help="用 CDP 真浏览器发（绕过风控）")

    args = ap.parse_args()
    if args.cmd == "login":
        sys.exit(asyncio.run(cmd_login(args.cookie)))
    elif args.cmd == "cdp-start":
        sys.exit(cmd_cdp_start())
    elif args.cmd == "feed":
        sys.exit(asyncio.run(cmd_feed(args.cookie, args.scrolls, args.out, args.headed)))
    elif args.cmd == "comment":
        sys.exit(asyncio.run(cmd_comment(args.cookie, args.vid, args.message, args.dry, args.cdp, args.at)))
    elif args.cmd == "comments":
        sys.exit(asyncio.run(cmd_comments(args.cookie, args.vid, args.out, args.headed)))
    elif args.cmd == "reply":
        sys.exit(asyncio.run(cmd_reply(args.cookie, args.vid, args.cid, args.message, args.dry, args.cdp, args.at)))
    elif args.cmd == "share":
        sys.exit(asyncio.run(cmd_share(args.cookie, args.vid, args.friend, args.dry, args.cdp, args.headless)))
    elif args.cmd == "dm-send":
        sys.exit(asyncio.run(cmd_dm_send(args.cookie, args.sec_uid, args.message, args.dry, args.cdp, args.name, args.headless)))
    elif args.cmd == "dm-list":
        sys.exit(asyncio.run(cmd_dm_list(args.cookie, args.out)))
    elif args.cmd == "dm-read":
        sys.exit(asyncio.run(cmd_dm_read(args.cookie, args.sec_uid, args.n, args.out, args.name, args.headless)))
    elif args.cmd == "my-videos":
        sys.exit(asyncio.run(cmd_my_videos(args.cookie, args.sec_uid, args.out, args.headed)))
    elif args.cmd == "comment-reply":
        sys.exit(asyncio.run(cmd_comment_reply(args.cookie, args.vid, args.match, args.text, args.dry, args.headed)))
    elif args.cmd == "self-info":
        sys.exit(asyncio.run(cmd_self_info(args.cookie, args.out)))
    elif args.cmd == "frames":
        sys.exit(asyncio.run(cmd_frames(args.cookie, args.vid, args.out, args.n, args.headed)))


if __name__ == "__main__":
    main()
