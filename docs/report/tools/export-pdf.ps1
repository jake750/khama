# Opens a .docx in Word, updates the table of contents, saves, and exports a PDF next to it.
# usage: pwsh export-pdf.ps1 C:\path\report.docx
# Word often throws RPC_E_DISCONNECTED after the export: the .docx and .pdf are already written; check them.
param([string]$Docx)
$pdf = [IO.Path]::ChangeExtension($Docx, ".pdf")
$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
try {
  $d = $w.Documents.Open($Docx, $false, $false)
  $d.TablesOfContents | ForEach-Object { $_.Update() }
  $d.Save(); $d.ExportAsFixedFormat($pdf, 17); $d.Close(0)
} catch { Write-Host "Word: $($_.Exception.Message)" } finally { try { $w.Quit() } catch {} }
if (Test-Path $pdf) { "pdf: $pdf" } else { "no pdf" }
