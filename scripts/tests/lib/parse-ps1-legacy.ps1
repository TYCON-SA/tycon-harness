# parse-ps1-legacy.ps1 - lee cada archivo como lo lee Windows PowerShell 5.1 y cuenta sus errores de sintaxis.
#
# Windows PowerShell 5.1 decodifica un .ps1 sin marca de codificacion (BOM) como Windows-1252; con la marca, como UTF-8.
# Aca se reproduce esa decodificacion y se le pasa el texto al analizador de PowerShell (el mismo motor en 5.1 y en 7
# para lo que importa: que caracteres cuentan como comillas). Lo usa scripts/tests/ps1-readable.test.js.
#
# Uso:    pwsh -NoProfile -File parse-ps1-legacy.ps1 <archivo> [<archivo> ...]
# Salida: una linea por archivo:
#   <errores><TAB><1 si tiene BOM, 0 si no><TAB><archivo><TAB><el primer error><TAB><sintaxis solo de 7><TAB><la primera>
# "Sintaxis solo de 7": los operadores que el analizador de PowerShell 7 acepta y el de 5.1 no (??, ??=, ?., ?[, &&, ||
# y el ternario). El analizador de esta maquina es el de 7: no los da por error, asi que se cuentan aparte, por su tipo
# de token. Con uno solo, 5.1 no puede leer el archivo.
# Sale 0 si pudo mirar todos; 2 si alguno no se pudo leer.
#
# Este archivo va en ASCII a proposito: es la herramienta que mide a los demas.
$ErrorActionPreference = 'Stop'
[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
$legacy = [System.Text.Encoding]::GetEncoding(1252)
$code = 0
foreach ($f in $args) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path (Get-Location) $f))
    } catch {
        [Console]::Error.WriteLine("no pude leer ${f}: $($_.Exception.Message)")
        $code = 2
        continue
    }
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if ($hasBom) { $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3) }
    else { $text = $legacy.GetString($bytes) }
    $tokens = $null
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errs)
    $first = ''
    if ($errs.Count -gt 0) { $first = "L$($errs[0].Extent.StartLineNumber): $($errs[0].Message)" -replace "[`t`r`n]", ' ' }
    $bomFlag = 0
    if ($hasBom) { $bomFlag = 1 }
    $newOnly = @($tokens | Where-Object { @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark') -contains [string]$_.Kind })
    $newFirst = ''
    if ($newOnly.Count -gt 0) { $newFirst = "L$($newOnly[0].Extent.StartLineNumber): $($newOnly[0].Kind)" }
    Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $errs.Count, $bomFlag, $f, $first, $newOnly.Count, $newFirst)
}
exit $code
