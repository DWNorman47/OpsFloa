// Fixed-value set for field_report_photos.media_type. Single source of truth for the app
// validators; the DB CHECK (migration 0193) and docs/db-enums.md must match this list.
const FIELD_REPORT_MEDIA_TYPES = Object.freeze(['photo', 'video']);
const FIELD_REPORT_MEDIA_TYPE_DEFAULT = 'photo';

module.exports = { FIELD_REPORT_MEDIA_TYPES, FIELD_REPORT_MEDIA_TYPE_DEFAULT };
