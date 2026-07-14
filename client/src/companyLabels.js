/**
 * Company labels (label_worker, label_client, label_work, label_field) are
 * stored SINGULAR and company-wide. When a company hasn't customized them we
 * fall back to a per-user-language default — English append-'s' pluralization
 * mangles Spanish multi-word labels (e.g. "Miembro del equipo" → wrong
 * "Miembro del equipos"), so defaults carry their own correct plural.
 *
 * A CUSTOM label keeps the existing English-style pluralization since only the
 * singular is stored (the company chose that word).
 *
 * `language` is the OpsFloa language NAME ('English' | 'Spanish'); anything
 * that isn't 'Spanish' resolves to English.
 */

const DEFAULTS = {
  worker: { en: { sg: 'Team Member', pl: 'Team Members' }, es: { sg: 'Miembro del equipo', pl: 'Miembros del equipo' } },
  client: { en: { sg: 'Customer', pl: 'Customers' },       es: { sg: 'Cliente', pl: 'Clientes' } },
  // 'work' is fixed to "Work" — no longer company-customizable (the module has
  // explicit Projects + Work Orders now). settings.label_work is dropped; the
  // first arg to labelSg/labelPl('work', …) stays as a future per-report hook.
  work:   { en: { sg: 'Work', pl: 'Work' },                es: { sg: 'Trabajo', pl: 'Trabajo' } },
  // 'project' is what the Projects tab / Haul log actually use. It must exist as
  // its own kind — without it, labelForms falls through to DEFAULTS.worker and
  // every "Project" label renders as "Team Member".
  project: { en: { sg: 'Project', pl: 'Projects' },        es: { sg: 'Proyecto', pl: 'Proyectos' } },
  field:  { en: { sg: 'Field Work', pl: 'Field Work' },    es: { sg: 'Trabajo de campo', pl: 'Trabajos de campo' } },
};

function pluralizeCustom(label) {
  if (/s$/i.test(label)) return label;
  if (/y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/**
 * Resolve a company label to its singular + plural display forms.
 * @param {string|null|undefined} custom  settings.label_X (may be empty)
 * @param {'worker'|'client'|'work'|'field'} kind
 * @param {string} language  'English' | 'Spanish'
 * @returns {{ sg: string, pl: string }}
 */
export function labelForms(custom, kind, language) {
  const c = (custom || '').trim();
  if (c) return { sg: c, pl: pluralizeCustom(c) };
  const d = DEFAULTS[kind] || DEFAULTS.worker;
  return d[language === 'Spanish' ? 'es' : 'en'];
}

/** Singular display form. */
export function labelSg(custom, kind, language) {
  return labelForms(custom, kind, language).sg;
}

/** Plural display form. */
export function labelPl(custom, kind, language) {
  return labelForms(custom, kind, language).pl;
}
