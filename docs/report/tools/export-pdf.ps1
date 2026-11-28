# Opens a .docx in Word, updates the contents and the lists of figures and tables, saves, and exports a PDF next to it
# with bookmarks from the headings and the document properties (title, subject, keywords) set by md-to-docx.cjs.
# usage: pwsh export-pdf.ps1 C:\path\report.docx
# Word often throws RPC_E_DISCONNECTED after the export: the .docx and .pdf are already written; check them.
param([string]$Docx)
$Docx = (Resolve-Path $Docx).Path
$pdf = [IO.Path]::ChangeExtension($Docx, ".pdf")
$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
try {
  $d = $w.Documents.Open($Docx, $false, $false)
  $d.Fields.Update() | Out-Null
  # twice: the lists of figures and tables add pages, which moves the page numbers in the contents
  foreach ($pass in 1..2) { $d.TablesOfContents | ForEach-Object { $_.Update() } }
  $d.Save()
  # ExportAsFixedFormat(path, wdExportFormatPDF=17, open=false, wdExportOptimizeForPrint=0, wdExportAllDocument=0,
  #   from, to, wdExportDocumentContent=0, IncludeDocProps, KeepIRM, wdExportCreateHeadingBookmarks=1,
  #   DocStructureTags, BitmapMissingFonts, UseISO19005_1)
  $d.ExportAsFixedFormat($pdf, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
  $d.Close(0)
} catch { Write-Host "Word: $($_.Exception.Message)" } finally { try { $w.Quit() } catch {} }
if (Test-Path $pdf) { "pdf: $pdf" } else { "no pdf" }
