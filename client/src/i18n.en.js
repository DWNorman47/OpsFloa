// English dictionary chunk — loaded lazily by the runtime in i18n.js.
// Don't add strings here: add them to i18n.js (both blocks) / i18nModules.js.
//
// The ?locale query makes the bundler treat these imports as modules separate
// from the plain './i18n' the app imports, so this chunk keeps only the English
// exports and the startup bundle keeps only the runtime.
import { moduleEn } from './i18nModules.js?locale=en';
import { English } from './i18n.js?locale=en';

// Module keys first so a same-named key in i18n.js wins (app strings are
// authoritative).
export default { ...moduleEn, ...English };
