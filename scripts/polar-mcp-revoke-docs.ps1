# Read-only: asks the Polar sandbox MCP for the documented way to revoke a subscription immediately (no change is made).
# No double quotes inside the prompt (Windows PowerShell 5.1 breaks them when calling a program).
$claude = 'C:\Users\Korman\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.295\d2e29494ec83\claude.exe'
$prompt = 'Read only, change nothing, never print any secret. Using the Polar tool descriptions (search_tools and describe_tools only, do NOT execute anything that changes data), report briefly: (1) which operation revokes a subscription immediately and which operation cancels it at period end; (2) for each: the HTTP method and path, the OAuth scope it needs, and what happens when the subscription is already canceled or revoked; (3) the operation that deletes a customer and its scope; (4) what happens to a customer that has external_id when the customer is deleted.'
& $claude -p $prompt --allowedTools 'mcp__polar-sandbox'
