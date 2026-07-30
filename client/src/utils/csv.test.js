import { describe, expect, test } from 'vitest';
import { csvCell, encodeCsv } from './csv';

describe('csvCell', () => {
  test.each(['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tformula', '\rformula'])(
    'neutralizes spreadsheet formula prefix %j',
    value => {
      expect(csvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    }
  );

  test('quotes commas, newlines, and double quotes', () => {
    expect(csvCell('A, "quoted"\nvalue')).toBe('"A, ""quoted""\nvalue"');
  });

  test('keeps nullish cells empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

test('encodeCsv applies the safe encoder to every row', () => {
  expect(encodeCsv([
    ['Name', 'Hours'],
    ['=HYPERLINK("https://example.test")', 8],
  ])).toBe('"Name","Hours"\r\n"\'=HYPERLINK(""https://example.test"")","8"');
});
