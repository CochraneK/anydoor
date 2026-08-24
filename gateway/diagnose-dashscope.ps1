param(
  [string]$ApiKey = $env:DASHSCOPE_API_KEY,
  [string]$BaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Write-Error 'Set DASHSCOPE_API_KEY to the Model Studio API Key (usually sk-...), not an Aliyun AccessKey Secret.'
  exit 2
}

$shape = if ($ApiKey -like 'sk-*') { 'dashscope-api-key-shape' } elseif ($ApiKey -like 'LTAI*') { 'aliyun-access-key-id-shape' } else { 'unknown-shape' }
Write-Output ("credential_shape=" + $shape)
if ($shape -ne 'dashscope-api-key-shape') {
  Write-Error 'The compatible endpoint expects a DashScope API Key. Create/copy one in Model Studio > Key Management; do not paste AccessKey ID/Secret here.'
  exit 3
}

try {
  $response = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/models') -Headers @{ Authorization = "Bearer $ApiKey" } -Method Get -TimeoutSec 30
  Write-Output ('models_ok=' + ([bool]$response.data))
} catch {
  Write-Error ('DashScope request failed: ' + $_.Exception.Message)
  exit 4
}
