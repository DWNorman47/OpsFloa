/**
 * Help-page content. Edit this file to add or revise FAQ entries.
 *
 * Shape:
 *   { id, title, intro?, items: [{ q, a, keywords? }] }
 *
 * - `id` becomes the URL hash for deep links (`/help#approvals`).
 * - `intro` is an optional paragraph rendered above the Q&A list.
 *
 * Bilingual authoring:
 * - Human-readable fields (`title`, `intro`, item `q`, item `a`) are
 *   `{ en, es }` objects. When `a` is a list of paragraphs, `en`/`es`
 *   are each an array of strings.
 * - `id` and `keywords` stay as plain values (keywords may include both
 *   English and Spanish terms so search works in either language).
 *
 * Consumers should NOT read `HELP_SECTIONS` directly for rendering; call
 * `getHelpSections(language)` to get sections resolved to the user's
 * language (falling back to English for anything untranslated).
 */

export const HELP_SECTIONS = [
  {
    id: 'getting-started',
    title: { en: 'Getting Started', es: 'Primeros pasos' },
    intro: {
      en: "If you're brand-new to OpsFloa, work through these in order. Most take about a minute each.",
      es: 'Si acabas de empezar con OpsFloa, sigue estos pasos en orden. La mayoría toma alrededor de un minuto.',
    },
    items: [
      {
        q: {
          en: 'How do I add my first team member?',
          es: '¿Cómo agrego a mi primer miembro del equipo?',
        },
        a: {
          en: 'Open Team in the AppSwitcher. Click "Add team member" and enter their name and email. They will get an invite link to set their own password. You can also create them with a temporary password if email is not reliable in their environment.',
          es: 'Abre Equipo en el AppSwitcher. Haz clic en "Agregar miembro del equipo" e ingresa su nombre y correo electrónico. Recibirá un enlace de invitación para establecer su propia contraseña. También puedes crearlo con una contraseña temporal si el correo no es confiable en su entorno.',
        },
      },
      {
        q: {
          en: 'How do I create projects people can clock in to?',
          es: '¿Cómo creo proyectos en los que la gente pueda registrar su entrada?',
        },
        a: {
          en: [
            'Open Projects in the AppSwitcher and click "New project". It only needs a name; everything else is optional.',
            'If your business does not track projects by job, route, case, or customer, create a single "General" project and use it for everything. People need one project available before they can clock in.',
          ],
          es: [
            'Abre Proyectos en el AppSwitcher y haz clic en "Nuevo proyecto". Solo necesita un nombre; todo lo demás es opcional.',
            'Si tu negocio no organiza los proyectos por trabajo, ruta, caso o cliente, crea un único proyecto "General" y úsalo para todo. La gente necesita al menos un proyecto disponible antes de poder registrar su entrada.',
          ],
        },
      },
      {
        q: {
          en: "Why don't I see Field, Inventory, or some other module?",
          es: '¿Por qué no veo Campo, Inventario u otro módulo?',
        },
        a: {
          en: 'Modules can be turned off per company under Administration > Workspace > Modules. New companies default to a minimal set and you turn on other tools as you need them.',
          es: 'Los módulos se pueden desactivar por empresa en Administración > Espacio de trabajo > Módulos. Las empresas nuevas comienzan con un conjunto mínimo y tú activas las demás herramientas conforme las necesites.',
        },
      },
      {
        q: {
          en: 'How do I switch between admin tools and clocking myself in?',
          es: '¿Cómo cambio entre las herramientas de administración y registrar mi propia entrada?',
        },
        a: {
          en: 'Click the AppSwitcher in the top-left. "Workforce" is the admin oversight view. "Time Clock" is the participating view, where you clock yourself in like the rest of the team.',
          es: 'Haz clic en el AppSwitcher en la parte superior izquierda. "Personal" es la vista de supervisión para administradores. "Reloj checador" es la vista de participación, donde registras tu propia entrada como el resto del equipo.',
        },
      },
    ],
  },
  {
    id: 'time-tracking',
    title: { en: 'Time Tracking', es: 'Registro de tiempo' },
    items: [
      {
        q: {
          en: "What's the difference between hourly and daily team members?",
          es: '¿Cuál es la diferencia entre los miembros por hora y por día?',
        },
        a: {
          en: [
            'Hourly people clock in, clock out, and get paid for elapsed time.',
            'Daily-rate people get paid a flat rate per day worked. You can have them clock in/out as usual or enable "Mark Day mode" on their profile so they tap one button to record presence.',
          ],
          es: [
            'Las personas por hora registran su entrada, registran su salida y se les paga por el tiempo transcurrido.',
            'Las personas con tarifa diaria reciben una tarifa fija por cada día trabajado. Puedes hacer que registren entrada/salida como de costumbre o activar el "modo Marcar día" en su perfil para que registren su presencia con un solo botón.',
          ],
        },
      },
      {
        q: {
          en: 'How does overtime work?',
          es: '¿Cómo funcionan las horas extra?',
        },
        a: {
          en: 'Set the rule under Administration > Workspace > Overtime. "Daily" pays OT after a per-day threshold. "Weekly" pays OT after a per-week total. You can override OT on a per-entry basis from the Approvals tab when a specific entry needs different treatment.',
          es: 'Configura la regla en Administración > Espacio de trabajo > Horas extra. "Diaria" paga horas extra después de un límite por día. "Semanal" paga horas extra después de un total por semana. Puedes ajustar las horas extra por registro individual desde la pestaña Aprobaciones cuando un registro específico requiera un tratamiento diferente.',
        },
      },
      {
        q: {
          en: 'Someone clocked in but is not showing on Live',
          es: 'Alguien registró su entrada pero no aparece en En vivo',
        },
        a: {
          en: 'Live polls every minute, so wait a moment or hit Refresh. If they still do not appear, check that they selected a project on clock-in. If their browser blocked location access, the clock-in still goes through but you will get a "Location denied" alert in the bell.',
          es: 'En vivo se actualiza cada minuto, así que espera un momento o presiona Actualizar. Si aún no aparece, verifica que haya seleccionado un proyecto al registrar su entrada. Si su navegador bloqueó el acceso a la ubicación, el registro de entrada se realiza igual, pero recibirás una alerta de "Ubicación denegada" en la campana.',
        },
      },
      {
        q: {
          en: 'Can people edit their own time after submitting?',
          es: '¿Puede la gente editar su propio tiempo después de enviarlo?',
        },
        a: {
          en: 'Yes, within 7 days and as long as the entry is not in a locked pay period. They cannot edit entries you have already approved. If you want to disable self-editing entirely, use the company setting under Administration > Workspace.',
          es: 'Sí, dentro de los 7 días y siempre que el registro no esté en un período de pago bloqueado. No pueden editar registros que ya hayas aprobado. Si quieres desactivar por completo la autoedición, usa la configuración de la empresa en Administración > Espacio de trabajo.',
        },
      },
      {
        q: {
          en: 'What does "Mark Day" do for daily-rate people?',
          es: '¿Qué hace "Marcar día" para las personas con tarifa diaria?',
        },
        a: {
          en: 'For daily-rate team members with Mark Day mode enabled, clock-in and clock-out collapse into one button. Useful for piece-rate, per-diem, or presence-based work where exact hours do not affect pay.',
          es: 'Para los miembros con tarifa diaria que tienen activado el modo Marcar día, el registro de entrada y salida se combina en un solo botón. Es útil para trabajo a destajo, por viáticos o basado en presencia, donde las horas exactas no afectan el pago.',
        },
      },
      {
        q: {
          en: 'How does someone request time off or PTO?',
          es: '¿Cómo solicita alguien tiempo libre o vacaciones pagadas (PTO)?',
        },
        keywords: ['time off', 'PTO', 'vacation', 'leave', 'sick day', 'request leave', 'absence', 'tiempo libre', 'vacaciones', 'permiso', 'día por enfermedad', 'ausencia', 'solicitar permiso'],
        a: {
          en: 'Open Time Clock > Time Off. Pick the dates, choose the request type, add a note if needed, and submit. Admins review requests from the workforce time-off tools.',
          es: 'Abre Reloj checador > Tiempo libre. Elige las fechas, selecciona el tipo de solicitud, agrega una nota si es necesario y envíala. Los administradores revisan las solicitudes desde las herramientas de tiempo libre del personal.',
        },
      },
    ],
  },
  {
    id: 'approvals',
    title: { en: 'Approvals & Edits', es: 'Aprobaciones y ediciones' },
    items: [
      {
        q: {
          en: 'How do I approve time entries?',
          es: '¿Cómo apruebo los registros de tiempo?',
        },
        a: {
          en: 'Workforce > Approvals. Each entry has Approve and Reject buttons. You can also edit times before approving, or split an entry across multiple projects if someone worked on more than one job, route, case, or customer in a single shift.',
          es: 'Personal > Aprobaciones. Cada registro tiene botones de Aprobar y Rechazar. También puedes editar los horarios antes de aprobar, o dividir un registro entre varios proyectos si alguien trabajó en más de un trabajo, ruta, caso o cliente en un mismo turno.',
        },
      },
      {
        q: {
          en: 'Someone clocked the wrong day. How do I fix it?',
          es: 'Alguien registró el día equivocado. ¿Cómo lo corrijo?',
        },
        a: {
          en: 'Workforce > Approvals > click Edit on the entry. Change the Date input to the correct day and Save. The change is recorded in the audit log.',
          es: 'Personal > Aprobaciones > haz clic en Editar en el registro. Cambia el campo de Fecha al día correcto y guarda. El cambio queda registrado en el historial de auditoría.',
        },
      },
      {
        q: {
          en: 'What does "lock a pay period" mean?',
          es: '¿Qué significa "bloquear un período de pago"?',
        },
        a: {
          en: 'Locking freezes every entry in a date range so it cannot be edited once you have closed the books on it. Use it after you have exported or paid out a period. Workforce > Approvals > Pay Periods.',
          es: 'Bloquear congela todos los registros de un rango de fechas para que no se puedan editar una vez que has cerrado la contabilidad de ese período. Úsalo después de exportar o pagar un período. Personal > Aprobaciones > Períodos de pago.',
        },
      },
      {
        q: {
          en: 'I rejected an entry by mistake. Can I undo it?',
          es: 'Rechacé un registro por error. ¿Puedo deshacerlo?',
        },
        a: {
          en: 'A rejected entry stays in the system as "rejected"; it is not deleted. The person can resubmit, and you can also unreject from the entry detail view.',
          es: 'Un registro rechazado permanece en el sistema como "rechazado"; no se elimina. La persona puede volver a enviarlo, y tú también puedes revertir el rechazo desde la vista de detalle del registro.',
        },
      },
    ],
  },
  {
    id: 'roles-permissions',
    title: { en: 'Roles & Permissions', es: 'Roles y permisos' },
    items: [
      {
        q: {
          en: "What's the difference between Team Member, Admin, and Owner?",
          es: '¿Cuál es la diferencia entre Miembro del equipo, Administrador y Propietario?',
        },
        a: {
          en: [
            'Team Member is the default participating role. They clock themselves in, see their own entries, and may submit reports or checklists depending on what is enabled.',
            'Admin includes oversight: approve entries, manage people and projects, view reports, and run exports.',
            'Owner includes billing, role management, and company-level control. Each company gets one Owner by default: the person who registered.',
          ],
          es: [
            'Miembro del equipo es el rol participante predeterminado. Registran su propia entrada, ven sus propios registros y pueden enviar reportes o listas de verificación según lo que esté activado.',
            'Administrador incluye la supervisión: aprobar registros, gestionar personas y proyectos, ver reportes y realizar exportaciones.',
            'Propietario incluye la facturación, la gestión de roles y el control a nivel de empresa. Cada empresa tiene un Propietario de forma predeterminada: la persona que se registró.',
          ],
        },
      },
      {
        q: {
          en: 'Can I create a custom role?',
          es: '¿Puedo crear un rol personalizado?',
        },
        a: {
          en: 'Yes. Team > Manage Roles lets you pick which Team Member or Admin permissions a custom role gets. Useful for a lead who approves entries but should not manage billing, or office staff who need reports without every admin control.',
          es: 'Sí. Equipo > Gestionar roles te permite elegir qué permisos de Miembro del equipo o Administrador recibe un rol personalizado. Es útil para un líder que aprueba registros pero no debe gestionar la facturación, o para personal de oficina que necesita reportes sin todos los controles de administración.',
        },
      },
      {
        q: {
          en: 'I removed a permission from someone but they still see the tab',
          es: 'Le quité un permiso a alguien pero todavía ve la pestaña',
        },
        a: {
          en: 'They need to refresh or log out and back in. Permissions are computed on login and cached in the session. The next auth refresh also picks up the change automatically.',
          es: 'Necesita actualizar la página o cerrar sesión y volver a iniciarla. Los permisos se calculan al iniciar sesión y se guardan en caché durante la sesión. La siguiente renovación de autenticación también aplica el cambio automáticamente.',
        },
      },
    ],
  },
  {
    id: 'reports-exports',
    title: { en: 'Reports & Exports', es: 'Reportes y exportaciones' },
    items: [
      {
        q: {
          en: 'How do I export hours for payroll?',
          es: '¿Cómo exporto las horas para la nómina?',
        },
        a: {
          en: 'Workforce > Reports > Export. Pick a date range and download as CSV. The Payroll Export tile formats columns the way most payroll providers expect.',
          es: 'Personal > Reportes > Exportar. Elige un rango de fechas y descárgalo como CSV. El mosaico de Exportación de nómina da formato a las columnas como lo esperan la mayoría de los proveedores de nómina.',
        },
      },
      {
        q: {
          en: 'What is Certified Payroll?',
          es: '¿Qué es la Nómina Certificada (Certified Payroll)?',
        },
        a: {
          en: 'Certified Payroll, including federal form WH-347, is required for some prevailing-wage public work. Enable it under Administration > Workspace > Modules to get classification fields, fringe benefit tracking, signed weekly reports, and the WH-347 PDF generator.',
          es: 'La Nómina Certificada, incluido el formulario federal WH-347, es obligatoria para algunas obras públicas con salario prevaleciente. Actívala en Administración > Espacio de trabajo > Módulos para obtener campos de clasificación, seguimiento de prestaciones complementarias, reportes semanales firmados y el generador de PDF del formulario WH-347.',
        },
      },
      {
        q: {
          en: 'Can I see labor cost by project?',
          es: '¿Puedo ver el costo de mano de obra por proyecto?',
        },
        a: {
          en: 'Workforce > Reports > Project Reports. Filter by date range and project to see total hours and pay, if Show Wages is enabled.',
          es: 'Personal > Reportes > Reportes de proyecto. Filtra por rango de fechas y proyecto para ver el total de horas y el pago, si la opción Mostrar salarios está activada.',
        },
      },
    ],
  },
  {
    id: 'inventory',
    title: { en: 'Inventory', es: 'Inventario' },
    items: [
      {
        q: {
          en: 'How do I run an inventory count or cycle count?',
          es: '¿Cómo realizo un conteo de inventario o un conteo cíclico?',
        },
        keywords: ['inventory count', 'cycle count', 'stock count', 'physical count', 'reconcile stock', 'audit inventory', 'conteo de inventario', 'conteo cíclico', 'conteo físico', 'conciliar existencias', 'auditar inventario'],
        a: {
          en: 'Open Inventory > Counts. Create a full count or cycle count, choose what should be counted, enter the counted quantities, review variances, and reconcile only when the numbers are ready.',
          es: 'Abre Inventario > Conteos. Crea un conteo completo o un conteo cíclico, elige qué se debe contar, ingresa las cantidades contadas, revisa las diferencias y concilia solo cuando los números estén listos.',
        },
      },
      {
        q: {
          en: 'How do I receive items from a purchase order?',
          es: '¿Cómo recibo artículos de una orden de compra?',
        },
        keywords: ['receive inventory', 'receive PO', 'supplier order', 'stock delivery', 'recibir inventario', 'recibir orden de compra', 'pedido a proveedor', 'entrega de existencias'],
        a: {
          en: 'Open Inventory > Orders, open the submitted PO, choose Receive Items, pick the receiving location, and enter only the quantities that arrived.',
          es: 'Abre Inventario > Órdenes, abre la orden de compra enviada, elige Recibir artículos, selecciona la ubicación de recepción e ingresa solo las cantidades que llegaron.',
        },
      },
    ],
  },
  {
    id: 'billing',
    title: { en: 'Billing & Subscription', es: 'Facturación y suscripción' },
    items: [
      {
        q: {
          en: 'How do I update my payment method?',
          es: '¿Cómo actualizo mi método de pago?',
        },
        a: {
          en: 'Administration > Billing > Manage Subscription opens the Stripe customer portal where you can change card, view invoices, and cancel.',
          es: 'Administración > Facturación > Gestionar suscripción abre el portal de clientes de Stripe, donde puedes cambiar la tarjeta, ver las facturas y cancelar.',
        },
      },
      {
        q: {
          en: 'My trial is about to expire. What happens?',
          es: 'Mi período de prueba está por vencer. ¿Qué pasa?',
        },
        a: {
          en: 'You will see a banner starting 7 days before. If the trial ends and you have not subscribed, the app keeps your data but blocks team member login until you pick a plan. Admins can still log in to update billing.',
          es: 'Verás un aviso a partir de 7 días antes. Si el período de prueba termina y no te has suscrito, la app conserva tus datos pero bloquea el inicio de sesión de los miembros del equipo hasta que elijas un plan. Los administradores aún pueden iniciar sesión para actualizar la facturación.',
        },
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: { en: 'Troubleshooting', es: 'Solución de problemas' },
    items: [
      {
        q: {
          en: "I'm not getting notification bell or push alerts",
          es: 'No recibo la campana de notificaciones ni las alertas push',
        },
        a: {
          en: 'Open Account > Notifications. Team members and admins each need to grant browser notification permission once. On iOS, push notifications only work if OpsFloa is installed as a home-screen app.',
          es: 'Abre Cuenta > Notificaciones. Tanto los miembros del equipo como los administradores deben conceder el permiso de notificaciones del navegador una vez. En iOS, las notificaciones push solo funcionan si OpsFloa está instalada como app en la pantalla de inicio.',
        },
      },
      {
        q: {
          en: 'People say the app feels slow with bad signal',
          es: 'La gente dice que la app se siente lenta cuando hay mala señal',
        },
        a: {
          en: 'OpsFloa is a PWA: clock-in and clock-out work offline. Punches are queued locally and replayed when the device gets a signal. If someone consistently reports slowness, it is usually network latency.',
          es: 'OpsFloa es una PWA: el registro de entrada y salida funciona sin conexión. Los registros se guardan localmente en cola y se reenvían cuando el dispositivo recupera la señal. Si alguien reporta lentitud de forma constante, normalmente se debe a la latencia de la red.',
        },
      },
      {
        q: {
          en: 'A setting I changed did not seem to apply',
          es: 'Una configuración que cambié no pareció aplicarse',
        },
        a: {
          en: 'Most settings take effect immediately, but some cached state, like a permission list, only refreshes when the browser revalidates auth. A page refresh or quick logout/login picks up the change.',
          es: 'La mayoría de las configuraciones surten efecto de inmediato, pero algún estado en caché, como una lista de permisos, solo se actualiza cuando el navegador revalida la autenticación. Actualizar la página o cerrar e iniciar sesión rápidamente aplica el cambio.',
        },
      },
      {
        q: {
          en: 'I need help that is not answered here',
          es: 'Necesito ayuda que no se responde aquí',
        },
        a: {
          en: 'Open Administration > Account > Send a support message. Include screenshots or steps if the issue is hard to describe.',
          es: 'Abre Administración > Cuenta > Enviar un mensaje de soporte. Incluye capturas de pantalla o los pasos si el problema es difícil de describir.',
        },
      },
    ],
  },
];

/**
 * Resolve a bilingual field (`{ en, es }`, where each side may be a string
 * or an array of strings) to a plain value in the requested language,
 * falling back to English when the translation is missing.
 */
function resolveField(field, es) {
  if (field == null) return field;
  // Plain (non-bilingual) values pass through untouched.
  if (typeof field !== 'object' || Array.isArray(field)) return field;
  const value = es && field.es != null ? field.es : field.en;
  return value != null ? value : field.en;
}

/**
 * Return HELP_SECTIONS with every human-readable field resolved to the
 * user's language. Anything other than 'Spanish' is treated as English.
 *
 * @param {string} [language] - e.g. 'English' or 'Spanish'.
 */
export function getHelpSections(language) {
  const es = language === 'Spanish';
  return HELP_SECTIONS.map(section => ({
    ...section,
    title: resolveField(section.title, es),
    intro: resolveField(section.intro, es),
    items: section.items.map(item => ({
      ...item,
      q: resolveField(item.q, es),
      a: resolveField(item.a, es),
    })),
  }));
}
