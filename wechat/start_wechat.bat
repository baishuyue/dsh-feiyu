@echo off
rem 双击启动微信机器人（无控制台窗口，日志在 %USERPROFILE%\.feiyu-ai\wechat-bot.log）
rem 单实例：如果已经有一个在跑，新起的这个会立刻自己退出，不会重复回复。
cd /d "%~dp0"
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0wechat_bot.py"
