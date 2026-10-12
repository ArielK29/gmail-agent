# Read-only status of the Polar SANDBOX through the authenticated Polar sandbox MCP server (no changes).
# No double quotes inside the prompt (Windows PowerShell 5.1 breaks them when calling a program).
$claude = 'C:\Users\Korman\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.295\d2e29494ec83\claude.exe'
$prompt = 'Read only, change nothing. For the Polar SANDBOX organization duofit-polar print a short table: (1) products with id, name, price, currency, interval, archived; (2) number of customers; (3) number of subscriptions by status; (4) number of orders; (5) which MCP tools you used. Never print any token or secret.'
& $claude -p $prompt --allowedTools 'mcp__polar-sandbox'
