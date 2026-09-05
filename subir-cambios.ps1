# ═══════════════════════════════════════════════════════════════════════════
#  subir-cambios.ps1
#
#  Guarda en GitHub todo lo que hayas cambiado en esta carpeta desde la
#  última vez. Hace CUATRO cosas, en este orden exacto:
#    1. Agrega todos los archivos modificados o nuevos.
#    2. Los guarda como un "commit" (una foto con fecha y hora) — ACÁ, en tu
#       compu, antes de tocar la red.
#    3. Baja lo que haya nuevo en GitHub (por si desde otra compu se subió
#       algo mientras tanto) y acomoda tu commit arriba de eso.
#    4. Sube todo a GitHub.
#
#  Ojo con el orden: el commit va ANTES del pull. Si se hiciera al revés,
#  git no te deja bajar cambios mientras tengas algo sin guardar en el medio
#  (con razón: no sabe si lo tuyo se puede llegar a perder) y el script se
#  frena ahí. Guardando primero tu propio commit, no hay nada "suelto" y el
#  paso de bajar cambios (rebase) puede hacerse tranquilo.
#
#  Uso, parado en esta carpeta:
#      .\subir-cambios.ps1
#      .\subir-cambios.ps1 "arreglé el cupo de guardias de julio"
#
#  Si no le pasás un mensaje, usa la fecha y hora como mensaje genérico.
# ═══════════════════════════════════════════════════════════════════════════

param(
    [string]$Mensaje = "Cambios del $(Get-Date -Format 'dd/MM/yyyy HH:mm')"
)

$ErrorActionPreference = "Stop"

function Salir($msg) {
    Write-Host "`n$msg" -ForegroundColor Red
    Write-Host "Avisale a Claude con este mensaje si no sabés qué hacer." -ForegroundColor Yellow
    exit 1
}

try {
    git rev-parse --is-inside-work-tree | Out-Null
} catch {
    Salir "Esta carpeta no es un repositorio de git. ¿Estás parado en la carpeta correcta?"
}

Write-Host "=== Esto es lo que hay para subir ===" -ForegroundColor Cyan
git status --short
$cambios = git status --porcelain
$habiaCambios = [bool]$cambios

if ($habiaCambios) {
    git add -A
    git commit -m "$Mensaje"
    if ($LASTEXITCODE -ne 0) { Salir "No se pudo crear el commit." }
} else {
    Write-Host "`nNo hay cambios locales nuevos. Igual reviso si falta subir algo de un commit anterior..." -ForegroundColor DarkGray
}

Write-Host "`n=== Bajando lo último de GitHub, por si otra compu subió algo ===" -ForegroundColor Cyan
git pull --rebase
if ($LASTEXITCODE -ne 0) {
    Salir "Hubo un conflicto al mezclar con lo que hay en GitHub. NO sigas solo: avisale a Claude y pegale la pantalla completa."
}

$faltaSubir = git log '@{u}..HEAD' --oneline
if (-not $faltaSubir) {
    Write-Host "`n✅ Ya estaba todo subido. No había nada pendiente." -ForegroundColor Green
    exit 0
}

git push
if ($LASTEXITCODE -ne 0) { Salir "No se pudo subir a GitHub. Revisá tu conexión a internet." }

Write-Host "`n✅ Listo. Tus cambios ya están en GitHub, disponibles desde cualquier compu." -ForegroundColor Green
