const { buildIcsEvent, buildIcsAttachment, escapeText, formatUtc } = require('../utils/ics');

describe('escapeText', () => {
  test('escapes the RFC 5545 special chars', () => {
    expect(escapeText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
  });
  test('turns literal newlines into \\n', () => {
    expect(escapeText('line1\nline2')).toBe('line1\\nline2');
    expect(escapeText('line1\r\nline2')).toBe('line1\\nline2');
  });
  test('returns empty string on null / undefined', () => {
    expect(escapeText(null)).toBe('');
    expect(escapeText(undefined)).toBe('');
  });
});

describe('formatUtc', () => {
  test('formats a UTC instant as YYYYMMDDTHHMMSSZ', () => {
    expect(formatUtc(new Date('2026-06-15T14:30:00Z'))).toBe('20260615T143000Z');
  });
  test('zero-pads single-digit fields', () => {
    expect(formatUtc(new Date('2026-01-05T03:07:09Z'))).toBe('20260105T030709Z');
  });
});

describe('buildIcsEvent', () => {
  const baseInputs = {
    uid: 'appt-42@opsfloa.com',
    start: new Date('2026-06-15T14:30:00Z'),
    end:   new Date('2026-06-15T15:30:00Z'),
    summary: 'Site Visit with Acme',
  };

  test('produces a VCALENDAR with the required RFC 5545 envelope', () => {
    const ics = buildIcsEvent(baseInputs);
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/VERSION:2\.0/);
    expect(ics).toMatch(/PRODID:-\/\/OpsFloa\/\/Booking\/\/EN/);
    expect(ics).toMatch(/BEGIN:VEVENT/);
    expect(ics).toMatch(/END:VEVENT/);
    expect(ics).toMatch(/END:VCALENDAR\r\n$/);
  });

  test('includes UID / DTSTAMP / DTSTART / DTEND / SUMMARY', () => {
    const ics = buildIcsEvent(baseInputs);
    expect(ics).toContain('UID:appt-42@opsfloa.com');
    expect(ics).toContain('DTSTART:20260615T143000Z');
    expect(ics).toContain('DTEND:20260615T153000Z');
    expect(ics).toContain('SUMMARY:Site Visit with Acme');
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });

  test('omits optional fields when not given', () => {
    const ics = buildIcsEvent(baseInputs);
    expect(ics).not.toMatch(/^DESCRIPTION:/m);
    expect(ics).not.toMatch(/^LOCATION:/m);
    expect(ics).not.toMatch(/^ORGANIZER/m);
    expect(ics).not.toMatch(/^ATTENDEE/m);
  });

  test('includes ORGANIZER + ATTENDEE with CN when emails provided', () => {
    const ics = buildIcsEvent({
      ...baseInputs,
      organizer: { name: 'Jane Smith', email: 'jane@acme.com' },
      attendee:  { name: 'John Doe',  email: 'john@example.com' },
    });
    expect(ics).toContain('ORGANIZER;CN=Jane Smith:mailto:jane@acme.com');
    expect(ics).toContain('ATTENDEE;CN=John Doe;RSVP=TRUE:mailto:john@example.com');
  });

  test('escapes commas + semicolons + backslashes in SUMMARY', () => {
    const ics = buildIcsEvent({
      ...baseInputs,
      summary: 'Phone call, after lunch; bring laptop\\charger',
    });
    expect(ics).toContain('SUMMARY:Phone call\\, after lunch\\; bring laptop\\\\charger');
  });

  test('escapes newlines in DESCRIPTION', () => {
    const ics = buildIcsEvent({
      ...baseInputs,
      description: 'First line\nSecond line',
    });
    expect(ics).toContain('DESCRIPTION:First line\\nSecond line');
  });

  test('uses CRLF line endings (RFC 5545 §3.1)', () => {
    const ics = buildIcsEvent(baseInputs);
    // Every newline in the output should be CRLF, never bare LF
    const lines = ics.split('\r\n');
    for (const line of lines.slice(0, -1)) {
      expect(line.includes('\n')).toBe(false);  // bare LF inside a "line" would mean missing CR
    }
  });

  test('marks STATUS:CONFIRMED so calendars treat as confirmed not tentative', () => {
    const ics = buildIcsEvent(baseInputs);
    expect(ics).toContain('STATUS:CONFIRMED');
  });
});

describe('buildIcsAttachment', () => {
  test('produces a SendGrid-shaped attachment object', () => {
    const att = buildIcsAttachment({
      uid: 'x@y',
      start: new Date('2026-06-15T14:30:00Z'),
      end:   new Date('2026-06-15T15:30:00Z'),
      summary: 'Test',
    });
    expect(att).toHaveProperty('content');
    expect(att).toHaveProperty('filename', 'appointment.ics');
    expect(att.type).toMatch(/^text\/calendar/);
    expect(att.disposition).toBe('attachment');
  });

  test('content is base64-encoded valid VCALENDAR', () => {
    const att = buildIcsAttachment({
      uid: 'x@y',
      start: new Date('2026-06-15T14:30:00Z'),
      end:   new Date('2026-06-15T15:30:00Z'),
      summary: 'Test',
    });
    const decoded = Buffer.from(att.content, 'base64').toString('utf8');
    expect(decoded).toMatch(/BEGIN:VCALENDAR/);
    expect(decoded).toMatch(/END:VCALENDAR/);
  });

  test('custom filename when provided', () => {
    const att = buildIcsAttachment({
      uid: 'x@y',
      start: new Date(), end: new Date(),
      summary: 'X',
    }, 'invite.ics');
    expect(att.filename).toBe('invite.ics');
  });
});
