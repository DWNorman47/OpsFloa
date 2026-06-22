// Minimal iCalendar (RFC 5545) builder for booking confirmations.
// Produces a single VEVENT inside a VCALENDAR; that's all we need for
// "drop this appointment into your calendar." Field escaping follows
// RFC 5545 §3.3.11 (commas, semicolons, backslashes get backslash-
// escaped; literal newlines become \n).

// RFC 5545 wants CRLF line endings; lines longer than 75 octets must
// be folded. Both rules enforced here so the output passes strict
// validators (Apple Mail / Outlook are notoriously picky).
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    parts.push((i === 0 ? '' : ' ') + line.slice(i, i + (i === 0 ? 75 : 74)));
    i += (i === 0 ? 75 : 74);
  }
  return parts.join('\r\n');
}

function escapeText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Format an instant as YYYYMMDDTHHMMSSZ (the UTC form RFC 5545 calls
// for when no TZID is attached).
function formatUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z'
  );
}

// Build the .ics body for a single appointment event.
//
//   uid           — globally-unique identifier; use `<appt-id>@opsfloa.com`
//   start, end    — Date or ISO string instants
//   summary       — calendar event title
//   description   — long-form notes (escaped)
//   location      — string ("Phone: 555-1234" / Zoom URL / etc.)
//   organizer     — { name, email } for the sender (the assignee or
//                    company); SendGrid won't enforce this, but Apple
//                    Mail uses it to show the right invite UI
//   attendee      — { name, email } for the recipient (optional)
function buildIcsEvent({ uid, start, end, summary, description, location, organizer, attendee }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpsFloa//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (location)    lines.push(`LOCATION:${escapeText(location)}`);
  if (organizer?.email) {
    const cn = organizer.name ? `;CN=${escapeText(organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${organizer.email}`);
  }
  if (attendee?.email) {
    const cn = attendee.name ? `;CN=${escapeText(attendee.name)}` : '';
    lines.push(`ATTENDEE${cn};RSVP=TRUE:mailto:${attendee.email}`);
  }
  lines.push('STATUS:CONFIRMED');
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// Produces the SendGrid-shaped attachment object.
function buildIcsAttachment(eventInputs, filename = 'appointment.ics') {
  const content = buildIcsEvent(eventInputs);
  return {
    content: Buffer.from(content, 'utf8').toString('base64'),
    filename,
    type: 'text/calendar; method=REQUEST; charset=utf-8',
    disposition: 'attachment',
  };
}

module.exports = { buildIcsEvent, buildIcsAttachment, escapeText, formatUtc };
