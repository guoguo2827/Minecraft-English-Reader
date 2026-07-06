$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\outputs")
$port = 8000
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
$listener.Start()

function Get-ContentType([string]$path) {
  switch -Regex ($path.ToLowerInvariant()) {
    '\.html?$' { return 'text/html; charset=utf-8' }
    '\.css$' { return 'text/css; charset=utf-8' }
    '\.js$' { return 'application/javascript; charset=utf-8' }
    '\.webp$' { return 'image/webp' }
    '\.png$' { return 'image/png' }
    '\.jpg$|\.jpeg$' { return 'image/jpeg' }
    default { return 'application/octet-stream' }
  }
}

function Send-Response($stream, [int]$status, [string]$statusText, [byte[]]$body, [string]$contentType) {
  $header = "HTTP/1.1 $status $statusText`r`nContent-Length: $($body.Length)`r`nContent-Type: $contentType`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($body.Length -gt 0) {
    $stream.Write($body, 0, $body.Length)
  }
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $buffer = New-Object byte[] 4096
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { continue }

    $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
    $firstLine = ($request -split "`r?`n")[0]
    $parts = $firstLine -split ' '
    $urlPath = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
    $urlPath = ($urlPath -split '\?')[0]
    $urlPath = [Uri]::UnescapeDataString($urlPath)
    if ($urlPath -eq "/") { $urlPath = "/index.html" }

    $relative = $urlPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    $rootPath = [System.IO.Path]::GetFullPath($root)

    if (-not $fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      $body = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
      Send-Response $stream 404 "Not Found" $body "text/plain; charset=utf-8"
      continue
    }

    $body = [System.IO.File]::ReadAllBytes($fullPath)
    Send-Response $stream 200 "OK" $body (Get-ContentType $fullPath)
  } catch {
    try {
      $body = [System.Text.Encoding]::UTF8.GetBytes("Server Error")
      Send-Response $stream 500 "Server Error" $body "text/plain; charset=utf-8"
    } catch {}
  } finally {
    $client.Close()
  }
}
