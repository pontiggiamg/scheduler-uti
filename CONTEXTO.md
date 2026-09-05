# CONTEXTO.md — leer esto primero, siempre

> Este archivo existe porque las conversaciones de Claude tienen memoria limitada:
> cuando se alargan, se resumen solas y se pierden detalles finos (una vez se
> "olvidó" que habíamos trabajado en la pestaña de Laura desde la notebook). Este
> archivo vive en git, no en una conversación — así que nunca se resume ni se
> pierde. **Cualquier sesión de Claude que retome este proyecto —esta misma
> conversación después de un resumen, o una conversación nueva en cualquiera de
> las dos computadoras— tiene que leer este archivo ANTES de tocar nada.**
>
> Gonzalo: si en algún momento Claude hace algo que contradice lo que dice acá,
> mandale el link a este archivo o pegale el contenido. Y cuando cerremos algo
> importante, pedile que lo actualice antes de terminar.

## Qué es esto

Scheduler de la residencia de UTI: quién está en sala, quién de guardia, quién
rota afuera, vacaciones, pases de guardia, votaciones internas (Chipa, Laura),
registro de procedimientos y clases, relevamiento diario para RedCap. Lo usan
los residentes (12 + jefe) y, sin login, el resto del hospital para ver "quién
está hoy" y los teléfonos internos.

**Stack**: React + Vite, Firebase Firestore (base de datos), desplegado en
Vercel. Las funciones de `api/` corren como serverless functions de Vercel con
una credencial de servicio (ver `api/_admin.js`), no como el navegador.

## Dónde vive el código

- **Repo real (con git)**: `C:\Users\gonza\dev\uti` en las dos máquinas
  (PC de escritorio y notebook). Fuera de OneDrive a propósito — ver más abajo.
- **GitHub**: `github.com/pontiggiamg/scheduler-uti`, rama `main`. Es la
  verdad última: cualquier máquina, en cualquier momento, se pone al día
  bajando de ahí.
- **Acceso directo en el Escritorio**: un ícono "Scheduler UTI" que abre esa
  carpeta. NO es la carpeta real — es un atajo. El Escritorio de Windows de
  Gonzalo está redirigido a OneDrive (`OneDrive\Desktop`), y meter un repo git
  ahí adentro (con `.git` y `node_modules`, miles de archivos internos) tiende
  a corromperse porque OneDrive y git pelean por los mismos archivos al mismo
  tiempo. Por eso el repo vive afuera de OneDrive y solo el ícono está en el
  Escritorio.

## Cómo trabajar entre las dos computadoras

Dos scripts en la raíz del repo, pensados para no tener que acordarse de git:

- **`bajar-cambios.ps1`** — correr ANTES de empezar a trabajar, sobre todo si
  se cambió de máquina. Trae lo último de GitHub.
- **`subir-cambios.ps1`** — correr AL TERMINAR. Guarda los cambios locales,
  los mezcla con lo que haya nuevo en GitHub, y sube todo.

**Limitación importante de Cowork (la herramienta con la que Claude trabaja
acá)**: una conversación de Cowork queda "vinculada" a la computadora desde la
que se abrió por primera vez, no a la que se está usando en cada momento. Si
Gonzalo escribe desde la notebook en una conversación que se vinculó original-
mente a la PC de escritorio, Claude sigue viendo el disco de la PC de
escritorio, no el de la notebook — no es un bug, es cómo funciona la
herramienta. Cuando esto pasa, Claude no puede tocar archivos directo en la
máquina "equivocada". Por eso conviene:
1. Usar siempre la MISMA conversación para trabajar en este proyecto (el chat
   viaja entre dispositivos aunque el acceso a archivos no).
2. Si Claude pide correr algo por PowerShell en vez de hacerlo directo, es por
   esto — no significa que algo esté roto.

**Método que funciona desde CUALQUIER máquina, sin depender de a cuál esté
"vinculada" la conversación (5/9/2026)**: cuando Gonzalo no está en la
computadora a la que quedó vinculada la conversación —el caso real: está en el
hospital con la notebook, o cualquier lugar sin la desktop a mano— Claude manda
el/los archivo(s) cambiados como tarjetas descargables en el chat (ya lo venía
haciendo para otras cosas). Gonzalo los baja (van a Descargas) y corre un
script cortito que los mueve a su lugar en el repo y llama a
`subir-cambios.ps1`. No depende de ningún "puente" de Cowork a ninguna
computadora — solo necesita el repo clonado y una terminal, en cualquier
máquina. Este es el método por default cuando Claude no tiene acceso directo a
donde está Gonzalo; el acceso directo (cuando coincide con la máquina
vinculada) es solo una comodidad cuando está disponible, nunca un requisito.

## Decisiones importantes ya tomadas (no volver a discutir desde cero)

- **5/9/2026 — Sistema de roles reemplaza a los "12 residentes hardcodeados"**:
  antes había una lista fija de emails con acceso total más un sistema de
  aprobación manual (`usuarios_autorizados`). Ahora cualquier cuenta se asigna
  un rol desde la pestaña Accesos (colección `cuentas` en Firestore), y qué
  pestañas ve cada rol se configura en vivo desde ahí también
  (`scheduler/roles_config`). El admin (Gonzalo) siempre ve todo, fijo por
  mail en las reglas — nunca depende de la colección `cuentas`, para no poder
  quedarse afuera de su propia base.
- **5/9/2026 — Reglas de Firestore en versión ESTRICTA, ya publicada**: todas
  las cuentas reales tenían rol asignado, así que se activó `firestore.rules`
  (exige `exists(cuentas/{email})`) y se dejó de usar
  `firestore-TRANSICION.rules` (que dejaba entrar a cualquier logueado). Sacarle
  el rol a alguien desde Accesos ahora sí lo bloquea de verdad — es justo lo
  que Gonzalo pidió: poder dar de baja un acceso sin que la persona pueda
  evitarlo desde el cliente. El archivo de transición se deja en el repo por si
  hiciera falta un rollback de emergencia, pero NO está publicado.
- **5/9/2026 — Accesos: filtro de actividad**: cada cuenta con rol muestra un
  punto verde/gris y "hace X min/h/d" según si entró en las últimas 24 hs
  (se lee de `access_logs`, que ya se escribía en cada carga de página — no
  hizo falta agregar tracking nuevo). Hay un botón para filtrar la lista a
  solo las activas. Ojo: "activo" es "tuvo la app abierta en algún momento de
  las últimas 24 hs", NO "la tiene abierta ahora mismo" — eso último (presencia
  en vivo) es una función distinta, todavía no pedida en firme.
- **5/9/2026 — Comodines en las hojas impresas**: en vez de armar un cuarto
  equipo manual en `scheduler/equipos` (que hubiera duplicado el dato), la
  hoja impresa lee los comodines ya marcados semana a semana y los muestra
  como un equipo más, con 🃏. En la hoja de mes se muestra la unión de quienes
  fueron comodín en alguna semana de ese mes.
- **5/9/2026 — Botón de eliminar acceso**: cada cuenta con rol tiene un 🗑️
  aparte del selector (bajar a "Sin rol…" desde el desplegable quedó sacado a
  propósito, para que sea una acción explícita con confirmación, no un click
  de más). Borra el rol, no el historial de la persona.
- **5/9/2026 — Limpieza automática de cuentas sin rol**: una cuenta que entró
  sin que se le asigne rol desaparece sola de la lista "⚠️ Sin rol asignado" a
  las 48 hs de su último ingreso (al toque en la pantalla, y de la base de
  verdad una vez por día vía `api/limpiar-accesos.js`, agregado como cron en
  `vercel.json`). Objetivo: que gente que entra una vez sin que a Gonzalo le
  interese darle acceso no ensucie esa lista para siempre. Si la cuenta vuelve
  a entrar, reaparece — no queda bloqueada ni marcada de ninguna forma.
  **Pendiente de Gonzalo**: configurar la variable de entorno `CRON_SECRET` en
  Vercel (Settings → Environment Variables, cualquier texto largo al azar) para
  que ese endpoint no quede abierto a cualquiera; sin ella igual funciona, pero
  menos seguro.
- **El bug real de "los comodines no se guardan"**: no era el guardado, era la
  LECTURA. `normalize()` en `modelo.jsx` armaba la semana copiando campo por
  campo desde `emptyWeek()`, y el campo `comodines` no estaba en esa lista —
  se descartaba cada vez que se leía de Firestore (cada recarga, cada eco del
  guardado). Arreglado agregando `comodines` a `emptyWeek()` y a `normalize()`.
  El arreglo del beacon de emergencia (`sendBeacon` en `nube.jsx`) sigue
  siendo válido y necesario para el caso de cerrar la pestaña con algo recién
  tipeado sin confirmar — pero no era la causa de este bug puntual.
- **Rotaciones de duración variable**: se puede asignar una rotación externa
  por tramos de semana (ej. "3ª-4ª semana"), no solo el mes completo. Catálogo
  en `TRAMOS_ROTACION` (config.jsx), lógica en `rotacionEseDia()` (modelo.jsx).
- **Matemática del cupo de guardias R4**: 14 guardias/mes ÷ 4 residentes R4 
  fuerza siempre la distribución 4+4+3+3 — no hay otra forma de repartirlo.
  En un año eso da exactamente 6 meses de 4 y 6 meses de 3 por persona (42
  guardias/año). El planteo de que la distribución es dispareja no tiene base
  matemática; lo que sí hay que resolver es la logística puntual de agosto
  2027 (una R4 rotando afuera, ver Hospital Güemes).

## Pendiente / a confirmar con Gonzalo

- [ ] Chequear en las primeras horas después de activar la regla estricta que
      nadie que debería tener acceso quedó afuera por error (ver Accesos →
      Cuentas → sección "⚠️ Sin rol asignado").
- [ ] Confirmar con el Hospital Güemes si Vani/Caro pueden cubrir guardias en
      el Británico durante su rotación externa de agosto 2027.
- [ ] Revisar la rama `respaldo-notebook-laura` (trabajo del 4/9 hecho en la
      notebook sobre la pestaña de Laura) y confirmar si algo de ahí hace
      falta traer a `main`, o si ya quedó cubierto por el commit `c58bc47`
      que ya está en `main`.
- [ ] Confirmar que el arreglo de comodines (guardar y F5) quedó funcionando
      en producción, en ambas máquinas.
- [ ] Probar en producción que las rotaciones por tramo de semana dejan
      disponible/no disponible a la persona correctamente.
- [ ] Probar en producción que los comodines aparecen bien en las hojas
      impresas (semana y mes).
- [ ] Decidir si hace falta una señal de "en vivo, ahora mismo" en Accesos
      (además del "activo en las últimas 24 hs" que ya existe) — se mencionó
      pero no se pidió en firme.

## Convención de esta bitácora

Cuando se cierre algo importante, agregar una línea a "Decisiones importantes"
con la fecha, y sacar el ítem correspondiente de "Pendiente" si corresponde.
No hace falta detallar cada cambio chico — esto es para las decisiones que, si
se pierden, generan confusión o retrabajo (como pasó hoy).
