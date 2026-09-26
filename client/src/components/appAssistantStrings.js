const english = {
  open: 'Open OpsFloa Assistant',
  title: 'OpsFloa Assistant',
  subtitle: 'Ask about work or open a page',
  close: 'Close assistant',
  newChat: 'Start a new conversation',
  welcome: 'What can I help you find in OpsFloa?',
  privacy: 'Answers use only the company data you already have permission to see. Changes are not enabled yet.',
  placeholder: 'Ask OpsFloa...',
  send: 'Send',
  thinking: 'Checking OpsFloa...',
  failed: 'I could not reach the assistant. Please try again.',
  tooLong: 'Keep requests under 2,000 characters.',
  prompts: ['What needs attention?', 'Show active projects', 'Take me to approvals'],
};

const spanish = {
  open: 'Abrir el Asistente de OpsFloa',
  title: 'Asistente de OpsFloa',
  subtitle: 'Pregunte sobre el trabajo o abra una pagina',
  close: 'Cerrar asistente',
  newChat: 'Iniciar una nueva conversacion',
  welcome: 'En que puedo ayudarle dentro de OpsFloa?',
  privacy: 'Las respuestas solo usan los datos de la empresa que usted puede ver. Los cambios aun no estan habilitados.',
  placeholder: 'Pregunte a OpsFloa...',
  send: 'Enviar',
  thinking: 'Revisando OpsFloa...',
  failed: 'No pude comunicarme con el asistente. Intentelo de nuevo.',
  tooLong: 'Mantenga la solicitud por debajo de 2,000 caracteres.',
  prompts: ['Que necesita atencion?', 'Mostrar proyectos activos', 'Llevame a aprobaciones'],
};

export function assistantStrings(language) {
  return String(language || '').toLowerCase().startsWith('span') ? spanish : english;
}
