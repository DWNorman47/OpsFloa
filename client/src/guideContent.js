import { userHasAnyPerm } from './hooks/usePerm';

// Guide content is bilingual (English + Spanish). Translatable fields —
// `title`, `summary`, `category`, `routeLabel`, `before`, and `steps` — are
// stored as { en, es } objects. Non-display fields (`id`, `route`,
// `requiredModules`, permissions, `related`, `app`) stay language-neutral.
// `keywords` include both English and Spanish search terms.
//
// Use getGuideTasks(language) to obtain tasks with every field resolved to a
// single string for the requested language (English is the fallback).

export const GUIDE_TASKS = [
  {
    id: 'create-subcontractor-po',
    title: { en: 'Create a subcontractor PO', es: 'Crear una orden de compra para subcontratista' },
    category: { en: 'Projects', es: 'Proyectos' },
    app: 'projects',
    summary: {
      en: 'Set up a purchase order for a subcontractor and tie it to the project it belongs to.',
      es: 'Crea una orden de compra para un subcontratista y vincúlala al proyecto al que pertenece.',
    },
    route: '/work#pos',
    routeLabel: { en: 'Open subcontractor POs', es: 'Abrir órdenes de compra de subcontratistas' },
    requiredModules: ['projects'],
    requiredAnyPerms: ['manage_projects', 'manage_settings'],
    permissionLabel: 'manage project work',
    keywords: [
      'po', 'purchase order', 'sub', 'subcontractor', 'vendor', 'scope', 'retainage',
      'pay a sub', 'sub po', 'contractor',
      'orden de compra', 'subcontratista', 'proveedor', 'alcance', 'retención', 'pagar a un sub',
    ],
    before: {
      en: [
        'The project should already exist.',
        'The subcontractor should already be in Directory > Subcontractors.',
      ],
      es: [
        'El proyecto ya debe existir.',
        'El subcontratista ya debe estar en Directorio > Subcontratistas.',
      ],
    },
    steps: {
      en: [
        'Open Projects.',
        'Go to the Purchase Orders tab.',
        'Choose New PO.',
        'Pick the project and subcontractor.',
        'Enter the scope, amount, retainage if needed, and any notes.',
        'Save it as a draft. Issue it only when the details are ready.',
      ],
      es: [
        'Abre Proyectos.',
        'Ve a la pestaña Órdenes de compra.',
        'Elige Nueva orden de compra.',
        'Selecciona el proyecto y el subcontratista.',
        'Ingresa el alcance, el monto, la retención si es necesaria y cualquier nota.',
        'Guárdala como borrador. Emítela solo cuando los detalles estén listos.',
      ],
    },
    related: ['add-subcontractor', 'create-project', 'record-subcontractor-payment'],
  },
  {
    id: 'add-subcontractor',
    title: { en: 'Add a subcontractor', es: 'Agregar un subcontratista' },
    category: { en: 'Directory', es: 'Directorio' },
    app: 'team',
    summary: {
      en: 'Create the subcontractor record that can be used in subcontractor POs and project paperwork.',
      es: 'Crea el registro del subcontratista que podrás usar en las órdenes de compra y en la documentación del proyecto.',
    },
    route: '/team#subs',
    routeLabel: { en: 'Open subcontractors', es: 'Abrir subcontratistas' },
    requiredModules: ['team'],
    requiredAdmin: true,
    permissionLabel: 'admin access to Directory',
    keywords: [
      'subcontractor', 'sub', 'vendor', 'directory', 'contractor', 'company',
      'subcontratista', 'proveedor', 'directorio', 'contratista', 'empresa',
    ],
    steps: {
      en: [
        'Open Directory.',
        'Go to the Subcontractors tab.',
        'Choose Add subcontractor.',
        'Enter the company name first. Add contact, trade, insurance, and notes when you have them.',
        'Save the subcontractor. You can come back later to attach documents.',
      ],
      es: [
        'Abre Directorio.',
        'Ve a la pestaña Subcontratistas.',
        'Elige Agregar subcontratista.',
        'Ingresa primero el nombre de la empresa. Agrega el contacto, el oficio, el seguro y las notas cuando los tengas.',
        'Guarda el subcontratista. Puedes volver más tarde para adjuntar documentos.',
      ],
    },
    related: ['create-subcontractor-po', 'add-team-member'],
  },
  {
    id: 'record-subcontractor-payment',
    title: { en: 'Record a subcontractor PO payment', es: 'Registrar un pago de orden de compra de subcontratista' },
    category: { en: 'Projects', es: 'Proyectos' },
    app: 'projects',
    summary: {
      en: 'Track partial or final payments against a subcontractor PO.',
      es: 'Lleva el control de los pagos parciales o finales de una orden de compra de subcontratista.',
    },
    route: '/work#pos',
    routeLabel: { en: 'Open subcontractor POs', es: 'Abrir órdenes de compra de subcontratistas' },
    requiredModules: ['projects'],
    requiredAnyPerms: ['manage_projects', 'manage_settings'],
    permissionLabel: 'manage project work',
    keywords: [
      'pay sub', 'payment', 'subcontractor payment', 'partial payment', 'invoice', 'po payment',
      'pagar sub', 'pago', 'pago a subcontratista', 'pago parcial', 'factura',
    ],
    before: {
      en: [
        'The subcontractor PO must be issued before payments can be recorded.',
      ],
      es: [
        'La orden de compra del subcontratista debe estar emitida antes de poder registrar pagos.',
      ],
    },
    steps: {
      en: [
        'Open Projects > Purchase Orders.',
        'Open the subcontractor PO.',
        'Find the Payments area.',
        'Enter the payment amount, paid date, invoice reference, and notes.',
        'Save the payment. OpsFloa will mark the PO partial or complete based on totals.',
      ],
      es: [
        'Abre Proyectos > Órdenes de compra.',
        'Abre la orden de compra del subcontratista.',
        'Busca la sección de Pagos.',
        'Ingresa el monto del pago, la fecha de pago, la referencia de la factura y las notas.',
        'Guarda el pago. OpsFloa marcará la orden como parcial o completa según los totales.',
      ],
    },
    related: ['create-subcontractor-po'],
  },
  {
    id: 'create-project',
    title: { en: 'Create a project', es: 'Crear un proyecto' },
    category: { en: 'Projects', es: 'Proyectos' },
    app: 'projects',
    summary: {
      en: 'Add a project, job, route, or customer work bucket people can clock into and report against.',
      es: 'Agrega un proyecto, trabajo, ruta o grupo de trabajo de cliente al que las personas puedan registrar tiempo y reportar.',
    },
    route: '/work',
    routeLabel: { en: 'Open Projects', es: 'Abrir Proyectos' },
    requiredModules: ['projects'],
    requiredAnyPerms: ['manage_projects'],
    permissionLabel: 'manage projects',
    keywords: [
      'project', 'job', 'work', 'route', 'customer', 'client', 'add job',
      'proyecto', 'trabajo', 'ruta', 'cliente', 'agregar trabajo',
    ],
    steps: {
      en: [
        'Open Projects.',
        'Choose New project.',
        'Enter the name. Add the customer, job number, budget, and location if you have them.',
        'Save the project.',
        'If people clock into projects, make sure it is active.',
      ],
      es: [
        'Abre Proyectos.',
        'Elige Nuevo proyecto.',
        'Ingresa el nombre. Agrega el cliente, el número de trabajo, el presupuesto y la ubicación si los tienes.',
        'Guarda el proyecto.',
        'Si las personas registran tiempo en proyectos, asegúrate de que esté activo.',
      ],
    },
    related: ['create-subcontractor-po', 'clock-in-to-project'],
  },
  {
    id: 'clock-in-to-project',
    title: { en: 'Clock in to a project', es: 'Registrar entrada en un proyecto' },
    category: { en: 'Time Clock', es: 'Reloj checador' },
    app: 'timeclock',
    summary: {
      en: 'Start the day against the right project so time lands where it belongs.',
      es: 'Comienza el día en el proyecto correcto para que el tiempo se registre donde corresponde.',
    },
    route: '/timeclock#clock',
    routeLabel: { en: 'Open Time Clock', es: 'Abrir Reloj checador' },
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['clock_self', 'submit_time_entry_self'],
    permissionLabel: 'clock yourself in',
    keywords: [
      'clock in', 'project', 'start day', 'time', 'punch in', 'job',
      'registrar entrada', 'proyecto', 'iniciar día', 'tiempo', 'checar entrada', 'trabajo',
    ],
    before: {
      en: [
        'If the company uses projects, at least one active project must exist.',
      ],
      es: [
        'Si la empresa usa proyectos, debe existir al menos un proyecto activo.',
      ],
    },
    steps: {
      en: [
        'Open Time Clock.',
        'Choose Clock.',
        'Select the project or work item.',
        'Add notes if they help explain the day.',
        'Tap Clock In.',
      ],
      es: [
        'Abre el Reloj checador.',
        'Elige Reloj.',
        'Selecciona el proyecto o la tarea de trabajo.',
        'Agrega notas si ayudan a explicar el día.',
        'Toca Registrar entrada.',
      ],
    },
    related: ['create-project', 'fix-missed-clock-out'],
  },
  {
    id: 'approve-time',
    title: { en: 'Approve time entries', es: 'Aprobar registros de tiempo' },
    category: { en: 'Time Clock', es: 'Reloj checador' },
    app: 'timeclock',
    summary: {
      en: 'Review pending time before payroll and approve only entries that are complete.',
      es: 'Revisa el tiempo pendiente antes de la nómina y aprueba solo los registros que estén completos.',
    },
    route: '/timeclock#wf-approvals',
    routeLabel: { en: 'Open Approvals', es: 'Abrir Aprobaciones' },
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['approve_entries'],
    permissionLabel: 'approve time entries',
    keywords: [
      'approve', 'approval', 'payroll', 'timesheet', 'pending time', 'review time',
      'aprobar', 'aprobación', 'nómina', 'hoja de tiempo', 'tiempo pendiente', 'revisar tiempo',
    ],
    steps: {
      en: [
        'Open Time Clock.',
        'Switch to Workforce.',
        'Open Approvals.',
        'Review the person, project, start time, end time, and notes.',
        'Edit or reject anything wrong.',
        'Approve entries only after they have ended.',
      ],
      es: [
        'Abre el Reloj checador.',
        'Cambia a Personal.',
        'Abre Aprobaciones.',
        'Revisa la persona, el proyecto, la hora de entrada, la hora de salida y las notas.',
        'Edita o rechaza cualquier cosa que esté mal.',
        'Aprueba los registros solo después de que hayan finalizado.',
      ],
    },
    related: ['fix-missed-clock-out', 'run-payroll-export'],
  },
  {
    id: 'fix-missed-clock-out',
    title: { en: 'Fix a missed clock-out', es: 'Corregir una salida no registrada' },
    category: { en: 'Time Clock', es: 'Reloj checador' },
    app: 'timeclock',
    summary: {
      en: 'Correct an open or incorrect time entry before it reaches payroll.',
      es: 'Corrige un registro de tiempo abierto o incorrecto antes de que llegue a la nómina.',
    },
    route: '/timeclock#wf-approvals',
    routeLabel: { en: 'Open Approvals', es: 'Abrir Aprobaciones' },
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['edit_any_entry', 'approve_entries'],
    permissionLabel: 'edit or approve time',
    keywords: [
      'missed clock out', 'forgot clock out', 'fix time', 'edit time', 'open shift', 'stale clock',
      'salida no registrada', 'olvidó registrar salida', 'corregir tiempo', 'editar tiempo', 'turno abierto',
    ],
    steps: {
      en: [
        'Open Time Clock.',
        'Switch to Workforce.',
        'Open Approvals.',
        'Find the entry and choose Edit.',
        'Set the correct end time and confirm the project or notes.',
        'Save, then approve only if the entry is ready for payroll.',
      ],
      es: [
        'Abre el Reloj checador.',
        'Cambia a Personal.',
        'Abre Aprobaciones.',
        'Busca el registro y elige Editar.',
        'Establece la hora de salida correcta y confirma el proyecto o las notas.',
        'Guarda y luego aprueba solo si el registro está listo para la nómina.',
      ],
    },
    related: ['approve-time'],
  },
  {
    id: 'run-payroll-export',
    title: { en: 'Run a payroll export', es: 'Generar una exportación de nómina' },
    category: { en: 'Reports', es: 'Reportes' },
    app: 'timeclock',
    summary: {
      en: 'Download approved time for payroll or review a date range before closing it.',
      es: 'Descarga el tiempo aprobado para la nómina o revisa un rango de fechas antes de cerrarlo.',
    },
    route: '/timeclock#wf-reports',
    routeLabel: { en: 'Open Reports', es: 'Abrir Reportes' },
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['view_reports', 'export_data'],
    permissionLabel: 'view reports or export data',
    keywords: [
      'payroll', 'export', 'csv', 'hours', 'pay period', 'reports',
      'nómina', 'exportar', 'horas', 'periodo de pago', 'reportes',
    ],
    before: {
      en: [
        'Approve and correct time entries first.',
      ],
      es: [
        'Primero aprueba y corrige los registros de tiempo.',
      ],
    },
    steps: {
      en: [
        'Open Time Clock.',
        'Switch to Workforce.',
        'Open Reports.',
        'Choose the payroll or time export.',
        'Pick the date range.',
        'Download the file and review totals before importing into payroll.',
      ],
      es: [
        'Abre el Reloj checador.',
        'Cambia a Personal.',
        'Abre Reportes.',
        'Elige la exportación de nómina o de tiempo.',
        'Selecciona el rango de fechas.',
        'Descarga el archivo y revisa los totales antes de importarlo a la nómina.',
      ],
    },
    related: ['approve-time', 'lock-pay-period'],
  },
  {
    id: 'lock-pay-period',
    title: { en: 'Lock a pay period', es: 'Bloquear un periodo de pago' },
    category: { en: 'Time Clock', es: 'Reloj checador' },
    app: 'timeclock',
    summary: {
      en: 'Freeze a completed date range after payroll has been reviewed or exported.',
      es: 'Congela un rango de fechas ya completado después de revisar o exportar la nómina.',
    },
    route: '/timeclock#wf-approvals',
    routeLabel: { en: 'Open Pay Periods', es: 'Abrir Periodos de pago' },
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['manage_pay_periods'],
    permissionLabel: 'manage pay periods',
    keywords: [
      'lock', 'pay period', 'close payroll', 'freeze time', 'payroll',
      'bloquear', 'periodo de pago', 'cerrar nómina', 'congelar tiempo', 'nómina',
    ],
    before: {
      en: [
        'Make sure entries in the date range are approved and exported.',
      ],
      es: [
        'Asegúrate de que los registros del rango de fechas estén aprobados y exportados.',
      ],
    },
    steps: {
      en: [
        'Open Time Clock > Workforce > Approvals.',
        'Open Pay Periods.',
        'Choose the start and end dates.',
        'Lock the period.',
        'If a correction is needed later, unlock intentionally, fix the entry, then lock it again.',
      ],
      es: [
        'Abre Reloj checador > Personal > Aprobaciones.',
        'Abre Periodos de pago.',
        'Elige las fechas de inicio y fin.',
        'Bloquea el periodo.',
        'Si más tarde se necesita una corrección, desbloquea a propósito, corrige el registro y vuelve a bloquearlo.',
      ],
    },
    related: ['run-payroll-export', 'approve-time'],
  },
  {
    id: 'request-time-off',
    title: { en: 'Request time off', es: 'Solicitar tiempo libre' },
    category: { en: 'Time Clock', es: 'Reloj checador' },
    app: 'timeclock',
    summary: {
      en: 'Submit vacation, sick time, PTO, or leave so an admin can review it.',
      es: 'Envía vacaciones, tiempo por enfermedad, PTO o permiso para que un administrador lo revise.',
    },
    route: '/timeclock#timeoff',
    routeLabel: { en: 'Open Time Off', es: 'Abrir Tiempo libre' },
    requiredModules: ['timeclock'],
    requiredAnyPerms: ['clock_self', 'submit_time_entry_self', 'view_own_entries'],
    permissionLabel: 'use personal time tools',
    keywords: [
      'time off', 'pto', 'vacation', 'leave', 'sick day', 'request leave', 'day off', 'absence',
      'tiempo libre', 'vacaciones', 'permiso', 'día por enfermedad', 'solicitar permiso', 'día libre', 'ausencia',
    ],
    steps: {
      en: [
        'Open Time Clock.',
        'Choose Time Off.',
        'Pick the start date, end date, and request type.',
        'Add a note if your manager needs context.',
        'Submit the request.',
        'Watch the same tab for approval or denial.',
      ],
      es: [
        'Abre el Reloj checador.',
        'Elige Tiempo libre.',
        'Selecciona la fecha de inicio, la fecha de fin y el tipo de solicitud.',
        'Agrega una nota si tu gerente necesita contexto.',
        'Envía la solicitud.',
        'Vigila la misma pestaña para ver la aprobación o el rechazo.',
      ],
    },
    related: ['approve-time', 'lock-pay-period'],
  },
  {
    id: 'create-inventory-po',
    title: { en: 'Create an inventory purchase order', es: 'Crear una orden de compra de inventario' },
    category: { en: 'Inventory', es: 'Inventario' },
    app: 'inventory',
    summary: {
      en: 'Order items from a supplier and receive them into stock when they arrive.',
      es: 'Pide artículos a un proveedor y recíbelos en existencias cuando lleguen.',
    },
    route: '/inventory#orders',
    routeLabel: { en: 'Open inventory orders', es: 'Abrir órdenes de inventario' },
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: [
      'inventory po', 'purchase order', 'supplier', 'order stock', 'reorder', 'materials',
      'orden de inventario', 'orden de compra', 'proveedor', 'pedir existencias', 'reabastecer', 'materiales',
    ],
    before: {
      en: [
        'Items and suppliers should already exist, though you can add missing setup data first.',
      ],
      es: [
        'Los artículos y proveedores ya deben existir, aunque puedes agregar primero los datos de configuración que falten.',
      ],
    },
    steps: {
      en: [
        'Open Inventory.',
        'Go to Operations > Orders.',
        'Choose New PO.',
        'Pick the supplier and default receiving location.',
        'Add items, quantities, and unit costs.',
        'Create the draft, then submit it when ready.',
      ],
      es: [
        'Abre Inventario.',
        'Ve a Operaciones > Órdenes.',
        'Elige Nueva orden de compra.',
        'Selecciona el proveedor y la ubicación de recepción predeterminada.',
        'Agrega artículos, cantidades y costos unitarios.',
        'Crea el borrador y luego envíalo cuando esté listo.',
      ],
    },
    related: ['receive-inventory-po', 'add-inventory-item'],
  },
  {
    id: 'receive-inventory-po',
    title: { en: 'Receive items from a PO', es: 'Recibir artículos de una orden de compra' },
    category: { en: 'Inventory', es: 'Inventario' },
    app: 'inventory',
    summary: {
      en: 'Move delivered items from a purchase order into the selected stock location.',
      es: 'Mueve los artículos entregados de una orden de compra a la ubicación de existencias seleccionada.',
    },
    route: '/inventory#orders',
    routeLabel: { en: 'Open inventory orders', es: 'Abrir órdenes de inventario' },
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: [
      'receive inventory', 'receive po', 'delivery', 'stock', 'supplier', 'items arrived',
      'recibir inventario', 'recibir orden', 'entrega', 'existencias', 'proveedor', 'artículos llegaron',
    ],
    steps: {
      en: [
        'Open Inventory > Orders.',
        'Open the submitted or partially received PO.',
        'Choose Receive Items.',
        'Pick the receiving location.',
        'Enter only the quantities that arrived now.',
        'Confirm receipt. Stock updates immediately.',
      ],
      es: [
        'Abre Inventario > Órdenes.',
        'Abre la orden enviada o recibida parcialmente.',
        'Elige Recibir artículos.',
        'Selecciona la ubicación de recepción.',
        'Ingresa solo las cantidades que llegaron ahora.',
        'Confirma la recepción. Las existencias se actualizan de inmediato.',
      ],
    },
    related: ['create-inventory-po'],
  },
  {
    id: 'add-inventory-item',
    title: { en: 'Add an inventory item', es: 'Agregar un artículo de inventario' },
    category: { en: 'Inventory', es: 'Inventario' },
    app: 'inventory',
    summary: {
      en: 'Create the item record that stock, transactions, counts, and purchase orders use.',
      es: 'Crea el registro del artículo que usan las existencias, las transacciones, los conteos y las órdenes de compra.',
    },
    route: '/inventory#items',
    routeLabel: { en: 'Open inventory items', es: 'Abrir artículos de inventario' },
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: [
      'item', 'sku', 'part', 'inventory item', 'add item', 'materials',
      'artículo', 'parte', 'artículo de inventario', 'agregar artículo', 'materiales',
    ],
    steps: {
      en: [
        'Open Inventory.',
        'Switch to Setup.',
        'Open Items.',
        'Choose Add Item.',
        'Enter the name, SKU, category, unit, cost, and reorder settings you know.',
        'Save the item. You can add stock later through transactions or receiving.',
      ],
      es: [
        'Abre Inventario.',
        'Cambia a Configuración.',
        'Abre Artículos.',
        'Elige Agregar artículo.',
        'Ingresa el nombre, el SKU, la categoría, la unidad, el costo y los ajustes de reabastecimiento que conozcas.',
        'Guarda el artículo. Puedes agregar existencias más tarde mediante transacciones o recepciones.',
      ],
    },
    related: ['create-inventory-po', 'receive-inventory-po'],
  },
  {
    id: 'run-inventory-count',
    title: { en: 'Run an inventory count', es: 'Realizar un conteo de inventario' },
    category: { en: 'Inventory', es: 'Inventario' },
    app: 'inventory',
    summary: {
      en: 'Create a full or cycle count to verify stock and reconcile what is physically on hand.',
      es: 'Crea un conteo completo o cíclico para verificar las existencias y conciliar lo que hay físicamente disponible.',
    },
    route: '/inventory#counts',
    routeLabel: { en: 'Open inventory counts', es: 'Abrir conteos de inventario' },
    requiredModules: ['inventory'],
    requiredAnyPerms: ['manage_inventory'],
    permissionLabel: 'manage inventory',
    keywords: [
      'inventory count', 'cycle count', 'stock count', 'physical count', 'reconcile stock', 'audit inventory', 'counts',
      'conteo de inventario', 'conteo cíclico', 'conteo de existencias', 'conteo físico', 'conciliar existencias', 'auditar inventario', 'conteos',
    ],
    before: {
      en: [
        'Items and stock locations should already exist.',
      ],
      es: [
        'Los artículos y las ubicaciones de existencias ya deben existir.',
      ],
    },
    steps: {
      en: [
        'Open Inventory.',
        'Go to Counts.',
        'Choose New Count.',
        'Pick full count or cycle count and choose the scope.',
        'Assign counters if more than one person is helping.',
        'Enter counted quantities, review variances, and reconcile when ready.',
      ],
      es: [
        'Abre Inventario.',
        'Ve a Conteos.',
        'Elige Nuevo conteo.',
        'Elige conteo completo o conteo cíclico y selecciona el alcance.',
        'Asigna contadores si más de una persona está ayudando.',
        'Ingresa las cantidades contadas, revisa las diferencias y concilia cuando estés listo.',
      ],
    },
    related: ['add-inventory-item', 'receive-inventory-po'],
  },
  {
    id: 'add-team-member',
    title: { en: 'Invite or add a team member', es: 'Invitar o agregar un miembro del equipo' },
    category: { en: 'Directory', es: 'Directorio' },
    app: 'team',
    summary: {
      en: 'Give a person access and set the basics needed for time, reports, and payroll.',
      es: 'Da acceso a una persona y define lo básico necesario para el tiempo, los reportes y la nómina.',
    },
    route: '/team#team',
    routeLabel: { en: 'Open team members', es: 'Abrir miembros del equipo' },
    requiredModules: ['team'],
    requiredAnyPerms: ['manage_workers'],
    permissionLabel: 'manage team members',
    keywords: [
      'invite', 'add user', 'add worker', 'team member', 'employee', 'email invite',
      'invitar', 'agregar usuario', 'agregar trabajador', 'miembro del equipo', 'empleado', 'invitación por correo',
    ],
    steps: {
      en: [
        'Open Directory.',
        'Go to the Team Members tab.',
        'Choose Add Manually or Invite by Email.',
        'Fill in required fields and choose the role.',
        'Add worker type, classification, rate type, and overtime rule when needed.',
        'Save or send the invite.',
      ],
      es: [
        'Abre Directorio.',
        'Ve a la pestaña Miembros del equipo.',
        'Elige Agregar manualmente o Invitar por correo.',
        'Completa los campos requeridos y elige el rol.',
        'Agrega el tipo de trabajador, la clasificación, el tipo de tarifa y la regla de horas extra cuando sea necesario.',
        'Guarda o envía la invitación.',
      ],
    },
    related: ['guided-company-setup'],
  },
  {
    id: 'guided-company-setup',
    title: { en: 'Run company setup', es: 'Ejecutar la configuración de la empresa' },
    category: { en: 'Administration', es: 'Administración' },
    app: 'administration',
    summary: {
      en: 'Choose which modules and daily tools this company should actually see.',
      es: 'Elige qué módulos y herramientas diarias debería ver realmente esta empresa.',
    },
    route: '/administration?setup=1',
    routeLabel: { en: 'Open guided setup', es: 'Abrir configuración guiada' },
    requiredModules: ['administration'],
    requiredAnyPerms: ['manage_settings'],
    permissionLabel: 'manage company settings',
    keywords: [
      'setup', 'wizard', 'turn on modules', 'company settings', 'configure', 'start',
      'configuración', 'asistente', 'activar módulos', 'ajustes de la empresa', 'configurar', 'iniciar',
    ],
    steps: {
      en: [
        'Open Administration.',
        'Start guided setup.',
        'Choose the work the company tracks.',
        'Choose the daily tools people need.',
        'Choose manager visibility and labels.',
        'Review the summary and apply the setup.',
      ],
      es: [
        'Abre Administración.',
        'Inicia la configuración guiada.',
        'Elige el trabajo que la empresa registra.',
        'Elige las herramientas diarias que las personas necesitan.',
        'Elige la visibilidad y las etiquetas para gerentes.',
        'Revisa el resumen y aplica la configuración.',
      ],
    },
    related: ['configure-modules', 'add-team-member'],
  },
  {
    id: 'configure-modules',
    title: { en: 'Turn modules on or off', es: 'Activar o desactivar módulos' },
    category: { en: 'Administration', es: 'Administración' },
    app: 'administration',
    summary: {
      en: 'Keep the app simple by showing only the parts this company uses.',
      es: 'Mantén la aplicación sencilla mostrando solo las partes que esta empresa usa.',
    },
    route: '/administration#workspace',
    routeLabel: { en: 'Open Company Settings', es: 'Abrir Ajustes de la empresa' },
    requiredModules: ['administration'],
    requiredAnyPerms: ['manage_settings'],
    permissionLabel: 'manage company settings',
    keywords: [
      'modules', 'settings', 'hide', 'show', 'turn on', 'turn off', 'customize',
      'módulos', 'ajustes', 'ocultar', 'mostrar', 'activar', 'desactivar', 'personalizar',
    ],
    steps: {
      en: [
        'Open Administration.',
        'Go to Workspace.',
        'Open Company Settings.',
        'Turn modules and feature controls on or off.',
        'Save changes.',
        'Ask users to refresh if their navigation does not update immediately.',
      ],
      es: [
        'Abre Administración.',
        'Ve a Espacio de trabajo.',
        'Abre Ajustes de la empresa.',
        'Activa o desactiva los módulos y los controles de funciones.',
        'Guarda los cambios.',
        'Pide a los usuarios que actualicen si su navegación no cambia de inmediato.',
      ],
    },
    related: ['guided-company-setup'],
  },
];

export const MODULE_LABELS = {
  timeclock: 'Time Clock',
  workforce: 'Workforce',
  field: 'Field Work',
  inventory: 'Inventory',
  team: 'Directory',
  projects: 'Projects',
  administration: 'Administration',
  financial_reports: 'Reports',
};

// Resolve a possibly-bilingual field ({ en, es }) to a single value for the
// requested language, falling back to English. Plain strings/arrays pass
// through unchanged so callers can pass already-resolved tasks safely.
function resolveField(value, lang) {
  if (value && typeof value === 'object' && !Array.isArray(value) && ('en' in value || 'es' in value)) {
    return (lang === 'es' ? value.es : value.en) ?? value.en ?? value.es;
  }
  return value;
}

// Normalize an app-language name ('English' | 'Spanish' | anything) into the
// short code the content is keyed on. Non-'Spanish' resolves to English.
function langCode(language) {
  return language === 'Spanish' || language === 'es' || language === 'es-MX' ? 'es' : 'en';
}

// Return the guide tasks with every translatable field resolved to the given
// app language. English is always the fallback.
export function getGuideTasks(language) {
  const lang = langCode(language);
  return resolveGuideTasks(lang);
}

function resolveGuideTasks(lang) {
  return GUIDE_TASKS.map(task => ({
    ...task,
    title: resolveField(task.title, lang),
    category: resolveField(task.category, lang),
    summary: resolveField(task.summary, lang),
    routeLabel: resolveField(task.routeLabel, lang),
    before: resolveField(task.before, lang),
    steps: resolveField(task.steps, lang),
  }));
}

export function isGuideModuleEnabled(features = {}, moduleId) {
  features = features || {};
  if (!moduleId) return true;
  if (moduleId === 'financial_reports') {
    return !(features.module_financial_reports === false && features.module_analytics === false);
  }
  // The Work module keeps the internal id 'projects' but its toggle is module_work.
  if (moduleId === 'projects') return features.module_work !== false;
  return features[`module_${moduleId}`] !== false;
}

export function getGuideTaskAvailability(task, user, features = {}) {
  features = features || {};
  const missingModules = (task.requiredModules || [])
    .filter(moduleId => !isGuideModuleEnabled(features, moduleId))
    .map(moduleId => MODULE_LABELS[moduleId] || moduleId);

  const adminOk = !task.requiredAdmin || user?.role === 'admin' || user?.role === 'super_admin';
  const permsOk = !task.requiredAnyPerms?.length || userHasAnyPerm(user, task.requiredAnyPerms);
  const missingRole = adminOk ? '' : 'admin access';
  const missingPermission = permsOk ? '' : task.permissionLabel || 'additional permission';

  return {
    ready: missingModules.length === 0 && adminOk && permsOk,
    missingModules,
    missingRole,
    missingPermission,
  };
}

// English-resolved default task list. Used when callers don't supply a
// language-resolved list (tests, non-UI callers), so the search/sort helpers
// always operate on plain-string fields rather than { en, es } objects.
const GUIDE_TASKS_EN = resolveGuideTasks('en');

export function sortGuideTasks(tasks, currentApp) {
  return [...tasks].sort((a, b) => {
    const aCurrent = a.app === currentApp ? 0 : 1;
    const bCurrent = b.app === currentApp ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    return String(a.title).localeCompare(String(b.title));
  });
}

const GUIDE_STOP_WORDS = new Set(['a', 'an', 'and', 'can', 'do', 'for', 'how', 'i', 'make', 'the', 'to']);

function normalizeGuideTokens(value) {
  const tokens = String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.flatMap(token => {
    if (token.length > 2 && token.endsWith('s')) {
      return [token, token.slice(0, -1)];
    }
    return [token];
  });
}

function guideFieldText(task, field) {
  if (Array.isArray(task[field])) return task[field].join(' ');
  return task[field] || '';
}

function guideTokenSet(task, fields) {
  return new Set(fields.flatMap(field => normalizeGuideTokens(guideFieldText(task, field))));
}

function guideTaskScore(task, terms, phrase, currentApp) {
  const titleTokens = guideTokenSet(task, ['title']);
  const routeTokens = guideTokenSet(task, ['routeLabel']);
  const keywordTokens = guideTokenSet(task, ['keywords']);
  const categoryTokens = guideTokenSet(task, ['category']);
  const bodyTokens = guideTokenSet(task, ['summary', 'before', 'steps']);
  const haystack = [
    task.title,
    task.category,
    task.summary,
    task.routeLabel,
    ...(task.keywords || []),
    ...(task.before || []),
    ...(task.steps || []),
  ].join(' ').toLowerCase();

  let score = task.app === currentApp ? 4 : 0;
  const phraseIsUseful = phrase.length > 2 || phrase.includes(' ');
  if (phraseIsUseful) {
    if (String(task.title || '').toLowerCase().includes(phrase)) score += 85;
    if (String(task.routeLabel || '').toLowerCase().includes(phrase)) score += 65;
    if ((task.keywords || []).join(' ').toLowerCase().includes(phrase)) score += 70;
    if (haystack.includes(phrase)) score += 15;
  }

  for (const term of terms) {
    let termScore = 0;
    if (titleTokens.has(term)) termScore += 70;
    if (keywordTokens.has(term)) termScore += 65;
    if (routeTokens.has(term)) termScore += 55;
    if (categoryTokens.has(term)) termScore += 20;
    if (bodyTokens.has(term)) termScore += 12;
    if (term.length >= 3 && haystack.includes(term)) termScore += 6;
    if (termScore === 0) return 0;
    score += termScore;
  }

  return score;
}

// Filter/sort tasks by query. Pass already-resolved tasks (from getGuideTasks)
// so search matches the language the user actually sees, plus keywords.
export function filterGuideTasks(query, currentApp, tasks = GUIDE_TASKS_EN) {
  const q = String(query || '').trim().toLowerCase();
  const sorted = sortGuideTasks(tasks, currentApp);
  if (!q) return sorted;
  const terms = normalizeGuideTokens(q).filter(term => term && !GUIDE_STOP_WORDS.has(term));
  if (terms.length === 0) return sorted;

  return tasks
    .map(task => ({ task, score: guideTaskScore(task, terms, q, currentApp) }))
    .filter(result => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aCurrent = a.task.app === currentApp ? 0 : 1;
      const bCurrent = b.task.app === currentApp ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      return String(a.task.title).localeCompare(String(b.task.title));
    })
    .map(result => result.task);
}

// Find a task by id. Pass a resolved task list (from getGuideTasks) to get the
// task in the user's language; defaults to the raw bilingual records.
export function findGuideTask(id, tasks = GUIDE_TASKS_EN) {
  return tasks.find(task => task.id === id) || null;
}
