// Safe CSV cell encoder.
//
// Two jobs:
//   1. RFC-4180 quoting — wrap in double quotes and double any internal
//      quote so commas / newlines / quotes inside a value don't break the
//      row.
//   2. Formula-injection neutralization — a cell whose text starts with
//      =, +, -, @ (or a leading tab / CR) is executed as a formula when the
//      file is opened in Excel / Google Sheets. A worker named
//      `=HYPERLINK("http://evil","click")` would then run in an admin's
//      spreadsheet. Prefix such values with a single quote so the
//      spreadsheet treats them as literal text.
function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

module.exports = { csvCell };
