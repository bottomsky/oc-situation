param(
    [string]$InputDocx = '',
    [Parameter(Mandatory = $true)][string]$OutputPdf,
    [switch]$CheckPaths
)
$ErrorActionPreference = 'Stop'
if (-not $InputDocx) {
    $InputDocx = Join-Path $PSScriptRoot '../../docs/product/海上智能态势与筹划分析产品方案.docx'
}
$InputDocx = (Resolve-Path -LiteralPath $InputDocx).Path
$OutputPdf = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPdf)
if (-not (Test-Path -LiteralPath (Split-Path -Parent $OutputPdf) -PathType Container)) {
    throw "输出目录不存在：$OutputPdf"
}
if ($CheckPaths) {
    Write-Output "Input: $InputDocx"
    Write-Output "Output: $OutputPdf"
    return
}
$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.Options.SaveNormalPrompt = $false
    $document = $word.Documents.Open($InputDocx, $false, $true, $false)
    $document.Repaginate()
    $document.ExportAsFixedFormat($OutputPdf, 17)
    Write-Output ('Pages: ' + $document.ComputeStatistics(2))
    Write-Output $OutputPdf
}
finally {
    if ($null -ne $document) {
        $document.Close(0)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
    }
    if ($null -ne $word) {
        $word.Quit(0)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
