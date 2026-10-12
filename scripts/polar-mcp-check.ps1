# Read-only check that the Polar SANDBOX MCP server is connected (lists organizations and products).
$claude = 'C:\Users\Korman\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.295\d2e29494ec83\claude.exe'
& $claude -p 'List my Polar sandbox organizations and their products. Read only, change nothing.' --allowedTools 'mcp__polar-sandbox'
