export function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function encodeCsv(rows, lineEnding = '\r\n') {
  return rows.map(row => row.map(csvCell).join(',')).join(lineEnding);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadCsv(rows, filename) {
  downloadBlob(new Blob([encodeCsv(rows)], { type: 'text/csv' }), filename);
}
