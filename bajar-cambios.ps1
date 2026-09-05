# ═══════════════════════════════════════════════════════════════════════════
#  bajar-cambios.ps1
#
#  Trae de GitHub los últimos cambios a esta compu — lo que hiciste (o lo que
#  hizo Claude) desde la otra máquina. Corré esto ANTES de empezar a trabajar
#  cada vez que cambiás de compu (PC de escritorio ↔ notebook).
#
#  Uso, parado en esta carpeta:
#      .\bajar-cambios.ps1
# ═══════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

function Salir($msg) {
    Write-Host "`n$msg" -ForegroundColor Red
    Write-Host "No se bajó nada. Avisale a Claude con este mensaje si no sabés qué hacer." -ForegroundColor Yellow
    exit 1
}

try {
    git rev-parse --is-inside-work-tree | Out-Null
} catch {
    Salir "Esta carpeta no es un repositorio de git. ¿Estás parado en la carpeta correcta?"
}

$cambiosLocales = git status --porcelain
if ($cambiosLocales) {
    Write-Host "⚠️  Tenés cambios locales sin subir todavía:" -ForegroundColor Yellow
    git status --short
    Write-Host "`nCorré primero .\subir-cambios.ps1 en la OTRA compu (o acá, si estos cambios son de acá) antes de bajar, para no perder nada." -ForegroundColor Yellow
    exit 1
}

Write-Host "=== Bajando lo último de GitHub ===" -ForegroundColor Cyan
git pull
if ($LASTEXITCODE -ne 0) { Salir "No se pudo bajar de GitHub. Revisá tu conexión a internet." }

Write-Host "`n✅ Listo. Tenés la última versión, lista para trabajar." -ForegroundColor Green
